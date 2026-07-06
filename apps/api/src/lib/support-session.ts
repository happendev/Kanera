import { clients, users } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db.js";

export interface SupportSessionTarget {
  userId: string;
  userEmail: string;
  orgName: string;
}

// Resolve the user a support session should act as: an *active owner* of the target org (oldest first).
// The minted token hardcodes role:"owner" and the schema/audit trail state the session acts as the org
// owner, so the acted-as user must genuinely be an owner — never a silent fall-back to a lesser role,
// which would make the token's claimed role diverge from reality. Acting as the owner gives the operator
// full setup access, and /me resolves against the target org. The operator's real identity is preserved
// in the support claims + audit row, never lost by acting as the owner.
//
// Excludes suspended/removed/soft-deleted owners: acting as a deactivated account would let a support
// session do things the account itself can no longer do, and tenant JWT auth performs no per-request
// user-status check, so the token would keep working for its full TTL. A soft-deleted org is likewise
// off-limits. A *suspended* org is intentionally still supportable — investigating a suspended tenant is
// a legitimate support task, and every action stays attributed to the operator. Returns null when the
// org has no active owner to act as.
export async function resolveSupportTargetOwner(clientId: string): Promise<SupportSessionTarget | null> {
  const [target] = await db
    .select({ userId: users.id, userEmail: users.email, orgName: clients.name })
    .from(users)
    .innerJoin(clients, eq(clients.id, users.clientId))
    .where(and(
      eq(users.clientId, clientId),
      eq(users.clientRole, "owner"),
      isNull(users.removedAt),
      isNull(users.suspendedAt),
      isNull(users.deletedAt),
      isNull(clients.deletedAt),
    ))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return target ?? null;
}
