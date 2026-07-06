import type { ServerToClientEvents } from "@kanera/shared/events";
import {
  boards,
  directRealtimeOutbox,
  eventOutbox,
  type DirectRealtimeOutbox,
  type DirectRealtimeOutboxScope,
  type EventOutbox,
  type EventOutboxScope,
  type WebhookEndpoint,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { db, pool } from "../db.js";
import { env } from "../env.js";
import { startSweepScheduler } from "../lib/sweep-scheduler.js";
import { enqueueWebhookDeliveriesForOutboxEvent, loadEnabledEndpointsByWorkspace } from "../lib/webhooks.js";
import { broadcastToBoard, broadcastToClient, broadcastToUser, broadcastToWorkspace } from "./broadcast.js";

const OUTBOX_NOTIFY_CHANNEL = "kanera_event_outbox";
const DIRECT_OUTBOX_NOTIFY_CHANNEL = "kanera_direct_realtime_outbox";
const DEFAULT_PROCESS_LIMIT = 50;
const PROCESSING_LEASE_SECONDS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1,440 minutes

type EventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];
type DirectEventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];
interface RealtimeOutboxDependencies {
  broadcastToBoard: typeof broadcastToBoard;
  broadcastToWorkspace: typeof broadcastToWorkspace;
  broadcastToUser: typeof broadcastToUser;
  broadcastToClient: typeof broadcastToClient;
  enqueueWebhookDeliveriesForOutboxEvent: typeof enqueueWebhookDeliveriesForOutboxEvent;
}

const defaultDependencies: RealtimeOutboxDependencies = {
  broadcastToBoard,
  broadcastToWorkspace,
  broadcastToUser,
  broadcastToClient,
  enqueueWebhookDeliveriesForOutboxEvent,
};
let dependencies = defaultDependencies;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "event outbox processing failed";
}

async function notifyOutbox(eventId: string): Promise<void> {
  await pool.query("select pg_notify($1, $2)", [OUTBOX_NOTIFY_CHANNEL, eventId]);
}

async function notifyDirectOutbox(eventId: string): Promise<void> {
  await pool.query("select pg_notify($1, $2)", [DIRECT_OUTBOX_NOTIFY_CHANNEL, eventId]);
}

const workspaceForBoardQuery = db
  .select({ workspaceId: boards.workspaceId })
  .from(boards)
  .where(eq(boards.id, sql.placeholder("boardId")))
  .limit(1)
  .prepare("workspaceForBoard");

async function workspaceForBoard(boardId: string): Promise<string | null> {
  const [board] = await workspaceForBoardQuery.execute({ boardId });
  return board?.workspaceId ?? null;
}

export async function publishRealtimeEvent<E extends keyof ServerToClientEvents>(
  scope: EventOutboxScope,
  scopeId: string,
  eventType: E,
  payload: EventPayload<E>,
  options: { realtimeDispatched?: boolean } = {},
): Promise<EventOutbox | null> {
  const workspaceId = scope === "workspace" ? scopeId : await workspaceForBoard(scopeId);
  if (!workspaceId) return null;

  const [event] = await db
    .insert(eventOutbox)
    .values({
      scope,
      scopeId,
      workspaceId,
      boardId: scope === "board" ? scopeId : null,
      eventType,
      payload,
      realtimeDispatched: options.realtimeDispatched ?? false,
    })
    .returning();

  if (event) void notifyOutbox(event.id).catch(() => undefined);
  return event ?? null;
}

export async function publishDirectRealtimeEvent<E extends keyof ServerToClientEvents>(
  scope: DirectRealtimeOutboxScope,
  scopeId: string,
  eventType: E,
  payload: DirectEventPayload<E>,
  options: { realtimeDispatched?: boolean } = {},
): Promise<DirectRealtimeOutbox | null> {
  // Direct realtime events have no webhook phase and no reconnect replay consumer. The outbox only
  // exists for events an io-less process could not hand to Socket.IO inline, such as public API or
  // MCP-triggered notification fanout.
  if (options.realtimeDispatched) return null;

  const [event] = await db
    .insert(directRealtimeOutbox)
    .values({
      scope,
      userId: scope === "user" ? scopeId : null,
      clientId: scope === "client" ? scopeId : null,
      eventType,
      payload,
      realtimeDispatched: false,
    })
    .returning();

  if (event) void notifyDirectOutbox(event.id).catch(() => undefined);
  return event ?? null;
}

async function processEvent(event: EventOutbox, endpoints: WebhookEndpoint[] | undefined): Promise<void> {
  if (!event.realtimeDispatched) {
    if (event.scope === "board") {
      dependencies.broadcastToBoard(event.scopeId, event.eventType, event.payload);
    } else {
      dependencies.broadcastToWorkspace(event.scopeId, event.eventType, event.payload);
    }
    // Persist realtimeDispatched on its own, immediately after the broadcast, so that if the webhook
    // enqueue below throws, a later retry resumes at webhook enqueue and never rebroadcasts. The
    // final "both flags done" write is batched once per drain by the caller, not per event.
    await db
      .update(eventOutbox)
      .set({
        realtimeDispatched: true,
        lastError: null,
        processingLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(eventOutbox.id, event.id));
  }

  if (!event.webhooksEnqueued) {
    await dependencies.enqueueWebhookDeliveriesForOutboxEvent(event, endpoints);
  }
}

async function processDirectEvent(event: DirectRealtimeOutbox): Promise<void> {
  if (event.realtimeDispatched) return;
  if (event.scope === "user") {
    if (!event.userId) throw new Error("direct realtime user event missing user id");
    dependencies.broadcastToUser(event.userId, event.eventType, event.payload);
  } else {
    if (!event.clientId) throw new Error("direct realtime client event missing client id");
    dependencies.broadcastToClient(event.clientId, event.eventType, event.payload);
  }
}

export function setRealtimeOutboxDependenciesForTests(overrides: Partial<RealtimeOutboxDependencies>): () => void {
  dependencies = { ...defaultDependencies, ...overrides };
  return () => {
    dependencies = defaultDependencies;
  };
}

export interface RealtimeOutboxResult {
  processed: number;
  // True when we claimed a full batch, signalling more rows are likely pending. The
  // dispatcher uses this to keep draining immediately rather than waiting a poll window.
  drainedFull: boolean;
}

export async function processRealtimeOutbox(options: { log?: FastifyBaseLogger; limit?: number } = {}): Promise<RealtimeOutboxResult> {
  const limit = options.limit ?? DEFAULT_PROCESS_LIMIT;
  const events = await db.transaction(async (tx) => {
    // Rows are claimed oldest-first, but retried rows may still be delivered after newer
    // events. Clients must tolerate this via desync/resync handling for ordered pairs such
    // as rebalance-before-*:moved.
    const claimed = await tx.execute<{ id: string }>(sql`
      update event_outbox
      set
        processing_lease_expires_at = now() + (${PROCESSING_LEASE_SECONDS} || ' seconds')::interval,
        attempts = attempts + 1,
        updated_at = now()
      where id in (
        select id
        from event_outbox
        where
          (realtime_dispatched = false or webhooks_enqueued = false)
          and (processing_lease_expires_at is null or processing_lease_expires_at <= now())
        order by created_at, id
        limit ${limit}
        for update skip locked
      )
      returning id
    `);
    const ids = claimed.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    return tx.select().from(eventOutbox).where(inArray(eventOutbox.id, ids)).orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
  });

  if (events.length === 0) return { processed: 0, drainedFull: false };

  // Load enabled webhook endpoints once for the whole batch instead of one SELECT per event. Only
  // workspaces with events still needing webhook enqueue are queried; many drains touch a handful
  // of workspaces, so this collapses N per-event lookups into one.
  const workspacesNeedingWebhooks = [
    ...new Set(events.filter((event) => !event.webhooksEnqueued).map((event) => event.workspaceId)),
  ];
  const endpointsByWorkspace = await loadEnabledEndpointsByWorkspace(workspacesNeedingWebhooks);

  const completedIds: string[] = [];
  for (const event of events) {
    try {
      await processEvent(event, endpointsByWorkspace.get(event.workspaceId));
      completedIds.push(event.id);
    } catch (err) {
      options.log?.error({ err, eventId: event.id, eventType: event.eventType }, "event outbox processing failed");
      await db
        .update(eventOutbox)
        .set({
          lastError: errorMessage(err),
          processingLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(eventOutbox.id, event.id));
    }
  }

  // Mark every fully-processed event done in a single UPDATE rather than one write per event.
  // Failed events are excluded here; their lease/lastError were already set by the catch block.
  if (completedIds.length > 0) {
    await db
      .update(eventOutbox)
      .set({
        realtimeDispatched: true,
        webhooksEnqueued: true,
        lastError: null,
        processingLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(inArray(eventOutbox.id, completedIds));
  }

  return { processed: events.length, drainedFull: events.length >= limit };
}

export async function processDirectRealtimeOutbox(options: { log?: FastifyBaseLogger; limit?: number } = {}): Promise<RealtimeOutboxResult> {
  const limit = options.limit ?? DEFAULT_PROCESS_LIMIT;
  const events = await db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: string }>(sql`
      update direct_realtime_outbox
      set
        processing_lease_expires_at = now() + (${PROCESSING_LEASE_SECONDS} || ' seconds')::interval,
        attempts = attempts + 1,
        updated_at = now()
      where id in (
        select id
        from direct_realtime_outbox
        where
          realtime_dispatched = false
          and (processing_lease_expires_at is null or processing_lease_expires_at <= now())
        order by created_at, id
        limit ${limit}
        for update skip locked
      )
      returning id
    `);
    const ids = claimed.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    return tx.select().from(directRealtimeOutbox).where(inArray(directRealtimeOutbox.id, ids)).orderBy(asc(directRealtimeOutbox.createdAt), asc(directRealtimeOutbox.id));
  });

  if (events.length === 0) return { processed: 0, drainedFull: false };

  const completedIds: string[] = [];
  for (const event of events) {
    try {
      await processDirectEvent(event);
      completedIds.push(event.id);
    } catch (err) {
      options.log?.error({ err, eventId: event.id, eventType: event.eventType, scope: event.scope }, "direct realtime outbox processing failed");
      await db
        .update(directRealtimeOutbox)
        .set({
          lastError: errorMessage(err),
          processingLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(directRealtimeOutbox.id, event.id));
    }
  }

  if (completedIds.length > 0) {
    await db
      .update(directRealtimeOutbox)
      .set({
        realtimeDispatched: true,
        lastError: null,
        processingLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(inArray(directRealtimeOutbox.id, completedIds));
  }

  return { processed: events.length, drainedFull: events.length >= limit };
}

export async function cleanupRealtimeOutbox(options: { log?: FastifyBaseLogger; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - env.REALTIME_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(eventOutbox)
    .where(and(
      eq(eventOutbox.realtimeDispatched, true),
      eq(eventOutbox.webhooksEnqueued, true),
      lt(eventOutbox.createdAt, cutoff),
    ))
    .returning({ id: eventOutbox.id });
  if (deleted.length > 0) {
    options.log?.info({ deletedCount: deleted.length, retentionDays: env.REALTIME_OUTBOX_RETENTION_DAYS }, "purged processed event outbox rows");
  }
  const stuck = await purgeStuckOutboxRows(eventOutbox, now, options.log, "event outbox");
  return deleted.length + stuck;
}

export async function cleanupDirectRealtimeOutbox(options: { log?: FastifyBaseLogger; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - env.REALTIME_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(directRealtimeOutbox)
    .where(and(
      eq(directRealtimeOutbox.realtimeDispatched, true),
      lt(directRealtimeOutbox.createdAt, cutoff),
    ))
    .returning({ id: directRealtimeOutbox.id });
  if (deleted.length > 0) {
    options.log?.info({ deletedCount: deleted.length, retentionDays: env.REALTIME_OUTBOX_RETENTION_DAYS }, "purged processed direct realtime outbox rows");
  }
  const stuck = await purgeStuckOutboxRows(directRealtimeOutbox, now, options.log, "direct realtime outbox");
  return deleted.length + stuck;
}

/**
 * Backstop for rows that never dispatch (unhealthy realtime/webhook delivery). Past
 * OUTBOX_STUCK_RETENTION_DAYS a row is deleted regardless of dispatch status — an undelivered realtime
 * event this old is stale (clients have long since reconnected and re-fetched current state) and the
 * webhook side is past any retry horizon. This is a warn (not info) because it means events were
 * dropped without delivering: it should be rare and worth an operator's attention if it recurs.
 */
async function purgeStuckOutboxRows(
  table: typeof eventOutbox | typeof directRealtimeOutbox,
  now: Date,
  log: FastifyBaseLogger | undefined,
  label: string,
): Promise<number> {
  const cutoff = new Date(now.getTime() - env.OUTBOX_STUCK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(table).where(lt(table.createdAt, cutoff)).returning({ id: table.id });
  if (deleted.length > 0) {
    log?.warn(
      { deletedCount: deleted.length, retentionDays: env.OUTBOX_STUCK_RETENTION_DAYS },
      `purged stuck (undelivered) ${label} rows past backstop retention`,
    );
  }
  return deleted.length;
}

export function startRealtimeOutboxDispatcher(
  options: { log?: FastifyBaseLogger; pollMs?: number; onDeliveriesEnqueued?: () => void } = {},
): () => void {
  const pollMs = options.pollMs ?? env.REALTIME_OUTBOX_POLL_MS;
  let stopped = false;
  let listener: PoolClient | null = null;
  let listenerReady: Promise<PoolClient | null> | null = null;
  let listenerReleased = false;

  // Drain dispatcher: single-flight, and when a run drains a full batch it continues
  // immediately so a backlog of outbox rows isn't paced one batch per poll window. After
  // any run that processed rows we wake the webhook scheduler so deliveries this drain
  // enqueued go out promptly instead of waiting up to a full webhook poll interval.
  const dispatcher = startSweepScheduler({
    name: "realtime-outbox",
    task: async () => {
      const result = await processRealtimeOutbox({ log: options.log });
      // A drain that processed rows may have enqueued webhook deliveries; wake the webhook
      // scheduler now rather than letting them sit until its next poll. Over-triggering when
      // no webhook was actually due is harmless — an empty delivery run is cheap.
      if (result.processed > 0) options.onDeliveriesEnqueued?.();
      return result;
    },
    nextDelayMs: (result) => (result?.drainedFull ? 0 : pollMs),
    log: options.log,
  });

  // Wake on every realtime mutation: NOTIFY collapses the public-API → fanout latency to
  // the insert, with the poll loop as a durability fallback. trigger() respects the
  // dispatcher's single-flight guard, so a NOTIFY mid-run coalesces to one rerun.
  listenerReady = pool.connect().then(async (client) => {
    if (stopped) {
      client.release();
      return null;
    }
    client.on("notification", (message) => {
      if (message.channel === OUTBOX_NOTIFY_CHANNEL) dispatcher.trigger();
    });
    client.on("error", (err) => {
      options.log?.error({ err }, "event outbox listener failed");
    });
    try {
      await client.query(`listen ${OUTBOX_NOTIFY_CHANNEL}`);
    } catch (err) {
      options.log?.error({ err }, "event outbox listen failed");
    }
    if (stopped) {
      await client.query(`unlisten ${OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
      return null;
    }
    listener = client;
    return client;
  }).catch((err) => {
    options.log?.error({ err }, "event outbox listener could not start");
    return null;
  });

  const cleanup = startSweepScheduler({
    name: "realtime-outbox-cleanup",
    task: () => cleanupRealtimeOutbox({ log: options.log }),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: options.log,
  });

  return () => {
    stopped = true;
    dispatcher.stop();
    cleanup.stop();
    const releaseListener = async () => {
      if (listenerReleased) return;
      listenerReleased = true;
      const client = listener ?? await listenerReady;
      if (!client) return;
      listener = null;
      await client.query(`unlisten ${OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
    };
    void releaseListener();
  };
}

export function startDirectRealtimeOutboxDispatcher(
  options: { log?: FastifyBaseLogger; pollMs?: number } = {},
): () => void {
  const pollMs = options.pollMs ?? env.REALTIME_OUTBOX_POLL_MS;
  let stopped = false;
  let listener: PoolClient | null = null;
  let listenerReady: Promise<PoolClient | null> | null = null;
  let listenerReleased = false;

  const dispatcher = startSweepScheduler({
    name: "direct-realtime-outbox",
    task: () => processDirectRealtimeOutbox({ log: options.log }),
    nextDelayMs: (result) => (result?.drainedFull ? 0 : pollMs),
    log: options.log,
  });

  listenerReady = pool.connect().then(async (client) => {
    if (stopped) {
      client.release();
      return null;
    }
    client.on("notification", (message) => {
      if (message.channel === DIRECT_OUTBOX_NOTIFY_CHANNEL) dispatcher.trigger();
    });
    client.on("error", (err) => {
      options.log?.error({ err }, "direct realtime outbox listener failed");
    });
    try {
      await client.query(`listen ${DIRECT_OUTBOX_NOTIFY_CHANNEL}`);
    } catch (err) {
      options.log?.error({ err }, "direct realtime outbox listen failed");
    }
    if (stopped) {
      await client.query(`unlisten ${DIRECT_OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
      return null;
    }
    listener = client;
    return client;
  }).catch((err) => {
    options.log?.error({ err }, "direct realtime outbox listener could not start");
    return null;
  });

  const cleanup = startSweepScheduler({
    name: "direct-realtime-outbox-cleanup",
    task: () => cleanupDirectRealtimeOutbox({ log: options.log }),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: options.log,
  });

  return () => {
    stopped = true;
    dispatcher.stop();
    cleanup.stop();
    const releaseListener = async () => {
      if (listenerReleased) return;
      listenerReleased = true;
      const client = listener ?? await listenerReady;
      if (!client) return;
      listener = null;
      await client.query(`unlisten ${DIRECT_OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
    };
    void releaseListener();
  };
}
