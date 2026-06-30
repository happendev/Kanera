import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { inviteTokens } from "./invite-token.js";
import { memberRole } from "./member-roles.js";
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
    role: memberRole("role").notNull().default("editor"),
  },
  (t) => [
    primaryKey({ columns: [t.inviteId, t.workspaceId] }),
    index("invite_workspace_grants_workspace_id_idx").on(t.workspaceId),
  ],
);

export type InviteWorkspaceGrant = typeof inviteWorkspaceGrants.$inferSelect;
export type NewInviteWorkspaceGrant = typeof inviteWorkspaceGrants.$inferInsert;
