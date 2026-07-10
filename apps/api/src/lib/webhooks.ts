import {
  clients,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
  type EventOutbox,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookPayload,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, lt, lte, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { createHmac } from "node:crypto";
import { db } from "../db.js";
import { env } from "../env.js";
import { isPaidTier } from "./entitlements.js";
import { decryptSecret } from "./secrets.js";
import { startSweepScheduler, type SweepScheduler } from "./sweep-scheduler.js";
import { assertResolvedHostAllowed } from "./ssrf.js";

const MAX_ATTEMPTS = 8;
const DELIVERY_LIMIT = 25;
const RESPONSE_BODY_LIMIT = 2000;
// Cap how long a single delivery can hold an outbound connection so a slow/hanging endpoint
// can't tie up the delivery worker (which runs deliveries in small concurrent chunks).
const DELIVERY_TIMEOUT_MS = 10_000;
// Circuit breaker: a single outbox event fans out one delivery row per matching endpoint.
// Endpoint counts are bounded by workspace config in practice, so this only guards against
// a pathological/misconfigured workspace blowing up one event's enqueue.
const ENDPOINT_FANOUT_LIMIT = 1000;
// Run a few deliveries concurrently so one slow endpoint can't stall the whole batch,
// while staying small enough to bound outbound connections.
const DELIVERY_CONCURRENCY = 5;
// A claimed batch may take several timeout windows to drain because delivery is chunked.
// Keep the lease comfortably above the worst normal batch duration so another worker
// only reclaims rows after a crash or severe stall, not while later chunks are waiting.
const DELIVERY_LEASE_MS = 2 * 60_000;
const SUCCESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function deliveryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.max(0, attempts - 1) * 30_000);
}

function responseExcerpt(value: string): string {
  return value.slice(0, RESPONSE_BODY_LIMIT);
}

function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function eventTypesMatch(configured: string[], eventType: string): boolean {
  return configured.length === 0 || configured.includes(eventType);
}

function workspaceIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { workspaceId?: unknown }).workspaceId;
  return typeof value === "string" ? value : null;
}

function cardIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { cardId?: unknown }).cardId;
  return typeof value === "string" ? value : null;
}

// Load enabled endpoints for a set of workspaces in one query, grouped by workspace, so a drain
// processing many events for the same workspace(s) reuses one SELECT instead of one per event.
export async function loadEnabledEndpointsByWorkspace(workspaceIds: string[]): Promise<Map<string, WebhookEndpoint[]>> {
  const byWorkspace = new Map<string, WebhookEndpoint[]>();
  if (workspaceIds.length === 0) return byWorkspace;
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(and(inArray(webhookEndpoints.workspaceId, workspaceIds), eq(webhookEndpoints.enabled, true)))
    .limit(ENDPOINT_FANOUT_LIMIT * workspaceIds.length);
  for (const endpoint of rows) {
    const list = byWorkspace.get(endpoint.workspaceId) ?? [];
    list.push(endpoint);
    byWorkspace.set(endpoint.workspaceId, list);
  }
  return byWorkspace;
}

export async function enqueueWebhookDeliveriesForOutboxEvent(
  event: EventOutbox,
  // When a caller has already loaded the workspace's enabled endpoints for this drain, reuse them
  // instead of issuing a per-event SELECT. Callers without the cache keep the single-event query path.
  preloadedEndpoints?: WebhookEndpoint[],
): Promise<void> {
  const endpoints = preloadedEndpoints
    ?? (await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.workspaceId, event.workspaceId), eq(webhookEndpoints.enabled, true)))
      .limit(ENDPOINT_FANOUT_LIMIT));
  const matching = endpoints.filter((endpoint) => eventTypesMatch(endpoint.eventTypes, String(event.eventType)));
  if (matching.length === 0) return;

  // Defense-in-depth: webhooks are a paid-only feature. Downgrade disables endpoints, but skip
  // delivery for a hosted free org here too so a stray enabled endpoint never fires. Only queried
  // when there is actually something to deliver; self-hosted always proceeds.
  if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
    const [org] = await db
      .select({ billingStatus: clients.billingStatus })
      .from(workspaces)
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(eq(workspaces.id, event.workspaceId))
      .limit(1);
    if (!isPaidTier(org?.billingStatus)) return;
  }

  const body = event.payload as unknown;
  const webhookPayload: WebhookPayload = {
    id: event.id,
    type: String(event.eventType),
    workspaceId: event.workspaceId,
    ...(event.boardId ? { boardId: event.boardId } : {}),
    ...(cardIdFromPayload(body) ? { cardId: cardIdFromPayload(body)! } : {}),
    occurredAt: event.occurredAt.toISOString(),
    data: body,
  };

  await db
    .insert(webhookDeliveries)
    .values(
      matching.map((endpoint) => ({
        endpointId: endpoint.id,
        workspaceId: event.workspaceId,
        outboxEventId: event.id,
        eventType: String(event.eventType),
        payload: {
          ...webhookPayload,
          workspaceId: workspaceIdFromPayload(body) ?? webhookPayload.workspaceId,
        },
      })),
    )
    .onConflictDoNothing();
}

export async function deliverWebhookDelivery(
  delivery: WebhookDelivery,
  endpoint?: WebhookEndpoint,
): Promise<WebhookDelivery> {
  const target = endpoint
    ?? (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, delivery.endpointId)).limit(1))[0];
  if (!target || !target.enabled) {
    const now = new Date();
    const [updated] = await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        lastAttemptAt: now,
        lastError: target ? "webhook endpoint disabled" : "webhook endpoint not found",
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, delivery.id))
      .returning();
    return updated ?? delivery;
  }

  const now = new Date();
  const attempts = delivery.attempts + 1;
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const secret = decryptSecret(target.encryptedSecret);
  const signature = signPayload(secret, timestamp, body);

  try {
    // Re-check the resolved target right before sending: the URL passed create-time validation,
    // but DNS could have been repointed at an internal address since (rebinding). Also bound the
    // request with a timeout so a hanging endpoint can't stall the delivery worker.
    await assertResolvedHostAllowed(target.url);
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Kanera-Webhooks/1.0",
        "X-Kanera-Event-Id": delivery.payload.id,
        "X-Kanera-Timestamp": timestamp,
        "X-Kanera-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    const responseBody = responseExcerpt(await response.text().catch(() => ""));
    const success = response.status >= 200 && response.status < 300;
    const [updated] = await db
      .update(webhookDeliveries)
      .set({
        status: success ? "success" : attempts >= MAX_ATTEMPTS ? "failed" : "queued",
        attempts,
        lastAttemptAt: now,
        responseStatus: response.status,
        responseBody,
        lastError: success ? null : `HTTP ${response.status}`,
        deliveredAt: success ? now : null,
        nextAttemptAt: success ? now : new Date(now.getTime() + deliveryDelayMs(attempts)),
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, delivery.id))
      .returning();
    return updated!;
  } catch (err) {
    const [updated] = await db
      .update(webhookDeliveries)
      .set({
        status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
        attempts,
        lastAttemptAt: now,
        lastError: Error.isError(err) ? err.message : "delivery failed",
        nextAttemptAt: new Date(now.getTime() + deliveryDelayMs(attempts)),
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, delivery.id))
      .returning();
    return updated!;
  }
}

export interface WebhookDeliveryResult {
  // True when we claimed a full batch, signalling more deliveries are likely due. The
  // scheduler uses this to drain the backlog immediately instead of waiting a poll window.
  drainedFull: boolean;
}

export async function processWebhookDeliveries(log?: FastifyBaseLogger): Promise<WebhookDeliveryResult> {
  const due = await claimWebhookDeliveries();

  // Deliver in fixed-size concurrent chunks: a single slow/timing-out endpoint no longer
  // blocks every other due delivery behind it. allSettled keeps one failure from rejecting
  // the chunk; deliverWebhookDelivery already persists failures, so we only log here.
  for (let i = 0; i < due.length; i += DELIVERY_CONCURRENCY) {
    const chunk = due.slice(i, i + DELIVERY_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((delivery) => deliverWebhookDelivery(delivery)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        log?.error({ err: result.reason, deliveryId: chunk[index]!.id }, "webhook delivery failed");
      }
    });
  }

  return { drainedFull: due.length >= DELIVERY_LIMIT };
}

export async function cleanupWebhookDeliveries(log?: FastifyBaseLogger, now = new Date()): Promise<number> {
  const successCutoff = new Date(now.getTime() - SUCCESS_RETENTION_MS);
  const failedCutoff = new Date(now.getTime() - FAILED_RETENTION_MS);
  // Only terminal rows are eligible: queued and leased deliveries must survive cleanup so
  // delayed retries and crash recovery cannot silently lose customer events.
  const deleted = await db
    .delete(webhookDeliveries)
    .where(or(
      and(eq(webhookDeliveries.status, "success"), lt(webhookDeliveries.updatedAt, successCutoff)),
      and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.updatedAt, failedCutoff)),
    ))
    .returning({ id: webhookDeliveries.id });
  if (deleted.length > 0) log?.info({ deletedCount: deleted.length }, "purged old webhook delivery rows");
  return deleted.length;
}

export function startWebhookDeliveryScheduler(options: { log?: FastifyBaseLogger; intervalMs?: number } = {}): SweepScheduler {
  const intervalMs = options.intervalMs ?? 10_000;
  // Single-flight + reschedule-after-completion via the shared scheduler. When a run drains
  // a full batch we continue immediately so a backlog isn't paced one batch per poll window.
  // The returned `trigger` lets the outbox dispatcher wake delivery the moment it enqueues
  // new rows, instead of leaving them to wait up to a full interval.
  const delivery = startSweepScheduler({
    name: "webhook-delivery",
    task: () => processWebhookDeliveries(options.log),
    nextDelayMs: (result) => (result?.drainedFull ? 0 : intervalMs),
    log: options.log,
  });
  const cleanup = startSweepScheduler({
    name: "webhook-delivery-cleanup",
    task: () => cleanupWebhookDeliveries(options.log),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: options.log,
  });
  return {
    trigger: delivery.trigger,
    stop: async () => {
      await Promise.all([delivery.stop(), cleanup.stop()]);
    },
  };
}

async function claimWebhookDeliveries(): Promise<WebhookDelivery[]> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const rows = await tx
      .select()
      .from(webhookDeliveries)
      .where(and(
        lte(webhookDeliveries.nextAttemptAt, now),
        or(eq(webhookDeliveries.status, "queued"), eq(webhookDeliveries.status, "delivering")),
      ))
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(DELIVERY_LIMIT)
      .for("update", { skipLocked: true });

    if (rows.length === 0) return [];

    return tx
      .update(webhookDeliveries)
      // The future nextAttemptAt is the lease expiry. If this process dies after claiming,
      // another scheduler can safely pick the delivery back up once the lease is due.
      .set({ status: "delivering", nextAttemptAt: leaseExpiresAt, updatedAt: now })
      .where(inArray(webhookDeliveries.id, rows.map((row) => row.id)))
      .returning();
  });
}
