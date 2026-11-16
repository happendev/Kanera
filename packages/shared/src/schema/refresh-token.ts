import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { AUTH_METHODS } from "./user-identity.js";
import { users } from "./user.js";

export const refreshTokens = pgTable(
  "refresh_token",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    // How this session family was signed in. Rotation copies it forward; refresh and org switches
    // read it because an organisation's MFA requirement is satisfied by provider sign-in.
    authMethod: text("auth_method", { enum: AUTH_METHODS }).notNull().default("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("refresh_tokens_user_id_idx").on(t.userId),
    check("refresh_token_auth_method_ck", valueIn(t.authMethod, AUTH_METHODS)),
  ],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
