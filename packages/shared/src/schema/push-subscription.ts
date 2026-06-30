import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";

export const pushSubscriptions = pgTable(
  "push_subscription",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    keyP256dh: text("key_p256dh").notNull(),
    keyAuth: text("key_auth").notNull(),
    expirationTime: timestamp("expiration_time", { withTimezone: true }),
    contentEncoding: text("content_encoding"),
    deviceLabel: text("device_label"),
    userAgent: text("user_agent"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastError: text("last_error"),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint),
    index("push_subscriptions_user_id_idx").on(t.userId),
    index("push_subscriptions_client_id_user_id_idx").on(t.clientId, t.userId),
    index("push_subscriptions_user_id_active_idx")
      .on(t.userId, t.updatedAt)
      .where(sql`${t.disabledAt} is null`),
  ],
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;