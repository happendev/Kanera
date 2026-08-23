import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ServerEventName, ServerToClientEvents } from "../events/index.js";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { workspaces } from "./workspace.js";

export const EVENT_OUTBOX_SCOPES = ["workspace", "board"] as const;
export type EventOutboxScope = (typeof EVENT_OUTBOX_SCOPES)[number];

export type EventOutboxPayload<E extends ServerEventName = ServerEventName> = Parameters<ServerToClientEvents[E]>[0];

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    scope: text("scope", { enum: EVENT_OUTBOX_SCOPES }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    boardId: uuid("board_id").references(() => boards.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull().$type<ServerEventName>(),
    payload: jsonb("payload").notNull().$type<EventOutboxPayload>(),
    realtimeDispatched: boolean("realtime_dispatched").notNull().default(false),
    webhooksEnqueued: boolean("webhooks_enqueued").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processingLeaseExpiresAt: timestamp("processing_lease_expires_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("event_outbox_scope_ck", valueIn(t.scope, EVENT_OUTBOX_SCOPES)),
    // Leads on the claim query's own ordering (created_at, id) so the dispatcher can walk the index
    // and stop at LIMIT. Leading on processing_lease_expires_at instead forced a Sort of the whole
    // pending set on every claim, which is exactly the wrong shape under a backlog — the only time
    // the pending set is large. The lease predicate becomes a cheap filter: rows leased at any
    // moment are bounded by (dispatchers x batch size), and the lease is short.
    index("event_outbox_pending_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.realtimeDispatched} = false or ${t.webhooksEnqueued} = false`),
    index("event_outbox_processed_created_at_idx")
      .on(t.createdAt)
      .where(sql`${t.realtimeDispatched} = true and ${t.webhooksEnqueued} = true`),
    index("event_outbox_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
    index("event_outbox_board_created_at_idx").on(t.boardId, t.createdAt),
  ],
);

export type EventOutbox = typeof eventOutbox.$inferSelect;
export type NewEventOutbox = typeof eventOutbox.$inferInsert;
