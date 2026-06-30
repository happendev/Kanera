import { buildServer } from "./server.js";
import { env } from "./env.js";
import { sendOpsAlert } from "./lib/ops-alerts.js";

const app = await buildServer({
  enableArchivedCardCleanupScheduler: false,
  enableDailyDigestScheduler: false,
  enableDueDateAutomationScheduler: false,
  enableEmailQueueScheduler: false,
  enableImportCleanupScheduler: false,
  enableOverdueScheduler: false,
  enablePushQueueScheduler: false,
  enableRealtimeOutboxDispatcher: false,
  enableTrialExpiryScheduler: false,
  enableWebhookDeliveryScheduler: false,
});

try {
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  void sendOpsAlert({ service: "api", type: "startup", port: env.API_PORT }, { log: app.log });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
