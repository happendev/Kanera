import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { eventOutbox } from "./event-outbox.js";
import { webhookEndpoints } from "./webhook-endpoint.js";
import { workspaces } from "./workspace.js";

export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", ["queued", "delivering", "success", "failed"]);
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatus.enumValues)[number];

export interface WebhookPayload {
  id: string;
  type: string;
  workspaceId: string;
  boardId?: string;
  cardId?: string;
  occurredAt: string;
  data: unknown;
}

export const webhookDeliveries = pgTable(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    outboxEventId: uuid("outbox_event_id").references(() => eventOutbox.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().$type<WebhookPayload>(),
    status: webhookDeliveryStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_created_at_idx").on(t.endpointId, t.createdAt),
    index("webhook_deliveries_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
    index("webhook_deliveries_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    uniqueIndex("webhook_deliveries_endpoint_outbox_event_uq")
      .on(t.endpointId, t.outboxEventId)
      .where(sql`${t.outboxEventId} is not null`),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
