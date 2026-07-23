import type { NotificationCardThumbnail, NotificationRow } from "@kanera/shared/dto";
import {
  ACTIVITY_ACTION,
  ACTIVITY_COALESCE_KEY,
  ACTIVITY_ENTITY_TYPE,
  NOTIFICATION_REASON,
  activityEvents,
  boardMembers,
  boardWatchers,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardMentions,
  cardWatchers,
  cards,
  comments,
  lists,
  notifications,
  users,
  workspaces,
  type ActivityAction,
  type ActivityEvent,
  type NotificationReason,
} from "@kanera/shared/schema";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db.js";
import { db as dbSingleton } from "../db.js";
import { signEmbeddedMediaUrls, withSignedMedia } from "./media-keys.js";
import { emitToUser } from "../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Per-source cap on notification recipients. See resolveRecipients for rationale.
const RECIPIENT_FANOUT_LIMIT = 1000;
// Watchers are for high-signal progress: comments/discussion, card movement,
// completion/status changes, assignee changes, and overdue-style attention
// events. Card metadata churn below still matters to the people assigned to the
// work, but it should not turn every passive watcher into an inbox recipient.
const ASSIGNEES_ONLY_CARD_ACTIONS = new Set<ActivityAction>([
  // New attachments are a visible collaboration update, so both card and board
  // watchers receive them; removal and cover churn remain assignee-only metadata.
  ACTIVITY_ACTION.ATTACHMENT_REMOVED,
  ACTIVITY_ACTION.COVER_REMOVED,
  ACTIVITY_ACTION.COVER_SET,
  ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_CLEARED,
  ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
  ACTIVITY_ACTION.CHECKLIST_ITEM_UPDATED,
  ACTIVITY_ACTION.CHECKLIST_ITEM_DESCRIPTION_SET,
  ACTIVITY_ACTION.LABELS_SET,
]);
const AUTOMATION_ASSIGNEES_ONLY_CARD_ACTIONS = new Set<ActivityAction>([
  ACTIVITY_ACTION.MOVED,
  ACTIVITY_ACTION.COMPLETED,
  ACTIVITY_ACTION.UNCOMPLETED,
  ACTIVITY_ACTION.COMPLETION_SET,
]);

const pendingFanout = new Set<Promise<void>>();
const fanoutErrors: unknown[] = [];
let fanoutTail: Promise<void> = Promise.resolve();
const notificationUsers = alias(users, "notification_users");

export function inboxVisibleNotificationCondition() {
  // Completed cards still keep normal watch/assignment/comment notifications
  // actionable; only overdue attention is cleared once the card is complete.
  // Archived cards are deletion-equivalent in the product, so no notification
  // linked to one may remain visible even if legacy data escaped archive cleanup.
  return sql`${cards.archivedAt} is null and (${notifications.reason} <> ${NOTIFICATION_REASON.OVERDUE} or ${cards.completedAt} is null)`;
}

function isRetryablePostgresConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40P01" || code === "40001";
}

async function runWithNotificationFanoutRetry(task: () => Promise<void>): Promise<void> {
  const maxAttempts = process.env.NODE_ENV === "test" ? 3 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      if (!isRetryablePostgresConflict(error) || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
}

function notificationActorSuppressionId(activity: ActivityEvent): string | null {
  // API keys borrow the creator's user id for tenancy/audit ownership, but the
  // trigger can be an external system. Keep the creator eligible for notifications
  // when they otherwise match as a watcher, assignee, or mention recipient.
  return activity.actorKind === "apiKey" ? null : activity.actorId;
}

export function queueNotificationFanout(
  activity: ActivityEvent,
  options?: { kind?: "created" | "updated" | "hidden"; suppressUserId?: string | null },
): void {
  // Notification fanout is intentionally decoupled from route latency, but the
  // database writes still target the same activity/notification indexes. Keep
  // queued work ordered so coalesced create/update/hide jobs cannot race each
  // other and leave tests or clients with stale notification rows.
  const pending = fanoutTail
    .catch(() => undefined)
    .then(() => runWithNotificationFanoutRetry(() => fanoutNotificationsForActivity(activity, options)))
    .catch((error: unknown) => {
      if (process.env.NODE_ENV === "test") fanoutErrors.push(error);
      else console.warn("notification fanout failed", error);
    })
    .finally(() => pendingFanout.delete(pending));
  fanoutTail = pending;
  pendingFanout.add(pending);
}

export async function waitForNotificationFanoutForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  while (pendingFanout.size > 0) {
    await Promise.allSettled([...pendingFanout]);
  }
  if (fanoutErrors.length > 0) {
    const errors = fanoutErrors.splice(0);
    throw new AggregateError(errors, "notification fanout failed");
  }
}

interface CardContext {
  cardId: string;
  listId: string;
  boardId: string;
  workspaceId: string;
}

function deriveCardId(activity: ActivityEvent): string | null {
  if (activity.entityType === ACTIVITY_ENTITY_TYPE.CARD) return activity.entityId;
  if (activity.entityType === ACTIVITY_ENTITY_TYPE.COMMENT) {
    const payload = activity.payload as { cardId?: string };
    return payload?.cardId ?? null;
  }
  return null;
}

async function loadCardContext(tx: Tx, cardId: string): Promise<CardContext | null> {
  const [row] = await tx
    .select({
      cardId: cards.id,
      listId: cards.listId,
      boardId: cards.boardId,
      workspaceId: lists.workspaceId,
      archivedAt: cards.archivedAt,
    })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(eq(cards.id, cardId))
    .limit(1);
  if (!row || row.archivedAt) return null;
  return row;
}

async function resolveRecipients(
  tx: Tx,
  ctx: CardContext,
  activity: ActivityEvent,
  options?: { suppressUserId?: string | null },
): Promise<Map<string, NotificationReason>> {
  const assigneesOnly = shouldNotifyAssigneesOnly(activity);
  // Circuit breaker on each recipient source. Watcher/assignee counts are bounded by
  // workspace membership, so this cap should never bite in practice; it only stops one
  // pathological card from fanning out an unbounded notification insert + emit.
  const [assignees, cardWatcherRows, boardWatcherRows, mentions] = await Promise.all([
    tx
      .select({ userId: cardAssignees.userId })
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, ctx.cardId))
      .limit(RECIPIENT_FANOUT_LIMIT),
    assigneesOnly
      ? Promise.resolve([])
      : tx
        .select({ userId: cardWatchers.userId })
        .from(cardWatchers)
        .where(eq(cardWatchers.cardId, ctx.cardId))
        .limit(RECIPIENT_FANOUT_LIMIT),
    assigneesOnly
      ? Promise.resolve([])
      : tx
        .select({ userId: boardWatchers.userId })
        .from(boardWatchers)
        .where(eq(boardWatchers.boardId, ctx.boardId))
        .limit(RECIPIENT_FANOUT_LIMIT),
    activity.entityType === ACTIVITY_ENTITY_TYPE.COMMENT
      ? tx
        .select({ userId: cardMentions.userId })
        .from(cardMentions)
        .where(and(
          eq(cardMentions.cardId, ctx.cardId),
          eq(cardMentions.commentId, activity.entityId),
          eq(cardMentions.source, ACTIVITY_ENTITY_TYPE.COMMENT),
        ))
        .limit(RECIPIENT_FANOUT_LIMIT)
      : Promise.resolve([]),
  ]);
  // System-authored automation activity can still be caused by a user action;
  // suppress that optional initiating user via suppressUserId.
  const suppressedUserIds = new Set([notificationActorSuppressionId(activity), options?.suppressUserId].filter((id): id is string => Boolean(id)));
  const recipients = new Map<string, NotificationReason>();
  for (const w of cardWatcherRows) {
    if (!suppressedUserIds.has(w.userId)) recipients.set(w.userId, NOTIFICATION_REASON.WATCHING);
  }
  for (const w of boardWatcherRows) {
    if (!suppressedUserIds.has(w.userId)) recipients.set(w.userId, NOTIFICATION_REASON.WATCHING);
  }
  // Assignment reason takes precedence over watcher reason so the UI can show
  // "you were assigned" rather than the more passive "watching this list".
  for (const a of assignees) {
    if (!suppressedUserIds.has(a.userId)) recipients.set(a.userId, NOTIFICATION_REASON.ASSIGNED);
  }
  // Mentions are explicit asks for attention, so they take precedence over
  // assignment/list-watch reasons for the same comment activity.
  for (const m of mentions) {
    if (!suppressedUserIds.has(m.userId)) recipients.set(m.userId, NOTIFICATION_REASON.MENTIONED);
  }
  return recipients;
}

function shouldNotifyAssigneesOnly(activity: ActivityEvent): boolean {
  if (activity.entityType !== ACTIVITY_ENTITY_TYPE.CARD) return false;
  const payload = activity.payload as { automationActionId?: unknown };
  // Automation move/completion activity is useful for the people assigned to the
  // card, but passive watchers do not need inbox noise for system follow-up actions.
  if (
    activity.actorKind === "system" &&
    typeof payload?.automationActionId === "string" &&
    AUTOMATION_ASSIGNEES_ONLY_CARD_ACTIONS.has(activity.action as ActivityAction)
  ) {
    return true;
  }
  // Some card activity is useful context for the people assigned to do the work
  // but too noisy for passive card/board watchers.
  return (activity.action === ACTIVITY_ACTION.UPDATED && activity.coalesceKey === ACTIVITY_COALESCE_KEY.CARD_DESCRIPTION)
    || ASSIGNEES_ONLY_CARD_ACTIONS.has(activity.action as ActivityAction);
}

export async function fanoutNotificationsForActivity(
  activity: ActivityEvent,
  options?: { kind?: "created" | "updated" | "hidden"; suppressUserId?: string | null },
): Promise<void> {
  const kind = options?.kind ?? "created";
  if (kind === "hidden") {
    const deleted = await dbSingleton
      .delete(notifications)
      .where(eq(notifications.activityId, activity.id))
      .returning({ id: notifications.id, userId: notifications.userId });
    for (const row of deleted) {
      emitToUser(row.userId, "notification:read", {
        notificationIds: [row.id],
        readAt: new Date().toISOString(),
      });
    }
    return;
  }

  const cardId = deriveCardId(activity);
  if (!cardId) return;

  const [currentActivity] = await dbSingleton
    .select({ feedVisible: activityEvents.feedVisible })
    .from(activityEvents)
    .where(eq(activityEvents.id, activity.id))
    .limit(1);
  if (!activity.feedVisible || currentActivity?.feedVisible === false) {
    return;
  }

  const ctx = await loadCardContext(dbSingleton, cardId);
  if (!ctx) return;

  const recipients = await resolveRecipients(dbSingleton, ctx, activity, { suppressUserId: options?.suppressUserId });
  if (recipients.size === 0) return;

  if (kind === "updated") {
    // For coalesced bursts the row may already exist. Emit an "updated" so the
    // client can bump the entry to the top of the list with the latest payload.
    const existing = await dbSingleton
      .select({ id: notifications.id, userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.activityId, activity.id));
    const suppressedUserIds = new Set([notificationActorSuppressionId(activity), options?.suppressUserId].filter((id): id is string => Boolean(id)));
    const suppressedExisting = existing.filter((row) => suppressedUserIds.has(row.userId));
    if (suppressedExisting.length > 0) {
      // Coalesced activity can be updated by a different actor inside the same
      // window; re-apply suppression so the current actor/triggering user does
      // not get their own completion notification resurfaced.
      await dbSingleton
        .delete(notifications)
        .where(inArray(notifications.id, suppressedExisting.map((row) => row.id)));
    }
    const visibleExisting = existing.filter((row) => !suppressedUserIds.has(row.userId));
    const existingUserIds = new Set(existing.map((row) => row.userId));
    const newRecipients = Array.from(recipients.entries()).filter(
      ([userId]) => !existingUserIds.has(userId),
    );
    if (newRecipients.length > 0) {
      const inserted = await dbSingleton
        .insert(notifications)
        .values(
          newRecipients.map(([userId, reason]) => ({
            userId,
            activityId: activity.id,
            cardId,
            listId: ctx.listId,
            boardId: ctx.boardId,
            workspaceId: ctx.workspaceId,
            reason,
          })),
        )
        .onConflictDoNothing({ target: [notifications.userId, notifications.activityId] })
        .returning();
      // Enrich all newly inserted rows in one multi-join query rather than one per
      // recipient — a busy card can fan out to dozens of watchers/assignees.
      const enriched = await enrichNotifications(dbSingleton, inserted.map((row) => row.id));
      for (const row of enriched) {
        emitToUser(row.userId, "notification:created", { notification: row });
      }
    }
    if (visibleExisting.length > 0) {
      // Re-fetch all existing rows so the emit carries the fresh activity payload.
      const ids = visibleExisting.map((row) => row.id);
      const enriched = await enrichNotifications(dbSingleton, ids);
      for (const row of enriched) {
        // Updated activity should re-surface the notification even if it was
        // previously marked read by the user.
        await dbSingleton
          .update(notifications)
          .set({ readAt: null })
          .where(eq(notifications.id, row.id));
        const refreshed = { ...row, readAt: null };
        emitToUser(refreshed.userId, "notification:updated", { notification: refreshed });
      }
    }
    return;
  }

  // kind === "created"
  const inserted = await dbSingleton
    .insert(notifications)
    .values(
      Array.from(recipients.entries()).map(([userId, reason]) => ({
        userId,
        activityId: activity.id,
        cardId,
        listId: ctx.listId,
        boardId: ctx.boardId,
        workspaceId: ctx.workspaceId,
        reason,
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.activityId] })
    .returning();

  if (inserted.length === 0) return;
  const enriched = await enrichNotifications(
    dbSingleton,
    inserted.map((row) => row.id),
  );
  for (const row of enriched) {
    emitToUser(row.userId, "notification:created", { notification: row });
  }
}

export async function notifyUserForActivity(params: {
  userId: string;
  activity: ActivityEvent;
  reason: NotificationReason;
}): Promise<void> {
  if (params.userId === notificationActorSuppressionId(params.activity) || !params.activity.feedVisible) return;

  const cardId = deriveCardId(params.activity);
  if (!cardId) return;
  const ctx = await loadCardContext(dbSingleton, cardId);
  if (!ctx) return;

  const [inserted] = await dbSingleton
    .insert(notifications)
    .values({
      userId: params.userId,
      activityId: params.activity.id,
      cardId,
      listId: ctx.listId,
      boardId: ctx.boardId,
      workspaceId: ctx.workspaceId,
      reason: params.reason,
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.activityId] })
    .returning();
  if (!inserted) return;

  const enriched = await enrichNotification(dbSingleton, inserted.id);
  if (enriched) emitToUser(params.userId, "notification:created", { notification: enriched });
}

export async function syncDirectNotificationForActivity(params: {
  userId: string | null;
  activity: ActivityEvent;
  reason: NotificationReason;
}): Promise<void> {
  const obsolete = await dbSingleton
    .delete(notifications)
    .where(and(
      eq(notifications.activityId, params.activity.id),
      params.userId ? sql`${notifications.userId} <> ${params.userId}` : sql`true`,
    ))
    .returning({ id: notifications.id, userId: notifications.userId });
  const readAt = new Date().toISOString();
  for (const row of obsolete) {
    emitToUser(row.userId, "notification:read", { notificationIds: [row.id], readAt });
  }

  if (!params.userId || params.userId === notificationActorSuppressionId(params.activity) || !params.activity.feedVisible) return;

  const cardId = deriveCardId(params.activity);
  if (!cardId) return;
  const ctx = await loadCardContext(dbSingleton, cardId);
  if (!ctx) return;

  const [row] = await dbSingleton
    .insert(notifications)
    .values({
      userId: params.userId,
      activityId: params.activity.id,
      cardId,
      listId: ctx.listId,
      boardId: ctx.boardId,
      workspaceId: ctx.workspaceId,
      reason: params.reason,
    })
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.activityId],
      set: { readAt: null, reason: params.reason },
    })
    .returning();
  if (!row) return;

  const enriched = await enrichNotification(dbSingleton, row.id);
  if (enriched) emitToUser(params.userId, "notification:updated", { notification: enriched });
}

async function enrichNotification(tx: Tx, notificationId: string): Promise<NotificationRow | null> {
  const rows = await enrichNotifications(tx, [notificationId]);
  return rows[0] ?? null;
}

export async function enrichNotifications(
  tx: Tx,
  ids: string[],
): Promise<NotificationRow[]> {
  if (ids.length === 0) return [];
  const baseRows = await tx
    .select({
      // notification columns
      id: notifications.id,
      userId: notifications.userId,
      activityId: notifications.activityId,
      cardId: notifications.cardId,
      checklistItemId: notifications.checklistItemId,
      listId: notifications.listId,
      boardId: notifications.boardId,
      workspaceId: notifications.workspaceId,
      reason: notifications.reason,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      // activity columns (re-select via inner join)
      activity_id: activityEvents.id,
      activity_actorId: activityEvents.actorId,
      activity_actorKind: activityEvents.actorKind,
      activity_apiKeyId: activityEvents.apiKeyId,
      activity_apiKeyName: activityEvents.apiKeyName,
      activity_supportSessionId: activityEvents.supportSessionId,
      activity_supportActorEmail: activityEvents.supportActorEmail,
      activity_boardId: activityEvents.boardId,
      activity_clientId: activityEvents.clientId,
      activity_workspaceId: activityEvents.workspaceId,
      activity_entityType: activityEvents.entityType,
      activity_entityId: activityEvents.entityId,
      activity_action: activityEvents.action,
      activity_payload: activityEvents.payload,
      activity_feedVisible: activityEvents.feedVisible,
      activity_coalesceKey: activityEvents.coalesceKey,
      activity_coalescedCount: activityEvents.coalescedCount,
      activity_coalescedUntil: activityEvents.coalescedUntil,
      activity_createdAt: activityEvents.createdAt,
      activity_updatedAt: activityEvents.updatedAt,
      actorName: sql<string | null>`
        case
          when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key')
          when ${activityEvents.actorKind} = 'system' then 'Kanera'
          else ${users.displayName}
        end
      `,
      actorAvatarUrl: sql<string | null>`case when ${activityEvents.actorKind} in ('apiKey', 'system') then null else ${users.avatarUrl} end`,
      cardTitle: cards.title,
      cardCompletedAt: cards.completedAt,
      cardArchivedAt: cards.archivedAt,
      cardDueDateLocalDate: cards.dueDateLocalDate,
      cardDueDateSlot: cards.dueDateSlot,
      cardDueDateTimezone: cards.dueDateTimezone,
      checklistItemText: cardChecklistItems.text,
      checklistItemDueDateLocalDate: cardChecklistItems.dueDateLocalDate,
      checklistItemDueDateSlot: cardChecklistItems.dueDateSlot,
      checklistItemDueDateTimezone: cardChecklistItems.dueDateTimezone,
      // Board membership is the access model, so the recipient's effective role on the notified
      // board is their board_member role (editor/observer) — except org admins, who hold implicit
      // full access and are treated as editors. A null role (no board_member row) means the
      // recipient can no longer act on the board's cards.
      viewerRole: sql<"editor" | "observer" | null>`
        case
          when ${notificationUsers.clientRole} in ('owner', 'admin') and ${notificationUsers.clientId} = ${workspaces.clientId}
            then 'editor'
          else ${boardMembers.role}
        end
      `,
      listName: lists.name,
      listColor: lists.color,
      listIcon: lists.icon,
      boardName: boards.name,
      boardIcon: boards.icon,
      boardIconColor: boards.iconColor,
      workspaceName: workspaces.name,
      workspaceIcon: workspaces.icon,
      workspaceAccentColor: workspaces.accentColor,
      workspaceClientId: workspaces.clientId,
    })
    .from(notifications)
    .leftJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .innerJoin(notificationUsers, eq(notificationUsers.id, notifications.userId))
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .leftJoin(cardChecklistItems, eq(cardChecklistItems.id, notifications.checklistItemId))
    .leftJoin(lists, eq(lists.id, notifications.listId))
    .leftJoin(boards, eq(boards.id, notifications.boardId))
    .innerJoin(workspaces, eq(workspaces.id, notifications.workspaceId))
    .leftJoin(
      boardMembers,
      and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, notifications.userId)),
    )
    .where(inArray(notifications.id, ids))
    // Tie-break on id so the display order matches the keyset page query in the
    // notifications routes (createdAt alone is not unique).
    .orderBy(desc(notifications.createdAt), desc(notifications.id));

  if (baseRows.length === 0) return [];

  // Attachments and comments are fetched in a follow-up pass so the join above
  // stays a single row per notification.
  const attachmentIds = baseRows
    .map((r) => {
      if (r.activity_action !== ACTIVITY_ACTION.ATTACHMENT_ADDED) return null;
      const payload = r.activity_payload as { attachmentId?: string };
      return payload?.attachmentId ?? null;
    })
    .filter((v): v is string => Boolean(v));
  const attachmentMap = new Map<string, NotificationCardThumbnail>();
  if (attachmentIds.length > 0) {
    const rows = await tx
      .select({
        id: cardAttachments.id,
        url: cardAttachments.url,
        thumbnailUrl: cardAttachments.thumbnailUrl,
        mimeType: cardAttachments.mimeType,
        fileName: cardAttachments.fileName,
      })
      .from(cardAttachments)
      .where(inArray(cardAttachments.id, attachmentIds));
    for (const row of rows) attachmentMap.set(row.id, row);
  }

  const commentIds = baseRows
    .filter((r) => r.activity_entityType === ACTIVITY_ENTITY_TYPE.COMMENT && r.activity_entityId)
    .map((r) => r.activity_entityId!);
  const commentBodyMap = new Map<string, string>();
  if (commentIds.length > 0) {
    const rows = await tx
      .select({ id: comments.id, body: comments.body })
      .from(comments)
      .where(inArray(comments.id, commentIds));
    for (const row of rows) commentBodyMap.set(row.id, row.body);
  }

  return baseRows.map((r) => {
    const attachmentId = r.activity_action === ACTIVITY_ACTION.ATTACHMENT_ADDED
      ? ((r.activity_payload as { attachmentId?: string })?.attachmentId ?? null)
      : null;
    const attachment = attachmentId ? attachmentMap.get(attachmentId) ?? null : null;
    const signedAttachment = attachment ? withSignedMedia(r.workspaceClientId, attachment) : null;
    const commentBody = r.activity_entityType === ACTIVITY_ENTITY_TYPE.COMMENT && r.activity_entityId
      ? commentBodyMap.get(r.activity_entityId) ?? null
      : null;
    // Comment notifications render markdown directly in the drawer, so pasted
    // inline media needs the same signed URL treatment as card descriptions.
    const signedCommentBody = signEmbeddedMediaUrls(commentBody, r.workspaceClientId);
    return withSignedMedia(r.workspaceClientId, {
      id: r.id,
      userId: r.userId,
      activityId: r.activityId,
      cardId: r.cardId,
      checklistItemId: r.checklistItemId,
      listId: r.listId,
      boardId: r.boardId,
      workspaceId: r.workspaceId,
      reason: r.reason,
      readAt: r.readAt,
      createdAt: r.createdAt,
      activity: r.activity_id
        ? {
          id: r.activity_id,
          actorId: r.activity_actorId!,
          actorKind: r.activity_actorKind!,
          apiKeyId: r.activity_apiKeyId,
          apiKeyName: r.activity_apiKeyName,
          supportSessionId: r.activity_supportSessionId,
          supportActorEmail: r.activity_supportActorEmail,
          boardId: r.activity_boardId,
          clientId: r.activity_clientId,
          workspaceId: r.activity_workspaceId!,
          entityType: r.activity_entityType!,
          entityId: r.activity_entityId!,
          action: r.activity_action!,
          payload: r.activity_payload!,
          feedVisible: r.activity_feedVisible!,
          coalesceKey: r.activity_coalesceKey,
          coalescedCount: r.activity_coalescedCount!,
          coalescedUntil: r.activity_coalescedUntil,
          createdAt: r.activity_createdAt!,
          updatedAt: r.activity_updatedAt!,
        }
        : null,
      actorName: r.actorName,
      actorAvatarUrl: r.actorAvatarUrl,
      cardTitle: r.cardTitle,
      cardCompletedAt: r.cardCompletedAt,
      cardArchivedAt: r.cardArchivedAt,
      cardDueDateLocalDate: r.cardDueDateLocalDate,
      cardDueDateSlot: r.cardDueDateSlot,
      cardDueDateTimezone: r.cardDueDateTimezone,
      checklistItemText: r.checklistItemText,
      checklistItemDueDateLocalDate: r.checklistItemDueDateLocalDate,
      checklistItemDueDateSlot: r.checklistItemDueDateSlot,
      checklistItemDueDateTimezone: r.checklistItemDueDateTimezone,
      viewerRole: r.viewerRole,
      listName: r.listName,
      listColor: r.listColor,
      listIcon: r.listIcon,
      boardName: r.boardName,
      boardIcon: r.boardIcon,
      boardIconColor: r.boardIconColor,
      workspaceName: r.workspaceName,
      workspaceIcon: r.workspaceIcon,
      workspaceAccentColor: r.workspaceAccentColor,
      attachment: signedAttachment,
      commentBody: signedCommentBody,
    });
  });
}

export async function clearOverdueNotificationsForCards(
  tx: Tx,
  cardIds: string[],
): Promise<void> {
  if (cardIds.length === 0) return;
  // Completing/archiving a card also clears any of its checklist-item overdue
  // notifications so they don't linger after the card is no longer active.
  const deleted = await tx
    .delete(notifications)
    .where(and(
      inArray(notifications.cardId, cardIds),
      inArray(notifications.reason, [NOTIFICATION_REASON.OVERDUE, NOTIFICATION_REASON.CHECKLIST_ITEM_OVERDUE]),
    ))
    .returning({ id: notifications.id, userId: notifications.userId });
  emitClearedNotifications(deleted);
}

export async function clearOverdueChecklistItemNotifications(
  tx: Tx,
  checklistItemIds: string[],
): Promise<void> {
  if (checklistItemIds.length === 0) return;
  const deleted = await tx
    .delete(notifications)
    .where(and(
      inArray(notifications.checklistItemId, checklistItemIds),
      eq(notifications.reason, NOTIFICATION_REASON.CHECKLIST_ITEM_OVERDUE),
    ))
    .returning({ id: notifications.id, userId: notifications.userId });
  emitClearedNotifications(deleted);
}

export async function clearNotificationsForRevokedAccess(
  tx: Tx,
  params: { userId: string; workspaceIds?: string[]; boardIds?: string[] },
): Promise<void> {
  const workspaceFilter = params.workspaceIds ? params.workspaceIds.filter(Boolean) : null;
  const boardFilter = params.boardIds ? params.boardIds.filter(Boolean) : null;
  if (workspaceFilter?.length === 0 && boardFilter?.length === 0) return;

  const scopeFilter = workspaceFilter || boardFilter
    ? or(
      workspaceFilter?.length ? inArray(notifications.workspaceId, workspaceFilter) : undefined,
      boardFilter?.length ? inArray(notifications.boardId, boardFilter) : undefined,
    )
    : sql`true`;

  // Access revocation is stronger than notification read state: once the user
  // leaves the workspace/org, old card links must disappear from their inbox.
  const deleted = await tx
    .delete(notifications)
    .where(and(
      eq(notifications.userId, params.userId),
      scopeFilter,
    ))
    .returning({ id: notifications.id, userId: notifications.userId });
  emitClearedNotifications(deleted);
}

export type DeletedNotificationRef = { id: string; userId: string };

export async function clearNotificationsForCards(tx: Tx, cardIds: string[]): Promise<DeletedNotificationRef[]> {
  const uniqueCardIds = [...new Set(cardIds.filter(Boolean))];
  if (uniqueCardIds.length === 0) return [];

  // Archiving is deletion-equivalent: remove the rows rather than marking them
  // read so they also disappear from the recipient's "All" notification feed.
  // The caller emits these refs only after its transaction commits; broadcasting
  // here would let clients refresh badge counts while the deleted rows are visible.
  return tx
    .delete(notifications)
    .where(inArray(notifications.cardId, uniqueCardIds))
    .returning({ id: notifications.id, userId: notifications.userId });
}

export function emitDeletedNotifications(deleted: DeletedNotificationRef[]): void {
  if (deleted.length === 0) return;
  const deletedIdsByUser = new Map<string, string[]>();
  for (const row of deleted) {
    const ids = deletedIdsByUser.get(row.userId) ?? [];
    ids.push(row.id);
    deletedIdsByUser.set(row.userId, ids);
  }
  for (const [userId, notificationIds] of deletedIdsByUser) {
    emitToUser(userId, "notification:deleted", { notificationIds });
  }
}

function emitClearedNotifications(deleted: { id: string; userId: string }[]): void {
  if (deleted.length === 0) return;
  const deletedIdsByUser = new Map<string, string[]>();
  for (const row of deleted) {
    const ids = deletedIdsByUser.get(row.userId) ?? [];
    ids.push(row.id);
    deletedIdsByUser.set(row.userId, ids);
  }

  const readAt = new Date().toISOString();
  for (const [userId, notificationIds] of deletedIdsByUser) {
    emitToUser(userId, "notification:read", { notificationIds, readAt });
  }
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const [row] = await dbSingleton
    .select({ c: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(
      eq(notifications.userId, userId),
      sql`${notifications.readAt} is null`,
      inboxVisibleNotificationCondition(),
    ));
  return row?.c ?? 0;
}
