import { after, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";
import { rm } from "node:fs/promises";
import "./setup.integration.js";
import { db, pool } from "../db.js";
import { waitForNotificationFanoutForTests } from "../lib/notifications.js";
import { closeRedis, getRedis, initRedis } from "../redis.js";
import type { BuildServerOptions } from "../server.js";

const apps: FastifyInstance[] = [];

export async function buildIntegrationServer(options: Partial<BuildServerOptions> = {}): Promise<FastifyInstance> {
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
    uploadsDir: ".tmp/test-uploads",
    ...options,
  });
  apps.push(app);
  return app;
}

beforeEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await initRedis();
  await getRedis().flushdb();
  await waitForNotificationFanoutForTests();
  const currentDb = await db.execute<{ current_database: string }>("select current_database()");
  if (currentDb.rows[0]?.current_database !== "kanera_test") {
    throw new Error(`Refusing to reset non-test database: ${currentDb.rows[0]?.current_database ?? "unknown"}`);
  }
  const tables = await db.execute<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  const tableNames = tables.rows.map((row) => `"public"."${row.tablename.replaceAll('"', '""')}"`);
  if (tableNames.length > 0) {
    await db.execute(`truncate table ${tableNames.join(", ")} restart identity cascade`);
  }
});

after(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await waitForNotificationFanoutForTests();
  await closeRedis();
  await pool.end();
  await rm(".tmp", { recursive: true, force: true });
});
