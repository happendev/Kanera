import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { adminRole } from "./admin-roles.js";
import { citext } from "./client.js";

// Platform-staff accounts for the admin console. Deliberately separate from `users`: an admin email and
// a tenant email may coincide, and the two identity domains must stay independent (a tenant token must
// never authenticate here, and vice-versa). Auth uses its own JWT secret, cookie, and refresh table.
export const adminUsers = pgTable(
  "admin_user",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    email: citext("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    role: adminRole("role").notNull().default("staff"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    // Set to soft-disable an admin. Checked on every authenticated request (not just login) so revoking
    // access takes effect immediately without waiting for the short access token to expire.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("admin_users_email_uq").on(t.email),
  ],
);

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
