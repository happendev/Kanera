import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { citext } from "./_citext.js";
import { users } from "./user.js";

// Hosted-only third-party sign-in. The provider list is application-owned (each one needs its own
// adapter and app registration), so it is a closed tuple rather than open text.
export const SIGN_IN_PROVIDERS = ["google", "microsoft", "github"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

// How a session was established. Carried on refresh tokens and access-token claims because an
// organisation's MFA requirement is satisfied by provider sign-in but not by a password alone.
export const AUTH_METHODS = ["password", ...SIGN_IN_PROVIDERS] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const userIdentities = pgTable(
  "user_identity",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: SIGN_IN_PROVIDERS }).notNull(),
    // The provider's stable account id (OIDC `sub`, GitHub numeric id). Never the email: provider
    // emails change, and matching on them after the first link would let a reassigned address
    // take over the Kanera account.
    providerSubject: text("provider_subject").notNull(),
    // The address the provider reported when the link was made, shown in account settings only.
    email: citext("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_identity_provider_subject_uq").on(t.provider, t.providerSubject),
    // One account per provider per user keeps "disconnect Google" unambiguous; it also serves the
    // per-user lookup, so no separate user_id index.
    uniqueIndex("user_identity_user_provider_uq").on(t.userId, t.provider),
    check("user_identity_provider_ck", valueIn(t.provider, SIGN_IN_PROVIDERS)),
  ],
);

export type UserIdentity = typeof userIdentities.$inferSelect;
