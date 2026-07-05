import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import { boardMembers, boards, clients, mfaCredentials, refreshTokens, users, workspaces } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { hashRefresh, REFRESH_REUSE_GRACE_MS } from "./jwt.js";
import * as OTPAuth from "otpauth";

type AuthResponse = { accessToken: string; user: { id: string } };

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function totp(secret: string, label: string) {
  return new OTPAuth.TOTP({ issuer: "Kanera", label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

// A TOTP for the next period. Replay protection rejects any code at or below the last accepted
// timestep, so a login code after enrollment (whose confirm consumed the current step) must come
// from a later step; +30s is within validate()'s ±1 skew window so it is still accepted now.
function nextTotp(secret: string, label: string): string {
  return totp(secret, label).generate({ timestamp: Date.now() + 30_000 });
}

async function signupUser(email = "owner@example.com", password = "Abc12345") {
  const app = await buildIntegrationServer();
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { orgName: "MFA Co", email, password, displayName: "Owner" } });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<AuthResponse>();
  return { app, accessToken, userId: user.id, email, password };
}

// Self-service enrollment via the authenticated endpoints, leaving the user with MFA enabled.
async function enrollMfa(app: Awaited<ReturnType<typeof signupUser>>["app"], accessToken: string, email: string, password: string) {
  const started = await app.inject({ method: "POST", url: "/auth/mfa/enroll", headers: authHeader(accessToken), payload: { currentPassword: password } });
  assert.equal(started.statusCode, 200);
  const secret = started.json<{ secret: string }>().secret;
  const confirmed = await app.inject({ method: "POST", url: "/auth/mfa/enroll/confirm", headers: authHeader(accessToken), payload: { code: totp(secret, email).generate() } });
  assert.equal(confirmed.statusCode, 200);
  return { secret, recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

async function startLoginChallenge(app: Awaited<ReturnType<typeof signupUser>>["app"], email: string, password: string): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const body = login.json<{ status: string; challengeToken: string }>();
  assert.equal(body.status, "mfa_required");
  assert.equal(login.cookies.some((cookie) => cookie.name === "kanera_rt"), false);
  return body.challengeToken;
}

async function signupAndCookie() {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Refresh Co",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const refreshCookie = signup.cookies.find((cookie) => cookie.name === "kanera_rt");
  assert.ok(refreshCookie);
  return { app, refreshCookie: refreshCookie.value, userId: signup.json<AuthResponse>().user.id };
}

void test("POST /auth/signup stores durable signup timestamps for user and organisation analytics", async () => {
  const app = await buildIntegrationServer();
  const beforeSignup = Date.now();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Analytics Signup Co",
      email: "analytics-signup-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  const afterSignup = Date.now();

  assert.equal(signup.statusCode, 200);
  const { user } = signup.json<{ user: { id: string; clientId: string } }>();
  const [createdUser] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  const [createdClient] = await db.select().from(clients).where(eq(clients.id, user.clientId)).limit(1);

  assert.ok(createdUser?.createdAt);
  assert.ok(createdClient?.createdAt);
  assert.ok(createdUser.createdAt.getTime() >= beforeSignup);
  assert.ok(createdUser.createdAt.getTime() <= afterSignup);
  assert.ok(createdClient.createdAt.getTime() >= beforeSignup);
  assert.ok(createdClient.createdAt.getTime() <= afterSignup);
});

void test("organisation MFA policy forces enrollment before password login issues a session", async () => {
  const { app, userId } = await signupAndCookie();
  const [user] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(clients).set({ requireMfa: true }).where(eq(clients.id, user!.clientId));

  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "owner@example.com", password: "Abc12345" } });
  const challenge = login.json<{ status: string; challengeToken: string }>();
  assert.equal(challenge.status, "mfa_enrollment_required");
  assert.equal(login.cookies.some((cookie) => cookie.name === "kanera_rt"), false);

  const started = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll", payload: { challengeToken: challenge.challengeToken } });
  const setup = started.json<{ secret: string }>();
  const code = new OTPAuth.TOTP({ issuer: "Kanera", label: "owner@example.com", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(setup.secret) }).generate();
  const confirmed = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll/confirm", payload: { challengeToken: challenge.challengeToken, code } });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes.length, 10);
  assert.equal(confirmed.cookies.some((cookie) => cookie.name === "kanera_rt"), false);

  const acknowledged = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll/acknowledge", payload: { challengeToken: challenge.challengeToken } });
  assert.equal(acknowledged.statusCode, 200);
  assert.ok(acknowledged.json<AuthResponse>().accessToken);
  assert.ok(acknowledged.cookies.find((cookie) => cookie.name === "kanera_rt"));
});

void test("a guest must enroll when a board's host organisation requires MFA", async () => {
  const { app, userId } = await signupAndCookie();
  const [host] = await db.insert(clients).values({ name: "Secure Host", requireMfa: true }).returning({ id: clients.id });
  const [workspace] = await db.insert(workspaces).values({ clientId: host!.id, name: "Secure Workspace" }).returning({ id: workspaces.id });
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Guest Board", position: "1000.0000000000" }).returning({ id: boards.id });
  await db.insert(boardMembers).values({ boardId: board!.id, userId });

  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "owner@example.com", password: "Abc12345" } });
  const body = login.json<{ status: string; challengeToken: string }>();
  assert.equal(body.status, "mfa_enrollment_required");
  assert.ok(body.challengeToken);
  assert.equal(login.cookies.some((cookie) => cookie.name === "kanera_rt"), false);

  const enrollment = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll", payload: { challengeToken: body.challengeToken } });
  assert.equal(enrollment.statusCode, 200);
});

void test("an enrolled user completes login with a TOTP code", async () => {
  const { app, accessToken, email, password } = await signupUser();
  const { secret } = await enrollMfa(app, accessToken, email, password);

  const challengeToken = await startLoginChallenge(app, email, password);
  const verified = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken, code: nextTotp(secret, email) } });

  assert.equal(verified.statusCode, 200);
  assert.ok(verified.json<AuthResponse>().accessToken);
  assert.ok(verified.cookies.find((cookie) => cookie.name === "kanera_rt"));
});

void test("a recovery code authenticates once and cannot be reused", async () => {
  const { app, accessToken, email, password } = await signupUser();
  const { recoveryCodes } = await enrollMfa(app, accessToken, email, password);

  const first = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code: recoveryCodes[0]! } });
  assert.equal(first.statusCode, 200);

  const reused = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code: recoveryCodes[0]! } });
  assert.equal(reused.statusCode, 401);
});

void test("a TOTP code cannot be replayed at login", async () => {
  const { app, accessToken, userId, email, password } = await signupUser();
  const { secret } = await enrollMfa(app, accessToken, email, password);
  const code = nextTotp(secret, email);

  const first = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code } });
  assert.equal(first.statusCode, 200);

  const replay = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code } });
  assert.equal(replay.statusCode, 401);

  // The replay attempt is a genuine failure and counts toward the lockout counter.
  const [credential] = await db.select({ attempts: mfaCredentials.failedVerifyAttempts }).from(mfaCredentials).where(eq(mfaCredentials.userId, userId)).limit(1);
  assert.equal(credential!.attempts, 1);
});

void test("repeated wrong TOTP codes lock second-factor verification", async () => {
  const { app, accessToken, userId, email, password } = await signupUser();
  const { secret } = await enrollMfa(app, accessToken, email, password);

  for (let i = 0; i < 5; i += 1) {
    const wrong = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code: "000000" } });
    assert.equal(wrong.statusCode, 401);
  }

  // A correct code is now rejected because the credential is locked, not because the code is wrong.
  const good = nextTotp(secret, email);
  const locked = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code: good } });
  assert.equal(locked.statusCode, 401);

  // Clearing the lock (as an admin reset would, minus deleting the credential) restores access.
  await db.update(mfaCredentials).set({ failedVerifyAttempts: 0, lockedUntil: null }).where(eq(mfaCredentials.userId, userId));
  const recovered = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload: { challengeToken: await startLoginChallenge(app, email, password), code: good } });
  assert.equal(recovered.statusCode, 200);
});

void test("a user cannot disable MFA while their organisation requires it", async () => {
  const { app, accessToken, userId, email, password } = await signupUser();
  const { recoveryCodes } = await enrollMfa(app, accessToken, email, password);
  const [user] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(clients).set({ requireMfa: true }).where(eq(clients.id, user!.clientId));

  const blocked = await app.inject({ method: "DELETE", url: "/auth/mfa", headers: authHeader(accessToken), payload: { currentPassword: password, code: recoveryCodes[0]! } });
  assert.equal(blocked.statusCode, 403);

  await db.update(clients).set({ requireMfa: false }).where(eq(clients.id, user!.clientId));
  const allowed = await app.inject({ method: "DELETE", url: "/auth/mfa", headers: authHeader(accessToken), payload: { currentPassword: password, code: recoveryCodes[1]! } });
  assert.equal(allowed.statusCode, 200);
});

void test("POST /auth/refresh rotates a valid refresh token and sets a replacement cookie", async () => {
  const { app, refreshCookie, userId } = await signupAndCookie();

  const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: refreshCookie } });

  assert.equal(refreshed.statusCode, 200);
  assert.ok(refreshed.json<AuthResponse>().accessToken);
  const replacementCookie = refreshed.cookies.find((cookie) => cookie.name === "kanera_rt");
  assert.ok(replacementCookie);
  assert.equal(replacementCookie.path, "/auth");
  assert.equal(replacementCookie.httpOnly, true);
  assert.match(String(replacementCookie.maxAge), /^\d+$/);

  const oldRows = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefresh(refreshCookie)));
  assert.equal(oldRows.length, 1);
  assert.ok(oldRows[0]!.revokedAt);
  assert.ok(oldRows[0]!.replacedById);

  const activeRows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
  assert.equal(activeRows.filter((row) => row.revokedAt === null).length, 1);
});

void test("POST /auth/refresh accepts immediate reuse of a just-rotated token without revoking the active session", async () => {
  const { app, refreshCookie, userId } = await signupAndCookie();

  const first = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: refreshCookie } });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: refreshCookie } });

  assert.equal(second.statusCode, 200);
  assert.ok(second.json<AuthResponse>().accessToken);
  assert.equal(second.cookies.some((cookie) => cookie.name === "kanera_rt"), false);

  const activeRows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
  assert.equal(activeRows.filter((row) => row.revokedAt === null).length, 1);
});

void test("POST /auth/refresh treats old rotated token reuse outside the grace window as theft", async () => {
  const { app, refreshCookie, userId } = await signupAndCookie();

  const first = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: refreshCookie } });
  assert.equal(first.statusCode, 200);

  const staleRevokedAt = new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000);
  await db
    .update(refreshTokens)
    .set({ revokedAt: staleRevokedAt })
    .where(eq(refreshTokens.tokenHash, hashRefresh(refreshCookie)));

  const reused = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: refreshCookie } });

  assert.equal(reused.statusCode, 401);
  const activeRows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
  assert.equal(activeRows.filter((row) => row.revokedAt === null).length, 0);

  const stillActive = await db.select().from(refreshTokens).where(isNull(refreshTokens.revokedAt));
  assert.equal(stillActive.length, 0);
});
