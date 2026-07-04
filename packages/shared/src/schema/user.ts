import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clientRole } from "./client-roles.js";
import { citext, clients } from "./client.js";

export const users = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    clientRole: clientRole("client_role").notNull().default("member"),
    email: citext("email").notNull(),
    // Timestamp the email was proven (code verified at signup or on an email change).
    // Null only for legacy rows created before verification existed; the signup flow
    // always sets it now since accounts are created after the code is verified.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    timezone: text("timezone").notNull().default("UTC"),
    lastOnlineAt: timestamp("last_online_at", { withTimezone: true }),
    // Set when a downgrade-to-free suspends members beyond the free cap. Suspended users are blocked
    // from authenticating (login/refresh/API key) but their data is retained; cleared on upgrade.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    // Set when an admin removes the member from their organisation. The row stays in place so
    // historical author/audit references remain valid, but the user no longer authenticates or
    // consumes seats.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    // Set by a platform admin to soft-delete the user. Hides them from tenant listings and blocks auth;
    // the row is retained so historical author/audit references stay valid. Recoverable until purged.
    // Distinct from `removedAt` (org-admin removal) and `suspendedAt` (plan/admin suspension).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    index("users_client_id_created_at_idx").on(t.clientId, t.createdAt),
    index("users_client_id_client_role_idx").on(t.clientId, t.clientRole),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
