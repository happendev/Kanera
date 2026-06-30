import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clientRole } from "./client-roles.js";
import { clients } from "./client.js";
import { memberRole } from "./member-roles.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const inviteTokens = pgTable(
  "invite_token",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    orgRole: clientRole("org_role").notNull().default("member"),
    role: memberRole("role").notNull().default("editor"),
    email: text("email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invite_tokens_client_id_idx").on(t.clientId),
    index("invite_tokens_workspace_id_idx").on(t.workspaceId),
  ],
);

export type InviteToken = typeof inviteTokens.$inferSelect;
export type NewInviteToken = typeof inviteTokens.$inferInsert;
