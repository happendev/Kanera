import { check, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { inviteTokens } from "./invite-token.js";
import { WORKSPACE_ROLES } from "./member-roles.js";
import { workspaces } from "./workspace.js";

export const inviteWorkspaceGrants = pgTable(
  "invite_workspace_grant",
  {
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => inviteTokens.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull().default("member"),
  },
  (t) => [
    check("invite_workspace_grants_role_ck", valueIn(t.role, WORKSPACE_ROLES)),
    primaryKey({ columns: [t.inviteId, t.workspaceId] }),
    index("invite_workspace_grants_workspace_id_idx").on(t.workspaceId),
  ],
);

export type InviteWorkspaceGrant = typeof inviteWorkspaceGrants.$inferSelect;
export type NewInviteWorkspaceGrant = typeof inviteWorkspaceGrants.$inferInsert;
