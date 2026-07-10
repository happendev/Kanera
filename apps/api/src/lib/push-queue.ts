import { PUSH_QUEUE_STATUS, pushQueue, pushSubscriptions, type PushQueue, type PushQueuePayload, type PushQueueReason } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ContentEncoding } from "web-push";
import type { Db } from "../db.js";
import { startSweepScheduler } from "./sweep-scheduler.js";
import { DEFAULT_PUSH_TTL, ensureWebPushReady, handleSubscriptionError, toPushSubscription, webPushClient } from "./web-push.js";

const MAX_RETRIES = 3;
const SWEEP_BATCH_SIZE = 50;
const SWEEP_INTERVAL_MS = 30_000; // 30 seconds
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 360 minutes
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 10,080 minutes
const DEFAULT_PUSH_ICON = "/assets/favicon/android-chrome-192x192.png";
const DEFAULT_PUSH_BADGE = "/assets/favicon/notification-badge.png";

export interface PushQueueDeps {
  db: Db;
  log: FastifyBaseLogger;
}

export interface EnqueuePushArgs {
  clientId: string;
  userId: string;
  reason: PushQueueReason;
  payload: PushQueuePayload;
}

export async function enqueuePush(db: Db, args: EnqueuePushArgs): Promise<PushQueue> {
  const [row] = await db
    .insert(pushQueue)
    .values({
      clientId: args.clientId,
      userId: args.userId,
      reason: args.reason,
      payload: withDefaultPushBranding(args.payload),
      status: PUSH_QUEUE_STATUS.queued,
    })
    .returning();
  return row!;
}

export async function enqueuePushImmediate(db: Db, args: EnqueuePushArgs): Promise<PushQueue> {
  const [row] = await db
    .insert(pushQueue)
    .values({
      clientId: args.clientId,
      userId: args.userId,
      reason: args.reason,
      payload: withDefaultPushBranding(args.payload),
      status: PUSH_QUEUE_STATUS.immediate,
    })
    .returning();
  return row!;
}

/**
 * Deliver a single push queue row to all active subscriptions for the user.
 * Returns a summary of what happened.
 */
export async function deliverPushRow(db: Db, row: PushQueue): Promise<{ delivered: number; disabled: number; failed: number }> {
  await ensureWebPushReady(row.clientId);

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.clientId, row.clientId),
        eq(pushSubscriptions.userId, row.userId),
        isNull(pushSubscriptions.disabledAt),
      ),
    );

  const result = { delivered: 0, disabled: 0, failed: 0 };
  const ttl = (row.payload as PushQueuePayload).ttl ?? DEFAULT_PUSH_TTL;
  const payload = JSON.stringify(row.payload);

  for (const sub of subscriptions) {
    try {
      await webPushClient.sendNotification(
        toPushSubscription(sub),
        payload,
        { TTL: ttl, ...(sub.contentEncoding ? { contentEncoding: sub.contentEncoding as ContentEncoding } : {}) },
      );
      result.delivered += 1;
      await clearSubscriptionErrors(db, sub);
    } catch (err) {
      const outcome = await handleSubscriptionError(db, sub, err);
      if (outcome === "disabled") {
        result.disabled += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}

function withDefaultPushBranding(payload: PushQueuePayload): PushQueuePayload {
  return {
    ...payload,
    icon: payload.icon ?? DEFAULT_PUSH_ICON,
    badge: payload.badge ?? DEFAULT_PUSH_BADGE,
  };
}

async function clearSubscriptionErrors(db: Db, sub: { id: string; failureCount: number; lastError: string | null; disabledAt: Date | null }) {
  if (sub.failureCount > 0 || sub.lastError !== null || sub.disabledAt !== null) {
    await db
      .update(pushSubscriptions)
      .set({ failureCount: 0, lastError: null, disabledAt: null, updatedAt: new Date() })
      .where(eq(pushSubscriptions.id, sub.id));
  }
}

export async function runPushQueueSweep({ db, log }: PushQueueDeps): Promise<number> {
  const rows = await claimQueuedPushes(db);
  if (rows.length === 0) return 0;

  for (const row of rows) {
    try {
      const result = await deliverPushRow(db, row);
      const allFailed = result.delivered === 0 && (result.disabled > 0 || result.failed > 0);
      if (allFailed && row.retries + 1 < MAX_RETRIES) {
        // Return to queue for retry if nothing was delivered
        await db
          .update(pushQueue)
          .set({
            status: PUSH_QUEUE_STATUS.queued,
            retries: row.retries + 1,
            lastError: `delivered=0 disabled=${result.disabled} failed=${result.failed}`,
            updatedAt: new Date(),
          })
          .where(eq(pushQueue.id, row.id));
      } else {
        await db
          .update(pushQueue)
          .set({
            status: allFailed ? PUSH_QUEUE_STATUS.error : PUSH_QUEUE_STATUS.success,
            sentAt: new Date(),
            lastError: allFailed ? `delivered=0 disabled=${result.disabled} failed=${result.failed}` : null,
            retries: row.retries + (allFailed ? 1 : 0),
            updatedAt: new Date(),
          })
          .where(eq(pushQueue.id, row.id));
      }
      log.info({ pushQueueId: row.id, userId: row.userId, reason: row.reason, ...result }, "push queue row processed");
    } catch (err) {
      const retries = row.retries + 1;
      await db
        .update(pushQueue)
        .set({
          status: retries >= MAX_RETRIES ? PUSH_QUEUE_STATUS.error : PUSH_QUEUE_STATUS.queued,
          retries,
          lastError: Error.isError(err) ? err.message : String(err),
          updatedAt: new Date(),
        })
        .where(eq(pushQueue.id, row.id));
      log.error({ err, pushQueueId: row.id, retries }, "push queue delivery failed");
    }
  }

  return rows.length;
}

export async function runPushQueueCleanup({ db, log }: PushQueueDeps, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const deleted = await db.delete(pushQueue).where(lt(pushQueue.createdAt, cutoff)).returning({ id: pushQueue.id });
  if (deleted.length > 0) log.info({ deletedCount: deleted.length }, "purged old push queue rows");
  return deleted.length;
}

export function startPushQueueScheduler(deps: PushQueueDeps): () => Promise<void> {
  const sweep = startSweepScheduler({
    name: "push-queue",
    task: () => runPushQueueSweep(deps),
    nextDelayMs: SWEEP_INTERVAL_MS,
    log: deps.log,
  });
  const cleanup = startSweepScheduler({
    name: "push-queue-cleanup",
    task: () => runPushQueueCleanup(deps),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: deps.log,
  });
  return async () => {
    await Promise.all([sweep.stop(), cleanup.stop()]);
  };
}

async function claimQueuedPushes(db: Db): Promise<PushQueue[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(pushQueue)
      .where(and(eq(pushQueue.status, PUSH_QUEUE_STATUS.queued), lt(pushQueue.retries, MAX_RETRIES)))
      .orderBy(pushQueue.createdAt)
      .limit(SWEEP_BATCH_SIZE)
      .for("update", { skipLocked: true });

    if (rows.length === 0) return [];

    await tx
      .update(pushQueue)
      .set({ status: PUSH_QUEUE_STATUS.immediate, updatedAt: new Date() })
      .where(inArray(pushQueue.id, rows.map((row) => row.id)));

    return rows;
  });
}
