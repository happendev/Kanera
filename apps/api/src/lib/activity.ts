import type { ActivityFeedEvent } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { activityEvents, type ActivityAction, type ActivityCoalesceKey, type ActivityEntityType, type ActivityEvent, type DynamicActivityCoalesceKey } from "@kanera/shared/schema";
import { requestContext } from "@fastify/request-context";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Db } from "../db.js";
import { queueNotificationFanout } from "./notifications.js";
import { emitToBoard } from "../realtime/emit.js";
import { withSignedMedia } from "./media-keys.js";
import { getUserDisplay, type UserDisplayMetadata } from "./user-display-cache.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

interface ActivityActor {
  displayName: string;
  avatarUrl: string | null;
}

type ActivityActorKind = "user" | "apiKey" | "system" | "support";

interface ActivityAttribution {
  actorKind: ActivityActorKind;
  apiKeyId: string | null;
  apiKeyName: string | null;
  supportSessionId: string | null;
  supportActorEmail: string | null;
}

export interface ActivityEmitOptions {
  notify?: boolean;
  actor?: UserDisplayMetadata;
  suppressNotificationUserId?: string | null;
}

export interface ActivityInput {
  boardId: string | null;
  workspaceId: string;
  actorId: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  payload?: Record<string, unknown>;
  actorKind?: "system";
}

export interface CoalescedActivityInput extends ActivityInput {
  actorId: string;
  coalesceKey: ActivityCoalesceKey | DynamicActivityCoalesceKey;
  windowMs: number;
  coalesceAcrossBoards?: boolean;
  preservePayloadKeys?: string[];
  fromValue?: unknown;
  toValue?: unknown;
}

export type CoalescedActivityResult =
  | { status: "created"; activity: ActivityEvent; previousBoardId?: string | null }
  | { status: "updated"; activity: ActivityEvent; previousBoardId?: string | null }
  | { status: "hidden"; activity: ActivityEvent; previousBoardId?: string | null };

const MERGED_OBJECT_PAYLOAD_KEYS = ["assigneeNamesById", "labelNamesById"] as const;

function currentAttribution(): ActivityAttribution {
  const authKind = requestContext.get("authKind");
  if (authKind === "apiKey") {
    return {
      actorKind: "apiKey",
      apiKeyId: requestContext.get("apiKeyId") ?? null,
      apiKeyName: requestContext.get("apiKeyName") ?? "API key",
      supportSessionId: null,
      supportActorEmail: null,
    };
  }
  // A support-session mutation acts as (actorId =) the impersonated org user, but must be recorded as
  // the operator's action so audit history is truthful. Carry the session id + operator email through.
  if (authKind === "support") {
    return {
      actorKind: "support",
      apiKeyId: null,
      apiKeyName: null,
      supportSessionId: requestContext.get("supportSessionId") ?? null,
      supportActorEmail: requestContext.get("supportActorEmail") ?? null,
    };
  }
  return { actorKind: "user", apiKeyId: null, apiKeyName: null, supportSessionId: null, supportActorEmail: null };
}

export async function recordActivity(tx: Tx, input: ActivityInput): Promise<ActivityEvent> {
  const attribution = input.actorKind === "system"
    ? { actorKind: "system" as const, apiKeyId: null, apiKeyName: null, supportSessionId: null, supportActorEmail: null }
    : currentAttribution();
  const [activity] = await tx.insert(activityEvents).values({
    boardId: input.boardId,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorKind: attribution.actorKind,
    apiKeyId: attribution.apiKeyId,
    apiKeyName: attribution.apiKeyName,
    supportSessionId: attribution.supportSessionId,
    supportActorEmail: attribution.supportActorEmail,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    payload: input.payload ?? {},
  }).returning();

  return activity!;
}

export function toActivityFeedEvent(activity: ActivityEvent, actor: ActivityActor | null | undefined, clientId: string): ActivityFeedEvent {
  if (activity.actorKind === "system") {
    return {
      ...activity,
      actorName: "Kanera",
      actorAvatarUrl: null,
    };
  }
  // Support-session actions are surfaced as the operator, never the impersonated owner, so the feed
  // does not falsely read as the customer's own action.
  if (activity.actorKind === "support") {
    return {
      ...activity,
      actorName: `Kanera Support (${activity.supportActorEmail ?? "operator"})`,
      actorAvatarUrl: null,
    };
  }
  const isApiKey = activity.actorKind === "apiKey";
  return {
    ...activity,
    actorName: isApiKey ? (activity.apiKeyName ?? "API key") : (actor?.displayName ?? "Unknown"),
    actorAvatarUrl: isApiKey
      ? null
      : actor ? withSignedMedia(clientId, { actorAvatarUrl: actor.avatarUrl }).actorAvatarUrl : null,
  };
}

export async function recordCoalescedActivity(tx: Tx, input: CoalescedActivityInput): Promise<CoalescedActivityResult> {
  const now = new Date();
  const attribution = currentAttribution();
  const coalescedUntil = new Date(now.getTime() + input.windowMs);
  const sameBoard = input.boardId === null ? isNull(activityEvents.boardId) : eq(activityEvents.boardId, input.boardId);
  const boardScope = input.coalesceAcrossBoards ? undefined : sameBoard;
  // Only visible activity can be extended. Once a burst returns to its original
  // value, the row is hidden and later edits start a new visible story.
  const [existing] = await tx
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.feedVisible, true),
        boardScope,
        eq(activityEvents.workspaceId, input.workspaceId),
        eq(activityEvents.actorId, input.actorId),
        eq(activityEvents.actorKind, attribution.actorKind),
        attribution.apiKeyId === null ? isNull(activityEvents.apiKeyId) : eq(activityEvents.apiKeyId, attribution.apiKeyId),
        // Never coalesce across support sessions, so a merged row can't blend two operators' edits.
        attribution.supportSessionId === null ? isNull(activityEvents.supportSessionId) : eq(activityEvents.supportSessionId, attribution.supportSessionId),
        eq(activityEvents.entityType, input.entityType),
        eq(activityEvents.entityId, input.entityId),
        eq(activityEvents.action, input.action),
        eq(activityEvents.coalesceKey, input.coalesceKey),
        gte(activityEvents.coalescedUntil, now),
      ),
    )
    .orderBy(desc(activityEvents.updatedAt))
    .limit(1);

  const nextPayload = input.payload ?? {};
  const nextToValue = Object.prototype.hasOwnProperty.call(nextPayload, "toValue") ? nextPayload.toValue : input.toValue;
  const insertPayload = {
    ...nextPayload,
    fromValue: Object.prototype.hasOwnProperty.call(nextPayload, "fromValue") ? nextPayload.fromValue : input.fromValue,
    toValue: nextToValue,
  };

  if (existing) {
    const previousBoardId = existing.boardId;
    const existingPayload = existing.payload as Record<string, unknown>;
    // Preserve the value from before the first edit in the burst so the feed can
    // say "A -> C" instead of showing every intermediate "A -> B -> C" step.
    const firstFromValue = Object.prototype.hasOwnProperty.call(existingPayload, "fromValue")
      ? existingPayload.fromValue
      : input.fromValue;
    // If the final value matches the original value, the burst did not leave a
    // meaningful change behind, so remove it from the human-facing feed.
    const feedVisible = !activityValuesEqual(firstFromValue, nextToValue);
    const payload: Record<string, unknown> = {
      ...existingPayload,
      ...nextPayload,
      fromValue: firstFromValue,
      toValue: nextToValue,
    };
    for (const key of MERGED_OBJECT_PAYLOAD_KEYS) {
      if (isActivityPlainObject(existingPayload[key]) || isActivityPlainObject(nextPayload[key])) {
        payload[key] = {
          ...(isActivityPlainObject(existingPayload[key]) ? existingPayload[key] : {}),
          ...(isActivityPlainObject(nextPayload[key]) ? nextPayload[key] : {}),
        };
      }
    }
    for (const key of input.preservePayloadKeys ?? []) {
      if (Object.prototype.hasOwnProperty.call(existingPayload, key)) {
        payload[key] = existingPayload[key];
      }
    }
    if (input.action === "labels:set" && Array.isArray(firstFromValue) && Array.isArray(nextToValue)) {
      const labelNamesById = isActivityPlainObject(payload.labelNamesById) ? payload.labelNamesById : {};
      const fromIds = firstFromValue.filter((id): id is string => typeof id === "string");
      const toIds = nextToValue.filter((id): id is string => typeof id === "string");
      const fromSet = new Set(fromIds);
      const toSet = new Set(toIds);
      payload.addedLabelNames = toIds
        .filter((id) => !fromSet.has(id))
        .map((id) => labelNamesById[id])
        .filter((name): name is string => typeof name === "string");
      payload.removedLabelNames = fromIds
        .filter((id) => !toSet.has(id))
        .map((id) => labelNamesById[id])
        .filter((name): name is string => typeof name === "string");
    }
    const [activity] = await tx
      .update(activityEvents)
      .set({
        boardId: input.boardId,
        payload,
        feedVisible,
        coalescedCount: existing.coalescedCount + 1,
        coalescedUntil,
        updatedAt: now,
      })
      .where(eq(activityEvents.id, existing.id))
      .returning();

    return { status: feedVisible ? "updated" : "hidden", activity: activity!, previousBoardId };
  }

  const feedVisible = !activityValuesEqual(input.fromValue, input.toValue);
  const [activity] = await tx
    .insert(activityEvents)
    .values({
      boardId: input.boardId,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorKind: attribution.actorKind,
      apiKeyId: attribution.apiKeyId,
      apiKeyName: attribution.apiKeyName,
      supportSessionId: attribution.supportSessionId,
      supportActorEmail: attribution.supportActorEmail,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      payload: insertPayload,
      feedVisible,
      coalesceKey: input.coalesceKey,
      coalescedUntil,
      updatedAt: now,
    })
    .returning();

  return { status: feedVisible ? "created" : "hidden", activity: activity! };
}

function activityValuesEqual(a: unknown, b: unknown): boolean {
  return normalizeActivityValue(a) === normalizeActivityValue(b);
}

function isActivityPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeActivityValue(value: unknown): string {
  // Coalescing compares user-visible scalar values that may arrive as strings,
  // booleans, numbers, dates, objects, or nulls depending on the route and field type.
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(stableActivityValue(value)) ?? "";
}

function stableActivityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableActivityValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableActivityValue(entry)]),
  );
}

export async function emitActivityFeedItem(boardId: string, cardId: string, activity: ActivityEvent, options?: ActivityEmitOptions): Promise<void> {
  const published = emitEnrichedActivityFeedItem(SERVER_EVENTS.CARD_FEED_ITEM_CREATED, boardId, cardId, activity, options);
  if (options?.notify !== false) {
    queueNotificationFanout(activity, { kind: "created", suppressUserId: options?.suppressNotificationUserId });
  }
  await published;
}

export async function emitActivityFeedItemUpdated(boardId: string, cardId: string, activity: ActivityEvent, options?: ActivityEmitOptions): Promise<void> {
  const published = emitEnrichedActivityFeedItem(SERVER_EVENTS.CARD_FEED_ITEM_UPDATED, boardId, cardId, activity, options);
  if (options?.notify !== false) {
    queueNotificationFanout(activity, { kind: "updated", suppressUserId: options?.suppressNotificationUserId });
  }
  await published;
}

export async function emitActivityFeedItemDeleted(boardId: string, cardId: string, activityId: string): Promise<void> {
  await emitToBoard(boardId, SERVER_EVENTS.CARD_FEED_ITEM_DELETED, { boardId, cardId, type: "activity", itemId: activityId });
  // When a coalesced burst collapses we also tear down any notifications that
  // referenced the now-hidden activity so users don't see stale entries.
  queueNotificationFanout({ id: activityId } as ActivityEvent, { kind: "hidden" });
}

async function emitEnrichedActivityFeedItem(
  event: typeof SERVER_EVENTS.CARD_FEED_ITEM_CREATED | typeof SERVER_EVENTS.CARD_FEED_ITEM_UPDATED,
  boardId: string,
  cardId: string,
  activity: ActivityEvent,
  options?: ActivityEmitOptions,
): Promise<void> {
  // Prefer caller-supplied actor data. Otherwise use the shared short-lived user
  // display cache so activity bursts do not repeatedly query actor/workspace rows.
  if (options?.actor) {
    await emitToBoard(boardId, event, {
      boardId,
      cardId,
      item: { type: "activity", data: toActivityFeedEvent(activity, options.actor, options.actor.clientId) },
    });
    return;
  }

  if (activity.actorKind === "system" || activity.actorId === null) {
    await emitToBoard(boardId, event, {
      boardId,
      cardId,
      item: { type: "activity", data: toActivityFeedEvent(activity, null, activity.workspaceId) },
    });
    return;
  }

  const actor = await getUserDisplay(activity.workspaceId, activity.actorId);
  const enriched = toActivityFeedEvent(activity, actor, actor?.clientId ?? activity.workspaceId);
  await emitToBoard(boardId, event, {
    boardId,
    cardId,
    item: { type: "activity", data: enriched },
  });
}
