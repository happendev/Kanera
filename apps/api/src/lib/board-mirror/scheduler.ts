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
    // Unlike the outbox dispatchers this scheduler polls anyway, so a connection that cannot LISTEN
    // is returned to the pool rather than held idle.
    releaseOnListenFailure: true,
    listenFailedMessage: "board mirror outbox listen failed; polling remains active",
  });
  return async () => {
    await scheduler.stop();
    await listener.release();
  };
}
