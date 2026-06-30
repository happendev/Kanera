import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";

export const PUSH_QUEUE_REASONS = [
  "test",
  "assigned",
  "mentioned",
  "comment",
  "dueDateChanged",
  "overdue",
  "watching",
] as const;
export type PushQueueReason = (typeof PUSH_QUEUE_REASONS)[number];

export const PUSH_QUEUE_STATUS = {
  queued: 0,
  success: 1,
  error: 2,
  immediate: 99,
} as const;

export type PushQueueStatus = (typeof PUSH_QUEUE_STATUS)[keyof typeof PUSH_QUEUE_STATUS];

export interface PushQueuePayload {
  kind: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  ttl?: number;
}

export const pushQueue = pgTable(
  "push_queue",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull().$type<PushQueueReason>(),
    payload: jsonb("payload").notNull().$type<PushQueuePayload>(),
    status: smallint("status").notNull().default(PUSH_QUEUE_STATUS.queued).$type<PushQueueStatus>(),
    retries: integer("retries").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("push_queue_status_created_at_idx").on(t.status, t.createdAt),
    index("push_queue_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("push_queue_created_at_idx").on(t.createdAt),
  ],
);

export type PushQueue = typeof pushQueue.$inferSelect;
export type NewPushQueue = typeof pushQueue.$inferInsert;
