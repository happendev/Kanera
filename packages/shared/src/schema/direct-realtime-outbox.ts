import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ServerEventName, ServerToClientEvents } from "../events/index.js";
import { clients } from "./client.js";
import { users } from "./user.js";

export type DirectRealtimeOutboxScope = "user" | "client";
export type DirectRealtimeOutboxPayload<E extends ServerEventName = ServerEventName> = Parameters<ServerToClientEvents[E]>[0];

export const directRealtimeOutbox = pgTable(
  "direct_realtime_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    scope: text("scope").notNull().$type<DirectRealtimeOutboxScope>(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull().$type<ServerEventName>(),
    payload: jsonb("payload").notNull().$type<DirectRealtimeOutboxPayload>(),
    realtimeDispatched: boolean("realtime_dispatched").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processingLeaseExpiresAt: timestamp("processing_lease_expires_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "direct_realtime_outbox_scope_target_chk",
      sql`(${t.scope} = 'user' and ${t.userId} is not null and ${t.clientId} is null) or (${t.scope} = 'client' and ${t.clientId} is not null and ${t.userId} is null)`,
    ),
    index("direct_realtime_outbox_pending_idx")
      .on(t.processingLeaseExpiresAt, t.createdAt)
      .where(sql`${t.realtimeDispatched} = false`),
    index("direct_realtime_outbox_processed_created_at_idx")
      .on(t.createdAt)
      .where(sql`${t.realtimeDispatched} = true`),
    index("direct_realtime_outbox_user_created_at_idx").on(t.userId, t.createdAt),
    index("direct_realtime_outbox_client_created_at_idx").on(t.clientId, t.createdAt),
  ],
);

export type DirectRealtimeOutbox = typeof directRealtimeOutbox.$inferSelect;
export type NewDirectRealtimeOutbox = typeof directRealtimeOutbox.$inferInsert;
