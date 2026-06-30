import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

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
    name: text("name").notNull(),
    url: text("url").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    eventTypes: jsonb("event_types").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_endpoints_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
    index("webhook_endpoints_workspace_enabled_idx").on(t.workspaceId, t.enabled),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
