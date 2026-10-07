import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

export interface NotifyListener {
  /** Unlistens and returns the connection to the pool; safe to call once the owner stops. */
  release(): Promise<void>;
}

/**
 * A dedicated pool connection that LISTENs on one Postgres channel and calls `onNotify` for each
 * notification. The poll loop of whichever scheduler owns it remains the durability fallback, so a
 * failed LISTEN is logged and either kept (the connection still delivers errors) or released when
 * `releaseOnListenFailure` is set. Stop races are handled: a release that arrives while the connect
 * is still in flight hands the connection straight back.
 */
export function startNotifyListener(options: {
  channel: string;
  onNotify: () => void;
  log?: FastifyBaseLogger;
  /** Noun for log lines, e.g. "event outbox" → "event outbox listener failed". */
  label: string;
  releaseOnListenFailure?: boolean;
  /** Overrides the log line for a failed LISTEN (the default is `${label} listen failed`). */
  listenFailedMessage?: string;
}): NotifyListener {
  const { channel, onNotify, log, label } = options;
  let stopped = false;
  let listener: PoolClient | null = null;
  let released = false;
  const listenerReady: Promise<PoolClient | null> = pool.connect().then(async (client) => {
    if (stopped) {
      client.release();
      return null;
    }
    client.on("notification", (message) => {
      if (message.channel === channel) onNotify();
    });
    client.on("error", (err) => {
      log?.error({ err }, `${label} listener failed`);
    });
    try {
      await client.query(`listen ${channel}`);
    } catch (err) {
      log?.error({ err }, options.listenFailedMessage ?? `${label} listen failed`);
      if (options.releaseOnListenFailure) {
        client.release();
        return null;
      }
    }
    if (stopped) {
      await client.query(`unlisten ${channel}`).catch(() => undefined);
      client.release();
      return null;
    }
    listener = client;
    return client;
  }).catch((err) => {
    log?.error({ err }, `${label} listener could not start`);
    return null;
  });

  return {
    async release() {
      stopped = true;
      if (released) return;
      released = true;
      const client = listener ?? await listenerReady;
      if (!client) return;
      listener = null;
      await client.query(`unlisten ${channel}`).catch(() => undefined);
      client.release();
    },
  };
}
