import {
  PUSH_QUEUE_STATUS,
  clients,
  notificationSettings,
  pushQueue,
  pushSubscriptions,
  type PersonalNotificationQueuePayload,
  type PushNotificationContent,
  type PushQueue,
  type PushQueueChannel,
  type PushQueuePayload,
  type PushQueueReason,
} from "@kanera/shared/schema";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ContentEncoding } from "web-push";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { hasPaidPlanEntitlement } from "./entitlements.js";
import { AppError } from "./errors.js";
import { decryptSecret } from "./secrets.js";
import { assertResolvedNotificationDestinationAllowed } from "./ssrf.js";
import { startSweepScheduler } from "./sweep-scheduler.js";
import { DEFAULT_PUSH_TTL, ensureWebPushReady, handleSubscriptionError, toPushSubscription, webPushClient } from "./web-push.js";
import { signWebhookPayload } from "./webhook-signing.js";

const MAX_RETRIES = 3;
const SWEEP_BATCH_SIZE = 50;
const SWEEP_INTERVAL_MS = 30_000; // 30 seconds
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 360 minutes
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 10,080 minutes
const PERSONAL_DELIVERY_TIMEOUT_MS = 10_000;
// Notification `icon` is a full-color app image. `badge` is a separate 96px
// alpha-only silhouette that Android masks and tints; do not reuse a PWA icon.
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
  payload: PushNotificationContent;
}

export interface EnqueuePersonalNotificationArgs extends EnqueuePushArgs {
  channel: Exclude<PushQueueChannel, "webPush">;
}

export async function enqueuePush(db: Db, args: EnqueuePushArgs): Promise<PushQueue> {
  const [row] = await db
    .insert(pushQueue)
    .values({
      clientId: args.clientId,
      userId: args.userId,
      reason: args.reason,
      channel: "webPush",
      payload: toPushQueuePayload(args.payload),
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
      channel: "webPush",
      payload: toPushQueuePayload(args.payload),
      status: PUSH_QUEUE_STATUS.immediate,
    })
    .returning();
  return row!;
}

export async function enqueuePersonalNotification(
  db: Db,
  args: EnqueuePersonalNotificationArgs,
  immediate = false,
): Promise<PushQueue> {
  const [row] = await db
    .insert(pushQueue)
    .values({
      clientId: args.clientId,
      userId: args.userId,
      reason: args.reason,
      channel: args.channel,
      payload: args.payload as unknown as PushQueuePayload,
      status: immediate ? PUSH_QUEUE_STATUS.immediate : PUSH_QUEUE_STATUS.queued,
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
  const queuePayload = row.payload as PushQueuePayload;
  const ttl = queuePayload.ttl ?? DEFAULT_PUSH_TTL;
  const payload = JSON.stringify({ notification: queuePayload.notification });

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

function personalPayload(row: PushQueue): PersonalNotificationQueuePayload {
  return row.payload as unknown as PersonalNotificationQueuePayload;
}

function appendPath(baseUrl: string, segment: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${segment}`;
  return url.toString();
}

async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  await assertResolvedNotificationDestinationAllowed(url);
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(PERSONAL_DELIVERY_TIMEOUT_MS),
  });
}

async function requireSuccess(response: Response, channel: string): Promise<void> {
  const status = response.status;
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`${channel} delivery failed with HTTP ${status}`);
}

type PersonalDeliveryResult =
  | { delivered: true; cancelled: false }
  | { delivered: false; cancelled: true; error: "channel disabled or not configured" | "unavailable on current plan" };

function personalDeliveryError(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error && /^(?:ntfy|Gotify|webhook) delivery failed with HTTP \d{3}$/u.test(err.message)) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") return "delivery timed out";
  // Fetch errors can embed the destination URL or nested request details. Keep the persisted and
  // logged diagnostic deliberately generic so personal endpoints and credentials never leak.
  return "network delivery failed";
}

export async function deliverPersonalNotificationRow(
  db: Db,
  row: PushQueue,
  options: { ignoreEnabled?: boolean } = {},
): Promise<PersonalDeliveryResult> {
  if (row.channel === "webPush") throw new Error("personal notification adapter requires a personal channel row");
  if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
    const [org] = await db
      .select({ plan: clients.plan, billingStatus: clients.billingStatus })
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);
    // Re-check at the final network boundary so a queued row cannot escape after a downgrade.
    // Browser push deliberately does not pass through this adapter and remains available on Free.
    if (!hasPaidPlanEntitlement(org?.plan, org?.billingStatus)) {
      return { delivered: false, cancelled: true, error: "unavailable on current plan" };
    }
  }
  const [settings] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, row.userId))
    .limit(1);
  if (!settings) return { delivered: false, cancelled: true, error: "channel disabled or not configured" };

  const payload = personalPayload(row);
  if (row.channel === "ntfy") {
    if ((!settings.ntfyEnabled && !options.ignoreEnabled) || !settings.ntfyServerUrl || !settings.ntfyTopic) {
      return { delivered: false, cancelled: true, error: "channel disabled or not configured" };
    }
    const response = await checkedFetch(appendPath(settings.ntfyServerUrl, encodeURIComponent(settings.ntfyTopic)), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: payload.title,
        ...(payload.url ? { Click: payload.url } : {}),
        ...(settings.encryptedNtfyToken ? { Authorization: `Bearer ${decryptSecret(settings.encryptedNtfyToken)}` } : {}),
      },
      body: payload.body,
    });
    await requireSuccess(response, "ntfy");
    return { delivered: true, cancelled: false };
  }

  if (row.channel === "gotify") {
    if ((!settings.gotifyEnabled && !options.ignoreEnabled) || !settings.gotifyServerUrl || !settings.encryptedGotifyToken) {
      return { delivered: false, cancelled: true, error: "channel disabled or not configured" };
    }
    const response = await checkedFetch(appendPath(settings.gotifyServerUrl, "message"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gotify-Key": decryptSecret(settings.encryptedGotifyToken),
      },
      body: JSON.stringify({
        title: payload.title,
        message: payload.body,
        priority: 5,
        ...(payload.url ? { extras: { "client::notification": { click: { url: payload.url } }, "client::display": { contentType: "text/plain" } } } : {}),
      }),
    });
    await requireSuccess(response, "Gotify");
    return { delivered: true, cancelled: false };
  }

  if ((!settings.webhookEnabled && !options.ignoreEnabled) || !settings.webhookUrl || !settings.encryptedWebhookSecret) {
    return { delivered: false, cancelled: true, error: "channel disabled or not configured" };
  }
  const body = JSON.stringify({
    id: row.id,
    type: "notification",
    occurredAt: row.createdAt.toISOString(),
    notification: {
      kind: payload.kind,
      reason: row.reason,
      title: payload.title,
      body: payload.body,
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = decryptSecret(settings.encryptedWebhookSecret);
  const response = await checkedFetch(settings.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Kanera-Personal-Notifications/1.0",
      "X-Kanera-Event-Id": row.id,
      "X-Kanera-Timestamp": timestamp,
      "X-Kanera-Signature": signWebhookPayload(secret, timestamp, body),
    },
    body,
  });
  await requireSuccess(response, "webhook");
  return { delivered: true, cancelled: false };
}

export async function deliverPersonalNotificationTestRow(
  db: Db,
  row: PushQueue,
): Promise<{ delivered: boolean; error: string | null }> {
  try {
    const result = await deliverPersonalNotificationRow(db, row, { ignoreEnabled: true });
    const error = result.cancelled
      ? result.error === "unavailable on current plan"
        ? result.error
        : "channel is not fully configured"
      : null;
    await db.update(pushQueue).set({
      status: result.cancelled ? PUSH_QUEUE_STATUS.cancelled : PUSH_QUEUE_STATUS.success,
      sentAt: result.delivered ? new Date() : null,
      lastError: error,
      updatedAt: new Date(),
    }).where(eq(pushQueue.id, row.id));
    return { delivered: result.delivered, error };
  } catch (err) {
    const error = personalDeliveryError(err);
    await db.update(pushQueue).set({ status: PUSH_QUEUE_STATUS.error, retries: 1, lastError: error, updatedAt: new Date() }).where(eq(pushQueue.id, row.id));
    return { delivered: false, error };
  }
}

function withDefaultPushBranding(payload: PushNotificationContent): PushNotificationContent {
  return {
    ...payload,
    icon: payload.icon ?? DEFAULT_PUSH_ICON,
    badge: payload.badge ?? DEFAULT_PUSH_BADGE,
  };
}

export function toPushQueuePayload(content: PushNotificationContent): PushQueuePayload {
  const payload = withDefaultPushBranding(content);
  return {
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.icon ? { icon: payload.icon } : {}),
      ...(payload.badge ? { badge: payload.badge } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
      data: {
        kind: payload.kind,
        ...(payload.url
          ? {
            onActionClick: {
              default: {
                // Reuse an open Kanera tab while still navigating it to the card.
                operation: "navigateLastFocusedOrOpen" as const,
                url: payload.url,
              },
            },
          }
          : {}),
      },
    },
    ...(payload.ttl !== undefined ? { ttl: payload.ttl } : {}),
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
      if (row.channel !== "webPush") {
        const result = await deliverPersonalNotificationRow(db, row);
        if (result.cancelled) {
          await db.update(pushQueue).set({ status: PUSH_QUEUE_STATUS.cancelled, lastError: result.error, updatedAt: new Date() }).where(eq(pushQueue.id, row.id));
        } else {
          await db.update(pushQueue).set({ status: PUSH_QUEUE_STATUS.success, sentAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(pushQueue.id, row.id));
        }
        log.info({ pushQueueId: row.id, userId: row.userId, reason: row.reason, channel: row.channel, delivered: result.delivered }, "personal notification queue row processed");
        continue;
      }
      const result = await deliverPushRow(db, row);
      const attempted = result.delivered + result.disabled + result.failed;
      if (attempted === 0) {
        // A removed or tenant-mismatched subscription must not make a push look
        // successful; there was no delivery attempt for the provider to accept.
        await db
          .update(pushQueue)
          .set({
            status: PUSH_QUEUE_STATUS.error,
            lastError: "no active push subscriptions",
            updatedAt: new Date(),
          })
          .where(eq(pushQueue.id, row.id));
        log.warn({ pushQueueId: row.id, userId: row.userId, reason: row.reason }, "push queue row had no active subscriptions");
        continue;
      }
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
      const lastError = row.channel === "webPush"
        ? Error.isError(err) ? err.message : String(err)
        : personalDeliveryError(err);
      await db
        .update(pushQueue)
        .set({
          status: retries >= MAX_RETRIES ? PUSH_QUEUE_STATUS.error : PUSH_QUEUE_STATUS.queued,
          retries,
          lastError,
          updatedAt: new Date(),
        })
        .where(eq(pushQueue.id, row.id));
      if (row.channel === "webPush") {
        log.error({ err, pushQueueId: row.id, retries }, "push queue delivery failed");
      } else {
        // Do not attach the raw fetch error: Undici may include the personal destination URL.
        log.error({ pushQueueId: row.id, channel: row.channel, retries, error: lastError }, "personal notification queue delivery failed");
      }
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
