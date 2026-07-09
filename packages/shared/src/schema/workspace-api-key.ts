import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const workspaceApiKeyScope = pgEnum("workspace_api_key_scope", ["read", "write", "admin"]);
export type WorkspaceApiKeyScope = (typeof workspaceApiKeyScope.enumValues)[number];

// Two kinds share this table (and the activity_events / comment `api_key_id` FKs that point at it):
//   - `workspace`: an integration credential pinned to one workspace, created by a workspace admin,
//     powers downgraded by `scope`. Acts as the creating user but reaches only `workspace_id`.
//   - `personal`: a user's own key. Not pinned to a workspace (`workspace_id` is null); when used it
//     is evaluated with the owner's real cross-workspace access (board content only) and attributes
//     activity to the owner, not to a key name. `scope` is ignored for personal keys.
export const workspaceApiKeyKind = pgEnum("workspace_api_key_kind", ["workspace", "personal"]);
export type WorkspaceApiKeyKind = (typeof workspaceApiKeyKind.enumValues)[number];

export const workspaceApiKeys = pgTable(
  "workspace_api_key",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: workspaceApiKeyKind("kind").notNull().default("workspace"),
    // Null for personal keys. Cascade-deletes workspace keys when their workspace is removed.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Required for workspace keys; an optional private label for personal keys (never shown in activity).
    name: text("name"),
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
    // Listing a user's personal keys keys off created_by_id, not workspace_id.
    index("workspace_api_keys_creator_active_idx")
      .on(t.createdById, t.createdAt)
      .where(sql`${t.revokedAt} is null`),
    // Enforce the kind invariant at the database: workspace keys are pinned + named, personal keys
    // are unpinned. Keeps a future bug from producing a workspace key with no workspace, or vice versa.
    check(
      "workspace_api_keys_kind_shape",
      sql`(${t.kind} = 'workspace' and ${t.workspaceId} is not null and ${t.name} is not null)
        or (${t.kind} = 'personal' and ${t.workspaceId} is null)`,
    ),
  ],
);

export type WorkspaceApiKey = typeof workspaceApiKeys.$inferSelect;
export type NewWorkspaceApiKey = typeof workspaceApiKeys.$inferInsert;
