import { boardMembers, boards, clientMembers, clients, workspaces, type AuthMethod } from "@kanera/shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db.js";
import { createMfaChallenge, getMfaCredential } from "./mfa.js";

/**
 * Whether `userId` must hold an enabled second factor to use `activeClientId`.
 *
 * The active organisation's own policy applies directly. A host organisation's security policy also
 * follows its data: board-only guests must satisfy it even though authentication and MFA credentials
 * still belong to the guest's single home identity.
 */
export async function requiresMfaForAccess(userId: string, activeClientId: string, activeRequiresMfa: boolean): Promise<boolean> {
  if (activeRequiresMfa) return true;
  const [guestPolicy] = await db
    .select({ id: boardMembers.boardId })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(and(
      eq(boardMembers.userId, userId),
      ne(clients.id, activeClientId),
      eq(clients.requireMfa, true),
      sql`not exists (
        select 1 from ${clientMembers} cm
        where cm.client_id = ${clients.id}
          and cm.user_id = ${userId}
      )`,
    ))
    .limit(1);
  return !!guestPolicy;
}

export type MfaEnrollmentRequired = { status: "mfa_enrollment_required"; challengeToken: string };

/**
 * Product rule (hosted sign-in providers): an organisation's MFA requirement is satisfied by a
 * session signed in through Google, Microsoft or GitHub. Kanera cannot see whether the provider
 * itself enforced a second factor; organisations that require MFA accept that trade for easier
 * team sign-in. A factor the user enabled on their own account is still asked for at sign-in.
 */
function authMethodSatisfiesOrganisationMfa(authMethod: AuthMethod | undefined): boolean {
  return !!authMethod && authMethod !== "password";
}

/**
 * The enrollment challenge a session-issuing path must return instead of tokens when the policy
 * applies and the user has no enabled factor yet. Password login, invite acceptance, invite-driven
 * signup and organisation switches all funnel through this so no entry point can hand out a session
 * that the next refresh would reject.
 */
export async function mfaEnrollmentRequiredFor(
  userId: string,
  active: { clientId: string; requireMfa: boolean },
  authMethod: AuthMethod,
): Promise<MfaEnrollmentRequired | null> {
  if (authMethodSatisfiesOrganisationMfa(authMethod)) return null;
  if (!(await requiresMfaForAccess(userId, active.clientId, active.requireMfa))) return null;
  if ((await getMfaCredential({ kind: "user", id: userId }))?.enabledAt) return null;
  return { status: "mfa_enrollment_required", challengeToken: createMfaChallenge({ kind: "user", id: userId }, "enroll") };
}

/** Refresh and org switches refuse a session the organisation's MFA policy would not have issued. */
export async function organisationMfaBlocksSession(
  userId: string,
  active: { clientId: string; requireMfa: boolean },
  authMethod: AuthMethod | undefined,
): Promise<boolean> {
  if (authMethodSatisfiesOrganisationMfa(authMethod)) return false;
  if (!(await requiresMfaForAccess(userId, active.clientId, active.requireMfa))) return false;
  return !(await getMfaCredential({ kind: "user", id: userId }))?.enabledAt;
}
