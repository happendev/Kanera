import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { adminUsers } from "./admin-user.js";
import { users } from "./user.js";

// Tenant and portal identities remain separate, but share the same MFA implementation. Exactly one
// owner column is populated so neither identity domain can accidentally authenticate as the other.
export const mfaCredentials = pgTable("mfa_credential", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  adminUserId: uuid("admin_user_id").references(() => adminUsers.id, { onDelete: "cascade" }),
  encryptedSecret: text("encrypted_secret").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  recoveryCodesAcknowledgedAt: timestamp("recovery_codes_acknowledged_at", { withTimezone: true }),
  // Per-credential brute-force lockout for the second factor. The per-IP limiter fails open on a
  // cache outage, so this durable counter is what actually caps TOTP guessing against one account.
  failedVerifyAttempts: integer("failed_verify_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  // Highest TOTP timestep already accepted. A code at or below this step is a replay and is rejected,
  // closing the ~90s reuse window that OTP validation with a skew window would otherwise allow.
  lastTotpStep: bigint("last_totp_step", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mfa_credentials_user_id_uq").on(t.userId),
  uniqueIndex("mfa_credentials_admin_user_id_uq").on(t.adminUserId),
  check("mfa_credentials_one_owner_ck", sql`num_nonnulls(${t.userId}, ${t.adminUserId}) = 1`),
]);

export const mfaRecoveryCodes = pgTable("mfa_recovery_code", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  credentialId: uuid("credential_id").notNull().references(() => mfaCredentials.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("mfa_recovery_codes_credential_id_idx").on(t.credentialId)]);
