import type { FastifyBaseLogger } from "fastify";
import type { Notification, Pool, PoolClient } from "pg";
import { pool } from "../db.js";

export interface NotifyListener {
  /** Completion of the initial subscription attempt; polling remains the fallback on failure. */
  ready: Promise<void>;
  /** Removes this callback and releases the shared connection after the last subscriber stops. */
  release(): Promise<void>;
}

interface ListenerOptions {
  channel: string;
  onNotify: () => void;
  log?: FastifyBaseLogger;
  label: string;
}

/** One process-wide LISTEN session; subscriber changes and reconnects never overlap. */
export function createNotifyListenerHub(connectionPool: Pool) {
  const subscribers = new Set<ListenerOptions>();
  const channels = new Set<string>();
  let client: PoolClient | null = null;
  let pending = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;

  const notify = (message: Notification) => {
    for (const subscriber of subscribers) {
      if (subscriber.channel !== message.channel) continue;
      try {
        subscriber.onNotify();
      } catch (err) {
        subscriber.log?.error({ err }, `${subscriber.label} notification callback failed`);
      }
    }
  };
  const discard = (broken = false) => {
    const previous = client;
    client = null;
    channels.clear();
    if (!previous) return;
    previous.removeListener("notification", notify);
    previous.removeListener("error", disconnected);
    previous.removeListener("end", ended);
    previous.release(broken);
  };
  const retryLater = () => {
    if (retry || subscribers.size === 0) return;
    retry = setTimeout(() => {
      retry = undefined;
      void reconcile();
    }, 1_000);
    retry.unref();
  };
  const disconnected = (err: Error) => {
    for (const subscriber of subscribers) subscriber.log?.error({ err }, `${subscriber.label} listener failed`);
    discard(true);
    retryLater();
  };
  const ended = () => disconnected(new Error("PostgreSQL notification connection ended"));

  const reconcile = (): Promise<void> => {
    pending = pending.then(async () => {
      if (subscribers.size === 0) {
        clearTimeout(retry);
        retry = undefined;
        if (client) {
          // Do not return a connection with active LISTEN channels or our callbacks to the pool.
          await client.query("unlisten *");
          discard();
        }
        return;
      }
      if (!client) {
        client = await connectionPool.connect();
        client.on("notification", notify);
        client.on("error", disconnected);
        client.on("end", ended);
      }
      const current = client;
      const wanted = new Set(Array.from(subscribers, ({ channel }) => channel));
      for (const channel of channels) {
        if (wanted.has(channel)) continue;
        await current.query(`unlisten ${channel}`);
        channels.delete(channel);
      }
      for (const channel of wanted) {
        if (channels.has(channel)) continue;
        await current.query(`listen ${channel}`);
        if (client !== current) throw new Error("notification connection lost during subscription");
        channels.add(channel);
      }
      // A stop can arrive while connect/LISTEN awaits I/O; its queued reconciliation releases us.
    }).catch((err: unknown) => {
      for (const subscriber of subscribers) subscriber.log?.error({ err }, `${subscriber.label} listener could not subscribe`);
      discard(true);
      retryLater();
    });
    return pending;
  };

  return {
    subscribe(options: ListenerOptions): NotifyListener {
      // Channels are internal constants; still keep interpolated identifiers strictly bounded.
      if (!/^[a-z_][a-z0-9_]*$/.test(options.channel)) throw new Error("invalid notification channel");
      subscribers.add(options);
      const ready = reconcile();
      let releasing: Promise<void> | undefined;
      return {
        ready,
        release() {
          if (releasing) return releasing;
          subscribers.delete(options);
          releasing = reconcile();
          return releasing;
        },
      };
    },
  };
}

const hub = createNotifyListenerHub(pool);

/** The event dispatcher and mirror share a channel; both must receive each wake on one session. */
export function startNotifyListener(options: ListenerOptions): NotifyListener {
  return hub.subscribe(options);
}
