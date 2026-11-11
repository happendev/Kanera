import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { startSweepScheduler } from "../sweep-scheduler.js";
import { processBoardMirrors } from "./drain.js";
import { OUTBOX_NOTIFY_CHANNEL } from "../../realtime/outbox.js";
import { startNotifyListener } from "../../realtime/notify-listener.js";

export function startBoardMirrorScheduler(options: { log?: FastifyBaseLogger; pollMs?: number } = {}): () => Promise<void> {
  const pollMs = options.pollMs ?? env.REALTIME_OUTBOX_POLL_MS;
  const scheduler = startSweepScheduler({
    name: "board-mirrors",
    task: () => processBoardMirrors({ log: options.log }),
    nextDelayMs: (result) => result?.drainedFull ? 0 : pollMs,
    log: options.log,
  });
  const listener = startNotifyListener({
    channel: OUTBOX_NOTIFY_CHANNEL,
    onNotify: () => scheduler.trigger(),
    log: options.log,
    label: "board mirror outbox",
  });
  return async () => {
    await scheduler.stop();
    await listener.release();
  };
}
