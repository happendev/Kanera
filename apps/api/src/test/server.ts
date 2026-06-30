import { after, afterEach, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";
import "./setup.js";
import { closeRedis, getRedis, initRedis } from "../redis.js";

const apps: FastifyInstance[] = [];

export async function buildTestServer(options: { slowRequestLogMs?: number } = {}): Promise<FastifyInstance> {
  const { buildServer } = await import("../server.js");
  const app = await buildServer({
    enableRealtime: false,
    enableOverdueScheduler: false,
    enableDueDateAutomationScheduler: false,
    enableDailyDigestScheduler: false,
    enableEmailQueueScheduler: false,
    enableArchivedCardCleanupScheduler: false,
    enableWebhookDeliveryScheduler: false,
    enableRealtimeOutboxDispatcher: false,
    logger: false,
    slowRequestLogMs: options.slowRequestLogMs,
    uploadsDir: ".tmp/test-uploads",
  });
  apps.push(app);
  return app;
}

export function trackTestServer<T extends FastifyInstance>(app: T): T {
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

beforeEach(async () => {
  await initRedis();
  await getRedis().flushdb();
});

after(async () => {
  await closeRedis();
});
