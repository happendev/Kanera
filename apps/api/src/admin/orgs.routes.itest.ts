import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { adminAuditLogs, clients } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildAdminIntegrationServer, buildIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";

async function signupOrg(orgName: string, email: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { user } = signup.json<{ user: { id: string; clientId: string } }>();
  return { tenantApp: app, clientId: user.clientId, userId: user.id };
}

void test("POST /admin/orgs/:id/suspend sets suspendedAt, writes an audit row, and blocks tenant login", async () => {
  const { tenantApp, clientId } = await signupOrg("Suspend Co", "suspend-owner@test.local");

  const adminApp = await buildAdminIntegrationServer();
  const adminId = await createAdmin("admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "admin@test.local", "admin-password");

  const res = await adminApp.inject({ method: "POST", url: `/admin/orgs/${clientId}/suspend`, headers: adminAuthHeader(accessToken) });
  assert.equal(res.statusCode, 200);

  const [org] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  assert.ok(org!.suspendedAt, "suspendedAt is set");

  const audit = await db
    .select()
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, "org.suspend"), eq(adminAuditLogs.targetClientId, clientId)));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.adminUserId, adminId);
  assert.equal(audit[0]!.targetType, "org");

  // The suspend must actually take effect on the tenant server, not just flip a column.
  const login = await tenantApp.inject({ method: "POST", url: "/auth/login", payload: { email: "suspend-owner@test.local", password: "Abc12345" } });
  assert.equal(login.statusCode, 401);
  assert.equal(login.json<{ message: string }>().message, "organisation suspended");
});

void test("POST /admin/orgs/:id/reactivate clears suspendedAt and restores tenant login", async () => {
  const { tenantApp, clientId } = await signupOrg("Reactivate Co", "react-owner@test.local");
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "admin@test.local", "admin-password");

  await adminApp.inject({ method: "POST", url: `/admin/orgs/${clientId}/suspend`, headers: adminAuthHeader(accessToken) });
  const res = await adminApp.inject({ method: "POST", url: `/admin/orgs/${clientId}/reactivate`, headers: adminAuthHeader(accessToken) });
  assert.equal(res.statusCode, 200);

  const login = await tenantApp.inject({ method: "POST", url: "/auth/login", payload: { email: "react-owner@test.local", password: "Abc12345" } });
  assert.equal(login.statusCode, 200);
});

void test("DELETE /admin/orgs/:id is superadmin-only", async () => {
  const { clientId } = await signupOrg("Delete Co", "del-owner@test.local");
  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("staff@test.local", "staff-password", "staff");
  const { accessToken } = await loginAdmin(adminApp, "staff@test.local", "staff-password");

  const res = await adminApp.inject({ method: "DELETE", url: `/admin/orgs/${clientId}`, headers: adminAuthHeader(accessToken) });
  assert.equal(res.statusCode, 403);

  const [org] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  assert.equal(org!.deletedAt, null);
});
