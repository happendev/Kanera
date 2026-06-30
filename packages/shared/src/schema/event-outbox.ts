import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ServerEventName, ServerToClientEvents } from "../events/index.js";
import { boards } from "./board.js";
import { workspaces } from "./workspace.js";

export type EventOutboxScope = "workspace" | "board";

export type EventOutboxPayload<E extends ServerEventName = ServerEventName> = Parameters<ServerToClientEvents[E]>[0];

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    scope: text("scope").notNull().$type<EventOutboxScope>(),
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
    index("event_outbox_pending_idx")
      .on(t.processingLeaseExpiresAt, t.createdAt)
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
