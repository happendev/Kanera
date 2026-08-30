import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const WORKSPACE_API_KEY_SCOPES = ["read", "write", "admin"] as const;
export type WorkspaceApiKeyScope = (typeof WORKSPACE_API_KEY_SCOPES)[number];

// Personal keys are evaluated with the owner's live access everywhere; `scope` only caps what the
// credential may do within that access. `admin` is deliberately not offered: the access layer
// treats personal scope as binary (`read` downgrades org/workspace/board authority, anything else
// grants the owner's full power), so a third value would mean nothing.
export const PERSONAL_API_KEY_SCOPES = ["read", "write"] as const;
export type PersonalApiKeyScope = (typeof PERSONAL_API_KEY_SCOPES)[number];

// Two kinds share this table (and the activity_events / comment `api_key_id` FKs that point at it):
//   - `workspace`: an integration credential pinned to one workspace, created by a workspace admin,
//     powers downgraded by `scope`. Acts as the creating user but reaches only `workspace_id`.
//   - `personal`: a user's own identity-wide key. Not pinned to a workspace (`workspace_id` is
//     null); when used it is evaluated with the owner's live access in every organisation and
//     attributes activity to the owner, not to a key name. `scope` caps what it may do within that
//     access: `read` downgrades the authority it borrows, `write` grants the owner's full power.
export const WORKSPACE_API_KEY_KINDS = ["workspace", "personal"] as const;
export type WorkspaceApiKeyKind = (typeof WORKSPACE_API_KEY_KINDS)[number];

export const workspaceApiKeys = pgTable(
  "workspace_api_key",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: text("kind", { enum: WORKSPACE_API_KEY_KINDS }).notNull().default("workspace"),
    // Null for personal keys. Cascade-deletes workspace keys when their workspace is removed.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    // For a personal credential this is the issuance/default organisation, retained for audit and
    // deterministic context on routes without a target resource. It is not an authorization pin.
    // Workspace credentials continue to derive their hard boundary from workspace_id.
    clientId: uuid("client_id").references(() => clients.id),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Required for workspace keys; an optional private label for personal keys (never shown in activity).
    name: text("name"),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scope: text("scope", { enum: WORKSPACE_API_KEY_SCOPES }).notNull().default("read"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_api_keys_kind_ck", valueIn(t.kind, WORKSPACE_API_KEY_KINDS)),
    check("workspace_api_keys_scope_ck", valueIn(t.scope, WORKSPACE_API_KEY_SCOPES)),
    uniqueIndex("workspace_api_keys_hash_uq").on(t.keyHash),
    index("workspace_api_keys_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
    index("workspace_api_keys_workspace_active_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.revokedAt} is null`),
    // Listing a user's personal keys keys off created_by_id, not workspace_id.
    index("workspace_api_keys_creator_active_idx")
      .on(t.createdById, t.createdAt)
      .where(sql`${t.revokedAt} is null`),
    // Personal keys must retain their issuance organisation; workspace keys derive it from
    // workspace_id. Authorization deliberately does not use this shape check as a tenant boundary.
    check(
      "workspace_api_keys_kind_shape",
      sql`(${t.kind} = 'workspace' and ${t.workspaceId} is not null and ${t.name} is not null)
        or (${t.kind} = 'personal' and ${t.workspaceId} is null and ${t.clientId} is not null)`,
    ),
  ],
);

export type WorkspaceApiKey = typeof workspaceApiKeys.$inferSelect;
