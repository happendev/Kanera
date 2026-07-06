import { adminAuditLogs } from "@kanera/shared/schema";
import type { Db } from "../db.js";

// Accepts the pool or an open transaction so audit writes land inside the same tx as the mutation they
// record — mirroring the tenant recordActivity pattern.
type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AdminAuditInput {
  adminUserId: string;
  // Stable dotted action id, e.g. "org.suspend", "user.role.update". Used for filtering/reporting.
  action: string;
  // Coarse subject class, e.g. "org", "user", "queue". Kept separate from `action` so we can list all
  // actions against a target type without parsing the action string.
  targetType: string;
  targetClientId?: string | null;
  targetUserId?: string | null;
  details?: Record<string, unknown> | null;
}

// Append-only audit write. Every admin mutation MUST call this inside its write transaction — the admin
// console has no realtime/activity fanout, so this row is the only durable record that the action happened.
export async function writeAdminAudit(tx: Tx, input: AdminAuditInput): Promise<void> {
  await tx.insert(adminAuditLogs).values({
    adminUserId: input.adminUserId,
    action: input.action,
    targetType: input.targetType,
    targetClientId: input.targetClientId ?? null,
    targetUserId: input.targetUserId ?? null,
    details: input.details ?? null,
  });
}
