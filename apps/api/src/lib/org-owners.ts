import { clientMembers, users } from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Counts active owners of an org. Used to block demoting/removing the last owner, which would leave a
// tenant with no one able to administer it. Excludes org-removed rows; a caller inside a soft-delete flow
// should run this in the same tx so the guard sees the just-applied state.
export async function countOwners(clientId: string, tx: Tx = db): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.clientRole, "owner"),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ));
  return row?.count ?? 0;
}
