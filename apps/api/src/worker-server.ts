import Fastify, { type FastifyServerOptions } from "fastify";
import { EMAIL_QUEUE_STATUS, emailQueue, PUSH_QUEUE_STATUS, pushQueue } from "@kanera/shared/schema";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.js";
import { env } from "./env.js";
import { productAnalytics } from "./lib/product-analytics.js";
import { startAgentRunStallScheduler } from "./lib/agent-runs.js";
import { startArchivedCardCleanupScheduler } from "./lib/archived-card-cleanup.js";
import { startCardReminderScheduler } from "./lib/card-follow.js";
import { startBoardMirrorScheduler } from "./lib/board-mirror/scheduler.js";
import { startDueDateAutomationScheduler } from "./lib/automations.js";
import { startDailyDigestScheduler } from "./lib/daily-digest.js";
import { startEmailQueueScheduler } from "./lib/email-queue.js";
import { startImportCleanupScheduler } from "./lib/import-cleanup.js";
import { startLifecycleEmailScheduler } from "./lib/lifecycle-emails.js";
import { registerMetrics, registerNotificationQueueStatsProvider, timestampAgeSeconds } from "./lib/metrics.js";
import mailerPlugin from "./lib/mailer-plugin.js";
import { startOverdueNotificationScheduler } from "./lib/overdue-notifications.js";
import { startInProgressAlertNotificationScheduler } from "./lib/in-progress-alerts.js";
import { startOrganisationDeletionScheduler } from "./lib/organisation-delete.js";
import { startPushQueueScheduler } from "./lib/push-queue.js";
import { startRetentionCleanupScheduler } from "./lib/retention-cleanup.js";
import { resolveSmtpConfig } from "./lib/smtp-resolve.js";
import { startStorageWarningScheduler } from "./lib/storage-warning.js";
import type { SweepScheduler } from "./lib/sweep-scheduler.js";
import { startTrialExpiryScheduler } from "./lib/trial-expiry.js";
import { startWebhookDeliveryScheduler } from "./lib/webhooks.js";
import { startWeeklyAdminRecapScheduler } from "./lib/weekly-admin-recap.js";
import { initRedis } from "./redis.js";
import { setupBroadcastIo, closeRealtimeIo, recordPresenceOffline } from "./realtime/io.js";
import { setRealtimeLogger } from "./realtime/metrics.js";
import { startDirectRealtimeOutboxDispatcher, startRealtimeOutboxDispatcher } from "./realtime/outbox.js";
import { startPresenceReaper } from "./realtime/presence.js";
import { broadcastPresenceToWorkspace } from "./realtime/broadcast.js";

const DEFAULT_LOG_LEVEL = env.NODE_ENV === "development" ? "debug" : "info";

export interface BuildWorkerServerOptions {
  logger?: FastifyServerOptions["logger"];
}

export async function buildWorkerServer(options: BuildWorkerServerOptions = {}) {
  // Three permanent LISTEN clients previously occupied this pool; the shared listener needs one.
  // Keep the old ordinary-query budget instead of turning the two saved sessions into parallel work.
  // Two total slots are the minimum for one listener plus a query on unusually small custom pools.
  pool.options.max = Math.max(2, env.PG_POOL_MAX - 2);
  await initRedis();
  const app = Fastify({
    logger: options.logger ?? {
      level: DEFAULT_LOG_LEVEL,
      ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      redact: { paths: ["*.password", "*.secret", "*.token", "*.generatedWebhookSecret", "*.authorization"], censor: "[REDACTED]" },
    },
  });
  setRealtimeLogger(app.log);

  await app.register(mailerPlugin);
  app.get("/health", async () => ({ ok: true, service: "worker" }));
  registerNotificationQueueStatsProvider(async () => {
    const now = Date.now();
    const [[pushStats], [emailStats]] = await Promise.all([
      db.select({
        queued: sql<number>`count(*) filter (where ${pushQueue.status} = ${PUSH_QUEUE_STATUS.queued})::int`,
        inFlight: sql<number>`count(*) filter (where ${pushQueue.status} = ${PUSH_QUEUE_STATUS.immediate})::int`,
        oldest: sql<Date | string | null>`min(${pushQueue.createdAt}) filter (where ${pushQueue.status} in (${PUSH_QUEUE_STATUS.queued}, ${PUSH_QUEUE_STATUS.immediate}))`,
      }).from(pushQueue),
      db.select({
        queued: sql<number>`count(*) filter (where ${emailQueue.status} = ${EMAIL_QUEUE_STATUS.queued})::int`,
        inFlight: sql<number>`count(*) filter (where ${emailQueue.status} = ${EMAIL_QUEUE_STATUS.immediate})::int`,
        failedLast24h: sql<number>`count(*) filter (where ${emailQueue.status} = ${EMAIL_QUEUE_STATUS.error} and ${emailQueue.updatedAt} > now() - interval '24 hours')::int`,
        oldest: sql<Date | string | null>`min(${emailQueue.createdAt}) filter (where ${emailQueue.status} in (${EMAIL_QUEUE_STATUS.queued}, ${EMAIL_QUEUE_STATUS.immediate}))`,
      }).from(emailQueue),
    ]);
    return {
      push: {
        queued: pushStats?.queued ?? 0,
        inFlight: pushStats?.inFlight ?? 0,
        oldestAgeSeconds: timestampAgeSeconds(pushStats?.oldest ?? null, now),
      },
      email: {
        queued: emailStats?.queued ?? 0,
        inFlight: emailStats?.inFlight ?? 0,
        failedLast24h: emailStats?.failedLast24h ?? 0,
        oldestAgeSeconds: timestampAgeSeconds(emailStats?.oldest ?? null, now),
      },
    };
  });
  registerMetrics(app);

  let webhookDeliveryScheduler: SweepScheduler | null = null;
  let stopRealtimeOutboxDispatcher: (() => Promise<void>) | null = null;
  let stopDirectRealtimeOutboxDispatcher: (() => Promise<void>) | null = null;
  let stopOverdueScheduler: (() => Promise<void>) | null = null;
  let stopInProgressAlertScheduler: (() => Promise<void>) | null = null;
  let stopCardReminderScheduler: (() => Promise<void>) | null = null;
  let stopDueDateAutomationScheduler: (() => Promise<void>) | null = null;
  let stopDailyDigestScheduler: (() => Promise<void>) | null = null;
  let stopEmailQueueScheduler: (() => Promise<void>) | null = null;
  let stopArchivedCardCleanupScheduler: (() => Promise<void>) | null = null;
  let stopImportCleanupScheduler: (() => Promise<void>) | null = null;
  let stopOrganisationDeletionScheduler: (() => Promise<void>) | null = null;
  let stopPushQueueScheduler: (() => Promise<void>) | null = null;
  let stopRetentionCleanupScheduler: (() => Promise<void>) | null = null;
  let stopTrialExpiryScheduler: (() => Promise<void>) | null = null;
  let stopStorageWarningScheduler: (() => Promise<void>) | null = null;
  let stopLifecycleEmailScheduler: (() => Promise<void>) | null = null;
  let stopBoardMirrorScheduler: (() => Promise<void>) | null = null;
  let stopWeeklyAdminRecapScheduler: (() => Promise<void>) | null = null;
  let stopPresenceReaper: (() => Promise<void>) | null = null;
  let stopAgentRunStallScheduler: (() => Promise<void>) | null = null;

  app.addHook("onClose", async () => {
    // Stop every producer before closing the adapter they publish through. Separate onClose
    // hooks run in reverse registration order, which used to close realtime before the jobs.
    const stopped = await Promise.allSettled([
      stopPresenceReaper?.(),
      stopAgentRunStallScheduler?.(),
      stopRealtimeOutboxDispatcher?.(),
      stopDirectRealtimeOutboxDispatcher?.(),
      webhookDeliveryScheduler?.stop(),
      stopOverdueScheduler?.(),
      stopInProgressAlertScheduler?.(),
      stopCardReminderScheduler?.(),
      stopDueDateAutomationScheduler?.(),
      stopDailyDigestScheduler?.(),
      stopEmailQueueScheduler?.(),
      stopArchivedCardCleanupScheduler?.(),
      stopImportCleanupScheduler?.(),
      stopOrganisationDeletionScheduler?.(),
      stopPushQueueScheduler?.(),
      stopRetentionCleanupScheduler?.(),
      stopTrialExpiryScheduler?.(),
      stopStorageWarningScheduler?.(),
      stopLifecycleEmailScheduler?.(),
      stopBoardMirrorScheduler?.(),
      stopWeeklyAdminRecapScheduler?.(),
    ]);
    try {
      const errors = stopped.filter(result => result.status === "rejected").map(result => result.reason as unknown);
      if (errors.length) throw new AggregateError(errors, "worker schedulers failed to stop");
    } finally {
      try {
        await closeRealtimeIo();
      } finally {
        await productAnalytics.shutdown();
      }
    }
  });

  app.addHook("onReady", async () => {
    await setupBroadcastIo();

    stopPresenceReaper = startPresenceReaper({
      log: app.log,
      emit: (event) => {
        return recordPresenceOffline(event)
          .then((payload) => { broadcastPresenceToWorkspace(payload.workspaceId, payload); })
          .catch((err: unknown) => {
            app.log.warn({ err, userId: event.userId }, "failed to record last online time");
            broadcastPresenceToWorkspace(event.workspaceId, event);
          });
      },
    });

    // The worker owns every poller/dispatcher so scaled API replicas never double-run jobs.
    webhookDeliveryScheduler = startWebhookDeliveryScheduler({ log: app.log });
    stopRealtimeOutboxDispatcher = startRealtimeOutboxDispatcher({
      log: app.log,
      onDeliveriesEnqueued: webhookDeliveryScheduler.trigger,
    });
    stopBoardMirrorScheduler = startBoardMirrorScheduler({ log: app.log });
    stopDirectRealtimeOutboxDispatcher = startDirectRealtimeOutboxDispatcher({ log: app.log });
    stopOverdueScheduler = startOverdueNotificationScheduler(app.log);
    stopInProgressAlertScheduler = startInProgressAlertNotificationScheduler(app.log);
    stopCardReminderScheduler = startCardReminderScheduler(app.log);
    stopAgentRunStallScheduler = startAgentRunStallScheduler(app.log);
    stopDueDateAutomationScheduler = startDueDateAutomationScheduler(app.log);
    stopDailyDigestScheduler = startDailyDigestScheduler({ db, webOrigin: env.WEB_ORIGIN, resolveSmtpConfig, log: app.log });
    stopEmailQueueScheduler = startEmailQueueScheduler({ db, resolveSmtpConfig, log: app.log });
    stopArchivedCardCleanupScheduler = startArchivedCardCleanupScheduler({ db, log: app.log });
    stopImportCleanupScheduler = startImportCleanupScheduler({ db, log: app.log });
    stopOrganisationDeletionScheduler = startOrganisationDeletionScheduler(app.log);
    stopPushQueueScheduler = startPushQueueScheduler({ db, log: app.log });
    stopRetentionCleanupScheduler = startRetentionCleanupScheduler({ db, log: app.log });
    stopTrialExpiryScheduler = startTrialExpiryScheduler(app.log, app.mailer);
    stopStorageWarningScheduler = startStorageWarningScheduler(app.log, app.mailer);
    stopLifecycleEmailScheduler = startLifecycleEmailScheduler(app.log, app.mailer);
    stopWeeklyAdminRecapScheduler = startWeeklyAdminRecapScheduler({
      db,
      adminEmail: env.ADMIN_EMAIL,
      adminUrl: env.ADMIN_WEB_ORIGIN,
      log: app.log,
    });
  });

  return app;
}
