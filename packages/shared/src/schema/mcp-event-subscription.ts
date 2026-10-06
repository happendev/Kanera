import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { workspaces } from "./workspace.js";
import { users } from "./user.js";
import { workspaceApiKeys } from "./workspace-api-key.js";
import { oauthClients, oauthGrants } from "./oauth.js";
import { eventOutbox } from "./event-outbox.js";
import { WEBHOOK_DELIVERY_STATUSES } from "./webhook-delivery.js";
import type { McpEventArguments, McpEventOccurrence } from "../dto/mcp-events.js";

// deliveryStatus.lastError categories from the events draft. They are deliberately coarse: raw
// endpoint status lines or bodies would turn subscribe refreshes into a response oracle for
// attacker-chosen URLs.
export const MCP_DELIVERY_ERRORS = ["connection_refused", "timeout", "tls_error", "http_4xx", "http_5xx", "challenge_failed"] as const;
export type McpDeliveryError = (typeof MCP_DELIVERY_ERRORS)[number];

export const mcpEventSubscriptions = pgTable("mcp_event_subscription", {
  id: text("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  boardId: uuid("board_id").references(() => boards.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ownerApiKeyId: uuid("owner_api_key_id").references(() => workspaceApiKeys.id, { onDelete: "cascade" }),
  ownerAgentGrantId: uuid("owner_agent_grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
  ownerServiceClientId: text("owner_service_client_id").references(() => oauthClients.clientId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  arguments: jsonb("arguments").notNull().$type<McpEventArguments>(),
  url: text("url").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  previousEncryptedSecret: text("previous_encrypted_secret"),
  secretRotationUntil: timestamp("secret_rotation_until", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  lastError: text("last_error", { enum: MCP_DELIVERY_ERRORS }),
  failedSince: timestamp("failed_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("mcp_subscription_owner_ck", sql`(${t.ownerApiKeyId} is null) <> (${t.ownerAgentGrantId} is null)`),
  check("mcp_subscription_last_error_ck", valueIn(t.lastError, MCP_DELIVERY_ERRORS)),
  index("mcp_subscription_workspace_event_idx").on(t.workspaceId, t.name, t.expiresAt),
  // Subscribe limit checks, the verification cache and credential-revocation cascades all filter
  // by owner; without these every refresh scans the table under the principal's advisory lock.
  index("mcp_subscription_owner_key_idx").on(t.ownerApiKeyId, t.expiresAt),
  index("mcp_subscription_owner_grant_idx").on(t.ownerAgentGrantId, t.expiresAt),
]);
export const mcpEventDeliveries = pgTable("mcp_event_delivery", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  subscriptionId: text("subscription_id").notNull().references(() => mcpEventSubscriptions.id, { onDelete: "cascade" }),
  outboxEventId: uuid("outbox_event_id").references(() => eventOutbox.id, { onDelete: "set null" }),
  payload: jsonb("payload").notNull().$type<McpEventOccurrence>(),
  status: text("status", { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  responseStatus: integer("response_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("mcp_delivery_status_ck", valueIn(t.status, WEBHOOK_DELIVERY_STATUSES)),
  index("mcp_delivery_pending_idx").on(t.nextAttemptAt).where(sql`${t.status} in ('queued', 'delivering')`),
  uniqueIndex("mcp_delivery_subscription_outbox_uq").on(t.subscriptionId, t.outboxEventId),
]);
export type McpEventSubscription = typeof mcpEventSubscriptions.$inferSelect;
