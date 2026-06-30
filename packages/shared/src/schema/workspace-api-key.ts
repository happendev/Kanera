import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const workspaceApiKeyScope = pgEnum("workspace_api_key_scope", ["read", "write", "admin"]);
export type WorkspaceApiKeyScope = (typeof workspaceApiKeyScope.enumValues)[number];

export const workspaceApiKeys = pgTable(
  "workspace_api_key",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scope: workspaceApiKeyScope("scope").notNull().default("read"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_api_keys_hash_uq").on(t.keyHash),
    index("workspace_api_keys_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
    index("workspace_api_keys_workspace_active_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type WorkspaceApiKey = typeof workspaceApiKeys.$inferSelect;
export type NewWorkspaceApiKey = typeof workspaceApiKeys.$inferInsert;
