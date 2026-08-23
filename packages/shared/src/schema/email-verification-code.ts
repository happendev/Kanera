import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { citext } from "./client.js";
import { users } from "./user.js";

// Why both purposes share one table: signup and email-change use the identical
// "email a 6-digit code, prove ownership before we write the address" flow. The
// purpose discriminates them so a signup code can never satisfy an email change
// (or vice versa) for the same address.
export const EMAIL_VERIFICATION_PURPOSES = ["signup", "email_change"] as const;

export const emailVerificationCodes = pgTable(
  "email_verification_code",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // citext mirrors users.email so lookups match the address case-insensitively.
    email: citext("email").notNull(),
    codeHash: text("code_hash").notNull(),
    purpose: text("purpose", { enum: EMAIL_VERIFICATION_PURPOSES }).notNull(),
    // Set for email_change (the user requesting the change); null for signup, where
    // no account exists yet.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // A 6-digit code is low entropy, so the real protections against guessing are this
    // attempt counter (capped in the verify path), the short expiry, and the per-IP
    // send rate limit — not the hash.
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_verification_codes_purpose_ck", valueIn(t.purpose, EMAIL_VERIFICATION_PURPOSES)),
    index("email_verification_code_email_purpose_idx").on(t.email, t.purpose),
  ],
);

export type EmailVerificationCode = typeof emailVerificationCodes.$inferSelect;
