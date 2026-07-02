import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { supportSessions } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildIntegrationServer } from "../test/integration.js";

type SignupResult = { accessToken: string; user: { id: string; clientId: string } };

// SUPERADMIN_EMAILS is env-driven and parsed once at import; the email-verification integration test
// flips env flags per-test the same way, so mutate it here and always restore.
const originalSuperadminEmails = env.SUPERADMIN_EMAILS;
afterEach(() => {
  env.SUPERADMIN_EMAILS = originalSuperadminEmails;
});

async function signup(app: Awaited<ReturnType<typeof buildIntegrationServer>>, orgName: string, email: string): Promise<SignupResult> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(res.statusCode, 200);
  return res.json<SignupResult>();
}

void test("superadmin starts a cross-tenant support session that acts as the target org owner and is audited", async () => {
  const app = await buildIntegrationServer();
  const superadmin = await signup(app, "Ops", "superadmin@example.com");
  const customer = await signup(app, "Customer Co", "customer@example.com");
  // Case-insensitive allowlist match (email is citext); use mixed case to prove normalization.
  env.SUPERADMIN_EMAILS = ["SuperAdmin@Example.com"];

  const started = await app.inject({
    method: "POST",
    url: "/auth/support-session",
    headers: { authorization: `Bearer ${superadmin.accessToken}` },
    payload: { target: "customer@example.com", reason: "help set up their workspace" },
  });

  assert.equal(started.statusCode, 200);
  const body = started.json<{ accessToken: string; url: string; expiresAt: string; session: { id: string; targetClientId: string; targetUserId: string; orgName: string }; user: { clientId: string; orgName: string } }>();
  assert.equal(body.session.targetClientId, customer.user.clientId);
  assert.equal(body.session.targetUserId, customer.user.id);
  assert.equal(body.session.orgName, "Customer Co");
  // The minted session acts inside the target org, not the operator's own.
  assert.equal(body.user.clientId, customer.user.clientId);
  assert.ok(body.accessToken);
  const supportUrl = new URL(body.url);
  assert.equal(supportUrl.origin, env.WEB_ORIGIN);
  assert.equal(supportUrl.pathname, "/support/enter");
  assert.equal(new URLSearchParams(supportUrl.hash.slice(1)).get("token"), body.accessToken);

  // The token is a genuine cross-tenant credential: /me resolves to the target org.
  const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${body.accessToken}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json<{ clientId: string }>().clientId, customer.user.clientId);

  // Durable audit row records who impersonated whom and why.
  const rows = await db.select().from(supportSessions).where(eq(supportSessions.id, body.session.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.superadminUserId, superadmin.user.id);
  assert.equal(rows[0]!.superadminEmail, "superadmin@example.com");
  assert.equal(rows[0]!.targetClientId, customer.user.clientId);
  // Immutable identity snapshots so the audit row survives deletion of the referenced org/user.
  assert.equal(rows[0]!.targetOrgName, "Customer Co");
  assert.equal(rows[0]!.targetUserEmail, "customer@example.com");
  assert.equal(rows[0]!.reason, "help set up their workspace");
  assert.equal(rows[0]!.endedAt, null);
});

void test("a support token cannot start another support session (no chaining)", async () => {
  const app = await buildIntegrationServer();
  const superadmin = await signup(app, "Ops", "superadmin@example.com");
  const customer = await signup(app, "Customer Co", "customer@example.com");
  env.SUPERADMIN_EMAILS = ["superadmin@example.com"];

  const started = await app.inject({
    method: "POST",
    url: "/auth/support-session",
    headers: { authorization: `Bearer ${superadmin.accessToken}` },
    payload: { target: customer.user.clientId, reason: "initial support session" },
  });
  assert.equal(started.statusCode, 200);
  const supportToken = started.json<{ accessToken: string }>().accessToken;

  const chained = await app.inject({
    method: "POST",
    url: "/auth/support-session",
    headers: { authorization: `Bearer ${supportToken}` },
    payload: { target: customer.user.clientId, reason: "trying to chain" },
  });
  assert.equal(chained.statusCode, 403);
});

void test("a non-superadmin user cannot start a support session", async () => {
  const app = await buildIntegrationServer();
  await signup(app, "Customer Co", "customer@example.com");
  const other = await signup(app, "Other Co", "other@example.com");
  env.SUPERADMIN_EMAILS = ["superadmin@example.com"];

  const res = await app.inject({
    method: "POST",
    url: "/auth/support-session",
    headers: { authorization: `Bearer ${other.accessToken}` },
    payload: { target: "customer@example.com", reason: "should be forbidden" },
  });
  assert.equal(res.statusCode, 403);
});

void test("an empty SUPERADMIN_EMAILS allowlist disables support sessions entirely", async () => {
  const app = await buildIntegrationServer();
  const superadmin = await signup(app, "Ops", "superadmin@example.com");
  await signup(app, "Customer Co", "customer@example.com");
  env.SUPERADMIN_EMAILS = [];

  const res = await app.inject({
    method: "POST",
    url: "/auth/support-session",
    headers: { authorization: `Bearer ${superadmin.accessToken}` },
    payload: { target: "customer@example.com", reason: "feature is off" },
  });
  assert.equal(res.statusCode, 403);
});

void test("ending a support session stamps endedAt and immediately revokes its token", async () => {
  const app = await buildIntegrationServer();
  const superadmin = await signup(app, "Ops", "superadmin@example.com");
  const customer = await signup(app, "Customer Co", "customer@example.com");
  env.SUPERADMIN_EMAILS = ["superadmin@example.com"];

  const started = await app.inject({
    method: "POST",
    url: "/auth/support-session",
    headers: { authorization: `Bearer ${superadmin.accessToken}` },
    payload: { target: customer.user.clientId, reason: "will end" },
  });
  assert.equal(started.statusCode, 200);
  const { accessToken, session } = started.json<{ accessToken: string; session: { id: string } }>();

  // The support token may close its own session.
  const ended = await app.inject({
    method: "POST",
    url: `/auth/support-session/${session.id}/end`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(ended.statusCode, 200);

  const [row] = await db.select().from(supportSessions).where(eq(supportSessions.id, session.id));
  assert.ok(row?.endedAt);

  // Ending is revocation, not just an audit marker: the same signed token is rejected immediately.
  const afterEnd = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(afterEnd.statusCode, 401);
});
