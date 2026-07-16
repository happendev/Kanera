import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../../db.js";
import { env } from "../../env.js";
import { startSweepScheduler } from "../sweep-scheduler.js";
import { processBoardMirrors } from "./drain.js";

const OUTBOX_NOTIFY_CHANNEL = "kanera_event_outbox";

export function startBoardMirrorScheduler(options: { log?: FastifyBaseLogger; pollMs?: number } = {}): () => Promise<void> {
  const pollMs = options.pollMs ?? env.REALTIME_OUTBOX_POLL_MS;
  let stopped = false;
  let listener: PoolClient | null = null;
  const scheduler = startSweepScheduler({
    name: "board-mirrors",
    task: () => processBoardMirrors({ log: options.log }),
    nextDelayMs: (result) => result?.drainedFull ? 0 : pollMs,
    log: options.log,
  });
  const listenerReady = pool.connect().then(async (client) => {
    if (stopped) {
      client.release();
      return null;
    }
    client.on("notification", (message) => {
      if (message.channel === OUTBOX_NOTIFY_CHANNEL) scheduler.trigger();
    });
    client.on("error", (error) => options.log?.error({ err: error }, "board mirror outbox listener failed"));
    try {
      await client.query(`listen ${OUTBOX_NOTIFY_CHANNEL}`);
    } catch (error) {
      options.log?.error({ err: error }, "board mirror outbox listen failed; polling remains active");
      client.release();
      return null;
    }
    if (stopped) {
      await client.query(`unlisten ${OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
      return null;
    }
    listener = client;
    return client;
  }).catch((error) => {
    options.log?.error({ err: error }, "board mirror outbox listener could not start");
    return null;
  });
  return async () => {
    stopped = true;
    await scheduler.stop();
    const client = listener ?? await listenerReady;
    if (!client) return;
    await client.query(`unlisten ${OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
    client.release();
    listener = null;
  };
}
