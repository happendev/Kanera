import type { dto } from "@kanera/shared";
import { isLocale, type Locale } from "@kanera/shared/locales";
import {
  clientMembers,
  clients,
  inviteTokens,
  inviteWorkspaceGrants,
  userAcquisitions,
  userIdentities,
  users,
  workspaceMembers,
  type SignInProvider,
  type User,
} from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { captureWorkspaceMemberJoined } from "../lib/analytics-milestones.js";
import { sendHostedBillingEmail } from "../lib/billing-emails.js";
import { emitBoardInvitationAccepted, loadBoardInvitationGrants, loadRedeemableBoardInvitation, redeemBoardInvitationInTx, type BoardInvitationGrant, type RedeemableBoardInvitation } from "../lib/board-invitation-redemption.js";
import { pinAdminToWorkspaceBoards, pinOrgAdminToClientBoards } from "../lib/board-membership.js";
import { isClientAdminRole } from "../lib/client-membership.js";
import { AppError, conflict, unauthorized } from "../lib/errors.js";
import { sendInternalSignupNotification } from "../lib/internal-notification-emails.js";
import { notifyAdminsOrgInviteAccepted } from "../lib/invite-accepted-notifications.js";
import { applyInviteBoardGrantsInTx, emitInviteBoardGrants, type AppliedInviteBoardGrants } from "../lib/invite-board-grants.js";
import { withSignedMedia } from "../lib/media-keys.js";
import { ANALYTICS_EVENT_VERSION, productAnalytics } from "../lib/product-analytics.js";
import { getConfiguredS3StorageConfig } from "../lib/storage/index.js";
import { assertOrgMemberLimit, assertSeatPoolAvailable } from "../lib/tier-limits.js";
import { hashOpaqueToken } from "../lib/tokens.js";
import { emitToClientDurable } from "../realtime/emit.js";

type AnalyticsAttribution = dto.SignupBody["analyticsAttribution"];

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

function activeInviteCondition(token: string) {
  return and(
    eq(inviteTokens.tokenHash, hashOpaqueToken(token)),
    isNull(inviteTokens.revokedAt),
    sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
  );
}

export function duplicateSignupMessage(intent: { inviteToken?: string | null; boardInviteToken?: string | null }) {
  return intent.boardInviteToken || intent.inviteToken
    ? "An account already exists for this email. Sign in to accept the invite."
    : "email already registered";
}

/**
 * Resolves the board invitation a signup carries and enforces that it was sent to this address.
 * Shared by password and provider signups so neither can redeem an invitation meant for someone else.
 */
export async function loadSignupBoardInvitation(params: {
  email: string;
  inviteToken?: string | null;
  boardInviteToken?: string | null;
}): Promise<RedeemableBoardInvitation | null> {
  const boardInvitation = params.boardInviteToken
    ? await loadRedeemableBoardInvitation({ token: params.boardInviteToken })
    : null;
  // Fail loud only when the board invite is the sole signup intent. Alongside a valid org
  // invite, a stale board token (they rotate when boards are bundled onto a pending invitation)
  // is ignored rather than blocking the stronger, still-valid invitation.
  if (params.boardInviteToken && !boardInvitation && !params.inviteToken) {
    throw unauthorized("This board invitation is invalid or has expired.");
  }
  if (boardInvitation && boardInvitation.email.toLowerCase() !== params.email.toLowerCase()) {
    throw new AppError(
      403,
      "BOARD_INVITE_EMAIL_MISMATCH",
      "This invitation was sent to a different email address. Sign up with the invited address.",
    );
  }
  return boardInvitation;
}

/** Rejects a signup for an address that already has an account, steering invitees to sign in. */
export async function assertEmailAvailableForSignup(params: {
  email: string;
  inviteToken?: string | null;
  boardInvitation: RedeemableBoardInvitation | null;
}) {
  const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, params.email)).limit(1);
  if (!existingUser) return;
  const message = duplicateSignupMessage({ inviteToken: params.inviteToken, boardInviteToken: params.boardInvitation ? "present" : null });
  if (params.inviteToken) {
    const [invite] = await db
      .select({ orgName: clients.name })
      .from(inviteTokens)
      .innerJoin(clients, eq(clients.id, inviteTokens.clientId))
      .where(activeInviteCondition(params.inviteToken))
      .limit(1);
    if (invite) throw new AppError(409, "ACCOUNT_EXISTS", message, { orgName: invite.orgName });
  }
  if (params.boardInvitation) {
    throw new AppError(409, "ACCOUNT_EXISTS", message, { orgName: params.boardInvitation.orgName, boardInvite: true });
  }
  throw conflict(message);
}

export type CreateAccountParams = {
  email: string;
  emailVerified: boolean;
  /** Null for a provider-only account; password login then never matches. */
  passwordHash: string | null;
  displayName: string;
  orgName: string;
  locale: Locale | null;
  inviteToken?: string | null;
  boardInviteToken?: string | null;
  boardInvitation: RedeemableBoardInvitation | null;
  analyticsAttribution?: AnalyticsAttribution;
  identity?: { provider: SignInProvider; subject: string; email: string };
};

export type CreatedAccount = {
  user: User;
  hasWorkspace: boolean;
  workspaceIds: string[];
  orgName: string;
  orgRole: "owner" | "admin" | "member";
  acceptedInvite: boolean;
  boardGrants: AppliedInviteBoardGrants;
  redeemedInvite: { invitation: RedeemableBoardInvitation; grants: BoardInvitationGrant[] } | null;
  boardInviteRedirect: string | null;
};

/**
 * Creates the identity, its home organisation (or joins the invited one), and every membership the
 * invitations grant, in one transaction. A seat or concurrency failure rolls all of it back.
 * The caller maps unique violations to its duplicate-account error.
 */
export async function createAccount(params: CreateAccountParams): Promise<CreatedAccount> {
  return db.transaction(async (tx) => {
    let clientId: string;
    let orgName: string;
    let orgRole: "owner" | "admin" | "member";
    let workspaceGrants: Array<{ workspaceId: string; role: "admin" | "member" }> = [];
    let acceptedInvite = false;
    let acceptedInviteId: string | null = null;
    let redeemedInvite: { invitation: RedeemableBoardInvitation; grants: BoardInvitationGrant[] } | null = null;
    const boardInvitation = params.boardInvitation;

    if (params.inviteToken) {
      acceptedInvite = true;
      const [invite] = await tx
        .select({
          id: inviteTokens.id,
          clientId: inviteTokens.clientId,
          orgRole: inviteTokens.orgRole,
          orgName: clients.name,
        })
        .from(inviteTokens)
        .innerJoin(clients, eq(clients.id, inviteTokens.clientId))
        .where(activeInviteCondition(params.inviteToken))
        .limit(1);
      if (!invite) throw unauthorized("invalid invite");
      clientId = invite.clientId;
      orgName = invite.orgName;
      orgRole = invite.orgRole;
      acceptedInviteId = invite.id;
      // Hard gate on the free-tier member cap: this is the point where a person actually joins
      // the org. Runs inside the signup transaction; the helper takes a tenant row lock so
      // concurrent invite acceptances serialize and cannot race past the cap. On trials the free cap
      // no-ops and seats are unlimited; paid subscriptions still gate against purchased capacity.
      await assertOrgMemberLimit(clientId, tx);
      await assertSeatPoolAvailable(clientId, tx);
      workspaceGrants = await tx
        .select({ workspaceId: inviteWorkspaceGrants.workspaceId, role: inviteWorkspaceGrants.role })
        .from(inviteWorkspaceGrants)
        .where(eq(inviteWorkspaceGrants.inviteId, invite.id));
    } else {
      const [client] = await tx
        .insert(clients)
        .values({
          // A board-only guest still needs a home client for the identity/JWT/media tenancy
          // invariant, but it is intentionally private and invisible in the signup journey.
          name: boardInvitation ? "Private" : params.orgName,
          storageConfig: getConfiguredS3StorageConfig() ?? { kind: "local" },
          // In hosted mode a new org starts on a time-boxed trial. currentPeriodEnd is the
          // trial end consumed by the trial-expiry sweep and surfaced to the UI; once it lapses
          // the org reverts to free. A board-invite guest's silent home org must NOT enter that
          // lifecycle: the sweeps select purely on billingStatus='trialing' and would otherwise
          // email trial warnings and a downgrade notice for a trial the guest was never told
          // about (their signup deliberately sends only the welcome email). Their org starts on
          // the free plan; they can begin a trial later by choosing to upgrade.
          ...(env.KANERA_DEPLOYMENT_MODE === "hosted"
            ? boardInvitation
              ? { pushEnabled: true }
              : {
                pushEnabled: true,
                plan: "paid" as const,
                billingStatus: "trialing" as const,
                currentPeriodEnd: new Date(Date.now() + env.HOSTED_TRIAL_DAYS * 86_400_000),
              }
            : {}),
        })
        .returning();
      clientId = client!.id;
      orgName = client!.name;
      orgRole = "owner";
    }

    const [user] = await tx
      .insert(users)
      .values({
        clientId,
        activeClientId: clientId,
        email: params.email,
        emailVerifiedAt: params.emailVerified ? new Date() : null,
        passwordHash: params.passwordHash,
        displayName: params.displayName,
        timezone: "UTC",
        locale: params.locale,
      })
      .returning();

    if (params.identity) {
      await tx.insert(userIdentities).values({
        userId: user!.id,
        provider: params.identity.provider,
        providerSubject: params.identity.subject,
        email: params.identity.email,
        lastUsedAt: new Date(),
      });
    }

    const attribution = params.analyticsAttribution;
    // Only consent-stamped hosted acquisition is durable. Legacy/no-consent signups still
    // work, and a member's private attribution never overwrites the organisation creator's.
    if (env.KANERA_DEPLOYMENT_MODE === "hosted" && attribution?.consent_version === 1
      && attribution.consented_at && attribution.captured_at) {
      await tx.insert(userAcquisitions).values({ userId: user!.id, attribution });
    }

    await tx.insert(clientMembers).values({
      clientId,
      userId: user!.id,
      clientRole: orgRole,
      createdById: acceptedInvite ? null : user!.id,
    });
    if (!acceptedInvite) {
      await tx.update(clients).set({ createdByUserId: user!.id }).where(eq(clients.id, clientId));
    }

    if (boardInvitation) {
      // The outer read gives a clear pre-verification error. Revalidation here is the
      // concurrency boundary; a seat failure or concurrent redemption rolls back the account,
      // private client, and every board membership together.
      const currentInvitation = await loadRedeemableBoardInvitation({ token: params.boardInviteToken! }, tx);
      if (!currentInvitation) throw conflict("invitation already accepted");
      // A board invite from the org this signup just joined via inviteToken is moot: org
      // membership supersedes guest access, and board_members rows are for cross-organisation
      // guests only (the accept route rejects the same combination). Skip rather than fail so
      // the org-invite signup still completes; the host can revoke the leftover invitation.
      if (currentInvitation.hostClientId !== clientId) {
        const grants = await loadBoardInvitationGrants(currentInvitation, tx);
        await redeemBoardInvitationInTx(tx, {
          invitation: currentInvitation,
          grants,
          userId: user!.id,
          redeemerEmail: user!.email,
          targetClientId: clientId,
          createdById: currentInvitation.invitedById,
        });
        redeemedInvite = { invitation: currentInvitation, grants };
      }
    }

    if (workspaceGrants.length > 0) {
      await tx.insert(workspaceMembers).values(
        workspaceGrants.map((g) => ({
          workspaceId: g.workspaceId,
          userId: user!.id,
          role: g.role,
        })),
      );
      // Board membership is the content-access model for normal users: a workspace-admin grant
      // alone opens workspace settings but not the boards themselves. Materialize the pinned
      // editor rows the promote path writes, or an invited admin gets 403 on every existing board.
      for (const grant of workspaceGrants) {
        if (grant.role === "admin") await pinAdminToWorkspaceBoards(tx, grant.workspaceId, user!.id);
      }
    }

    // After workspace grants so a workspace-admin pin from this invite is kept over a board grant.
    // Admin invites carry no board grants (create rejects them): org authority pins every board below.
    const boardGrants: AppliedInviteBoardGrants = acceptedInviteId
      ? await applyInviteBoardGrantsInTx(tx, { inviteId: acceptedInviteId, clientId, userId: user!.id })
      : { members: [], workspaceMembers: [] };

    // An accepted organisation-admin invite is another org-role assignment path. Materialize
    // its inherited board access before signup commits so existing standalone rosters stay whole.
    if (orgRole === "owner" || orgRole === "admin") {
      await pinOrgAdminToClientBoards(tx, clientId, user!.id);
    }

    return {
      user: user!,
      hasWorkspace: workspaceGrants.length > 0,
      workspaceIds: workspaceGrants.map((grant) => grant.workspaceId),
      orgName: orgName!,
      orgRole,
      acceptedInvite,
      boardGrants,
      redeemedInvite,
      boardInviteRedirect: redeemedInvite ? `/b/${redeemedInvite.grants[0]!.boardId}` : null,
    };
  });
}

/**
 * Everything a committed signup announces: analytics, welcome/trial mail, the staff notification,
 * and the membership events an invite acceptance owes open admin rosters.
 */
export async function announceCreatedAccount(app: FastifyInstance, result: CreatedAccount, context: {
  analyticsAttribution?: AnalyticsAttribution;
  signInMethod: "password" | SignInProvider;
  fallbackLocale: Locale;
  log: FastifyBaseLogger;
}) {
  const attribution = context.analyticsAttribution;
  // Account creation is authoritative here: the user and organisation transaction has committed.
  // Analytics is fire-and-forget and can never turn a successful signup into a failed request.
  void productAnalytics.capture({
    event: "registration_completed",
    distinctId: result.user.id,
    organizationId: result.user.clientId,
    properties: {
      user_id: result.user.id,
      signup_method: context.signInMethod,
      source: attribution?.source ?? "direct",
      medium: attribution?.medium ?? "none",
      campaign: attribution?.campaign ?? "none",
      event_version: ANALYTICS_EVENT_VERSION,
    },
  });
  // Single source for every trial-start side effect (analytics below, email switch further
  // down): a signup that joined an existing org or redeemed a board invite starts no trial,
  // and its silent home org was created without trial billing columns to match.
  const startsHostedTrial = env.KANERA_DEPLOYMENT_MODE === "hosted" && !result.acceptedInvite && !result.redeemedInvite;
  if (startsHostedTrial) {
    void productAnalytics.capture({
      event: "trial_started",
      distinctId: result.user.id,
      organizationId: result.user.clientId,
      properties: {
        // Billing is organisation-scoped in Kanera; the guide's workspace_id maps to that
        // billing account for commercial events rather than to one child workspace.
        workspace_id: result.user.clientId,
        plan_code: "pro_trial",
        billing_period: "not_selected",
        event_version: ANALYTICS_EVENT_VERSION,
      },
    });
    // Keep the established lifecycle event while adding the activation vocabulary used by the
    // new value-to-upgrade funnel. Both are emitted from the same committed signup boundary.
    void productAnalytics.capture({
      event: "trial_activated",
      distinctId: result.user.id,
      organizationId: result.user.clientId,
      properties: {
        workspace_id: result.user.clientId,
        plan_code: "pro_trial",
        billing_period: "not_selected",
        event_version: ANALYTICS_EVENT_VERSION,
      },
    });
  }

  if (result.redeemedInvite) {
    await emitBoardInvitationAccepted(app, {
      invitation: result.redeemedInvite.invitation,
      grants: result.redeemedInvite.grants,
      user: result.user,
    });
  }

  // A new hosted owner gets the trial-start message below, which now includes the account-ready
  // context and trial next steps. Avoid sending a second generic welcome email in the same minute.
  const locale = isLocale(result.user.locale) ? result.user.locale : context.fallbackLocale;
  if (!startsHostedTrial) await app.mailer.sendWelcome(result.user.email, result.user.displayName, locale);
  await sendInternalSignupNotification(
    result.acceptedInvite
      ? { type: "invite_accepted", displayName: result.user.displayName, email: result.user.email, orgName: result.orgName }
      : {
        type: "signup",
        displayName: result.user.displayName,
        email: result.user.email,
        orgName: result.orgName,
        // The team follows up by hand, so it needs to know which channel brought this person in.
        attribution: attribution
          ? {
            source: attribution.source,
            medium: attribution.medium,
            campaign: attribution.campaign,
            referringDomain: attribution.referring_domain,
            landingPage: attribution.landing_page,
          }
          : null,
      },
    { log: context.log },
  );
  if (startsHostedTrial) {
    const [client] = await db
      .select({ currentPeriodEnd: clients.currentPeriodEnd })
      .from(clients)
      .where(eq(clients.id, result.user.clientId))
      .limit(1);
    await sendHostedBillingEmail(app.mailer, {
      clientId: result.user.clientId,
      kind: "pro_trial_started",
      trialEndsAt: client?.currentPeriodEnd ?? null,
      dedupeKey: `pro_trial_started:${result.user.clientId}`,
    }, { log: context.log });
  }
  if (result.acceptedInvite) {
    // Signup is also an organisation-membership mutation. Publish the same client event as the
    // authenticated acceptance path so open admin rosters and their seat usage converge without
    // waiting for a page refresh.
    await emitToClientDurable(result.user.clientId, "client:user:added", {
      clientId: result.user.clientId,
      user: withSignedMedia(result.user.clientId, {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.displayName,
        avatarUrl: result.user.avatarUrl,
        role: result.orgRole,
        createdAt: result.user.createdAt,
      }),
    });
    await emitInviteBoardGrants(result.boardGrants, { ...result.user, orgRole: result.orgRole });
    await captureWorkspaceMemberJoined({
      organizationId: result.user.clientId,
      workspaceIds: result.workspaceIds,
      // An org owner/admin who accepted an invite with no explicit workspace grants joins every
      // workspace; count that as one organisation-scoped acceptance rather than one per workspace.
      orgWide: result.workspaceIds.length === 0
        && isClientAdminRole(result.orgRole),
      actorId: result.user.id,
      joinSource: "invitation",
    });
    await notifyAdminsOrgInviteAccepted(app, {
      acceptedUserId: result.user.id,
      acceptedByName: result.user.displayName,
      acceptedByEmail: result.user.email,
      clientId: result.user.clientId,
      orgName: result.orgName,
      orgRole: result.orgRole,
    });
    // No Stripe change on acceptance: the new member occupies a pre-purchased pool seat (the signup
    // tx already gated on seat_limit via assertSeatPoolAvailable), and the billed quantity is the
    // seat_limit, not headcount. Capacity is only charged when the admin explicitly buys seats.
  }
}
