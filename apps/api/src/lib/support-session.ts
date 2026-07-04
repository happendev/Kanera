import { clients, users } from "@kanera/shared/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";

export interface SupportSessionTarget {
  userId: string;
  userEmail: string;
  orgName: string;
}

// Resolve the user a support session should act as: the org's highest-privilege active user
// (owner → admin → member, oldest first). Acting as the owner gives the operator full setup access, and
// /me resolves against the target org. The operator's real identity is preserved in the support claims +
// audit row, never lost by acting as the owner. Returns null when the org has no active user to act as.
export async function resolveSupportTargetOwner(clientId: string): Promise<SupportSessionTarget | null> {
  const [target] = await db
    .select({ userId: users.id, userEmail: users.email, orgName: clients.name })
    .from(users)
    .innerJoin(clients, eq(clients.id, users.clientId))
    .where(and(eq(users.clientId, clientId), isNull(users.removedAt), isNull(users.suspendedAt)))
    .orderBy(sql`case ${users.clientRole} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(users.createdAt))
    .limit(1);
  return target ?? null;
}
