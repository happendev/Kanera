import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { customFields } from "./custom-field.js";
import { oauthGrants } from "./oauth.js";
import { users } from "./user.js";
import { workspaceApiKeys } from "./workspace-api-key.js";
import { workspaces } from "./workspace.js";

export const WEBHOOK_ENDPOINT_PROVIDERS = ["generic", "slack", "discord", "telegram", "zulip"] as const;
export type WebhookEndpointProvider = (typeof WEBHOOK_ENDPOINT_PROVIDERS)[number];

export const CHAT_DESTINATION_PROVIDERS = ["slack", "discord", "telegram", "zulip"] as const;
export type ChatDestinationProvider = (typeof CHAT_DESTINATION_PROVIDERS)[number];

export const CHAT_DESTINATION_EVENT_TYPES = [
  "card_created",
  "status_changed",
  "priority_changed",
  "title_changed",
  "description_changed",
  "comment_created",
] as const;
export type ChatDestinationEventType = (typeof CHAT_DESTINATION_EVENT_TYPES)[number];

export const webhookEndpoints = pgTable(
  "webhook_endpoint",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider: text("provider", { enum: WEBHOOK_ENDPOINT_PROVIDERS }).notNull().default("generic"),
    name: text("name").notNull(),
    url: text("url"),
    encryptedSecret: text("encrypted_secret"),
    encryptedConfig: text("encrypted_config"),
    priorityFieldId: uuid("priority_field_id")
      .references(() => customFields.id, { onDelete: "set null" }),
    eventTypes: jsonb("event_types").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    enabled: boolean("enabled").notNull().default(true),
    // Connection-scoped endpoints. A non-admin agent (a write-scoped API key, or an interactive
    // OAuth grant) may subscribe to a workspace it is a member of, but it only ever sees and manages
    // the endpoints owned by its own connection; workspace admins see everything. Exactly one owner
    // column is set for a connection-scoped endpoint and both are null for an admin-created one.
    // CASCADE: revoking the connection removes the subscriptions nobody else can reach.
    ownerApiKeyId: uuid("owner_api_key_id").references(() => workspaceApiKeys.id, { onDelete: "cascade" }),
    ownerAgentGrantId: uuid("owner_agent_grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("webhook_endpoints_provider_ck", valueIn(t.provider, WEBHOOK_ENDPOINT_PROVIDERS)),
    check("webhook_endpoints_owner_ck", sql`${t.ownerApiKeyId} is null or ${t.ownerAgentGrantId} is null`),
    index("webhook_endpoints_owner_api_key_idx").on(t.ownerApiKeyId).where(sql`${t.ownerApiKeyId} is not null`),
    index("webhook_endpoints_owner_agent_grant_idx").on(t.ownerAgentGrantId).where(sql`${t.ownerAgentGrantId} is not null`),
    check(
      "webhook_endpoints_config_ck",
      sql`(
        (${t.provider} = 'generic' and ${t.url} is not null and ${t.encryptedSecret} is not null and ${t.encryptedConfig} is null)
        or
        (${t.provider} <> 'generic' and ${t.url} is null and ${t.encryptedSecret} is null and ${t.encryptedConfig} is not null)
      )`,
    ),
    index("webhook_endpoints_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
    index("webhook_endpoints_workspace_enabled_idx").on(t.workspaceId, t.enabled),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
