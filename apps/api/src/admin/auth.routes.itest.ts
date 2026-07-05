import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { adminRefreshTokens, adminUsers } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildAdminIntegrationServer, buildIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";
import { seedFirstAdmin } from "./bootstrap.js";
import { ADMIN_REFRESH_REUSE_GRACE_MS, hashAdminRefresh } from "./jwt.js";
import { getRedis } from "../redis.js";
import * as OTPAuth from "otpauth";

const SILENT_LOG = { warn() {}, info() {} } as unknown as Parameters<typeof seedFirstAdmin>[0];

void test("seedFirstAdmin bootstraps exactly one superadmin and is idempotent", async () => {
  await seedFirstAdmin(SILENT_LOG);
  const afterFirst = await db.select().from(adminUsers);
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0]!.role, "superadmin");
  assert.equal(afterFirst[0]!.email, "seed-admin@test.local");

  // Running again with an admin already present must not create a second account.
  await seedFirstAdmin(SILENT_LOG);
  const afterSecond = await db.select().from(adminUsers);
  assert.equal(afterSecond.length, 1);
});

void test("POST /admin/auth/login requires MFA enrollment before issuing a session", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("ops@test.local", "correct-password", "staff");

  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "ops@test.local", password: "correct-password" } });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ status: string; challengeToken: string }>();
  assert.equal(body.status, "mfa_enrollment_required");
  assert.ok(body.challengeToken);
  assert.equal(res.cookies.find((c) => c.name === "kanera_admin_rt"), undefined);
});

void test("POST /admin/auth/login rejects a wrong password with the generic error", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("ops@test.local", "correct-password");

  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "ops@test.local", password: "wrong-password" } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json<{ message: string }>().message, "invalid credentials");
});

void test("POST /admin/auth/login rejects an unknown email (timing-safe, same error)", async () => {
  const app = await buildAdminIntegrationServer();
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "nobody@test.local", password: "whatever" } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json<{ message: string }>().message, "invalid credentials");
});

void test("POST /admin/auth/login locks an admin for five minutes after five failed attempts", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("locked@test.local", "correct-password");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const failed = await app.inject({ method: "POST", url: "/admin/auth/login", remoteAddress: "198.51.100.10", payload: { email: "locked@test.local", password: "wrong-password" } });
    assert.equal(failed.statusCode, 401);
  }

  // While locked, even the correct password is refused — but with the generic 401 (not a distinct 429),
  // so the lock cannot be used to tell a real account apart from an unknown email.
  const locked = await app.inject({ method: "POST", url: "/admin/auth/login", remoteAddress: "198.51.100.11", payload: { email: "locked@test.local", password: "correct-password" } });
  assert.equal(locked.statusCode, 401);
  assert.equal(locked.json<{ message: string }>().message, "invalid credentials");

  // Clearing the lock lets the same correct password through, proving the 401 above was the lock (not a
  // credential problem) doing the blocking.
  await db.update(adminUsers).set({ lockedUntil: new Date(Date.now() - 1) }).where(eq(adminUsers.email, "locked@test.local"));
  const recovered = await app.inject({ method: "POST", url: "/admin/auth/login", remoteAddress: "198.51.100.12", payload: { email: "locked@test.local", password: "correct-password" } });
  assert.equal(recovered.statusCode, 200);

  const [admin] = await db.select({ failedLoginAttempts: adminUsers.failedLoginAttempts, lockedUntil: adminUsers.lockedUntil }).from(adminUsers).where(eq(adminUsers.email, "locked@test.local"));
  assert.equal(admin!.failedLoginAttempts, 0);
  assert.equal(admin!.lockedUntil, null);
});

void test("POST /admin/auth/login rate-limits one IP across different emails", async () => {
  const app = await buildAdminIntegrationServer();
  const remoteAddress = "198.51.100.20";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const failed = await app.inject({ method: "POST", url: "/admin/auth/login", remoteAddress, payload: { email: `unknown-${attempt}@test.local`, password: "wrong-password" } });
    assert.equal(failed.statusCode, 401);
  }

  const limited = await app.inject({ method: "POST", url: "/admin/auth/login", remoteAddress, payload: { email: "another-email@test.local", password: "wrong-password" } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["ratelimit-limit"], "5");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});

void test("an enrolled admin's wrong TOTP code is rejected and a valid one authenticates", async () => {
  const app = await buildAdminIntegrationServer();
  const email = "verify@test.local";
  await createAdmin(email, "correct-password");

  // Enroll the admin (login + enroll + confirm + acknowledge). The confirm step consumes the current
  // TOTP timestep, so the login code below is drawn from the next period to clear replay protection.
  const login1 = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password: "correct-password" } });
  const challengeToken = login1.json<{ challengeToken: string }>().challengeToken;
  const started = await app.inject({ method: "POST", url: "/admin/auth/mfa/enroll", payload: { challengeToken } });
  const secret = started.json<{ secret: string }>().secret;
  const makeTotp = () => new OTPAuth.TOTP({ issuer: "Kanera", label: email, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  await app.inject({ method: "POST", url: "/admin/auth/mfa/enroll/confirm", payload: { challengeToken, code: makeTotp().generate() } });
  await app.inject({ method: "POST", url: "/admin/auth/mfa/enroll/acknowledge", payload: { challengeToken } });

  // The admin per-IP throttle (5/window, shared with login/enroll) is already spent by enrollment.
  // Reset it so this test exercises the verify code path, not the rate limiter.
  await getRedis().flushdb();

  const verifyChallenge = (await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password: "correct-password" } })).json<{ status: string; challengeToken: string }>();
  assert.equal(verifyChallenge.status, "mfa_required");

  const wrong = await app.inject({ method: "POST", url: "/admin/auth/mfa/verify", payload: { challengeToken: verifyChallenge.challengeToken, code: "000000" } });
  assert.equal(wrong.statusCode, 401);

  const good = await app.inject({ method: "POST", url: "/admin/auth/mfa/verify", payload: { challengeToken: verifyChallenge.challengeToken, code: makeTotp().generate({ timestamp: Date.now() + 30_000 }) } });
  assert.equal(good.statusCode, 200);
  assert.ok(good.cookies.find((c) => c.name === "kanera_admin_rt"));
});

void test("POST /admin/auth/refresh rotates the token and detects reuse of the old one", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("ops@test.local", "correct-password");
  const { refreshCookie } = await loginAdmin(app, "ops@test.local", "correct-password");

  const first = await app.inject({ method: "POST", url: "/admin/auth/refresh", headers: { cookie: `kanera_admin_rt=${refreshCookie}` } });
  assert.equal(first.statusCode, 200);
  const rotated = first.cookies.find((c) => c.name === "kanera_admin_rt");
  assert.ok(rotated && rotated.value !== refreshCookie, "cookie rotated to a new value");

  // Age the just-revoked original token past the reconnect grace window so a replay reads as theft
  // rather than a racing reconnect (the grace path intentionally returns 200 for a brief window).
  await db
    .update(adminRefreshTokens)
    .set({ revokedAt: new Date(Date.now() - ADMIN_REFRESH_REUSE_GRACE_MS - 1000) })
    .where(eq(adminRefreshTokens.tokenHash, hashAdminRefresh(refreshCookie)));

  // Reusing the original (now-revoked, past-grace) token is treated as theft -> 401.
  const reuse = await app.inject({ method: "POST", url: "/admin/auth/refresh", headers: { cookie: `kanera_admin_rt=${refreshCookie}` } });
  assert.equal(reuse.statusCode, 401);
});

void test("POST /admin/auth/refresh accepts immediate reuse of a just-rotated token", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("grace@test.local", "correct-password");
  const { refreshCookie } = await loginAdmin(app, "grace@test.local", "correct-password");

  const first = await app.inject({ method: "POST", url: "/admin/auth/refresh", headers: { cookie: `kanera_admin_rt=${refreshCookie}` } });
  assert.equal(first.statusCode, 200);

  // A second tab may still carry the old cookie while the first response is being applied. The
  // short grace path issues an access token without rotating or revoking the replacement session.
  const raced = await app.inject({ method: "POST", url: "/admin/auth/refresh", headers: { cookie: `kanera_admin_rt=${refreshCookie}` } });
  assert.equal(raced.statusCode, 200);
  assert.ok(raced.json<{ accessToken: string }>().accessToken);
  assert.equal(raced.cookies.some((cookie) => cookie.name === "kanera_admin_rt"), false);
});

void test("adminAuthenticate rejects a tenant JWT (isolation)", async () => {
  const tenantApp = await buildIntegrationServer();
  const signup = await tenantApp.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Iso Co", email: "iso-owner@test.local", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const tenantToken = signup.json<{ accessToken: string }>().accessToken;

  const adminApp = await buildAdminIntegrationServer();
  const res = await adminApp.inject({ method: "GET", url: "/admin/orgs", headers: adminAuthHeader(tenantToken) });
  // Different secret + namespace: a valid tenant token must not authenticate on the admin API.
  assert.equal(res.statusCode, 401);
});

void test("a disabled admin cannot use an already-issued access token", async () => {
  const app = await buildAdminIntegrationServer();
  const adminId = await createAdmin("ops@test.local", "correct-password");
  const { accessToken } = await loginAdmin(app, "ops@test.local", "correct-password");

  // Token works before disabling.
  const before = await app.inject({ method: "GET", url: "/admin/orgs", headers: adminAuthHeader(accessToken) });
  assert.equal(before.statusCode, 200);

  await db.update(adminUsers).set({ disabledAt: new Date() }).where(eq(adminUsers.id, adminId));

  // The per-request disabledAt check cuts access immediately, without waiting for the token to expire.
  const after = await app.inject({ method: "GET", url: "/admin/orgs", headers: adminAuthHeader(accessToken) });
  assert.equal(after.statusCode, 401);
});
