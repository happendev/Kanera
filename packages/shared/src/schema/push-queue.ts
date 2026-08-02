import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
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

export const PUSH_QUEUE_CHANNELS = ["webPush", "ntfy", "gotify", "webhook"] as const;
export type PushQueueChannel = (typeof PUSH_QUEUE_CHANNELS)[number];

export const PUSH_QUEUE_STATUS = {
  queued: "queued",
  success: "success",
  error: "error",
  immediate: "immediate",
  cancelled: "cancelled",
} as const;

export type PushQueueStatus = (typeof PUSH_QUEUE_STATUS)[keyof typeof PUSH_QUEUE_STATUS];
export const PUSH_QUEUE_STATUSES = Object.values(PUSH_QUEUE_STATUS) as [
  PushQueueStatus,
  ...PushQueueStatus[],
];

export interface PushNotificationContent {
  kind: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  ttl?: number;
}

export interface PushQueuePayload {
  notification: {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    tag?: string;
    renotify?: boolean;
    data: {
      kind: string;
      onActionClick?: {
        default: {
          operation: "navigateLastFocusedOrOpen";
          url: string;
        };
      };
    };
  };
  ttl?: number;
}

export interface PersonalNotificationQueuePayload {
  kind: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
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
    reason: text("reason", { enum: PUSH_QUEUE_REASONS }).notNull(),
    channel: text("channel", { enum: PUSH_QUEUE_CHANNELS }).notNull().default("webPush"),
    // Legacy web-push readers rely on this inferred payload type. Personal-channel rows use the
    // same JSONB column with a channel-discriminated content shape and cast at their adapter edge.
    payload: jsonb("payload").notNull().$type<PushQueuePayload>(),
    status: text("status", { enum: PUSH_QUEUE_STATUSES }).notNull().default(PUSH_QUEUE_STATUS.queued),
    retries: integer("retries").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("push_queue_reason_ck", valueIn(t.reason, PUSH_QUEUE_REASONS)),
    check("push_queue_channel_ck", valueIn(t.channel, PUSH_QUEUE_CHANNELS)),
    check("push_queue_status_ck", valueIn(t.status, PUSH_QUEUE_STATUSES)),
    index("push_queue_status_created_at_idx").on(t.status, t.createdAt),
    index("push_queue_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("push_queue_created_at_idx").on(t.createdAt),
  ],
);

export type PushQueue = typeof pushQueue.$inferSelect;
export type NewPushQueue = typeof pushQueue.$inferInsert;
