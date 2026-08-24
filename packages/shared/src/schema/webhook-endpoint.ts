import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { customFields } from "./custom-field.js";
import { users } from "./user.js";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("webhook_endpoints_provider_ck", valueIn(t.provider, WEBHOOK_ENDPOINT_PROVIDERS)),
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
