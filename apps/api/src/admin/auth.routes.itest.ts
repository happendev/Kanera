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

void test("POST /admin/auth/login succeeds with valid credentials and sets the admin refresh cookie", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("ops@test.local", "correct-password", "staff");

  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "ops@test.local", password: "correct-password" } });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ accessToken: string; admin: { email: string; role: string } }>();
  assert.ok(body.accessToken);
  assert.equal(body.admin.email, "ops@test.local");
  assert.equal(body.admin.role, "staff");

  const cookie = res.cookies.find((c) => c.name === "kanera_admin_rt");
  assert.ok(cookie, "refresh cookie present");
  assert.equal(cookie.path, "/admin/auth");
  assert.equal(cookie.httpOnly, true);
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

  const locked = await app.inject({ method: "POST", url: "/admin/auth/login", remoteAddress: "198.51.100.11", payload: { email: "locked@test.local", password: "correct-password" } });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json<{ message: string }>().message, "account temporarily locked; try again in 5 minutes");

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
