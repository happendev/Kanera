import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { WORKSPACE_ROLES } from "./member-roles.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const workspaceMembers = pgTable(
  "workspace_member",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull().default("member"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_members_role_ck", valueIn(t.role, WORKSPACE_ROLES)),
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_id_idx").on(t.userId),
    index("workspace_members_workspace_role_idx").on(t.workspaceId, t.role),
  ],
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
