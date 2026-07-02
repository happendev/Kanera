import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";

// Append-only audit trail for superadmin cross-tenant support sessions. Each row records a
// platform operator (identified by an env-allowlisted email) minting a short-lived token that acts
// as a user inside another organisation. The minted token carries only the session id; this table
// is the durable record of who impersonated whom, when, and why, so the "who really did this" is
// never lost even though the token itself acts as the target org's owner.
export const supportSessions = pgTable(
  "support_session",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Audit evidence must survive deletion of the people/orgs it references, so every FK is nullable
    // with ON DELETE SET NULL and is paired with an immutable identity snapshot (email/org name)
    // captured at session start. Deleting an operator, org, or target user nulls the FK but leaves
    // the human-readable record intact — the row is never destroyed by a cascade.
    superadminUserId: uuid("superadmin_user_id").references(() => users.id, { onDelete: "set null" }),
    superadminEmail: text("superadmin_email").notNull(),
    targetClientId: uuid("target_client_id").references(() => clients.id, { onDelete: "set null" }),
    // Immutable snapshot of the org name at session start (survives org deletion).
    targetOrgName: text("target_org_name").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    // Immutable snapshot of the acted-as user's email at session start (survives user deletion).
    targetUserEmail: text("target_user_email").notNull(),
    reason: text("reason").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // When the minted token stops being valid (mirrors the token's exp).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Revocation marker set when the operator explicitly ends the session. Support-token
    // authentication requires this to remain null, while expiresAt provides the automatic cutoff.
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("support_sessions_superadmin_user_id_idx").on(t.superadminUserId),
    index("support_sessions_target_client_id_idx").on(t.targetClientId),
  ],
);

export type SupportSession = typeof supportSessions.$inferSelect;
export type NewSupportSession = typeof supportSessions.$inferInsert;
