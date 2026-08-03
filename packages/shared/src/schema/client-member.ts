import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { CLIENT_ROLES } from "./client-roles.js";
import { clients } from "./client.js";
import { users } from "./user.js";

export const clientMembers = pgTable(
  "client_member",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientRole: text("client_role", { enum: CLIENT_ROLES }).notNull().default("member"),
    // Suspension and removal belong to one organisation. Neither state disables the user's
    // identity or their memberships in other organisations.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("client_members_client_role_ck", valueIn(t.clientRole, CLIENT_ROLES)),
    primaryKey({ columns: [t.clientId, t.userId] }),
    index("client_members_user_id_idx").on(t.userId),
    index("client_members_active_idx")
      .on(t.clientId, t.clientRole)
      .where(sql`${t.suspendedAt} is null and ${t.removedAt} is null`),
  ],
);

export type ClientMember = typeof clientMembers.$inferSelect;
export type NewClientMember = typeof clientMembers.$inferInsert;
