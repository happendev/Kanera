import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { adminAuditLogs, boardMembers, boards, refreshTokens, users, workspaces } from "@kanera/shared/schema";
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

void test("POST /admin/users/:id/suspend sets suspendedAt, revokes refresh tokens, and audits", async () => {
  const { userId } = await signupOrg("User Suspend Co", "member-owner@test.local");

  const adminApp = await buildAdminIntegrationServer();
  const adminId = await createAdmin("admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "admin@test.local", "admin-password");

  // Signup created a live refresh token for the owner; suspend must revoke it in the same tx.
  const before = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  assert.ok(before.length >= 1);

  const res = await adminApp.inject({ method: "POST", url: `/admin/users/${userId}/suspend`, headers: adminAuthHeader(accessToken) });
  assert.equal(res.statusCode, 200);

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  assert.ok(user!.suspendedAt, "suspendedAt is set");

  const live = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  assert.equal(live.length, 0, "all refresh tokens revoked");

  const audit = await db
    .select()
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, "user.suspend"), eq(adminAuditLogs.targetUserId, userId)));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.adminUserId, adminId);
});

void test("PATCH /admin/users/:id/role blocks demoting the last owner", async () => {
  const { userId } = await signupOrg("Last Owner Co", "last-owner@test.local");

  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "admin@test.local", "admin-password");

  const res = await adminApp.inject({
    method: "PATCH",
    url: `/admin/users/${userId}/role`,
    headers: adminAuthHeader(accessToken),
    payload: { role: "member" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json<{ message: string }>().message, "cannot demote the last owner");

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  assert.equal(user!.clientRole, "owner", "role unchanged");
});

void test("PATCH /admin/users/:id/role synchronizes inherited standalone board users", async () => {
  const { clientId } = await signupOrg("Admin Role Sync Co", "role-sync-owner@test.local");
  const [member] = await db.insert(users).values({
    clientId,
    clientRole: "member",
    email: "role-sync-member@test.local",
    passwordHash: "hash",
    displayName: "Role Sync Member",
  }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId, name: "Standalone", kind: "board" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Standalone", position: "1000" }).returning();

  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("role-sync-admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "role-sync-admin@test.local", "admin-password");
  const headers = adminAuthHeader(accessToken);

  const promoted = await adminApp.inject({
    method: "PATCH",
    url: `/admin/users/${member!.id}/role`,
    headers,
    payload: { role: "admin" },
  });
  assert.equal(promoted.statusCode, 200);
  const [inherited] = await db.select({ role: boardMembers.role, pinned: boardMembers.pinned })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, board!.id), eq(boardMembers.userId, member!.id)));
  assert.deepEqual(inherited, { role: "editor", pinned: true });

  const demoted = await adminApp.inject({
    method: "PATCH",
    url: `/admin/users/${member!.id}/role`,
    headers,
    payload: { role: "member" },
  });
  assert.equal(demoted.statusCode, 200);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, board!.id), eq(boardMembers.userId, member!.id))), 0);
});

void test("POST /admin/users/:id/force-reverify clears emailVerifiedAt", async () => {
  const { userId } = await signupOrg("Reverify Co", "reverify-owner@test.local");

  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "admin@test.local", "admin-password");

  const res = await adminApp.inject({ method: "POST", url: `/admin/users/${userId}/force-reverify`, headers: adminAuthHeader(accessToken) });
  assert.equal(res.statusCode, 200);

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  assert.equal(user!.emailVerifiedAt, null);
});
