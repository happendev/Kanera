import { notifyAccountSecurityChange } from "../lib/account-security-notices.js";
import { dto } from "@kanera/shared";
import type { Locale } from "@kanera/shared/locales";
import {
  boardMembers,
  boards,
  clientMembers,
  clients,
  emailVerificationCodes,
  inviteTokens,
  inviteWorkspaceGrants,
  passwordResetTokens,
  refreshTokens,
  supportSessions,
  users,
  userAcquisitions,
  workspaceMembers,
  workspaces,
  mfaCredentials,
  type EmailVerificationPurpose,
} from "@kanera/shared/schema";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { clientIpForRequest } from "../lib/client-ip.js";
import { AppError, badRequest, conflict, forbidden, tooManyRequests, unauthorized } from "../lib/errors.js";
import { assertOrgMemberLimit, assertSeatPoolAvailable } from "../lib/tier-limits.js";
import { storageKeyFromMediaUrl, unsignedMediaUrl, withSignedMedia } from "../lib/media-keys.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter, type RateLimitPolicy } from "../lib/rate-limit.js";
import { sendHostedBillingEmail } from "../lib/billing-emails.js";
import { accountLocale, requestLocale } from "../lib/i18n/request-locale.js";
import { sendInternalSignupNotification } from "../lib/internal-notification-emails.js";
import { getConfiguredS3StorageConfig, getStorageForClient } from "../lib/storage/index.js";
import { avatarStorageKey } from "../lib/storage/keys.js";
import { notifyAdminsOrgInviteAccepted } from "../lib/invite-accepted-notifications.js";
import { applyInviteBoardGrantsInTx, emitInviteBoardGrants, type AppliedInviteBoardGrants } from "../lib/invite-board-grants.js";
import { emitBoardInvitationAccepted, loadBoardInvitationGrants, loadRedeemableBoardInvitation, redeemBoardInvitationInTx, type BoardInvitationGrant, type RedeemableBoardInvitation } from "../lib/board-invitation-redemption.js";
import { pinAdminToWorkspaceBoards, pinOrgAdminToClientBoards } from "../lib/board-membership.js";
import { hashOpaqueToken, newOpaqueToken, newVerificationCode } from "../lib/tokens.js";
import { emitToBoard, emitToClient, emitToClientDurable, emitToWorkspace } from "../realtime/emit.js";
import { newRefreshToken, rotateRefresh } from "./jwt.js";
import { hashPassword, needsPasswordRehash, verifyPassword, verifyPasswordTimingSafe } from "./password.js";
import { beginMfaEnrollment, createMfaChallenge, enableMfa, getMfaCredential, readMfaChallenge, regenerateRecoveryCodes, resetMfa, verifyMfaCode, verifyMfaLoginCode } from "./mfa.js";
import { ANALYTICS_EVENT_VERSION, productAnalytics } from "../lib/product-analytics.js";
import { captureWorkspaceMemberJoined } from "../lib/analytics-milestones.js";
import { isClientAdminRole, resolveActiveOrganisation, resolveActiveOrganisationContext, type ActiveOrganisation } from "../lib/client-membership.js";
import { disconnectSupportSessionSockets, disconnectUserRealtimeSockets } from "../realtime/io.js";
import { emitToUser } from "../realtime/emit.js";
import { mfaEnrollmentRequiredFor, organisationMfaBlocksSession, requiresMfaForAccess } from "./mfa-policy.js";
import { configuredSignInProviders } from "./providers/adapters.js";
import { providerAuthRoutes } from "./providers/routes.js";
import { announceCreatedAccount, assertEmailAvailableForSignup, createAccount, duplicateSignupMessage, isUniqueViolation, loadSignupBoardInvitation } from "./create-account.js";
import { authUserPayload as meResponseFor, issueUserSession as issueSession, REFRESH_COOKIE, refreshCookieOptions } from "./session.js";

const ALLOWED_AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

async function bootstrapOrganisationAfterFullDeletion(userId: string): Promise<{
  active: ActiveOrganisation;
  organisations: ActiveOrganisation[];
} | null> {
  const clientId = await db.transaction(async (tx) => {
    // Two simultaneous password/MFA completions must converge on one replacement organisation.
    const [identity] = await tx.select({ needsOrganisationOnLoginAt: users.needsOrganisationOnLoginAt })
      .from(users).where(eq(users.id, userId)).limit(1).for("update");
    const current = await resolveActiveOrganisationContext(userId, undefined, tx);
    if (current.active || !identity?.needsOrganisationOnLoginAt) return current.active?.clientId ?? null;
    const [client] = await tx.insert(clients).values({
      name: "Private",
      createdByUserId: userId,
      storageConfig: getConfiguredS3StorageConfig() ?? { kind: "local" },
      ...(env.KANERA_DEPLOYMENT_MODE === "hosted"
        ? {
          pushEnabled: true,
          plan: "paid" as const,
          billingStatus: "trialing" as const,
          currentPeriodEnd: new Date(Date.now() + env.HOSTED_TRIAL_DAYS * 86_400_000),
        }
        : {}),
    }).returning({ id: clients.id });
    await tx.insert(clientMembers).values({ clientId: client!.id, userId, clientRole: "owner", createdById: userId });
    // The prior tenant namespace is being destroyed, so an avatar anchored there cannot survive.
    await tx.update(users).set({
      clientId: client!.id,
      activeClientId: client!.id,
      avatarUrl: null,
      needsOrganisationOnLoginAt: null,
      updatedAt: new Date(),
    }).where(eq(users.id, userId));
    return client!.id;
  });
  if (!clientId) return null;
  const context = await resolveActiveOrganisationContext(userId, clientId);
  return context.active ? { active: context.active, organisations: context.organisations } : null;
}

async function emitProfileUpdated(userId: string, clientId: string, displayName: string, avatarUrl: string | null) {
  const payload = { userId, displayName, avatarUrl };
  const memberWorkspaces = await db
    .select({ workspaceId: workspaceMembers.workspaceId, clientId: workspaces.clientId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  const workspaceIds = [...new Set(memberWorkspaces.map((row) => row.workspaceId))];
  const workspaceBoards = workspaceIds.length
    ? await db.select({ boardId: boards.id, clientId: workspaces.clientId }).from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(inArray(boards.workspaceId, workspaceIds))
    : [];
  const guestBoards = await db
    .select({ boardId: boardMembers.boardId, clientId: workspaces.clientId })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(eq(boardMembers.userId, userId));
  const boardIds = [...new Set([...workspaceBoards, ...guestBoards].map((row) => row.boardId))];
  const clientIds = [...new Set([clientId, ...memberWorkspaces, ...workspaceBoards, ...guestBoards].map((row) =>
    typeof row === "string" ? row : row.clientId,
  ))];

  // Client fanout updates the user's other sessions and org directory. Workspace fanout covers
  // normal collaborators; board fanout is also required because guests intentionally do not join
  // workspace event rooms and would otherwise retain stale profile data.
  for (const relatedClientId of clientIds) emitToClient(relatedClientId, "user:profile:updated", payload);
  await Promise.all([
    ...workspaceIds.map((workspaceId) => emitToWorkspace(workspaceId, "user:profile:updated", payload)),
    ...boardIds.map((boardId) => emitToBoard(boardId, "user:profile:updated", payload)),
  ]);
}

// Email verification (signup + email change). The short expiry and attempt cap are
// the real defenses for a low-entropy 6-digit code; the per-IP send rate limit is
// the third leg.
const EMAIL_VERIFICATION_EXPIRY_MINUTES = 15;
const MAX_VERIFICATION_ATTEMPTS = 5;
// Rejected refresh cookies one IP may present per window before /auth/refresh answers 429. Generous
// enough that an office NAT whose users' cookies expire in the same minute is never caught.
const REFRESH_FAILURE_LIMIT = 30;
const REFRESH_FAILURE_WINDOW_MS = 60_000;
const PASSWORD_RESET_RECIPIENT_LIMIT = 3;
const PASSWORD_RESET_RECIPIENT_WINDOW_MS = 60 * 60_000;
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function normalizeTimezone(value: string | undefined): string {
  if (!value) return "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

export async function authRoutes(app: FastifyInstance) {
  // Per-IP brute-force / abuse throttle for unauthenticated auth endpoints. Valkey makes the
  // buckets global across API processes; keys stay action-scoped so login attempts do not drain
  // signup or password-reset allowance.
  const authRateLimiter = env.AUTH_RATE_LIMIT_ENABLED
    ? new FixedWindowRateLimiter()
    : null;
  if (authRateLimiter) app.addHook("onClose", async () => authRateLimiter.close());
  const passwordResetRecipientLimiter = new FixedWindowRateLimiter();
  app.addHook("onClose", async () => passwordResetRecipientLimiter.close());
  const authRateLimitPolicy: RateLimitPolicy = {
    limit: env.AUTH_RATE_LIMIT_MAX,
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  };
  const passwordResetRecipientPolicy: RateLimitPolicy = {
    limit: PASSWORD_RESET_RECIPIENT_LIMIT,
    windowMs: PASSWORD_RESET_RECIPIENT_WINDOW_MS,
  };
  function authRateLimit(action: string) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!authRateLimiter) return;
      const result = await authRateLimiter.check(`${action}:${clientIpForRequest(req)}`, authRateLimitPolicy);
      applyRateLimitHeaders(reply, result);
      if (!result.allowed) throw tooManyRequests();
    };
  }

  // /auth/refresh is unauthenticated (the cookie is the credential) and a presented cookie costs a
  // refresh_tokens lookup, so bogus cookies could drive database traffic without ever touching the
  // login throttle. Only rejected cookies count, so ordinary multi-tab and reconnect bursts, which
  // all succeed, never trip it. Missing cookies short-circuit before the lookup and are not counted.
  const refreshFailurePolicy: RateLimitPolicy = { limit: REFRESH_FAILURE_LIMIT, windowMs: REFRESH_FAILURE_WINDOW_MS };
  const refreshFailureKey = (req: FastifyRequest) => `refresh-failed:${clientIpForRequest(req)}`;
  async function rejectIfRefreshFailuresExceeded(req: FastifyRequest, reply: FastifyReply) {
    if (!authRateLimiter) return;
    const result = await authRateLimiter.wouldLimit(refreshFailureKey(req), refreshFailurePolicy);
    applyRateLimitHeaders(reply, result);
    if (!result.allowed) throw tooManyRequests();
  }
  async function recordRefreshFailure(req: FastifyRequest) {
    if (!authRateLimiter) return;
    await authRateLimiter.penalty(refreshFailureKey(req), refreshFailurePolicy);
  }

  app.get("/auth/config", async (): Promise<dto.AuthConfigResponse> => {
    const analytics = env.ANALYTICS_ENABLED
      && env.ANALYTICS_PROVIDER === "posthog"
      && env.KANERA_DEPLOYMENT_MODE === "hosted"
      && (env.KANERA_ENVIRONMENT === "production" || env.KANERA_ENVIRONMENT === "staging")
      && env.POSTHOG_PROJECT_KEY
      && env.POSTHOG_API_HOST
      ? { enabled: true as const, provider: "posthog" as const, projectKey: env.POSTHOG_PROJECT_KEY, apiHost: env.POSTHOG_API_HOST }
      : null;
    return {
      emailVerificationEnabled: env.EMAIL_VERIFICATION_ENABLED,
      signupsEnabled: env.SIGNUPS_ENABLED,
      turnstileSiteKey: turnstileEnabled() ? env.CLOUDFLARE_TURNSTILE_SITE_KEY! : null,
      kaneraEnvironment: env.KANERA_ENVIRONMENT,
      deploymentMode: env.KANERA_DEPLOYMENT_MODE,
      signInProviders: configuredSignInProviders().map((adapter) => adapter.id),
      analytics,
    };
  });

  function turnstileEnabled(): boolean {
    return env.KANERA_DEPLOYMENT_MODE === "hosted" && !!env.CLOUDFLARE_TURNSTILE_SITE_KEY && !!env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  }

  async function verifyTurnstile(req: FastifyRequest, token: string | undefined) {
    if (!turnstileEnabled()) return;
    if (!token) throw badRequest("security challenge required");

    const form = new URLSearchParams({
      secret: env.CLOUDFLARE_TURNSTILE_SECRET_KEY!,
      response: token,
      remoteip: clientIpForRequest(req),
    });
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, { method: "POST", body: form });
    if (!response.ok) {
      req.log.warn({ status: response.status }, "turnstile verification request failed");
      throw badRequest("security challenge failed");
    }
    const result = await response.json().catch(() => null);
    if (!isTurnstileSuccess(result)) {
      req.log.warn({ errorCodes: turnstileErrorCodes(result) }, "turnstile verification rejected auth request");
      throw badRequest("security challenge failed");
    }
  }

  function isTurnstileSuccess(value: unknown): boolean {
    return !!value && typeof value === "object" && (value as { success?: unknown }).success === true;
  }

  function turnstileErrorCodes(value: unknown): string[] {
    if (!value || typeof value !== "object") return [];
    const codes = (value as { "error-codes"?: unknown })["error-codes"];
    return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string") : [];
  }

  async function assertSignupOpenForIntent(params: { inviteToken?: string; boardInviteToken?: string }) {
    if (env.SIGNUPS_ENABLED) return;
    // An organisation invite is the strongest intent, so it is checked first: a stale board-invite
    // token accompanying a valid org invite (tokens rotate when boards are bundled onto a pending
    // invitation) must never block an otherwise-valid invited signup.
    if (params.inviteToken) {
      const [invite] = await db
        .select({ id: inviteTokens.id })
        .from(inviteTokens)
        .where(
          and(
            eq(inviteTokens.tokenHash, hashOpaqueToken(params.inviteToken)),
            isNull(inviteTokens.revokedAt),
            sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
          ),
        )
        .limit(1);
      if (invite) return;
    }
    if (params.boardInviteToken) {
      const invitation = await loadRedeemableBoardInvitation({ token: params.boardInviteToken });
      if (!invitation) throw unauthorized("invalid invite");
      return;
    }
    if (!params.inviteToken) throw forbidden("Signups are currently disabled.");
    throw unauthorized("invalid invite");
  }

  // Generate a fresh verification code, invalidate any prior unconsumed codes for the
  // same address+purpose (so only the newest is valid), persist the hash, and email
  // the raw code immediately. Delivery failures are logged but not surfaced so we
  // never leak whether the address exists via a different error shape.
  async function issueVerificationCode(params: {
    email: string;
    purpose: EmailVerificationPurpose;
    userId: string | null;
    /** The reader's language: the signup form's at signup, the account's for an email change. */
    locale: Locale;
    log: FastifyRequest["log"];
  }) {
    const { code, hash } = newVerificationCode();
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MINUTES * 60_000);
    await db.transaction(async (tx) => {
      await tx
        .update(emailVerificationCodes)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(emailVerificationCodes.email, params.email),
            eq(emailVerificationCodes.purpose, params.purpose),
            isNull(emailVerificationCodes.consumedAt),
          ),
        );
      await tx.insert(emailVerificationCodes).values({
        email: params.email,
        purpose: params.purpose,
        userId: params.userId,
        codeHash: hash,
        expiresAt,
      });
    });
    try {
      await app.mailer.sendEmailVerificationCode(params.email, code, EMAIL_VERIFICATION_EXPIRY_MINUTES, params.locale);
    } catch (err) {
      params.log.error({ err, purpose: params.purpose }, "failed to send verification code email");
    }
  }

  // Verify and consume the newest valid code for (email, purpose[, userId]). Every check
  // spends an attempt as a standalone write — this must persist even when the
  // caller's surrounding transaction later rolls back, otherwise the attempt cap is
  // defeated. Consuming (marking used) is conditional so a concurrent request cannot
  // redeem the same code twice. Throws badRequest on any failure.
  async function verifyAndConsumeCode(params: {
    email: string;
    purpose: EmailVerificationPurpose;
    code: string;
    userId?: string | null;
  }) {
    const [row] = await db
      .select({ id: emailVerificationCodes.id })
      .from(emailVerificationCodes)
      .where(
        and(
          eq(emailVerificationCodes.email, params.email),
          eq(emailVerificationCodes.purpose, params.purpose),
          isNull(emailVerificationCodes.consumedAt),
          gt(emailVerificationCodes.expiresAt, new Date()),
          ...(params.userId ? [eq(emailVerificationCodes.userId, params.userId)] : []),
        ),
      )
      .orderBy(desc(emailVerificationCodes.createdAt))
      .limit(1);
    if (!row) throw badRequest("invalid or expired verification code");
    // Spend an attempt before comparing, in one statement. Reading the counter and writing it back
    // let concurrent guesses all see the same value and try far more codes than the cap allows.
    const [claimed] = await db
      .update(emailVerificationCodes)
      .set({ attempts: sql`${emailVerificationCodes.attempts} + 1` })
      .where(and(eq(emailVerificationCodes.id, row.id), lt(emailVerificationCodes.attempts, MAX_VERIFICATION_ATTEMPTS)))
      .returning({ codeHash: emailVerificationCodes.codeHash });
    if (!claimed) throw badRequest("too many attempts; request a new code");
    if (claimed.codeHash !== hashOpaqueToken(params.code)) throw badRequest("invalid or expired verification code");
    const consumed = await db
      .update(emailVerificationCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailVerificationCodes.id, row.id), isNull(emailVerificationCodes.consumedAt)))
      .returning({ id: emailVerificationCodes.id });
    if (consumed.length === 0) throw badRequest("invalid or expired verification code");
  }

  // Re-confirms the account owner before a password-gated settings change. Accounts with a password
  // must use it (a stolen session alone cannot read their mailbox *and* know the password); accounts
  // that only sign in through a provider have no password, so a code emailed to the account stands in.
  async function assertStepUp(userId: string, proof: { currentPassword?: string; emailCode?: string }) {
    const [user] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw unauthorized();
    if (user.passwordHash) {
      if (!proof.currentPassword || !(await verifyPassword(user.passwordHash, proof.currentPassword))) throw unauthorized("invalid password");
      return;
    }
    if (!proof.emailCode) throw badRequest("verification code required");
    await verifyAndConsumeCode({ email: user.email, purpose: "step_up", code: proof.emailCode, userId });
  }

  // Step 1 of verify-before-account: email a code to the address the visitor wants to
  // register. Mirrors the signup duplicate-email check so an already-registered address
  // gets the same conflict here rather than after they enter a code.
  app.post("/auth/request-email-verification", { preHandler: authRateLimit("request-email-verification") }, async (req) => {
    const body = dto.requestEmailVerificationBody.parse(req.body);
    await assertSignupOpenForIntent({ inviteToken: body.inviteToken, boardInviteToken: body.boardInviteToken });
    // This endpoint sends mail before an account exists, so Turnstile is checked here to protect
    // the inbox path. The final signup step is then protected by the one-time email code.
    if (env.EMAIL_VERIFICATION_ENABLED) await verifyTurnstile(req, body.turnstileToken);
    // Verification can be disabled before SMTP is ready. A token-less request must then return ok
    // before ANY account probe — Turnstile is also skipped in this mode, so answering 409 for
    // registered addresses would hand bots an email-enumeration oracle. Invite-carrying requests
    // (whose tokens were themselves delivered by email) still get the existing-account steer below.
    if (!env.EMAIL_VERIFICATION_ENABLED && !body.inviteToken && !body.boardInviteToken) return { ok: true };
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) {
      if (body.inviteToken) {
        const [invite] = await db
          .select({ orgName: clients.name })
          .from(inviteTokens)
          .innerJoin(clients, eq(clients.id, inviteTokens.clientId))
          .where(and(
            eq(inviteTokens.tokenHash, hashOpaqueToken(body.inviteToken)),
            isNull(inviteTokens.revokedAt),
            sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
          ))
          .limit(1);
        if (invite) throw new AppError(409, "ACCOUNT_EXISTS", "An account already exists for this email. Sign in to accept the invite.", { orgName: invite.orgName });
      }
      if (body.boardInviteToken) {
        const invitation = await loadRedeemableBoardInvitation({ token: body.boardInviteToken });
        if (invitation) {
          throw new AppError(409, "ACCOUNT_EXISTS", "An account already exists for this email. Sign in to accept the invite.", {
            orgName: invitation.orgName,
            boardInvite: true,
          });
        }
      }
      throw conflict("email already registered");
    }
    // Verification can be disabled before SMTP is ready. Keep the endpoint benign for new
    // addresses, while preserving the invite-aware existing-account route above.
    if (!env.EMAIL_VERIFICATION_ENABLED) return { ok: true };
    // No account exists yet: write in the language the signup form is showing.
    await issueVerificationCode({ email: body.email, purpose: "signup", userId: null, locale: body.locale ?? requestLocale(req), log: req.log });
    return { ok: true };
  });

  app.post("/auth/signup", { preHandler: authRateLimit("signup") }, async (req, reply) => {
    const body = dto.signupBody.parse(req.body);
    await assertSignupOpenForIntent({ inviteToken: body.inviteToken, boardInviteToken: body.boardInviteToken });
    const boardInvitation = await loadSignupBoardInvitation(body);
    await assertEmailAvailableForSignup({ email: body.email, inviteToken: body.inviteToken, boardInvitation });

    if (!env.EMAIL_VERIFICATION_ENABLED) {
      await verifyTurnstile(req, body.turnstileToken);
    }

    // Verify mailbox ownership before creating the account. When the flag is on a code is
    // required; a code is always validated when present so the disabled-flag test harness
    // can still exercise the real verification path. Done before the write transaction so a
    // wrong-code attempt increment (see verifyAndConsumeCode) is not rolled back.
    let emailVerified = false;
    if (env.EMAIL_VERIFICATION_ENABLED || body.code !== undefined) {
      if (!body.code) throw badRequest("verification code required");
      await verifyAndConsumeCode({ email: body.email, purpose: "signup", code: body.code });
      emailVerified = true;
    }

    try {
      const result = await createAccount({
        email: body.email,
        emailVerified,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
        orgName: body.orgName,
        locale: body.locale ?? null,
        inviteToken: body.inviteToken,
        boardInviteToken: body.boardInviteToken,
        boardInvitation,
        analyticsAttribution: body.analyticsAttribution,
      });

      // An invite-driven signup joins an organisation (or a board-invite host) whose security policy may
      // already mandate MFA. The account now exists either way, so every side effect below still runs,
      // but tokens are withheld and the enrollment challenge is returned exactly as password login does.
      const joinedOrganisation = await resolveActiveOrganisation(result.user.id, result.user.clientId);
      const enrollment = joinedOrganisation ? await mfaEnrollmentRequiredFor(result.user.id, joinedOrganisation, "password") : null;
      let accessToken: string | null = null;
      if (!enrollment) {
        accessToken = app.jwt.sign({
          sub: result.user.id,
          cid: result.user.clientId,
          role: result.orgRole,
          amr: "password",
        });
        const refresh = newRefreshToken();
        await db
          .insert(refreshTokens)
          .values({ userId: result.user.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt, authMethod: "password" });

        reply.setCookie(REFRESH_COOKIE, refresh.raw, refreshCookieOptions());
      }
      await announceCreatedAccount(app, result, {
        analyticsAttribution: body.analyticsAttribution,
        signInMethod: "password",
        fallbackLocale: requestLocale(req),
        log: req.log,
      });

      if (enrollment) return enrollment;
      return { accessToken, user: { ...(await meResponseFor(result.user.id, result.user.clientId)), boardInviteRedirect: result.boardInviteRedirect } };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw conflict(duplicateSignupMessage(body));
      throw err;
    }
  });

  app.post("/auth/login", { preHandler: authRateLimit("login") }, async (req, reply) => {
    const body = dto.loginBody.parse(req.body);

    const [row] = await db
      .select({
        userId: users.id,
        passwordHash: users.passwordHash,
        deletedAt: users.deletedAt,
        needsOrganisationOnLoginAt: users.needsOrganisationOnLoginAt,
      })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    // Always run a password verification (against a dummy hash when the email is unknown) so
    // login response time doesn't reveal whether an account exists. Keep the error message
    // identical for both the missing-user and wrong-password cases.
    const passwordOk = await verifyPasswordTimingSafe(row?.passwordHash ?? null, body.password);
    if (!row || !passwordOk) throw unauthorized("invalid credentials");
    // Platform-admin soft-deletes block auth entirely; per-organisation removal merely removes that
    // membership and login falls back to another active one.
    // Use the generic credentials error so a deleted account is indistinguishable from a wrong password.
    if (row.deletedAt) throw unauthorized("invalid credentials");
    const credential = await getMfaCredential({ kind: "user", id: row.userId });
    if (credential?.enabledAt) return { status: "mfa_required" as const, challengeToken: createMfaChallenge({ kind: "user", id: row.userId }, "verify") };
    let organisationContext = await resolveActiveOrganisationContext(row.userId);
    if (!organisationContext.active && row.needsOrganisationOnLoginAt) {
      organisationContext = await bootstrapOrganisationAfterFullDeletion(row.userId) ?? organisationContext;
    }
    const active = organisationContext.active;
    if (!active) throw unauthorized("no active organisation membership");
    if (await requiresMfaForAccess(row.userId, active.clientId, active.requireMfa)) return { status: "mfa_enrollment_required" as const, challengeToken: createMfaChallenge({ kind: "user", id: row.userId }, "enroll") };

    const upgradedPasswordHash = row.passwordHash && needsPasswordRehash(row.passwordHash) ? await hashPassword(body.password) : null;
    if (upgradedPasswordHash) await db.update(users).set({ passwordHash: upgradedPasswordHash, updatedAt: new Date() }).where(eq(users.id, row.userId));
    return issueSession(app, row.userId, reply, active.clientId, organisationContext);
  });

  app.post("/auth/mfa/verify", { preHandler: authRateLimit("mfa") }, async (req, reply) => {
    const body = dto.mfaChallengeBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "verify"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential?.enabledAt || !(await verifyMfaLoginCode(credential, body.code))) throw unauthorized("invalid verification code");
    await bootstrapOrganisationAfterFullDeletion(challenge.id);
    return issueSession(app, challenge.id, reply, undefined, undefined, challenge.amr ?? "password");
  });

  // Organisation-enforced enrollment runs after password verification but before any access or refresh
  // token exists. The purpose-bound challenge is the only authority these three endpoints accept.
  app.post("/auth/mfa/required/enroll", { preHandler: authRateLimit("mfa-enroll") }, async (req) => {
    const body = dto.adminMfaEnrollmentStartBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, challenge.id)).limit(1);
    const active = await resolveActiveOrganisation(challenge.id);
    if (!user || !active || !(await requiresMfaForAccess(challenge.id, active.clientId, active.requireMfa))) throw unauthorized("MFA enrollment is not required");
    const result = await beginMfaEnrollment(challenge, user.email);
    return { secret: result.secret, otpauthUri: result.otpauthUri };
  });

  app.post("/auth/mfa/required/enroll/confirm", { preHandler: authRateLimit("mfa-enroll") }, async (req) => {
    const body = dto.adminMfaEnrollmentConfirmBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential || credential.enabledAt || !(await verifyMfaCode(credential, body.code, false))) throw unauthorized("invalid verification code");
    const recoveryCodes = await enableMfa(credential.id);
    await notifyAccountSecurityChange(app.mailer, { userId: challenge.id, event: "mfa_enabled", log: req.log });
    return { status: "recovery_codes_required" as const, recoveryCodes };
  });

  app.post("/auth/mfa/required/enroll/acknowledge", { preHandler: authRateLimit("mfa-enroll") }, async (req, reply) => {
    const body = dto.adminMfaEnrollmentStartBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential?.enabledAt) throw unauthorized("enrollment incomplete");
    await db.update(mfaCredentials).set({ recoveryCodesAcknowledgedAt: new Date(), updatedAt: new Date() }).where(eq(mfaCredentials.id, credential.id));
    return issueSession(app, challenge.id, reply);
  });

  app.get("/auth/mfa", { preHandler: app.authenticate }, async (req) => ({ enabled: !!(await getMfaCredential({ kind: "user", id: req.auth.sub }))?.enabledAt }));

  // Rate limited like the other second-factor routes: enrollment is password-gated, and when a
  // factor is already enabled it also consumes a code, so it must share the login throttle.
  app.post("/auth/mfa/enroll", { preHandler: [app.authenticate, authRateLimit("mfa")] }, async (req) => {
    const body = dto.mfaEnrollmentStartBody.parse(req.body);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    if (!user) throw unauthorized();
    await assertStepUp(req.auth.sub, body);
    // beginMfaEnrollment replaces the existing credential, which would silently leave the account
    // without an enabled factor if the new enrollment is abandoned. Replacing an enabled factor is
    // therefore equivalent to disabling it and must clear the same bar: a valid current code, with
    // the per-credential lockout applied.
    const existing = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (existing?.enabledAt) {
      if (!body.code || !(await verifyMfaLoginCode(existing, body.code))) throw unauthorized("invalid verification code");
    }
    const result = await beginMfaEnrollment({ kind: "user", id: req.auth.sub }, user.email);
    return { secret: result.secret, otpauthUri: result.otpauthUri };
  });

  app.post("/auth/mfa/enroll/confirm", { preHandler: app.authenticate }, async (req) => {
    const body = dto.mfaEnrollmentConfirmBody.parse(req.body);
    const credential = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (!credential || credential.enabledAt || !(await verifyMfaCode(credential, body.code, false))) throw badRequest("invalid verification code");
    const recoveryCodes = await enableMfa(credential.id);
    await notifyAccountSecurityChange(app.mailer, { userId: req.auth.sub, event: "mfa_enabled", log: req.log });
    return { recoveryCodes };
  });

  // These actions are password-gated, but they must share login's IP throttle and credential
  // lockout so a stolen session plus password cannot brute-force the six-digit second factor.
  app.post("/auth/mfa/recovery-codes", { preHandler: [app.authenticate, authRateLimit("mfa")] }, async (req) => {
    const body = dto.mfaProtectedActionBody.parse(req.body);
    const credential = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (!credential?.enabledAt) throw unauthorized();
    await assertStepUp(req.auth.sub, body);
    if (!(await verifyMfaLoginCode(credential, body.code))) throw unauthorized();
    const recoveryCodes = await regenerateRecoveryCodes(credential.id);
    await notifyAccountSecurityChange(app.mailer, { userId: req.auth.sub, event: "recovery_codes_regenerated", log: req.log });
    return { recoveryCodes };
  });

  app.delete("/auth/mfa", { preHandler: [app.authenticate, authRateLimit("mfa")] }, async (req) => {
    const body = dto.mfaProtectedActionBody.parse(req.body);
    const active = await resolveActiveOrganisation(req.auth.sub, req.auth.cid);
    const credential = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (!credential?.enabledAt) throw unauthorized();
    await assertStepUp(req.auth.sub, body);
    if (!(await verifyMfaLoginCode(credential, body.code))) throw unauthorized();
    // A user cannot leave themselves without a second factor while the active org (or a true guest
    // host org) mandates MFA — they would only be forced to re-enroll on next login anyway.
    if (!active || await requiresMfaForAccess(req.auth.sub, active.clientId, active.requireMfa)) throw forbidden("MFA is required by your organisation");
    await resetMfa({ kind: "user", id: req.auth.sub });
    await notifyAccountSecurityChange(app.mailer, { userId: req.auth.sub, event: "mfa_disabled", log: req.log });
    return { ok: true };
  });

  app.post("/auth/refresh", async (req, reply) => {
    const body = dto.refreshBody.parse(req.body ?? {});
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) {
      // Anonymous startup probes for an httpOnly refresh cookie it cannot inspect.
      req.log.debug({ refreshCookiePresent: false }, "refresh token missing");
      throw unauthorized();
    }

    await rejectIfRefreshFailuresExceeded(req, reply);
    const refresh = await rotateRefresh(raw);
    if (refresh.status === "reused") {
      req.log.warn({ userId: refresh.userId, refreshCookiePresent: true, refreshStatus: refresh.status }, "detected refresh token reuse; revoked active refresh tokens");
      await recordRefreshFailure(req);
      throw unauthorized();
    }
    if (refresh.status === "invalid") {
      req.log.warn({ refreshCookiePresent: true, refreshStatus: refresh.status }, "refresh token rejected");
      await recordRefreshFailure(req);
      throw unauthorized();
    }
    // Rotation succeeds independently of which tab-local organisation was requested. Persist the
    // fresh cookie before membership validation so a stale tab can retry without losing the family.
    if (refresh.status === "rotated") {
      reply.setCookie(REFRESH_COOKIE, refresh.fresh.raw, refreshCookieOptions());
    }

    const [identity] = await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, refresh.userId)).limit(1);
    if (!identity || identity.deletedAt) throw unauthorized();
    const organisationContext = await resolveActiveOrganisationContext(identity.id, body.clientId);
    const active = organisationContext.active;
    if (!active) {
      if (body.clientId) throw forbidden("organisation membership is not active");
      throw unauthorized("no active organisation membership");
    }
    if (await organisationMfaBlocksSession(identity.id, active, refresh.authMethod)) {
      throw forbidden("MFA is required by this organisation");
    }
    if (!body.clientId) {
      await db.update(users).set({ activeClientId: active.clientId, updatedAt: new Date() }).where(eq(users.id, identity.id));
    }
    const accessToken = app.jwt.sign({ sub: identity.id, cid: active.clientId, role: active.role, amr: refresh.authMethod });

    return { accessToken, user: await meResponseFor(identity.id, active.clientId, organisationContext.organisations) };
  });

  app.post("/auth/switch-org", { preHandler: app.authenticate }, async (req, reply) => {
    if (req.auth.authKind !== "user") throw forbidden();
    const body = dto.switchOrgBody.parse(req.body);
    const organisationContext = await resolveActiveOrganisationContext(req.auth.sub, body.clientId);
    const active = organisationContext.active;
    if (!active) throw forbidden("organisation membership is not active");
    if (await organisationMfaBlocksSession(req.auth.sub, active, req.auth.amr)) {
      throw forbidden("MFA is required by this organisation");
    }
    const session = await issueSession(app, req.auth.sub, reply, active.clientId, organisationContext, req.auth.amr);
    // Evict only after the replacement token exists so reconnecting clients cannot rejoin the old
    // organisation with the token that initiated the switch.
    disconnectUserRealtimeSockets(req.auth.sub);
    return session;
  });

  app.post("/auth/logout", async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (raw) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, hashOpaqueToken(raw)));
    }
    reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    return { ok: true };
  });

  // Self-close a support session from the web app's "Leave session" button. Minting now lives in the
  // management portal (POST /admin/orgs/:clientId/support-session); this endpoint only lets the support
  // token end its own session. Stamping endedAt fails the per-request row check in the auth plugin, so the
  // signed token stops working immediately. Admin-side revocation lives at /admin/support-sessions/:id/end.
  app.post("/auth/support-session/:id/end", { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);

    // A support token may only close its own session; nothing else can reach this endpoint's effect.
    if (req.auth.authKind !== "support" || req.auth.support?.sessionId !== id) throw forbidden();

    await db
      .update(supportSessions)
      .set({ endedAt: new Date() })
      .where(and(eq(supportSessions.id, id), isNull(supportSessions.endedAt)));
    disconnectSupportSessionSockets(id);
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticate }, async (req) => {
    return meResponseFor(req.auth.sub, req.auth.cid);
  });

  app.patch("/auth/me", { preHandler: app.authenticate }, async (req) => {
    // Email is deliberately not editable here — it goes through the verified two-step
    // flow below so the address is always proven before it lands on the account.
    const body = dto.updateMeBody.parse(req.body);
    const updates: Partial<typeof users.$inferInsert> = {};
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.timezone !== undefined) updates.timezone = normalizeTimezone(body.timezone);
    if (body.showCardKeys !== undefined) updates.showCardKeys = body.showCardKeys;
    if (body.showScratchpad !== undefined) updates.showScratchpad = body.showScratchpad;
    if (body.theme !== undefined) updates.theme = body.theme;
    if (body.accent !== undefined) updates.accent = body.accent;
    if (body.locale !== undefined) updates.locale = body.locale;
    if (Object.keys(updates).length > 0) {
      await db
        .update(users)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(users.id, req.auth.sub));
    }
    const me = await meResponseFor(req.auth.sub, req.auth.cid);
    // Appearance is account-scoped, so the user's other devices have to follow the change rather
    // than wait for their next session load. User-scoped on purpose — see the event contract.
    if (body.theme !== undefined || body.accent !== undefined) {
      emitToUser(req.auth.sub, "user:appearance:updated", { theme: me.theme, accent: me.accent });
    }
    return me;
  });

  // Step 1 of a verified email change: email a code to the NEW address so we confirm the
  // user controls it before we move their sign-in identity there. Rate limited per IP like
  // the other code-issuing endpoints.
  app.post(
    "/auth/me/email/request-verification",
    { preHandler: [app.authenticate, authRateLimit("request-email-verification")] },
    async (req) => {
      const body = dto.requestEmailChangeBody.parse(req.body);
      if (!env.EMAIL_VERIFICATION_ENABLED) return { ok: true };
      const [me] = await db.select({ email: users.email, locale: users.locale }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
      if (!me) throw unauthorized();
      // citext makes the stored email case-insensitive; compare the same way here.
      if (me.email.toLowerCase() === body.email.toLowerCase()) throw badRequest("that is already your email address");
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, body.email), ne(users.id, req.auth.sub)))
        .limit(1);
      if (existing) throw conflict("email already registered");
      await issueVerificationCode({ email: body.email, purpose: "email_change", userId: req.auth.sub, locale: accountLocale(me.locale, req), log: req.log });
      return { ok: true };
    },
  );

  // Step 2: confirm the code and move the account to the new address. The unique-violation
  // catch guards the race where the address was taken between request and confirm.
  // Throttled like the other code-checking routes: the code is short and this is where it is guessed.
  app.post("/auth/me/email", { preHandler: [app.authenticate, authRateLimit("confirm-email-change")] }, async (req) => {
    const body = dto.confirmEmailChangeBody.parse(req.body);
    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    if (!me) throw unauthorized();
    if (me.email.toLowerCase() === body.email.toLowerCase()) throw badRequest("that is already your email address");
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, body.email), ne(users.id, req.auth.sub)))
      .limit(1);
    if (existing) throw conflict("email already registered");
    let emailVerified = false;
    if (env.EMAIL_VERIFICATION_ENABLED || body.code !== undefined) {
      if (!body.code) throw badRequest("verification code required");
      await verifyAndConsumeCode({ email: body.email, purpose: "email_change", code: body.code, userId: req.auth.sub });
      emailVerified = true;
    }
    try {
      await db
        .update(users)
        .set({ email: body.email, emailVerifiedAt: emailVerified ? new Date() : null, updatedAt: new Date() })
        .where(eq(users.id, req.auth.sub));
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw conflict("email already registered");
      throw err;
    }
    // To the previous address: if someone else made this change, the real owner can no longer read
    // mail at the new one.
    await notifyAccountSecurityChange(app.mailer, { userId: req.auth.sub, event: "email_changed", toEmail: me.email, newEmail: body.email, log: req.log });
    return meResponseFor(req.auth.sub, req.auth.cid);
  });

  app.post("/auth/me/avatar", { preHandler: app.authenticate }, async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }).catch(() => null);
    if (!file) throw badRequest("no file uploaded");
    if (!ALLOWED_AVATAR_MIME.has(file.mimetype)) throw badRequest("unsupported file type");

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_AVATAR_BYTES) throw badRequest("file too large");

    const [current] = await db
      .select({ avatarUrl: users.avatarUrl, displayName: users.displayName, homeClientId: users.clientId })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    if (!current) throw unauthorized();

    const ext = EXT_FOR_MIME[file.mimetype] ?? "bin";
    const key = avatarStorageKey(req.auth.sub, ext);
    const storage = await getStorageForClient(current.homeClientId);
    const prevKey = storageKeyFromMediaUrl(current.avatarUrl, current.homeClientId);
    await storage.put(key, buffer, file.mimetype);
    const url = unsignedMediaUrl(current.homeClientId, key);

    await db
      .update(users)
      .set({ avatarUrl: url, updatedAt: new Date() })
      .where(eq(users.id, req.auth.sub));

    if (prevKey && prevKey !== key) {
      await storage.delete(prevKey).catch((err: unknown) => req.log.warn({ err }, "failed to delete previous avatar"));
    }

    const result = withSignedMedia(current.homeClientId, { avatarUrl: url });
    await emitProfileUpdated(req.auth.sub, current.homeClientId, current.displayName, result.avatarUrl);
    return result;
  });

  app.delete("/auth/me/avatar", { preHandler: app.authenticate }, async (req) => {
    const [current] = await db
      .select({ avatarUrl: users.avatarUrl, displayName: users.displayName, homeClientId: users.clientId })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    if (!current) throw unauthorized();

    const prevKey = storageKeyFromMediaUrl(current.avatarUrl, current.homeClientId);
    if (prevKey) {
      const storage = await getStorageForClient(current.homeClientId);
      await storage.delete(prevKey).catch((err: unknown) => req.log.warn({ err }, "failed to delete avatar"));
    }

    await db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, req.auth.sub));

    await emitProfileUpdated(req.auth.sub, current.homeClientId, current.displayName, null);
    return { avatarUrl: null };
  });

  // Emails the code that stands in for a password on password-gated settings. Only provider-only
  // accounts get one; an account with a password must keep using it.
  app.post("/auth/me/step-up-code", { preHandler: [app.authenticate, authRateLimit("request-email-verification")] }, async (req) => {
    if (req.auth.authKind !== "user") throw forbidden();
    const [me] = await db.select({ email: users.email, locale: users.locale, passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    if (!me) throw unauthorized();
    if (me.passwordHash) throw badRequest("confirm with your current password");
    await issueVerificationCode({ email: me.email, purpose: "step_up", userId: req.auth.sub, locale: accountLocale(me.locale, req), log: req.log });
    return { ok: true };
  });

  app.post("/auth/change-password", { preHandler: app.authenticate }, async (req) => {
    const body = dto.changePasswordBody.parse(req.body);
    const [row] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    if (!row) throw unauthorized();
    if (row.passwordHash) {
      if (!body.currentPassword || !(await verifyPassword(row.passwordHash, body.currentPassword))) {
        throw unauthorized("invalid current password");
      }
    } else {
      // A provider-only account is setting its first password; the emailed code proves the owner.
      await assertStepUp(row.id, body);
    }

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
        .where(eq(users.id, row.id));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, row.id));
    });
    await notifyAccountSecurityChange(app.mailer, { userId: row.id, event: "password_changed", log: req.log });

    return { ok: true };
  });

  app.post("/auth/forgot-password", { preHandler: authRateLimit("forgot-password") }, async (req, reply) => {
    const body = dto.forgotPasswordBody.parse(req.body);
    await verifyTurnstile(req, body.turnstileToken);
    // This bucket is keyed by the requested mailbox, not account existence, so repeated reset
    // sends cannot inbox-bomb a known recipient and the throttle shape does not reveal users.
    const result = await passwordResetRecipientLimiter.check(`forgot-password-recipient:${body.email.toLowerCase()}`, passwordResetRecipientPolicy);
    applyRateLimitHeaders(reply, result);
    if (!result.allowed) throw tooManyRequests();
    const [user] = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName, locale: users.locale })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (user) {
      const token = newOpaqueToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.transaction(async (tx) => {
        await tx
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
        await tx.insert(passwordResetTokens).values({ userId: user.id, tokenHash: token.hash, expiresAt });
      });

      const resetUrl = `${env.WEB_ORIGIN}/reset-password?token=${token.raw}`;
      req.log.info({ userId: user.id }, "password reset link generated");

      try {
        await app.mailer.sendPasswordReset(user.email, user.displayName, resetUrl, accountLocale(user.locale, req));
      } catch (err) {
        req.log.error({ err, userId: user.id }, "failed to process password reset email");
      }
    }
    return { ok: true };
  });

  app.post("/auth/reset-password", { preHandler: authRateLimit("reset-password") }, async (req) => {
    const body = dto.resetPasswordBody.parse(req.body);
    const tokenHash = hashOpaqueToken(body.token);

    const userId = await db.transaction(async (tx) => {
      const [reset] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!reset) throw unauthorized("invalid reset token");

      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() })
        .where(eq(users.id, reset.userId));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, reset.userId));
      return reset.userId;
    });
    await notifyAccountSecurityChange(app.mailer, { userId, event: "password_reset", log: req.log });
    return { ok: true };
  });

  // Hosted-only Google / Microsoft / GitHub sign-in. Registered inside this plugin so it shares the
  // auth throttles, signup gates and verification-code helpers above.
  await providerAuthRoutes(app, {
    authRateLimit,
    assertSignupOpenForIntent,
    issueVerificationCode,
    verifyAndConsumeCode,
    bootstrapOrganisationAfterFullDeletion,
  });
}
