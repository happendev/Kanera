import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { adminUsers } from "./admin-user.js";
import { clients } from "./client.js";

// Append-only record of every admin-console mutation. This is the admin equivalent of the tenant
// `recordActivity` + realtime-emit pattern (which does not apply here) — a mutation route without a
// matching audit write is a defect.
//
// FK notes:
// - adminUserId uses `restrict` so we can never delete an admin that still has an audit trail.
// - targetClientId is `set null` so purging an org keeps its audit rows (with the reference nulled).
// - targetUserId intentionally has NO FK: soft/hard-deleting a user must not erase the audit trail of
//   the very action that deleted them.
export const adminAuditLogs = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetClientId: uuid("target_client_id").references(() => clients.id, { onDelete: "set null" }),
    // No FK by design — see table comment.
    targetUserId: uuid("target_user_id"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("admin_audit_logs_admin_user_id_created_at_idx").on(t.adminUserId, t.createdAt),
    index("admin_audit_logs_target_client_id_created_at_idx").on(t.targetClientId, t.createdAt),
    index("admin_audit_logs_created_at_idx").on(t.createdAt),
  ],
);

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLogs.$inferInsert;
