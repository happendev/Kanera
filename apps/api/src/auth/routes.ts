import { dto } from "@kanera/shared";
import {
  boardInvitationGrants,
  boardInvitations,
  boardMembers,
  boards,
  clients,
  emailVerificationCodes,
  inviteTokens,
  inviteWorkspaceGrants,
  passwordResetTokens,
  refreshTokens,
  supportSessions,
  users,
  workspaceMembers,
  workspaces,
  mfaCredentials,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { clientIpForRequest } from "../lib/client-ip.js";
import { cookieDomainAttribute } from "../lib/cookie-domain.js";
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from "../lib/errors.js";
import { getUploadEntitlements } from "../lib/entitlements.js";
import { assertOrgMemberLimit, assertSeatPoolAvailable, getEntitlements } from "../lib/tier-limits.js";
import { storageKeyFromMediaUrl, unsignedMediaUrl, withSignedMedia } from "../lib/media-keys.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter, type RateLimitPolicy } from "../lib/rate-limit.js";
import { sendHostedBillingEmail } from "../lib/billing-emails.js";
import { sendInternalSignupNotification } from "../lib/internal-notification-emails.js";
import { getConfiguredS3StorageConfig, getStorageForClient } from "../lib/storage/index.js";
import { avatarStorageKey } from "../lib/storage/keys.js";
import { notifyAdminsBoardInviteAccepted, notifyAdminsOrgInviteAccepted } from "../lib/invite-accepted-notifications.js";
import { assertGuestBoardLimitForBoards } from "../lib/board-guest-limits.js";
import { pinOrgAdminToClientBoards } from "../lib/board-membership.js";
import { hashOpaqueToken, newOpaqueToken, newVerificationCode } from "../lib/tokens.js";
import { emitToBoard, emitToClient, emitToWorkspace } from "../realtime/emit.js";
import { hashRefresh, newRefreshToken, rotateRefresh } from "./jwt.js";
import { hashPassword, needsPasswordRehash, verifyPassword, verifyPasswordTimingSafe } from "./password.js";
import { beginMfaEnrollment, createMfaChallenge, enableMfa, getMfaCredential, readMfaChallenge, regenerateRecoveryCodes, resetMfa, verifyMfaCode, verifyMfaLoginCode } from "./mfa.js";
import { productAnalytics } from "../lib/product-analytics.js";
import { captureWorkspaceMemberJoined } from "../lib/analytics-milestones.js";

async function getOrgInfo(clientId: string): Promise<{ orgName: string; logoUrl: string | null; analyticsExcluded: boolean }> {
  const [row] = await db
    .select({ name: clients.name, logoUrl: clients.logoUrl, analyticsExcluded: clients.analyticsExcluded })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return { orgName: row?.name ?? "", logoUrl: row?.logoUrl ? withSignedMedia(clientId, { logoUrl: row.logoUrl }).logoUrl : null, analyticsExcluded: row?.analyticsExcluded ?? true };
}

// Builds the account-scoped payload attached to every auth response: storage usage plus the plan
// entitlements the web app uses to gate create affordances. Derived from a single billing-status
// read inside getUploadEntitlements so both share one source of truth.
async function getAccountPayload(clientId: string) {
  // storageUsage reflects the caller's own org pool (shared across all members). Uploads to a guest
  // board count against the host org, not shown here — this is the viewer's home-org allowance.
  const { billingStatus, currentPeriodEnd, plan: _plan, ...storageUsage } = await getUploadEntitlements(db, clientId);
  return { storageUsage, entitlements: getEntitlements(billingStatus, currentPeriodEnd) };
}

const REFRESH_COOKIE = "kanera_rt";
const ALLOWED_AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

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
const PASSWORD_RESET_RECIPIENT_LIMIT = 3;
const PASSWORD_RESET_RECIPIENT_WINDOW_MS = 60 * 60_000;
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    // Refresh is only sent to /auth and relies on SameSite=Lax as the CSRF gate
    // for cross-site POSTs to /auth/refresh in modern browsers. Widening the path
    // or relaxing SameSite removes that protection and needs a replacement.
    sameSite: "lax" as const,
    secure: env.COOKIE_SECURE,
    domain: cookieDomainAttribute(env.COOKIE_DOMAIN),
    path: "/auth",
    maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400,
  };
}

function normalizeTimezone(value: string | undefined): string {
  if (!value) return "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

export async function authRoutes(app: FastifyInstance) {
  // Per-IP brute-force / abuse throttle for unauthenticated auth endpoints. Valkey makes the
  // buckets global across API processes; keys stay action-scoped so login attempts do not drain
  // signup or password-reset allowance.
  const authRateLimiter = env.AUTH_RATE_LIMIT_ENABLED
    ? new FixedWindowRateLimiter(env.AUTH_RATE_LIMIT_WINDOW_MS, { log: app.log })
    : null;
  if (authRateLimiter) app.addHook("onClose", async () => authRateLimiter.close());
  const passwordResetRecipientLimiter = new FixedWindowRateLimiter(PASSWORD_RESET_RECIPIENT_WINDOW_MS, { log: app.log });
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
    if (!params.inviteToken) {
      // Board-invite-only signup still creates the user's home organisation before adding
      // board access, so it follows the public signup gate rather than the org-invite exception.
      throw forbidden("Signups are currently disabled.");
    }
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
    if (!invite) throw unauthorized("invalid invite");
  }

  async function hasWorkspace(userId: string) {
    // Archived and hidden standalone-board workspaces do not count, so onboarding only reflects
    // access to product-level workspaces.
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), ne(workspaces.kind, "board"), isNull(workspaces.archivedAt)));
    return (row?.count ?? 0) > 0;
  }

  async function requiresMfaForAccess(userId: string, homeClientId: string, homeRequiresMfa: boolean) {
    if (homeRequiresMfa) return true;
    const [guestPolicy] = await db
      .select({ id: boardMembers.boardId })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(eq(boardMembers.userId, userId), ne(clients.id, homeClientId), eq(clients.requireMfa, true)))
      .limit(1);
    // A host organisation's security policy follows its data: board-only guests must satisfy it even
    // though authentication and MFA credentials still belong to the guest's single home identity.
    return !!guestPolicy;
  }

  // Builds the standard /me payload. Shared by GET /me, PATCH /auth/me, and the
  // email-change confirm route so all three stay in lockstep.
  async function meResponseFor(userId: string) {
    const [user] = await db
      .select({
        id: users.id,
        clientId: users.clientId,
        clientRole: users.clientRole,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        timezone: users.timezone,
        orgName: clients.name,
        logoUrl: clients.logoUrl,
        analyticsExcluded: clients.analyticsExcluded,
      })
      .from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw unauthorized();
    const { clientRole, ...rest } = user;
    return {
      ...withSignedMedia(user.clientId, rest),
      deploymentMode: env.KANERA_DEPLOYMENT_MODE,
      kaneraEnvironment: env.KANERA_ENVIRONMENT,
      hasWorkspace: await hasWorkspace(user.id),
      role: clientRole,
      ...(await getAccountPayload(user.clientId)),
      analyticsExcluded: user.analyticsExcluded,
    };
  }

  // Generate a fresh verification code, invalidate any prior unconsumed codes for the
  // same address+purpose (so only the newest is valid), persist the hash, and email
  // the raw code immediately. Delivery failures are logged but not surfaced so we
  // never leak whether the address exists via a different error shape.
  async function issueVerificationCode(params: {
    email: string;
    purpose: "signup" | "email_change";
    userId: string | null;
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
      await app.mailer.sendEmailVerificationCode(params.email, code, EMAIL_VERIFICATION_EXPIRY_MINUTES);
    } catch (err) {
      params.log.error({ err, purpose: params.purpose }, "failed to send verification code email");
    }
  }

  // Verify and consume the newest valid code for (email, purpose[, userId]). On a wrong
  // code we increment attempts as a standalone write — this must persist even when the
  // caller's surrounding transaction later rolls back, otherwise the attempt cap is
  // defeated. Consuming (marking used) is conditional so a concurrent request cannot
  // redeem the same code twice. Throws badRequest on any failure.
  async function verifyAndConsumeCode(params: {
    email: string;
    purpose: "signup" | "email_change";
    code: string;
    userId?: string | null;
  }) {
    const [row] = await db
      .select({ id: emailVerificationCodes.id, codeHash: emailVerificationCodes.codeHash, attempts: emailVerificationCodes.attempts })
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
    if (row.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      throw badRequest("too many attempts; request a new code");
    }
    if (row.codeHash !== hashOpaqueToken(params.code)) {
      await db
        .update(emailVerificationCodes)
        .set({ attempts: row.attempts + 1 })
        .where(eq(emailVerificationCodes.id, row.id));
      throw badRequest("invalid or expired verification code");
    }
    const consumed = await db
      .update(emailVerificationCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailVerificationCodes.id, row.id), isNull(emailVerificationCodes.consumedAt)))
      .returning({ id: emailVerificationCodes.id });
    if (consumed.length === 0) throw badRequest("invalid or expired verification code");
  }

  // Step 1 of verify-before-account: email a code to the address the visitor wants to
  // register. Mirrors the signup duplicate-email check so an already-registered address
  // gets the same conflict here rather than after they enter a code.
  app.post("/auth/request-email-verification", { preHandler: authRateLimit("request-email-verification") }, async (req) => {
    const body = dto.requestEmailVerificationBody.parse(req.body);
    await assertSignupOpenForIntent({ inviteToken: body.inviteToken, boardInviteToken: body.boardInviteToken });
    // Verification can be disabled before SMTP is ready. Keep the endpoint benign so stale
    // clients do not get stuck on an email send that the deployment intentionally turned off.
    if (!env.EMAIL_VERIFICATION_ENABLED) return { ok: true };
    // This endpoint sends mail before an account exists, so Turnstile is checked here to protect
    // the inbox path. The final signup step is then protected by the one-time email code.
    await verifyTurnstile(req, body.turnstileToken);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) throw conflict("email already registered");
    await issueVerificationCode({ email: body.email, purpose: "signup", userId: null, log: req.log });
    return { ok: true };
  });

  app.post("/auth/signup", { preHandler: authRateLimit("signup") }, async (req, reply) => {
    const body = dto.signupBody.parse(req.body);
    await assertSignupOpenForIntent({ inviteToken: body.inviteToken, boardInviteToken: body.boardInviteToken });
    const duplicateSignupMessage = body.boardInviteToken || body.inviteToken
      ? "An account already exists for this email. Sign in to accept the invite."
      : "email already registered";

    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existingUser) throw conflict(duplicateSignupMessage);

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
      const result = await db.transaction(async (tx) => {
        let clientId: string;
        let orgName: string;
        let orgRole: "owner" | "admin" | "member";
        let workspaceGrants: Array<{ workspaceId: string; role: "admin" | "member" }> = [];
        let acceptedInvite = false;

        if (body.inviteToken) {
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
            .where(
              and(
                eq(inviteTokens.tokenHash, hashOpaqueToken(body.inviteToken)),
                isNull(inviteTokens.revokedAt),
                sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
              ),
            )
            .limit(1);
          if (!invite) throw unauthorized("invalid invite");
          clientId = invite.clientId;
          orgName = invite.orgName;
          orgRole = invite.orgRole;
          // Hard gate on the free-tier member cap: this is the point where a person actually joins
          // the org. Runs inside the signup transaction; the helper takes a tenant row lock so
          // concurrent invite acceptances serialize and cannot race past the cap. On trials the free cap
          // no-ops and seats are unlimited; paid subscriptions still gate against purchased capacity.
          await assertOrgMemberLimit(clientId, tx);
          await assertSeatPoolAvailable(clientId, tx);
          const grants = await tx
            .select({ workspaceId: inviteWorkspaceGrants.workspaceId, role: inviteWorkspaceGrants.role })
            .from(inviteWorkspaceGrants)
            .where(eq(inviteWorkspaceGrants.inviteId, invite.id));
          workspaceGrants = grants;
        } else {
          const [client] = await tx
            .insert(clients)
            .values({
              name: body.orgName,
              storageConfig: getConfiguredS3StorageConfig() ?? { kind: "local" },
              // In hosted mode every new org (including a brand-new guest's own org) starts on a
              // time-boxed trial. currentPeriodEnd is the trial end consumed by the trial-expiry
              // sweep and surfaced to the UI; once it lapses the org reverts to free.
              ...(env.KANERA_DEPLOYMENT_MODE === "hosted"
                ? {
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

        const passwordHash = await hashPassword(body.password);
        const [user] = await tx
          .insert(users)
          .values({
            clientId,
            clientRole: orgRole,
            email: body.email,
            emailVerifiedAt: emailVerified ? new Date() : null,
            passwordHash,
            displayName: body.displayName,
            timezone: normalizeTimezone(undefined),
          })
          .returning();

        if (workspaceGrants.length > 0) {
          await tx.insert(workspaceMembers).values(
            workspaceGrants.map((g) => ({
              workspaceId: g.workspaceId,
              userId: user!.id,
              role: g.role,
            })),
          );
        }

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
          acceptedInvite,
          boardInviteToken: body.boardInviteToken,
        };
      });

      const accessToken = app.jwt.sign({
        sub: result.user.id,
        cid: result.user.clientId,
        role: result.user.clientRole,
      });
      const refresh = newRefreshToken();
      await db
        .insert(refreshTokens)
        .values({ userId: result.user.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt });

      reply.setCookie(REFRESH_COOKIE, refresh.raw, refreshCookieOptions());
      const { logoUrl, analyticsExcluded } = await getOrgInfo(result.user.clientId);

      // Account creation is authoritative here: the user and organisation transaction has committed.
      // Analytics is fire-and-forget and can never turn a successful signup into a failed request.
      void productAnalytics.capture({
        event: "account_created",
        distinctId: result.user.id,
        organizationId: result.user.clientId,
        properties: { registration_method: "email", has_attribution: body.analyticsHasAttribution === true },
      });

      // Redeem a board invitation if one was provided at signup.
      let boardInviteRedirect: string | null = null;
      if (result.boardInviteToken) {
        const [invitation] = await db
          .select({
            id: boardInvitations.id,
            boardId: boardInvitations.boardId,
            boardName: boards.name,
            role: boardInvitations.role,
            email: boardInvitations.email,
            hostClientId: workspaces.clientId,
            orgName: clients.name,
            workspaceId: workspaces.id,
          })
          .from(boardInvitations)
          .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
          .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
          .innerJoin(clients, eq(clients.id, workspaces.clientId))
          .where(
            and(
              eq(boardInvitations.tokenHash, hashOpaqueToken(result.boardInviteToken)),
              isNull(boardInvitations.revokedAt),
              isNull(boardInvitations.acceptedAt),
              sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
            ),
          )
          .limit(1);
        if (
          invitation &&
          invitation.hostClientId !== result.user.clientId &&
          invitation.email.toLowerCase() === result.user.email.toLowerCase()
        ) {
          const grantRows = await db
            .select({
              boardId: boardInvitationGrants.boardId,
              boardName: boards.name,
              workspaceId: boards.workspaceId,
              role: boardInvitationGrants.role,
            })
            .from(boardInvitationGrants)
            .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
            .where(and(eq(boardInvitationGrants.invitationId, invitation.id), isNull(boards.archivedAt)))
            .orderBy(asc(boards.position));
          const grants = grantRows.length > 0
            ? grantRows
            : [{ boardId: invitation.boardId, boardName: invitation.boardName, workspaceId: invitation.workspaceId, role: invitation.role }];

          await db.transaction(async (tx) => {
            // Crossing the host org's free guest-board cap consumes a seat from its purchased pool. The
            // host pre-paid for capacity, so this only fails if the pool is full (402 SEAT_LIMIT_REACHED).
            // Runs in-tx with the membership inserts for race-safe gating.
            await assertGuestBoardLimitForBoards({
              hostClientId: invitation.hostClientId,
              boardIds: grants.map((grant) => grant.boardId),
              userId: result.user.id,
              targetClientId: result.user.clientId,
              createdById: undefined,
              tx,
            });
            for (const grant of grants) {
              await tx
                .insert(boardMembers)
                .values({ boardId: grant.boardId, userId: result.user.id, role: grant.role })
                .onConflictDoUpdate({
                  target: [boardMembers.boardId, boardMembers.userId],
                  set: { role: grant.role },
                });
            }
            await tx
              .update(boardInvitations)
              .set({ acceptedAt: new Date(), acceptedByUserId: result.user.id })
              .where(eq(boardInvitations.id, invitation.id));
          });
          await captureWorkspaceMemberJoined({
            organizationId: invitation.hostClientId,
            workspaceIds: [...new Set(grants.map((grant) => grant.workspaceId))],
            actorId: result.user.id,
            joinSource: "guest_invitation",
          });
          const firstGrant = grants[0]!;
          boardInviteRedirect = `/b/${firstGrant.boardId}`;
          await notifyAdminsBoardInviteAccepted(app, {
            acceptedUserId: result.user.id,
            acceptedByName: result.user.displayName,
            acceptedByEmail: result.user.email,
            hostClientId: invitation.hostClientId,
            orgName: invitation.orgName,
            boardId: firstGrant.boardId,
            boardName: firstGrant.boardName,
            boardRole: firstGrant.role,
          });
        }
      }

      await app.mailer.sendWelcome(result.user.email, result.user.displayName);
      await sendInternalSignupNotification(
        result.acceptedInvite
          ? { type: "invite_accepted", displayName: result.user.displayName, email: result.user.email, orgName: result.orgName }
          : { type: "signup", displayName: result.user.displayName, email: result.user.email, orgName: result.orgName },
        { log: req.log },
      );
      if (env.KANERA_DEPLOYMENT_MODE === "hosted" && !result.acceptedInvite) {
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
        }, { log: req.log });
      }
      if (result.acceptedInvite) {
        await captureWorkspaceMemberJoined({
          organizationId: result.user.clientId,
          workspaceIds: result.workspaceIds,
          actorId: result.user.id,
          joinSource: "invitation",
        });
        await notifyAdminsOrgInviteAccepted(app, {
          acceptedUserId: result.user.id,
          acceptedByName: result.user.displayName,
          acceptedByEmail: result.user.email,
          clientId: result.user.clientId,
          orgName: result.orgName,
          orgRole: result.user.clientRole,
        });
        // No Stripe change on acceptance: the new member occupies a pre-purchased pool seat (the signup
        // tx already gated on seat_limit via assertSeatPoolAvailable), and the billed quantity is the
        // seat_limit, not headcount. Capacity is only charged when the admin explicitly buys seats.
      }

      return {
        accessToken,
        user: {
          id: result.user.id,
          clientId: result.user.clientId,
          email: result.user.email,
          displayName: result.user.displayName,
          avatarUrl: withSignedMedia(result.user.clientId, { avatarUrl: result.user.avatarUrl }).avatarUrl,
          timezone: result.user.timezone,
          orgName: result.orgName,
          logoUrl,
          deploymentMode: env.KANERA_DEPLOYMENT_MODE,
          kaneraEnvironment: env.KANERA_ENVIRONMENT,
          hasWorkspace: result.hasWorkspace,
          role: result.user.clientRole,
          isClientAdmin: result.user.clientRole === "owner" || result.user.clientRole === "admin",
          ...(await getAccountPayload(result.user.clientId)),
          boardInviteRedirect,
          analyticsExcluded,
        },
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw conflict(duplicateSignupMessage);
      throw err;
    }
  });

  async function issueUserSession(userId: string, reply: FastifyReply) {
    const [row] = await db.select({ userId: users.id, clientId: users.clientId, clientRole: users.clientRole, email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, timezone: users.timezone, orgName: clients.name, logoUrl: clients.logoUrl, analyticsExcluded: clients.analyticsExcluded })
      .from(users).innerJoin(clients, eq(clients.id, users.clientId)).where(eq(users.id, userId)).limit(1);
    if (!row) throw unauthorized();
    const accessToken = app.jwt.sign({ sub: row.userId, cid: row.clientId, role: row.clientRole });
    const refresh = newRefreshToken();
    await db.insert(refreshTokens).values({ userId: row.userId, tokenHash: refresh.hash, expiresAt: refresh.expiresAt });
    reply.setCookie(REFRESH_COOKIE, refresh.raw, refreshCookieOptions());
    return { status: "authenticated" as const, accessToken, user: { id: row.userId, clientId: row.clientId, email: row.email, displayName: row.displayName, avatarUrl: withSignedMedia(row.clientId, { avatarUrl: row.avatarUrl }).avatarUrl, timezone: row.timezone, orgName: row.orgName, logoUrl: withSignedMedia(row.clientId, { logoUrl: row.logoUrl }).logoUrl, deploymentMode: env.KANERA_DEPLOYMENT_MODE, kaneraEnvironment: env.KANERA_ENVIRONMENT, hasWorkspace: await hasWorkspace(row.userId), role: row.clientRole, analyticsExcluded: row.analyticsExcluded, ...(await getAccountPayload(row.clientId)) } };
  }

  app.post("/auth/login", { preHandler: authRateLimit("login") }, async (req, reply) => {
    const body = dto.loginBody.parse(req.body);

    const [row] = await db
      .select({
        userId: users.id,
        clientId: users.clientId,
        clientRole: users.clientRole,
        passwordHash: users.passwordHash,
        suspendedAt: users.suspendedAt,
        removedAt: users.removedAt,
        deletedAt: users.deletedAt,
        orgSuspendedAt: clients.suspendedAt,
        orgDeletedAt: clients.deletedAt,
        requireMfa: clients.requireMfa,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        timezone: users.timezone,
        orgName: clients.name,
        logoUrl: clients.logoUrl,
        analyticsExcluded: clients.analyticsExcluded,
      })
      .from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(eq(users.email, body.email))
      .limit(1);

    // Always run a password verification (against a dummy hash when the email is unknown) so
    // login response time doesn't reveal whether an account exists. Keep the error message
    // identical for both the missing-user and wrong-password cases.
    const passwordOk = await verifyPasswordTimingSafe(row?.passwordHash ?? null, body.password);
    if (!row || !passwordOk) throw unauthorized("invalid credentials");
    if (row.removedAt) throw unauthorized("invalid credentials");
    // Platform-admin soft-deletes (user or org) block auth entirely — otherwise the delete is cosmetic.
    // Use the generic credentials error so a deleted account is indistinguishable from a wrong password.
    if (row.deletedAt || row.orgDeletedAt) throw unauthorized("invalid credentials");
    // Members suspended by a plan downgrade cannot sign in until the org upgrades again.
    if (row.suspendedAt) throw unauthorized("account suspended");
    // Whole-org suspension by a platform admin blocks every member.
    if (row.orgSuspendedAt) throw unauthorized("organisation suspended");

    const credential = await getMfaCredential({ kind: "user", id: row.userId });
    if (credential?.enabledAt) return { status: "mfa_required" as const, challengeToken: createMfaChallenge({ kind: "user", id: row.userId }, "verify") };
    if (await requiresMfaForAccess(row.userId, row.clientId, row.requireMfa)) return { status: "mfa_enrollment_required" as const, challengeToken: createMfaChallenge({ kind: "user", id: row.userId }, "enroll") };

    const upgradedPasswordHash = needsPasswordRehash(row.passwordHash) ? await hashPassword(body.password) : null;
    if (upgradedPasswordHash) await db.update(users).set({ passwordHash: upgradedPasswordHash, updatedAt: new Date() }).where(eq(users.id, row.userId));
    return issueUserSession(row.userId, reply);
  });

  app.post("/auth/mfa/verify", { preHandler: authRateLimit("mfa") }, async (req, reply) => {
    const body = dto.mfaChallengeBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "verify"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential?.enabledAt || !(await verifyMfaLoginCode(credential, body.code))) throw unauthorized("invalid verification code");
    return issueUserSession(challenge.id, reply);
  });

  // Organisation-enforced enrollment runs after password verification but before any access or refresh
  // token exists. The purpose-bound challenge is the only authority these three endpoints accept.
  app.post("/auth/mfa/required/enroll", { preHandler: authRateLimit("mfa-enroll") }, async (req) => {
    const body = dto.adminMfaEnrollmentStartBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const [user] = await db.select({ email: users.email, clientId: users.clientId, requireMfa: clients.requireMfa }).from(users).innerJoin(clients, eq(clients.id, users.clientId)).where(eq(users.id, challenge.id)).limit(1);
    if (!user || !(await requiresMfaForAccess(challenge.id, user.clientId, user.requireMfa))) throw unauthorized("MFA enrollment is not required");
    const result = await beginMfaEnrollment(challenge, user.email);
    return { secret: result.secret, otpauthUri: result.otpauthUri };
  });

  app.post("/auth/mfa/required/enroll/confirm", { preHandler: authRateLimit("mfa-enroll") }, async (req) => {
    const body = dto.adminMfaEnrollmentConfirmBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential || credential.enabledAt || !(await verifyMfaCode(credential, body.code, false))) throw unauthorized("invalid verification code");
    return { status: "recovery_codes_required" as const, recoveryCodes: await enableMfa(credential.id) };
  });

  app.post("/auth/mfa/required/enroll/acknowledge", { preHandler: authRateLimit("mfa-enroll") }, async (req, reply) => {
    const body = dto.adminMfaEnrollmentStartBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "user", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential?.enabledAt) throw unauthorized("enrollment incomplete");
    await db.update(mfaCredentials).set({ recoveryCodesAcknowledgedAt: new Date(), updatedAt: new Date() }).where(eq(mfaCredentials.id, credential.id));
    return issueUserSession(challenge.id, reply);
  });

  app.get("/auth/mfa", { preHandler: app.authenticate }, async (req) => ({ enabled: !!(await getMfaCredential({ kind: "user", id: req.auth.sub }))?.enabledAt }));

  app.post("/auth/mfa/enroll", { preHandler: app.authenticate }, async (req) => {
    const body = dto.mfaEnrollmentStartBody.parse(req.body);
    const [user] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) throw unauthorized("invalid password");
    const result = await beginMfaEnrollment({ kind: "user", id: req.auth.sub }, user.email);
    return { secret: result.secret, otpauthUri: result.otpauthUri };
  });

  app.post("/auth/mfa/enroll/confirm", { preHandler: app.authenticate }, async (req) => {
    const body = dto.mfaEnrollmentConfirmBody.parse(req.body);
    const credential = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (!credential || credential.enabledAt || !(await verifyMfaCode(credential, body.code, false))) throw badRequest("invalid verification code");
    return { recoveryCodes: await enableMfa(credential.id) };
  });

  // These actions are password-gated, but they must share login's IP throttle and credential
  // lockout so a stolen session plus password cannot brute-force the six-digit second factor.
  app.post("/auth/mfa/recovery-codes", { preHandler: [app.authenticate, authRateLimit("mfa")] }, async (req) => {
    const body = dto.mfaProtectedActionBody.parse(req.body);
    const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    const credential = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (!user || !credential?.enabledAt || !(await verifyPassword(user.passwordHash, body.currentPassword)) || !(await verifyMfaLoginCode(credential, body.code))) throw unauthorized();
    return { recoveryCodes: await regenerateRecoveryCodes(credential.id) };
  });

  app.delete("/auth/mfa", { preHandler: [app.authenticate, authRateLimit("mfa")] }, async (req) => {
    const body = dto.mfaProtectedActionBody.parse(req.body);
    const [user] = await db.select({ passwordHash: users.passwordHash, clientId: users.clientId, requireMfa: clients.requireMfa }).from(users).innerJoin(clients, eq(clients.id, users.clientId)).where(eq(users.id, req.auth.sub)).limit(1);
    const credential = await getMfaCredential({ kind: "user", id: req.auth.sub });
    if (!user || !credential?.enabledAt || !(await verifyPassword(user.passwordHash, body.currentPassword)) || !(await verifyMfaLoginCode(credential, body.code))) throw unauthorized();
    // A user cannot leave themselves without a second factor while their home org (or a guest host org)
    // mandates MFA — they would only be forced to re-enroll on next login anyway.
    if (await requiresMfaForAccess(req.auth.sub, user.clientId, user.requireMfa)) throw forbidden("MFA is required by your organisation");
    await resetMfa({ kind: "user", id: req.auth.sub });
    return { ok: true };
  });

  app.post("/auth/refresh", async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) {
      req.log.warn({ refreshCookiePresent: false }, "refresh token missing");
      throw unauthorized();
    }

    const refresh = await rotateRefresh(raw);
    if (refresh.status === "reused") {
      req.log.warn({ userId: refresh.userId, refreshCookiePresent: true, refreshStatus: refresh.status }, "detected refresh token reuse; revoked active refresh tokens");
      throw unauthorized();
    }
    if (refresh.status === "invalid") {
      req.log.warn({ refreshCookiePresent: true, refreshStatus: refresh.status }, "refresh token rejected");
      throw unauthorized();
    }

    const [user] = await db
      .select({
        id: users.id,
        clientId: users.clientId,
        clientRole: users.clientRole,
        suspendedAt: users.suspendedAt,
        removedAt: users.removedAt,
        deletedAt: users.deletedAt,
        orgSuspendedAt: clients.suspendedAt,
        orgDeletedAt: clients.deletedAt,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        timezone: users.timezone,
        orgName: clients.name,
        logoUrl: clients.logoUrl,
        analyticsExcluded: clients.analyticsExcluded,
      })
      .from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(eq(users.id, refresh.userId))
      .limit(1);
    if (!user) throw unauthorized();
    if (user.removedAt) throw unauthorized();
    // Stop token renewal once a platform admin has soft-deleted the user or their org.
    if (user.deletedAt || user.orgDeletedAt) throw unauthorized();
    // Stop token renewal for members suspended by a plan downgrade; their access token expires within TTL.
    if (user.suspendedAt) throw unauthorized("account suspended");
    // Same for a whole-org admin suspension.
    if (user.orgSuspendedAt) throw unauthorized("organisation suspended");

    const accessToken = app.jwt.sign({ sub: user.id, cid: user.clientId, role: user.clientRole });

    if (refresh.status === "rotated") {
      reply.setCookie(REFRESH_COOKIE, refresh.fresh.raw, refreshCookieOptions());
    }
    const {
      clientRole,
      suspendedAt: _suspendedAt,
      removedAt: _removedAt,
      deletedAt: _deletedAt,
      orgSuspendedAt: _orgSuspendedAt,
      orgDeletedAt: _orgDeletedAt,
      ...rest
    } = user;
    return {
      accessToken,
      user: {
        ...withSignedMedia(user.clientId, rest),
        deploymentMode: env.KANERA_DEPLOYMENT_MODE,
        kaneraEnvironment: env.KANERA_ENVIRONMENT,
        hasWorkspace: await hasWorkspace(user.id),
        role: clientRole,
        analyticsExcluded: user.analyticsExcluded,
        ...(await getAccountPayload(user.clientId)),
      },
    };
  });

  app.post("/auth/logout", async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (raw) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, hashRefresh(raw)));
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
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticate }, async (req) => {
    return meResponseFor(req.auth.sub);
  });

  app.patch("/auth/me", { preHandler: app.authenticate }, async (req) => {
    // Email is deliberately not editable here — it goes through the verified two-step
    // flow below so the address is always proven before it lands on the account.
    const body = dto.updateMeBody.parse(req.body);
    const updates: Partial<typeof users.$inferInsert> = {};
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.timezone !== undefined) updates.timezone = normalizeTimezone(body.timezone);
    if (Object.keys(updates).length > 0) {
      await db
        .update(users)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(users.id, req.auth.sub));
    }
    return meResponseFor(req.auth.sub);
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
      const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
      if (!me) throw unauthorized();
      // citext makes the stored email case-insensitive; compare the same way here.
      if (me.email.toLowerCase() === body.email.toLowerCase()) throw badRequest("that is already your email address");
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, body.email), ne(users.id, req.auth.sub)))
        .limit(1);
      if (existing) throw conflict("email already registered");
      await issueVerificationCode({ email: body.email, purpose: "email_change", userId: req.auth.sub, log: req.log });
      return { ok: true };
    },
  );

  // Step 2: confirm the code and move the account to the new address. The unique-violation
  // catch guards the race where the address was taken between request and confirm.
  app.post("/auth/me/email", { preHandler: app.authenticate }, async (req) => {
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
    return meResponseFor(req.auth.sub);
  });

  app.post("/auth/me/avatar", { preHandler: app.authenticate }, async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }).catch(() => null);
    if (!file) throw badRequest("no file uploaded");
    if (!ALLOWED_AVATAR_MIME.has(file.mimetype)) throw badRequest("unsupported file type");

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_AVATAR_BYTES) throw badRequest("file too large");

    const [current] = await db
      .select({ avatarUrl: users.avatarUrl, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    if (!current) throw unauthorized();

    const ext = EXT_FOR_MIME[file.mimetype] ?? "bin";
    const key = avatarStorageKey(req.auth.sub, ext);
    const storage = await getStorageForClient(req.auth.cid);
    const prevKey = storageKeyFromMediaUrl(current.avatarUrl, req.auth.cid);
    await storage.put(key, buffer, file.mimetype);
    const url = unsignedMediaUrl(req.auth.cid, key);

    await db
      .update(users)
      .set({ avatarUrl: url, updatedAt: new Date() })
      .where(eq(users.id, req.auth.sub));

    if (prevKey && prevKey !== key) {
      await storage.delete(prevKey).catch((err: unknown) => req.log.warn({ err }, "failed to delete previous avatar"));
    }

    const result = withSignedMedia(req.auth.cid, { avatarUrl: url });
    await emitProfileUpdated(req.auth.sub, req.auth.cid, current.displayName, result.avatarUrl);
    return result;
  });

  app.delete("/auth/me/avatar", { preHandler: app.authenticate }, async (req) => {
    const [current] = await db
      .select({ avatarUrl: users.avatarUrl, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    if (!current) throw unauthorized();

    const prevKey = storageKeyFromMediaUrl(current.avatarUrl, req.auth.cid);
    if (prevKey) {
      const storage = await getStorageForClient(req.auth.cid);
      await storage.delete(prevKey).catch((err: unknown) => req.log.warn({ err }, "failed to delete avatar"));
    }

    await db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, req.auth.sub));

    await emitProfileUpdated(req.auth.sub, req.auth.cid, current.displayName, null);
    return { avatarUrl: null };
  });

  app.post("/auth/change-password", { preHandler: app.authenticate }, async (req) => {
    const body = dto.changePasswordBody.parse(req.body);
    const [row] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    if (!row) throw unauthorized();
    if (!(await verifyPassword(row.passwordHash, body.currentPassword))) {
      throw unauthorized("invalid current password");
    }

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
        .where(eq(users.id, row.id));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, row.id));
    });

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
      .select({ id: users.id, email: users.email, displayName: users.displayName })
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
        await app.mailer.sendPasswordReset(user.email, user.displayName, resetUrl);
      } catch (err) {
        req.log.error({ err, userId: user.id }, "failed to process password reset email");
      }
    }
    return { ok: true };
  });

  app.post("/auth/reset-password", { preHandler: authRateLimit("reset-password") }, async (req) => {
    const body = dto.resetPasswordBody.parse(req.body);
    const tokenHash = hashOpaqueToken(body.token);

    await db.transaction(async (tx) => {
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
    });
    return { ok: true };
  });
}
