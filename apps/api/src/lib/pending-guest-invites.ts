import { boardInvitations, clientMembers, users, workspaces } from "@kanera/shared/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

/**
 * Open board invitations in `clientId` that would create a guest: their email does not belong to an
 * active member of this organisation (email is globally unique, so a matching same-org user means an
 * internal invite that stays). Join `boardInvitations` to `boards` and `workspaces` before applying.
 */
export function pendingGuestInviteCondition(clientId: string): SQL {
  return and(
    eq(workspaces.clientId, clientId),
    isNull(boardInvitations.acceptedAt),
    isNull(boardInvitations.revokedAt),
    sql`not exists (
          select 1 from ${users}
          inner join ${clientMembers}
            on ${clientMembers.userId} = ${users.id}
           and ${clientMembers.clientId} = ${clientId}
           and ${clientMembers.suspendedAt} is null
           and ${clientMembers.removedAt} is null
          where ${users.email} = ${boardInvitations.email}
            and ${users.deletedAt} is null
        )`,
  )!;
}
