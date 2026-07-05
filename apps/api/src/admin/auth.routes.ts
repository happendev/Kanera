import { dto } from "@kanera/shared";
import { adminRefreshTokens, adminUsers, mfaCredentials } from "@kanera/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { unauthorized } from "../lib/errors.js";
import { verifyPasswordTimingSafe } from "../auth/password.js";
import { hashAdminRefresh, newAdminRefreshToken, rotateAdminRefresh } from "./jwt.js";
import { signAdminAccessToken } from "./plugin.js";
import { beginMfaEnrollment, createMfaChallenge, enableMfa, getMfaCredential, readMfaChallenge, verifyMfaCode, verifyMfaLoginCode } from "../auth/mfa.js";

const ADMIN_REFRESH_COOKIE = "kanera_admin_rt";
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ADMIN_LOGIN_LOCK_MS = 5 * 60 * 1000;

// Distinct cookie name AND path from the tenant `kanera_rt` (which is scoped to /auth). Scoping to
// /admin/auth means the browser never sends the admin refresh token to tenant endpoints and vice-versa,
// so the two sessions cannot collide even on a shared parent domain.
function adminRefreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    path: "/admin/auth",
    maxAge: env.ADMIN_JWT_REFRESH_TTL_DAYS * 86_400,
  };
}

function adminPayload(row: { id: string; email: string; displayName: string; role: string }) {
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
}

export interface AdminAuthRouteDeps {
  // Per-IP login throttle, supplied by the server so it shares the one rate limiter instance.
  loginLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function adminAuthRoutes(app: FastifyInstance, deps: AdminAuthRouteDeps) {
  async function issueAdminSession(adminId: string, reply: FastifyReply) {
    const [row] = await db.select({ id: adminUsers.id, email: adminUsers.email, displayName: adminUsers.displayName, role: adminUsers.role, disabledAt: adminUsers.disabledAt }).from(adminUsers).where(eq(adminUsers.id, adminId)).limit(1);
    if (!row || row.disabledAt) throw unauthorized();
    const accessToken = signAdminAccessToken(app, { sub: row.id, role: row.role });
    const refresh = newAdminRefreshToken();
    await db.transaction(async (tx) => {
      await tx.insert(adminRefreshTokens).values({ adminUserId: row.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt });
      await tx.update(adminUsers).set({ lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null }).where(eq(adminUsers.id, row.id));
    });
    reply.setCookie(ADMIN_REFRESH_COOKIE, refresh.raw, adminRefreshCookieOptions());
    return { status: "authenticated" as const, accessToken, admin: adminPayload(row) };
  }

  app.post("/auth/login", { preHandler: deps.loginLimit }, async (req, _reply) => {
    const body = dto.adminLoginBody.parse(req.body);

    const [row] = await db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        displayName: adminUsers.displayName,
        role: adminUsers.role,
        passwordHash: adminUsers.passwordHash,
        disabledAt: adminUsers.disabledAt,
        failedLoginAttempts: adminUsers.failedLoginAttempts,
        lockedUntil: adminUsers.lockedUntil,
      })
      .from(adminUsers)
      .where(eq(adminUsers.email, body.email))
      .limit(1);

    // Always run a verification (dummy hash when the email is unknown) so response timing does not reveal
    // whether an admin account exists. Identical error for missing-account and wrong-password.
    const passwordOk = await verifyPasswordTimingSafe(row?.passwordHash ?? null, body.password);
    // A locked account returns the SAME generic 401 as a wrong password or an unknown email — never a
    // distinct 429 — so the lock status cannot be used to enumerate which admin emails exist (an attacker
    // who locks an account by guessing would otherwise see 429 for real emails and 401 for fake ones).
    // The lock still fully blocks login, including with the correct password, until lockedUntil passes;
    // it just does so silently. Checked after the constant-time verify above so timing stays uniform too.
    if (row?.lockedUntil && row.lockedUntil > new Date()) {
      throw unauthorized("invalid credentials");
    }
    if (!row || !passwordOk) {
      if (row) {
        const now = new Date();
        if (row.lockedUntil) {
          await db.update(adminUsers).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(adminUsers.id, row.id));
        }
        // Increment in SQL so concurrent failures cannot overwrite one another and bypass the threshold.
        const [failed] = await db.update(adminUsers).set({
          failedLoginAttempts: sql`${adminUsers.failedLoginAttempts} + 1`,
          updatedAt: now,
        }).where(eq(adminUsers.id, row.id)).returning({ attempts: adminUsers.failedLoginAttempts });
        if (failed && failed.attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
          await db.update(adminUsers).set({ lockedUntil: new Date(now.getTime() + ADMIN_LOGIN_LOCK_MS) }).where(eq(adminUsers.id, row.id));
        }
      }
      throw unauthorized("invalid credentials");
    }
    if (row.disabledAt) throw unauthorized("account disabled");
    // A correct password ends the password-lockout state even though MFA still gates session issuance.
    await db.update(adminUsers).set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(adminUsers.id, row.id));
    const credential = await getMfaCredential({ kind: "admin", id: row.id });
    return credential?.enabledAt && credential.recoveryCodesAcknowledgedAt
      ? { status: "mfa_required" as const, challengeToken: createMfaChallenge({ kind: "admin", id: row.id }, "verify") }
      : { status: "mfa_enrollment_required" as const, challengeToken: createMfaChallenge({ kind: "admin", id: row.id }, "enroll") };
  });

  app.post("/auth/mfa/verify", { preHandler: deps.loginLimit }, async (req, reply) => {
    const body = dto.adminMfaChallengeBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "admin", "verify"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential?.enabledAt || !(await verifyMfaLoginCode(credential, body.code))) throw unauthorized("invalid verification code");
    return issueAdminSession(challenge.id, reply);
  });

  app.post("/auth/mfa/enroll", { preHandler: deps.loginLimit }, async (req) => {
    const body = dto.adminMfaEnrollmentStartBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "admin", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const [admin] = await db.select({ email: adminUsers.email, disabledAt: adminUsers.disabledAt }).from(adminUsers).where(eq(adminUsers.id, challenge.id)).limit(1);
    if (!admin || admin.disabledAt) throw unauthorized();
    const result = await beginMfaEnrollment(challenge, admin.email);
    return { secret: result.secret, otpauthUri: result.otpauthUri };
  });

  app.post("/auth/mfa/enroll/confirm", { preHandler: deps.loginLimit }, async (req, reply) => {
    const body = dto.adminMfaEnrollmentConfirmBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "admin", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential || credential.enabledAt || !(await verifyMfaCode(credential, body.code, false))) throw unauthorized("invalid verification code");
    return { status: "recovery_codes_required" as const, recoveryCodes: await enableMfa(credential.id) };
  });

  app.post("/auth/mfa/enroll/acknowledge", { preHandler: deps.loginLimit }, async (req, reply) => {
    const body = dto.adminMfaEnrollmentStartBody.parse(req.body);
    let challenge;
    try { challenge = readMfaChallenge(body.challengeToken, "admin", "enroll"); } catch { throw unauthorized("invalid or expired challenge"); }
    const credential = await getMfaCredential(challenge);
    if (!credential?.enabledAt) throw unauthorized("enrollment incomplete");
    await db.update(mfaCredentials).set({ recoveryCodesAcknowledgedAt: new Date(), updatedAt: new Date() }).where(eq(mfaCredentials.id, credential.id));
    return issueAdminSession(challenge.id, reply);
  });

  app.post("/auth/refresh", async (req, reply) => {
    const raw = req.cookies[ADMIN_REFRESH_COOKIE];
    if (!raw) throw unauthorized();

    const refresh = await rotateAdminRefresh(raw);
    if (refresh.status === "reused") {
      req.log.warn({ adminUserId: refresh.adminUserId }, "detected admin refresh token reuse; revoked active tokens");
      throw unauthorized();
    }
    if (refresh.status === "invalid") throw unauthorized();

    const [admin] = await db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        displayName: adminUsers.displayName,
        role: adminUsers.role,
        disabledAt: adminUsers.disabledAt,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, refresh.adminUserId))
      .limit(1);
    // Stop token renewal for a disabled/deleted admin; any live access token expires within its short TTL.
    if (!admin || admin.disabledAt) throw unauthorized();

    const accessToken = signAdminAccessToken(app, { sub: admin.id, role: admin.role });
    if (refresh.status === "rotated") {
      reply.setCookie(ADMIN_REFRESH_COOKIE, refresh.fresh.raw, adminRefreshCookieOptions());
    }
    return { accessToken, admin: adminPayload(admin) };
  });

  app.post("/auth/logout", async (req, reply) => {
    const raw = req.cookies[ADMIN_REFRESH_COOKIE];
    if (raw) {
      await db
        .update(adminRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(adminRefreshTokens.tokenHash, hashAdminRefresh(raw)));
    }
    reply.clearCookie(ADMIN_REFRESH_COOKIE, adminRefreshCookieOptions());
    return { ok: true };
  });

  // Authenticated separately from the business-route scope, so it carries its own preHandler.
  app.get("/me", { preHandler: app.adminAuthenticate }, async (req) => {
    const [admin] = await db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        displayName: adminUsers.displayName,
        role: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, req.adminAuth.sub))
      .limit(1);
    if (!admin) throw unauthorized();
    return { admin: adminPayload(admin) };
  });
}
