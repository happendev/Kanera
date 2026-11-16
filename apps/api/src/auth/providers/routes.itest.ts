import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { and, desc, eq } from "drizzle-orm";
import { clients, emailQueue, mfaCredentials, userIdentities, users } from "@kanera/shared/schema";
import type { SignInProvider } from "@kanera/shared/schema";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";
import type { ProviderProfile } from "./adapters.js";

// Drives the real begin → provider → callback → complete flow against a stub OAuth server (the
// KANERA_TEST_OAUTH_ISSUER adapters). Failures caught here: login CSRF through a missing browser
// binding, an unverified provider email reaching an existing account, a provider session blocked by
// (or skipping a user's own) MFA, and a passwordless account locking itself out.

const profiles = new Map<string, ProviderProfile>();
let stub: Server;
let previous: { mode: typeof env.KANERA_DEPLOYMENT_MODE; issuer: string | undefined };

before(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (req.method === "POST" && url.pathname.endsWith("/token")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const code = new URLSearchParams(body).get("code") ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: code, token_type: "Bearer" }));
      });
      return;
    }
    if (url.pathname.endsWith("/profile")) {
      const profile = profiles.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      res.writeHead(profile ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(profile ?? {}));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  previous = { mode: env.KANERA_DEPLOYMENT_MODE, issuer: env.KANERA_TEST_OAUTH_ISSUER };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.KANERA_TEST_OAUTH_ISSUER = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(async () => {
  env.KANERA_DEPLOYMENT_MODE = previous.mode;
  env.KANERA_TEST_OAUTH_ISSUER = previous.issuer;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

type Flow = { cookie: string; state: string };

function flowCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((candidate) => candidate.name === "kanera_pf");
  assert.ok(cookie, "expected the browser-binding cookie");
  return cookie.value;
}

async function begin(app: FastifyInstance, provider: SignInProvider, payload: Record<string, unknown> = {}, accessToken?: string): Promise<Flow> {
  const res = await app.inject({
    method: "POST",
    url: accessToken ? `/auth/me/identities/${provider}/begin` : `/auth/providers/${provider}/begin`,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  const state = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl).searchParams.get("state");
  assert.ok(state);
  return { cookie: flowCookie(res), state };
}

/** Returns the web callback query the API redirected the browser to. */
async function callback(app: FastifyInstance, provider: SignInProvider, flow: Flow, profile: ProviderProfile, cookie = flow.cookie): Promise<URLSearchParams> {
  const code = crypto.randomUUID();
  profiles.set(code, profile);
  const res = await app.inject({
    method: "GET",
    url: `/auth/providers/${provider}/callback?code=${code}&state=${encodeURIComponent(flow.state)}`,
    headers: { cookie: `kanera_pf=${cookie}` },
  });
  assert.equal(res.statusCode, 302, res.body);
  const location = new URL(res.headers.location as string);
  assert.equal(`${location.origin}${location.pathname}`, `${env.WEB_ORIGIN}/auth/callback`);
  return location.searchParams;
}

async function complete(app: FastifyInstance, flow: Flow, handoff: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/auth/providers/complete", headers: { cookie: `kanera_pf=${flow.cookie}` }, payload: { handoff, ...payload } });
}

/** begin + callback + first complete. */
async function signIn(app: FastifyInstance, provider: SignInProvider, profile: ProviderProfile) {
  const flow = await begin(app, provider, { locale: "en-GB" });
  const handoff = (await callback(app, provider, flow, profile)).get("h");
  assert.ok(handoff, "expected a handoff code");
  return { flow, handoff, res: await complete(app, flow, handoff) };
}

async function passwordSignup(app: FastifyInstance, email: string) {
  const res = await app.inject({ method: "POST", url: "/auth/signup", payload: { orgName: "Acme", email, password: "Abc12345", displayName: "Owner" } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<{ accessToken: string; user: { id: string; clientId: string } }>();
}

async function latestEmail(email: string, type: "account_security" | "email_verification") {
  const [row] = await db.select({ data: emailQueue.data }).from(emailQueue)
    .where(and(eq(emailQueue.type, type), eq(emailQueue.toEmail, email)))
    .orderBy(desc(emailQueue.createdAt)).limit(1);
  return row?.data as Record<string, unknown> | undefined;
}

const profile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  subject: crypto.randomUUID(),
  email: "new@example.com",
  emailVerified: true,
  displayName: "New Person",
  ...overrides,
});

void test("self-hosted offers no providers even when a provider is configured", async () => {
  const app = await buildIntegrationServer();
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  try {
    const config = await app.inject({ method: "GET", url: "/auth/config" });
    assert.deepEqual(config.json<{ signInProviders: string[] }>().signInProviders, []);
    const res = await app.inject({ method: "POST", url: "/auth/providers/google/begin", payload: {} });
    assert.equal(res.statusCode, 404);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = "hosted";
  }
  const hosted = await app.inject({ method: "GET", url: "/auth/config" });
  assert.deepEqual(hosted.json<{ signInProviders: string[] }>().signInProviders, ["google", "microsoft", "github"]);
});

void test("a provider signup creates a passwordless account that signs straight back in", async () => {
  const app = await buildIntegrationServer();
  const person = profile();
  const first = await signIn(app, "github", person);
  assert.equal(first.res.statusCode, 200, first.res.body);
  assert.equal(first.res.json<{ status: string }>().status, "signup_details_required");

  const created = await complete(app, first.flow, first.handoff, { signup: { displayName: "New Person" } });
  assert.equal(created.statusCode, 200, created.body);
  assert.ok(created.json<{ accessToken: string }>().accessToken);
  assert.ok(created.cookies.find((cookie) => cookie.name === "kanera_rt"));
  const [user] = await db.select().from(users).where(eq(users.email, "new@example.com"));
  assert.equal(user!.passwordHash, null);
  assert.ok(user!.emailVerifiedAt);

  // The handoff is single use.
  const replay = await complete(app, first.flow, first.handoff, { signup: { displayName: "New Person" } });
  assert.equal(replay.statusCode, 401);

  // A later sign-in matches on the provider subject, even after the provider email changes.
  const again = await signIn(app, "github", { ...person, email: "renamed@example.com" });
  assert.equal(again.res.statusCode, 200, again.res.body);
  assert.ok(again.res.json<{ accessToken: string }>().accessToken);
});

void test("the callback and the handoff only work in the browser that started the sign-in", async () => {
  const app = await buildIntegrationServer();
  const flow = await begin(app, "google");
  const forged = await callback(app, "google", flow, profile(), "someone-elses-cookie");
  assert.equal(forged.get("error"), "expired");
  assert.equal(forged.get("h"), null);

  const next = await begin(app, "google");
  const handoff = (await callback(app, "google", next, profile())).get("h")!;
  const stolen = await complete(app, { ...next, cookie: "attacker" }, handoff);
  assert.equal(stolen.statusCode, 401);
  assert.equal(stolen.json<{ code: string }>().code, "PROVIDER_SIGN_IN_EXPIRED");
});

void test("a verified email links to the existing account; an unverified one needs the emailed code", async () => {
  const app = await buildIntegrationServer();
  const owner = await passwordSignup(app, "owner@example.com");

  const verified = await signIn(app, "google", profile({ email: "owner@example.com" }));
  assert.equal(verified.res.statusCode, 200, verified.res.body);
  assert.equal(verified.res.json<{ user: { id: string } }>().user.id, owner.user.id);
  assert.equal((await latestEmail("owner@example.com", "account_security"))?.event, "sign_in_method_added");

  const unverified = await signIn(app, "microsoft", profile({ email: "owner@example.com", emailVerified: false }));
  assert.deepEqual(unverified.res.json(), { status: "email_code_required", email: "owner@example.com" });
  assert.equal((await db.select().from(userIdentities).where(eq(userIdentities.provider, "microsoft"))).length, 0);

  const wrong = await complete(app, unverified.flow, unverified.handoff, { code: "000000" });
  assert.equal(wrong.statusCode, 400);
  const code = (await latestEmail("owner@example.com", "email_verification"))?.code as string;
  const confirmed = await complete(app, unverified.flow, unverified.handoff, { code });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json<{ user: { id: string } }>().user.id, owner.user.id);
});

void test("closed signups block a provider signup but not an existing account", async () => {
  const app = await buildIntegrationServer();
  await passwordSignup(app, "owner@example.com");
  const prev = env.SIGNUPS_ENABLED;
  env.SIGNUPS_ENABLED = false;
  try {
    const flow = await begin(app, "google");
    assert.equal((await callback(app, "google", flow, profile())).get("error"), "signups_closed");
    const existing = await signIn(app, "google", profile({ email: "owner@example.com" }));
    assert.ok(existing.res.json<{ accessToken: string }>().accessToken);
  } finally {
    env.SIGNUPS_ENABLED = prev;
  }
});

void test("a provider session satisfies organisation MFA through refresh, but personal MFA still asks", async () => {
  const app = await buildIntegrationServer();
  const owner = await passwordSignup(app, "owner@example.com");
  await db.update(clients).set({ requireMfa: true }).where(eq(clients.id, owner.user.clientId));

  const password = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "owner@example.com", password: "Abc12345" } });
  assert.equal(password.json<{ status: string }>().status, "mfa_enrollment_required");

  const subject = crypto.randomUUID();
  const provider = await signIn(app, "google", profile({ subject, email: "owner@example.com" }));
  assert.ok(provider.res.json<{ accessToken: string }>().accessToken, provider.res.body);
  const refreshCookie = provider.res.cookies.find((cookie) => cookie.name === "kanera_rt")!;
  const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: `kanera_rt=${refreshCookie.value}` }, payload: {} });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.ok(refreshed.json<{ accessToken: string }>().accessToken);

  await db.insert(mfaCredentials).values({ userId: owner.user.id, encryptedSecret: "unused", enabledAt: new Date() });
  const personal = await signIn(app, "google", profile({ subject, email: "owner@example.com" }));
  assert.equal(personal.res.json<{ status: string }>().status, "mfa_required");
  assert.equal(personal.res.cookies.some((cookie) => cookie.name === "kanera_rt"), false);
});

void test("a passwordless account keeps a way in and sets a password with an emailed code", async () => {
  const app = await buildIntegrationServer();
  const first = await signIn(app, "google", profile());
  const created = await complete(app, first.flow, first.handoff, { signup: { displayName: "New Person" } });
  const auth = { authorization: `Bearer ${created.json<{ accessToken: string }>().accessToken}` };

  const last = await app.inject({ method: "DELETE", url: "/auth/me/identities/google", headers: auth });
  assert.equal(last.statusCode, 409);
  assert.equal(last.json<{ code: string }>().code, "LAST_SIGN_IN_METHOD");

  const noCode = await app.inject({ method: "POST", url: "/auth/change-password", headers: auth, payload: { newPassword: "Xyz98765" } });
  assert.equal(noCode.statusCode, 400);
  const sent = await app.inject({ method: "POST", url: "/auth/me/step-up-code", headers: auth });
  assert.equal(sent.statusCode, 200, sent.body);
  const code = (await latestEmail("new@example.com", "email_verification"))?.code as string;
  const set = await app.inject({ method: "POST", url: "/auth/change-password", headers: auth, payload: { newPassword: "Xyz98765", emailCode: code } });
  assert.equal(set.statusCode, 200, set.body);

  const methods = await app.inject({ method: "GET", url: "/auth/me/sign-in-methods", headers: auth });
  assert.equal(methods.json<{ hasPassword: boolean }>().hasPassword, true);
  const removed = await app.inject({ method: "DELETE", url: "/auth/me/identities/google", headers: auth });
  assert.equal(removed.statusCode, 200, removed.body);
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "new@example.com", password: "Xyz98765" } });
  assert.ok(login.json<{ accessToken: string }>().accessToken);
});

void test("connecting from settings links the provider, and refuses one already on another account", async () => {
  const app = await buildIntegrationServer();
  const owner = await passwordSignup(app, "owner@example.com");
  const other = await passwordSignup(app, "other@example.com");
  const subject = crypto.randomUUID();

  const flow = await begin(app, "github", { returnUrl: "/settings/account-security" }, owner.accessToken);
  const params = await callback(app, "github", flow, profile({ subject, email: "owner@github.example" }));
  assert.equal(params.get("intent"), "link");
  const linked = await complete(app, flow, params.get("h")!);
  assert.deepEqual(linked.json(), { status: "linked", provider: "github", returnUrl: "/settings/account-security" });

  const taken = await begin(app, "github", {}, other.accessToken);
  const refused = await callback(app, "github", taken, profile({ subject, email: "owner@github.example" }));
  assert.equal(refused.get("error"), "identity_in_use");
  assert.equal(refused.get("intent"), "link");
});
