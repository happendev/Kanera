import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { adminAuditLogs, clients, supportSessions, users } from "@kanera/shared/schema";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildAdminIntegrationServer, buildIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";

type SignupResult = { tenantApp: FastifyInstance; clientId: string; userId: string; email: string };

async function signupOrg(orgName: string, email: string): Promise<SignupResult> {
  const tenantApp = await buildIntegrationServer();
  const res = await tenantApp.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(res.statusCode, 200);
  const { user } = res.json<{ user: { id: string; clientId: string } }>();
  return { tenantApp, clientId: user.clientId, userId: user.id, email };
}

// Pull the tenant support token out of the enter URL fragment the portal returns.
function tokenFromUrl(url: string): string {
  const parsed = new URL(url);
  assert.equal(parsed.origin, env.WEB_ORIGIN);
  assert.equal(parsed.pathname, "/support/enter");
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  assert.ok(token, "enter URL carries the token in its fragment");
  return token;
}

void test("a portal superadmin starts a support session that acts as the org owner and is audited twice", async () => {
  const org = await signupOrg("Customer Co", "customer@example.com");
  const adminApp = await buildAdminIntegrationServer();
  const adminId = await createAdmin("ops@kanera.dev", "admin-password", "superadmin");
  const { accessToken: adminToken } = await loginAdmin(adminApp, "ops@kanera.dev", "admin-password");

  const started = await adminApp.inject({
    method: "POST",
    url: `/admin/orgs/${org.clientId}/support-session`,
    headers: adminAuthHeader(adminToken),
    payload: { reason: "help set up their workspace" },
  });
  assert.equal(started.statusCode, 200);
  const body = started.json<{ url: string; expiresAt: string; session: { id: string; targetClientId: string; targetUserId: string; orgName: string }; actingAsEmail: string }>();
  assert.equal(body.session.targetClientId, org.clientId);
  assert.equal(body.session.targetUserId, org.userId);
  assert.equal(body.session.orgName, "Customer Co");
  assert.equal(body.actingAsEmail, org.email);

  // The minted token is a genuine cross-tenant credential: /me on the tenant server resolves to the org.
  const token = tokenFromUrl(body.url);
  const me = await org.tenantApp.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json<{ clientId: string }>().clientId, org.clientId);

  // Durable support_session row records which admin impersonated whom and why.
  const [row] = await db.select().from(supportSessions).where(eq(supportSessions.id, body.session.id));
  assert.ok(row);
  assert.equal(row.adminUserId, adminId);
  assert.equal(row.adminEmail, "ops@kanera.dev");
  assert.equal(row.targetClientId, org.clientId);
  assert.equal(row.targetOrgName, "Customer Co");
  assert.equal(row.targetUserEmail, "customer@example.com");
  assert.equal(row.reason, "help set up their workspace");
  assert.equal(row.endedAt, null);

  // And an admin_audit_log entry so the action shows in the portal audit trail.
  const audit = await db
    .select()
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, "support.session.start"), eq(adminAuditLogs.targetClientId, org.clientId)));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.adminUserId, adminId);
  assert.equal(audit[0]!.targetUserId, org.userId);

  // The portal list surfaces the live session (filtered to this org, active-only) for revocation.
  const list = await adminApp.inject({
    method: "GET",
    url: `/admin/support-sessions?clientId=${org.clientId}&status=active`,
    headers: adminAuthHeader(adminToken),
  });
  assert.equal(list.statusCode, 200);
  const listed = list.json<{ items: { id: string; adminEmail: string; active: boolean }[]; total: number }>();
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]!.id, body.session.id);
  assert.equal(listed.items[0]!.adminEmail, "ops@kanera.dev");
  assert.equal(listed.items[0]!.active, true);
});

void test("a support session cannot target an org whose only owner is soft-deleted", async () => {
  const org = await signupOrg("Gone Co", "gone@example.com");
  // Admin soft-deletes the sole owner; the resolver must not fall back to acting as a deactivated account.
  await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, org.userId));
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("ops@kanera.dev", "admin-password", "superadmin");
  const { accessToken: adminToken } = await loginAdmin(adminApp, "ops@kanera.dev", "admin-password");

  const res = await adminApp.inject({
    method: "POST",
    url: `/admin/orgs/${org.clientId}/support-session`,
    headers: adminAuthHeader(adminToken),
    payload: { reason: "must not resolve a deleted owner" },
  });
  assert.equal(res.statusCode, 404);
});

void test("a support session cannot target a soft-deleted org", async () => {
  const org = await signupOrg("Deleted Co", "deleted@example.com");
  await db.update(clients).set({ deletedAt: new Date() }).where(eq(clients.id, org.clientId));
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("ops@kanera.dev", "admin-password", "superadmin");
  const { accessToken: adminToken } = await loginAdmin(adminApp, "ops@kanera.dev", "admin-password");

  const res = await adminApp.inject({
    method: "POST",
    url: `/admin/orgs/${org.clientId}/support-session`,
    headers: adminAuthHeader(adminToken),
    payload: { reason: "must not enter a deleted org" },
  });
  assert.equal(res.statusCode, 404);
});

void test("a staff admin cannot start a support session", async () => {
  const org = await signupOrg("Customer Co", "customer@example.com");
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("staff@kanera.dev", "admin-password", "staff");
  const { accessToken: staffToken } = await loginAdmin(adminApp, "staff@kanera.dev", "admin-password");

  const res = await adminApp.inject({
    method: "POST",
    url: `/admin/orgs/${org.clientId}/support-session`,
    headers: adminAuthHeader(staffToken),
    payload: { reason: "should be forbidden" },
  });
  assert.equal(res.statusCode, 403);
});

void test("revoking a support session from the portal immediately invalidates its token", async () => {
  const org = await signupOrg("Customer Co", "customer@example.com");
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("ops@kanera.dev", "admin-password", "superadmin");
  const { accessToken: adminToken } = await loginAdmin(adminApp, "ops@kanera.dev", "admin-password");

  const started = await adminApp.inject({
    method: "POST",
    url: `/admin/orgs/${org.clientId}/support-session`,
    headers: adminAuthHeader(adminToken),
    payload: { reason: "will be revoked" },
  });
  assert.equal(started.statusCode, 200);
  const { url, session } = started.json<{ url: string; session: { id: string } }>();
  const token = tokenFromUrl(url);

  // Token works before revocation.
  const before = await org.tenantApp.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(before.statusCode, 200);

  const ended = await adminApp.inject({ method: "POST", url: `/admin/support-sessions/${session.id}/end`, headers: adminAuthHeader(adminToken) });
  assert.equal(ended.statusCode, 200);

  const [row] = await db.select().from(supportSessions).where(eq(supportSessions.id, session.id));
  assert.ok(row?.endedAt);

  // Revocation is not just an audit marker: the same signed token is rejected on the next request.
  const after = await org.tenantApp.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.statusCode, 401);
});

void test("the support token can self-close its own session from the tenant side", async () => {
  const org = await signupOrg("Customer Co", "customer@example.com");
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("ops@kanera.dev", "admin-password", "superadmin");
  const { accessToken: adminToken } = await loginAdmin(adminApp, "ops@kanera.dev", "admin-password");

  const started = await adminApp.inject({
    method: "POST",
    url: `/admin/orgs/${org.clientId}/support-session`,
    headers: adminAuthHeader(adminToken),
    payload: { reason: "operator will leave" },
  });
  assert.equal(started.statusCode, 200);
  const { url, session } = started.json<{ url: string; session: { id: string } }>();
  const token = tokenFromUrl(url);

  // The web app's "Leave session" button hits the tenant endpoint with the support token.
  const ended = await org.tenantApp.inject({ method: "POST", url: `/auth/support-session/${session.id}/end`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(ended.statusCode, 200);

  const after = await org.tenantApp.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.statusCode, 401);
});
