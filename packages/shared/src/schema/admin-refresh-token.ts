import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { adminUsers } from "./admin-user.js";

// Mirrors `refresh_tokens` but FKs `admin_users`, not `users`. A separate table (rather than reuse) is
// what makes admin/tenant session isolation hold at the storage layer — the tenant rotation logic is
// hard-wired to `refresh_tokens.userId`.
export const adminRefreshTokens = pgTable(
  "admin_refresh_token",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("admin_refresh_tokens_admin_user_id_idx").on(t.adminUserId),
  ],
);

export type AdminRefreshToken = typeof adminRefreshTokens.$inferSelect;
export type NewAdminRefreshToken = typeof adminRefreshTokens.$inferInsert;
