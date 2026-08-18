import "../test/setup.integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { adminAuditLogs, boardMembers, boards, clientGuestSeats, clientMembers, clients, refreshTokens, users, workspaces } from "@kanera/shared/schema";
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

void test("user admin views expose Free/Pro membership and paid guest relationships", async () => {
  const host = await signupOrg("User Access Host", "user-access-host@test.local");
  const guest = await signupOrg("User Access Home", "user-access-guest@test.local");
  const periodEnd = new Date("2027-01-15T00:00:00.000Z");
  await db.update(clients).set({ plan: "paid", billingStatus: "active", billingInterval: "annual", currentPeriodEnd: periodEnd, cancelAtPeriodEnd: true, seatLimit: 3 }).where(eq(clients.id, host.clientId));
  const [workspace] = await db.insert(workspaces).values({ clientId: host.clientId, name: "Host Workspace" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Host Board", position: "1000" }).returning();
  await db.insert(boardMembers).values({ boardId: board!.id, userId: guest.userId });
  await db.insert(clientGuestSeats).values({ clientId: host.clientId, userId: guest.userId, createdById: host.userId });

  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("user-access-admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "user-access-admin@test.local", "admin-password");
  const headers = adminAuthHeader(accessToken);

  const list = await adminApp.inject({ method: "GET", url: "/admin/users?q=user-access-guest%40test.local", headers });
  assert.equal(list.statusCode, 200, list.body);
  const [item] = list.json<{ items: Array<{ orgs: Array<{ name: string; plan: string; billingStatus: string }>; guestOrgs: Array<{ clientId: string; name: string; plan: string; paidGuestSeat: boolean; billingStatus: string; billingInterval: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }> }> }>().items;
  assert.deepEqual(item!.orgs.map(({ name, plan, billingStatus }) => ({ name, plan, billingStatus })), [
    { name: "User Access Home", plan: "free", billingStatus: "none" },
  ]);
  assert.deepEqual(item!.guestOrgs, [{ clientId: host.clientId, name: "User Access Host", plan: "paid", billingStatus: "active", billingInterval: "annual", currentPeriodEnd: periodEnd.toISOString(), cancelAtPeriodEnd: true, paidGuestSeat: true }]);

  const detail = await adminApp.inject({ method: "GET", url: `/admin/users/${guest.userId}`, headers });
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json<{ guestBoardAccess: Array<{ orgName: string; paidGuestSeat: boolean; billingStatus: string; billingInterval: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }> }>();
  assert.deepEqual(body.guestBoardAccess.map((access) => ({ orgName: access.orgName, paidGuestSeat: access.paidGuestSeat, billingStatus: access.billingStatus, billingInterval: access.billingInterval, currentPeriodEnd: access.currentPeriodEnd, cancelAtPeriodEnd: access.cancelAtPeriodEnd })), [
    { orgName: "User Access Host", paidGuestSeat: true, billingStatus: "active", billingInterval: "annual", currentPeriodEnd: periodEnd.toISOString(), cancelAtPeriodEnd: true },
  ]);
});

void test("POST /admin/users/:id/suspend sets membership suspendedAt, revokes refresh tokens, and audits", async () => {
  const { userId } = await signupOrg("User Suspend Co", "member-owner@test.local");

  const adminApp = await buildAdminIntegrationServer();
  const adminId = await createAdmin("admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "admin@test.local", "admin-password");

  // Signup created a live refresh token for the owner; suspend must revoke it in the same tx.
  const before = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  assert.ok(before.length >= 1);

  const res = await adminApp.inject({ method: "POST", url: `/admin/users/${userId}/suspend`, headers: adminAuthHeader(accessToken) });
  assert.equal(res.statusCode, 200);

  const [membership] = await db.select().from(clientMembers).where(eq(clientMembers.userId, userId)).limit(1);
  assert.ok(membership!.suspendedAt, "suspendedAt is set on the organisation membership");

  const live = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  assert.equal(live.length, 0, "refresh tokens are revoked so stale sessions cannot outlive suspension");

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

  const [membership] = await db.select().from(clientMembers).where(eq(clientMembers.userId, userId)).limit(1);
  assert.equal(membership!.clientRole, "owner", "role unchanged");
});

void test("PATCH /admin/users/:id/role synchronizes inherited standalone board users", async () => {
  const { clientId } = await signupOrg("Admin Role Sync Co", "role-sync-owner@test.local");
  const [member] = await insertTestUsers(db, {
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
