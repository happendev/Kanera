import Fastify, { type FastifyServerOptions } from "fastify";
import { db } from "./db.js";
import { env } from "./env.js";
import { startArchivedCardCleanupScheduler } from "./lib/archived-card-cleanup.js";
import { startDueDateAutomationScheduler } from "./lib/automations.js";
import { startDailyDigestScheduler } from "./lib/daily-digest.js";
import { startEmailQueueScheduler } from "./lib/email-queue.js";
import { startImportCleanupScheduler } from "./lib/import-cleanup.js";
import { registerMetrics } from "./lib/metrics.js";
import mailerPlugin from "./lib/mailer-plugin.js";
import { startOverdueNotificationScheduler } from "./lib/overdue-notifications.js";
import { startPushQueueScheduler } from "./lib/push-queue.js";
import { startRetentionCleanupScheduler } from "./lib/retention-cleanup.js";
import { resolveSmtpConfig } from "./lib/smtp-resolve.js";
import type { SweepScheduler } from "./lib/sweep-scheduler.js";
import { startTrialExpiryScheduler } from "./lib/trial-expiry.js";
import { startWebhookDeliveryScheduler } from "./lib/webhooks.js";
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
  await initRedis();
  const app = Fastify({
    logger: options.logger ?? {
      level: DEFAULT_LOG_LEVEL,
      ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      redact: { paths: ["*.password", "*.secret", "*.token"], censor: "[REDACTED]" },
    },
  });
  setRealtimeLogger(app.log);

  await app.register(mailerPlugin);
  app.get("/health", async () => ({ ok: true, service: "worker" }));
  registerMetrics(app);

  let webhookDeliveryScheduler: SweepScheduler | null = null;
  let stopRealtimeOutboxDispatcher: (() => Promise<void>) | null = null;
  let stopDirectRealtimeOutboxDispatcher: (() => Promise<void>) | null = null;
  let stopOverdueScheduler: (() => Promise<void>) | null = null;
  let stopDueDateAutomationScheduler: (() => Promise<void>) | null = null;
  let stopDailyDigestScheduler: (() => Promise<void>) | null = null;
  let stopEmailQueueScheduler: (() => Promise<void>) | null = null;
  let stopArchivedCardCleanupScheduler: (() => Promise<void>) | null = null;
  let stopImportCleanupScheduler: (() => Promise<void>) | null = null;
  let stopPushQueueScheduler: (() => Promise<void>) | null = null;
  let stopRetentionCleanupScheduler: (() => Promise<void>) | null = null;
  let stopTrialExpiryScheduler: (() => Promise<void>) | null = null;
  let stopPresenceReaper: (() => void) | null = null;

  app.addHook("onClose", async () => stopPresenceReaper?.());
  app.addHook("onClose", async () => stopRealtimeOutboxDispatcher?.());
  app.addHook("onClose", async () => stopDirectRealtimeOutboxDispatcher?.());
  app.addHook("onClose", async () => webhookDeliveryScheduler?.stop());
  app.addHook("onClose", async () => stopOverdueScheduler?.());
  app.addHook("onClose", async () => stopDueDateAutomationScheduler?.());
  app.addHook("onClose", async () => stopDailyDigestScheduler?.());
  app.addHook("onClose", async () => stopEmailQueueScheduler?.());
  app.addHook("onClose", async () => stopArchivedCardCleanupScheduler?.());
  app.addHook("onClose", async () => stopImportCleanupScheduler?.());
  app.addHook("onClose", async () => stopPushQueueScheduler?.());
  app.addHook("onClose", async () => stopRetentionCleanupScheduler?.());
  app.addHook("onClose", async () => stopTrialExpiryScheduler?.());
  app.addHook("onClose", async () => closeRealtimeIo());

  app.addHook("onReady", async () => {
    await setupBroadcastIo();

    stopPresenceReaper = startPresenceReaper({
      log: app.log,
      emit: (event) => {
        void recordPresenceOffline(event)
          .then((payload) => broadcastPresenceToWorkspace(payload.workspaceId, payload))
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
    stopDirectRealtimeOutboxDispatcher = startDirectRealtimeOutboxDispatcher({ log: app.log });
    stopOverdueScheduler = startOverdueNotificationScheduler(app.log);
    stopDueDateAutomationScheduler = startDueDateAutomationScheduler(app.log);
    stopDailyDigestScheduler = startDailyDigestScheduler({ db, webOrigin: env.WEB_ORIGIN, resolveSmtpConfig, log: app.log });
    stopEmailQueueScheduler = startEmailQueueScheduler({ db, resolveSmtpConfig, log: app.log });
    stopArchivedCardCleanupScheduler = startArchivedCardCleanupScheduler({ db, log: app.log });
    stopImportCleanupScheduler = startImportCleanupScheduler({ db, log: app.log });
    stopPushQueueScheduler = startPushQueueScheduler({ db, log: app.log });
    stopRetentionCleanupScheduler = startRetentionCleanupScheduler({ db, log: app.log });
    stopTrialExpiryScheduler = startTrialExpiryScheduler(app.log, app.mailer);
  });

  return app;
}
