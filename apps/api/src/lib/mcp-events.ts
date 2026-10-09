import { MCP_PRIORITY_EVENT_NAME, mcpEventData, type McpCardEventOccurrence, type McpEventArguments, type McpEventName, type McpPriorityEventOccurrence, type McpStoredEventArguments } from "@kanera/shared/dto";
import { cards, clientMembers, lists, mcpEventDeliveries, mcpEventSubscriptions, oauthClients, oauthGrants, users, workspaceApiKeys, type EventOutbox, type EventOutboxActor, type McpDeliveryError, type McpEventSubscription } from "@kanera/shared/schema";
import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { assertBoardAccess, assertCardAccess, assertWorkspaceAccess } from "./access.js";
import { AppError, badRequest, forbidden } from "./errors.js";
import { decryptSecret } from "./secrets.js";
import { McpCallbackError, mcpWebhookHeaders, postMcpWebhook, type McpWebhookRequest } from "./mcp-event-webhooks.js";
import { absoluteCardUrl } from "./wire-card.js";

// Bounded retry budget from the events draft ("3 to 5 attempts spread over no more than 10 to 15
// minutes"): attempts at 0s, 30s, 1.5m, 3.5m and 7.5m. An endpoint that is down for longer misses
// the occurrence; the subscriber recovers by reading current state, since no replay is offered.
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const DELIVERY_BATCH = 25;

export function mcpSubscriptionOwner(claims: AuthClaims) {
  if (claims.authKind !== "apiKey") throw forbidden("MCP subscriptions require an API or OAuth credential");
  if (claims.agentGrantId) return { principal: `grant:${claims.agentGrantId}:${claims.sub}`, ownerAgentGrantId: claims.agentGrantId, ownerApiKeyId: null, ownerServiceClientId: null };
  if (!claims.apiKeyId || !/^[0-9a-f-]{36}$/iu.test(claims.apiKeyId)) throw forbidden();
  return { principal: `${claims.oauthServiceClientId ? `service:${claims.oauthServiceClientId}:` : ""}key:${claims.apiKeyId}:${claims.sub}`, ownerApiKeyId: claims.apiKeyId, ownerAgentGrantId: null, ownerServiceClientId: claims.oauthServiceClientId ?? null };
}
export async function assertMcpEventAccess(claims: AuthClaims, name: McpEventName, args: McpStoredEventArguments) {
  // Your own queue is always readable (as in priorities.list), so there is nothing to check beyond
  // the live connection, which liveSubscriptionClaims re-verifies before every delivery.
  if (name === MCP_PRIORITY_EVENT_NAME) return;
  await assertCardEventAccess(claims, args as McpEventArguments);
}
async function assertCardEventAccess(claims: AuthClaims, args: McpEventArguments) {
  if (args.boardId) {
    const access = await assertBoardAccess(claims, args.boardId);
    if (access.workspaceId !== args.workspaceId) throw forbidden();
    // A board-wide stream would reveal unassigned cards to an assigned-items-only guest.
    if (access.assignedItemsOnly && !args.cardId) throw forbidden("this guest must subscribe to an assigned card");
    if (args.cardId) {
      const cardAccess = await assertCardAccess(claims, args.cardId);
      if (cardAccess.boardId !== args.boardId) throw forbidden();
    }
  } else await assertWorkspaceAccess(claims, args.workspaceId);
  if (args.listId) {
    // Lists belong to the workspace, so a board filter only narrows the shared list stream.
    const [list] = await db.select({ id: lists.id }).from(lists)
      .where(and(eq(lists.id, args.listId), eq(lists.workspaceId, args.workspaceId))).limit(1);
    if (!list) throw badRequest("listId must identify a list in the monitored workspace");
  }
}

// Reconstruct authority from live connection rows; stored issuance claims must never keep a
// revoked grant/key or removed user alive. The normal access helpers then recheck membership,
// tenant suspension, scope pins and per-card guest visibility before each outbound delivery.
async function liveSubscriptionClaims(sub: McpEventSubscription): Promise<AuthClaims> {
  const [user] = await db.select().from(users).where(eq(users.id, sub.userId)).limit(1);
  if (!user || user.deletedAt) throw forbidden();
  let claims: AuthClaims;
  if (sub.ownerApiKeyId) {
    const [key] = await db.select().from(workspaceApiKeys).where(eq(workspaceApiKeys.id, sub.ownerApiKeyId)).limit(1);
    if (!key || key.revokedAt || key.createdById !== user.id) throw forbidden();
    if (sub.ownerServiceClientId) {
      const [service] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, sub.ownerServiceClientId)).limit(1);
      if (!service || service.revokedAt || service.apiKeyId !== key.id) throw forbidden();
    }
    claims = { sub: user.id, cid: key.clientId ?? user.clientId, role: "member", authKind: "apiKey",
      apiKeyId: key.id, apiKeyKind: key.kind, apiKeyWorkspaceId: key.workspaceId ?? undefined, apiKeyScope: key.scope };
  } else {
    const [row] = await db.select({ grant: oauthGrants, client: oauthClients }).from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthGrants.clientId))
      .where(eq(oauthGrants.id, sub.ownerAgentGrantId!)).limit(1);
    if (!row || row.grant.revokedAt || row.client.revokedAt || row.grant.userId !== user.id) throw forbidden();
    claims = { sub: user.id, cid: row.grant.orgClientId, role: "member", authKind: "apiKey",
      agentGrantId: row.grant.id, apiKeyKind: "personal", apiKeyScope: row.grant.scopes.includes("kanera:write") ? "write" : "read" };
  }
  const [membership] = await db.select().from(clientMembers).where(and(eq(clientMembers.clientId, claims.cid), eq(clientMembers.userId, user.id))).limit(1);
  claims.role = membership?.clientRole ?? "member";
  return claims;
}

// Shared occurrence for every matching subscription; actor.self is filled in per subscriber.
type BaseOccurrence = Omit<McpCardEventOccurrence, "data"> & { data: Omit<McpCardEventOccurrence["data"], "actor"> };
async function occurrenceFor(event: EventOutbox): Promise<BaseOccurrence | null> {
  const names = { "card:created": "card.created", "card:updated": "card.updated", "card:moved": "card.moved", "comment:created": "comment.created" } as const;
  const name = names[event.eventType as keyof typeof names];
  if (!name || !event.boardId) return null;
  const payload = event.payload as unknown as Record<string, unknown>;
  const card = payload.card as { id?: string; title?: string; listId?: string; organisationKey?: string; key?: string } | undefined;
  const cardId = typeof payload.cardId === "string" ? payload.cardId : card?.id;
  if (!cardId) return null;
  const comment = payload.comment as { id?: string; body?: string } | undefined;
  // A bounded summary avoids shipping descriptions, attachment URLs, or oversized comment bodies.
  // The matching read tools provide full current content when the task needs it.
  const [current] = card?.key ? [card] : await db.select({ key: cards.key, organisationKey: cards.organisationKey, listId: cards.listId }).from(cards).where(eq(cards.id, cardId)).limit(1);
  const data = mcpEventData.omit({ actor: true }).parse({
    workspaceId: event.workspaceId, boardId: event.boardId, cardId,
    ...(card?.title !== undefined ? { title: card.title.slice(0, 2000) } : {}),
    // card:moved carries no card object; its destination travels as toListId.
    ...(card?.listId ? { listId: card.listId } : typeof payload.toListId === "string" ? { listId: payload.toListId } : current?.listId ? { listId: current.listId } : {}),
    ...(name === "card.moved" && typeof payload.fromListId === "string" ? { fromListId: payload.fromListId } : {}),
    ...(typeof payload.prevPosition === "string" ? { prevPosition: payload.prevPosition } : {}),
    ...(comment ? { commentId: comment.id, text: (comment.body ?? "").slice(0, 8000) } : {}),
    ...(current?.key && current.organisationKey ? { url: absoluteCardUrl(current.organisationKey, current.key) } : {}),
  });
  return { eventId: `evt_${event.id}`, name, timestamp: event.occurredAt.toISOString(), data, cursor: null };
}
// Service OAuth connections share a backing key but own subscriptions separately, so a write made
// with the bare key (or another service client on it) must not read as the subscriber's own.
function isSelf(actor: EventOutboxActor | null, sub: McpEventSubscription) {
  if (!actor) return false;
  if (sub.ownerAgentGrantId) return actor.agentGrantId === sub.ownerAgentGrantId;
  if (!sub.ownerApiKeyId || actor.apiKeyId !== sub.ownerApiKeyId) return false;
  return (actor.serviceClientId ?? null) === (sub.ownerServiceClientId ?? null);
}
export async function loadActiveMcpSubscriptionsByWorkspace(workspaceIds: string[]) {
  const grouped = new Map<string, McpEventSubscription[]>();
  if (!workspaceIds.length) return grouped;
  const rows = await db.select().from(mcpEventSubscriptions).where(and(
    inArray(mcpEventSubscriptions.workspaceId, workspaceIds), gt(mcpEventSubscriptions.expiresAt, new Date()),
  ));
  for (const row of rows) {
    // The IN filter already excludes user-addressed (priorities.changed) rows; this narrows the type.
    if (!row.workspaceId) continue;
    const subscriptions = grouped.get(row.workspaceId) ?? [];
    subscriptions.push(row);
    grouped.set(row.workspaceId, subscriptions);
  }
  return grouped;
}
export async function enqueueMcpEventDeliveries(event: EventOutbox, preloadedSubscriptions?: McpEventSubscription[]) {
  // Skip before enrichment on the overwhelmingly common non-catalog outbox events.
  if (!["card:created", "card:updated", "card:moved", "comment:created"].includes(event.eventType)) return;
  const subscriptions = preloadedSubscriptions ?? await db.select().from(mcpEventSubscriptions).where(and(
    eq(mcpEventSubscriptions.workspaceId, event.workspaceId),
    eq(mcpEventSubscriptions.name, event.eventType.replace(":", ".")),
    gt(mcpEventSubscriptions.expiresAt, new Date()), lte(mcpEventSubscriptions.startsAt, event.occurredAt),
  ));
  if (!subscriptions.length) return;
  const occurrence = await occurrenceFor(event);
  if (!occurrence) return;
  const matching = subscriptions.filter((sub) => {
    if (sub.name !== occurrence.name || sub.expiresAt <= new Date() || sub.startsAt > event.occurredAt) return false;
    // The name matched a card event, so these are the workspace/board/list/card filter arguments.
    const args = sub.arguments as McpEventArguments;
    return (!args.boardId || args.boardId === event.boardId)
      && (!args.cardId || args.cardId === occurrence.data.cardId)
      // Match the occurrence snapshot, not the live card: it may already have left this list again
      // by the time the outbox drains. List watchers only want arrivals and departures, not reorders.
      && (!args.listId || occurrence.name !== "card.moved"
        || occurrence.data.fromListId !== occurrence.data.listId)
      && (!args.listId || args.listId === occurrence.data.listId
        || (occurrence.name === "card.moved" && args.listId === occurrence.data.fromListId));
  });
  if (!matching.length) return;
  // Rows published before actor capture existed carry no actor; they are reported as system.
  const actor = event.actor ?? null;
  // The uniqueness key makes outbox retry/crash recovery idempotent, retaining the same eventId.
  await db.insert(mcpEventDeliveries).values(matching.map((sub) => ({
    subscriptionId: sub.id, outboxEventId: event.id,
    payload: { ...occurrence, data: { ...occurrence.data, actor: actorFor(actor, sub) } },
  }))).onConflictDoNothing();
}
function actorFor(actor: EventOutboxActor | null, sub: McpEventSubscription) {
  return { kind: actor?.kind ?? "system", userId: actor?.userId ?? null, self: isSelf(actor, sub) };
}

/**
 * Queue a `priorities.changed` occurrence for this person's own subscriptions to their "Up next" queue.
 *
 * Called from `emitCardPriorityInvalidated`, so it fires on exactly the changes the web app refetches
 * on — direct add/move/remove and indirect completion, archive and reassignment of a queued card.
 * The queue spans workspaces and therefore never enters the workspace `event_outbox` (see that
 * emitter), so unlike card events these rows are written straight after the caller's commit rather
 * than from the outbox drain. A crash in between loses the occurrence, the same exposure as the
 * inline realtime ping; subscribers converge on their next priorities.list read, and no replay is
 * promised anyway. Delivery still re-verifies the subscribing connection is live.
 */
export async function enqueuePriorityQueueMcpEvents(targetUserId: string, actor: EventOutboxActor | null): Promise<void> {
  const now = new Date();
  const subscriptions = await db.select().from(mcpEventSubscriptions).where(and(
    // userId too, though the scope check already pins target to subscriber: a queue owner's change
    // must never reach a subscription that some other user holds.
    eq(mcpEventSubscriptions.targetUserId, targetUserId), eq(mcpEventSubscriptions.userId, targetUserId),
    eq(mcpEventSubscriptions.name, MCP_PRIORITY_EVENT_NAME),
    gt(mcpEventSubscriptions.expiresAt, now), lte(mcpEventSubscriptions.startsAt, now),
  ));
  if (!subscriptions.length) return;
  const eventId = `evt_${crypto.randomUUID()}`;
  await db.insert(mcpEventDeliveries).values(subscriptions.map((sub) => ({
    subscriptionId: sub.id, outboxEventId: null,
    payload: {
      eventId, name: MCP_PRIORITY_EVENT_NAME, timestamp: now.toISOString(), cursor: null,
      data: { targetUserId, actor: actorFor(actor, sub) },
    } satisfies McpPriorityEventOccurrence,
  })));
}

// Map a failed attempt to the draft's fixed deliveryStatus.lastError categories. Redirects are
// never followed, so a 3xx is reported with client errors as an endpoint misconfiguration.
function deliveryErrorFor(status: number | null, error: unknown): McpDeliveryError {
  if (status !== null) return status >= 500 ? "http_5xx" : "http_4xx";
  const reason = error instanceof McpCallbackError ? error.reason : "connection_refused";
  return reason === "timeout" || reason === "tls_error" ? reason : "connection_refused";
}

// Why a delivery was not posted. `skipped` says nothing about the endpoint (no attempt was made),
// `rejected` is a permanent endpoint answer for this occurrence only, `retry` keeps the row queued.
type DeliveryOutcome =
  | { kind: "skipped" }
  | { kind: "delivered"; status: number }
  | { kind: "rejected"; status: number }
  | { kind: "retry"; status: number | null; error?: unknown };

// Authority is resolved once per subscription for the batch: every row of a board-wide stream
// shares the same connection, membership and board checks, and only the card check is per row.
type SubscriptionGate = { sub: McpEventSubscription; claims: AuthClaims | null };
async function gateFor(sub: McpEventSubscription): Promise<SubscriptionGate> {
  if (sub.expiresAt <= new Date()) return { sub, claims: null };
  try {
    const claims = await liveSubscriptionClaims(sub);
    await assertMcpEventAccess(claims, sub.name as McpEventName, sub.arguments);
    return { sub, claims };
  } catch (error) {
    if (!(error instanceof AppError && error.statusCode < 500)) throw error;
    // Lost connection, membership or scope access ends the subscription; the client learns on refresh.
    await db.update(mcpEventSubscriptions).set({ expiresAt: new Date() }).where(eq(mcpEventSubscriptions.id, sub.id));
    return { sub, claims: null };
  }
}

async function attemptDelivery(delivery: typeof mcpEventDeliveries.$inferSelect, gate: SubscriptionGate, send: McpWebhookRequest): Promise<DeliveryOutcome> {
  const { sub, claims } = gate;
  if (!claims || new Date(delivery.payload.timestamp) < sub.startsAt) return { kind: "skipped" };
  // Queue events name no card, and only ever describe the subscriber's own queue (a database check).
  if (delivery.payload.name !== MCP_PRIORITY_EVENT_NAME) {
    try {
      // Authorize the card's current board: it may have moved after this event was queued.
      // Losing one card must not expire an otherwise valid workspace/board-wide subscription.
      await assertCardAccess(claims, delivery.payload.data.cardId);
    } catch (error) {
      if (!(error instanceof AppError && error.statusCode < 500)) throw error;
      return { kind: "skipped" };
    }
  }
  const body = JSON.stringify(delivery.payload);
  if (Buffer.byteLength(body) > 262_144) return { kind: "skipped" };
  const secrets = [decryptSecret(sub.encryptedSecret)];
  if (sub.previousEncryptedSecret && sub.secretRotationUntil && sub.secretRotationUntil > new Date()) secrets.push(decryptSecret(sub.previousEncryptedSecret));
  let status: number;
  try { status = (await send(sub.url, body, mcpWebhookHeaders(delivery.payload.eventId, sub.id, body, secrets))).status; }
  catch (error) { return { kind: "retry", status: null, error }; /* Same event ID, fresh signing time next attempt. */ }
  if (status >= 200 && status < 300) return { kind: "delivered", status };
  // 410/413 reject this occurrence only; 408/425/429 and 5xx are transient (425 can mean subscribe
  // routing has not propagated yet).
  if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return { kind: "rejected", status };
  return { kind: "retry", status };
}

export async function processMcpEventDeliveries(send: McpWebhookRequest = postMcpWebhook, log?: FastifyBaseLogger): Promise<boolean> {
  const due = await db.transaction(async (tx) => {
    const rows = await tx.select().from(mcpEventDeliveries).where(and(
      lte(mcpEventDeliveries.nextAttemptAt, new Date()),
      inArray(mcpEventDeliveries.status, ["queued", "delivering"]),
    )).orderBy(asc(mcpEventDeliveries.createdAt), asc(mcpEventDeliveries.id)).limit(DELIVERY_BATCH).for("update", { skipLocked: true });
    if (!rows.length) return [];
    return tx.update(mcpEventDeliveries).set({ status: "delivering", nextAttemptAt: new Date(Date.now() + 120_000), attempts: sql`${mcpEventDeliveries.attempts} + 1` })
      .where(inArray(mcpEventDeliveries.id, rows.map((row) => row.id))).returning();
  });
  if (!due.length) return false;
  const subscriptionIds = [...new Set(due.map((delivery) => delivery.subscriptionId))];
  const subscriptions = await db.select().from(mcpEventSubscriptions).where(inArray(mcpEventSubscriptions.id, subscriptionIds));
  const gates = new Map<string, SubscriptionGate>();
  await Promise.all(subscriptions.map(async (sub) => {
    try { gates.set(sub.id, await gateFor(sub)); }
    catch (err) { log?.error({ err, subscriptionId: sub.id }, "mcp subscription authorization failed"); }
  }));
  // One subscription's occurrences are posted one at a time, oldest first, so a list watcher sees a
  // card arrive before it departs; up to five subscriptions deliver concurrently. Order is best
  // effort: a row that fails and retries is posted after occurrences that succeeded in the meantime.
  const bySubscription = new Map<string, typeof due>();
  for (const delivery of due.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    bySubscription.set(delivery.subscriptionId, [...(bySubscription.get(delivery.subscriptionId) ?? []), delivery]);
  }
  const streams = [...bySubscription.values()];
  for (let i = 0; i < streams.length; i += 5) {
    await Promise.all(streams.slice(i, i + 5).map(async (stream) => {
      for (const delivery of stream) {
        // A failure here must stay local to this row: the sweep that called us also drains the
        // regular webhook queue, and a corrupt secret or DB hiccup on one subscription must not
        // starve every other endpoint. The lease above makes the row retry later on its own.
        try {
          const gate = gates.get(delivery.subscriptionId);
          if (!gate) continue;
          const outcome = await attemptDelivery(delivery, gate, send);
          await recordOutcome(delivery, gate.sub, outcome);
        } catch (err) {
          log?.error({ err, deliveryId: delivery.id, subscriptionId: delivery.subscriptionId }, "mcp event delivery failed");
        }
      }
    }));
  }
  return due.length === DELIVERY_BATCH;
}

async function recordOutcome(delivery: typeof mcpEventDeliveries.$inferSelect, sub: McpEventSubscription, outcome: DeliveryOutcome) {
  const now = new Date();
  const exhausted = outcome.kind === "retry" && delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  await db.update(mcpEventDeliveries).set({
    status: outcome.kind === "delivered" ? "success" : outcome.kind === "retry" && !exhausted ? "queued" : "failed",
    responseStatus: "status" in outcome ? outcome.status : null,
    updatedAt: now,
    nextAttemptAt: new Date(now.getTime() + 2 ** (delivery.attempts - 1) * RETRY_BASE_MS),
  }).where(eq(mcpEventDeliveries.id, delivery.id));
  // Surfaced to the client as deliveryStatus on its next refresh. Only real endpoint attempts
  // count; skipped occurrences (lost access, oversize) say nothing about the endpoint's health.
  if (outcome.kind === "delivered") {
    await db.update(mcpEventSubscriptions).set({ lastDeliveryAt: now, lastError: null, failedSince: null }).where(eq(mcpEventSubscriptions.id, sub.id));
  } else if (outcome.kind !== "skipped") {
    await db.update(mcpEventSubscriptions).set({
      lastError: deliveryErrorFor(outcome.status, "error" in outcome ? outcome.error : undefined),
      failedSince: sql`coalesce(${mcpEventSubscriptions.failedSince}, ${now})`,
    }).where(eq(mcpEventSubscriptions.id, sub.id));
  }
}
export async function cleanupMcpEvents() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60_000);
  await db.delete(mcpEventDeliveries).where(and(inArray(mcpEventDeliveries.status, ["success", "failed"]), lt(mcpEventDeliveries.updatedAt, cutoff)));
  await db.delete(mcpEventSubscriptions).where(lt(mcpEventSubscriptions.expiresAt, cutoff));
}
