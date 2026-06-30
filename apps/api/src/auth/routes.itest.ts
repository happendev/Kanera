import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import { clients, refreshTokens, users } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { hashRefresh, REFRESH_REUSE_GRACE_MS } from "./jwt.js";

type AuthResponse = { accessToken: string; user: { id: string } };

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
