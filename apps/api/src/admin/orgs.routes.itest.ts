import "../test/setup.integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { adminAuditLogs, boardMembers, boards, clientGuestSeats, clientMembers, clients, planActions, workspaces } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildAdminIntegrationServer, buildIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";
import { signupOwner } from "../test/api-fixtures.js";

async function signupOrg(orgName: string, email: string) {
  const app = await buildIntegrationServer();
  const { user } = await signupOwner(app, { orgName, email, displayName: "Owner" });
  return { tenantApp: app, clientId: user.clientId, userId: user.id };
}

void test("organisation admin views distinguish purchased seats, members, and paid/free guests", async () => {
  const host = await signupOrg("Seat Visibility Co", "seat-visibility-owner@test.local");
  const external = await signupOrg("External People Co", "paid-guest@test.local");
  const [freeGuest] = await insertTestUsers(db, {
    clientId: external.clientId,
    email: "free-guest@test.local",
    passwordHash: "x",
    displayName: "Free Guest",
  }).returning();
  const periodEnd = new Date("2027-01-15T00:00:00.000Z");
  await db.update(clients).set({
    plan: "paid",
    billingStatus: "active",
    billingInterval: "annual",
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: true,
    seatLimit: 4,
  }).where(eq(clients.id, host.clientId));
  const [workspace] = await db.insert(workspaces).values({ clientId: host.clientId, name: "Guest Work" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Guest Board", position: "1000" }).returning();
  await db.insert(boardMembers).values([
    { boardId: board!.id, userId: external.userId },
    { boardId: board!.id, userId: freeGuest!.id },
  ]);
  await db.insert(clientGuestSeats).values({ clientId: host.clientId, userId: external.userId, createdById: host.userId });

  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("seat-visibility-admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "seat-visibility-admin@test.local", "admin-password");
  const headers = adminAuthHeader(accessToken);

  const list = await adminApp.inject({ method: "GET", url: "/admin/orgs?q=Seat%20Visibility%20Co", headers });
  assert.equal(list.statusCode, 200, list.body);
  const [item] = list.json<{ items: Array<{ id: string; billingInterval: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; seatLimit: number; memberCount: number; paidGuestCount: number; freeGuestCount: number; usedSeatCount: number }> }>().items;
  assert.deepEqual(
    { id: item!.id, billingInterval: item!.billingInterval, currentPeriodEnd: item!.currentPeriodEnd, cancelAtPeriodEnd: item!.cancelAtPeriodEnd, seatLimit: item!.seatLimit, memberCount: item!.memberCount, paidGuestCount: item!.paidGuestCount, freeGuestCount: item!.freeGuestCount, usedSeatCount: item!.usedSeatCount },
    { id: host.clientId, billingInterval: "annual", currentPeriodEnd: periodEnd.toISOString(), cancelAtPeriodEnd: true, seatLimit: 4, memberCount: 1, paidGuestCount: 1, freeGuestCount: 1, usedSeatCount: 2 },
  );

  const detail = await adminApp.inject({ method: "GET", url: `/admin/orgs/${host.clientId}`, headers });
  assert.equal(detail.statusCode, 200, detail.body);
  const detailBody = detail.json<{ billingInterval: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; usage: unknown }>();
  assert.deepEqual(
    { billingInterval: detailBody.billingInterval, currentPeriodEnd: detailBody.currentPeriodEnd, cancelAtPeriodEnd: detailBody.cancelAtPeriodEnd },
    { billingInterval: "annual", currentPeriodEnd: periodEnd.toISOString(), cancelAtPeriodEnd: true },
  );
  assert.deepEqual(detailBody.usage, {
    storageUsedBytes: 0,
    storageQuotaBytes: null,
    workspaceCount: 1,
    boardCount: 1,
    cardCount: 0,
    memberCount: 1,
    guestCount: 2,
    paidGuestCount: 1,
    freeGuestCount: 1,
    usedSeatCount: 2,
  });

  const people = await adminApp.inject({ method: "GET", url: `/admin/orgs/${host.clientId}/people`, headers });
  assert.equal(people.statusCode, 200, people.body);
  const accessByEmail = Object.fromEntries(people.json<{ items: Array<{ email: string; access: string }> }>().items.map((person) => [person.email, person.access]));
  assert.equal(accessByEmail["seat-visibility-owner@test.local"], "pro_member");
  assert.equal(accessByEmail["paid-guest@test.local"], "paid_guest");
  assert.equal(accessByEmail["free-guest@test.local"], "free_guest");
});

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
  assert.equal(login.json<{ message: string }>().message, "no active organisation membership");
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

void test("PATCH /admin/orgs/:id/plan restores resources recorded by a hosted downgrade", async () => {
  const { clientId } = await signupOrg("Manual Upgrade Co", "manual-upgrade-owner@test.local");
  const [workspace] = await db.insert(workspaces).values({ clientId, name: "Delivery" }).returning();
  const [disabledBoard] = await db.insert(boards).values({
    workspaceId: workspace!.id,
    name: "Safely retained",
    position: "1000.0000000000",
    archivedAt: new Date(),
  }).returning();
  const [suspendedUser] = await insertTestUsers(db, {
    clientId,
    email: "manual-upgrade-member@test.local",
    passwordHash: "x",
    displayName: "Member",
    clientRole: "member",
    suspendedAt: new Date(),
  }).returning();
  await db.insert(planActions).values([
    { clientId, kind: "board_archived", payload: { boardId: disabledBoard!.id } },
    { clientId, kind: "user_suspended", payload: { userId: suspendedUser!.id } },
  ]);

  const adminApp = await buildAdminIntegrationServer();
  await createAdmin("manual-upgrade-admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(adminApp, "manual-upgrade-admin@test.local", "admin-password");
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const response = await adminApp.inject({
      method: "PATCH",
      url: `/admin/orgs/${clientId}/plan`,
      headers: adminAuthHeader(accessToken),
      // The portal's manual plan control is sufficient on its own; the route coherently infers the
      // ordinary active override instead of leaving a paid/none row with free entitlements.
      payload: { plan: "paid" },
    });
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }

  const [org] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  const [board] = await db.select().from(boards).where(eq(boards.id, disabledBoard!.id)).limit(1);
  const [member] = await db.select().from(clientMembers).where(and(eq(clientMembers.clientId, clientId), eq(clientMembers.userId, suspendedUser!.id))).limit(1);
  assert.equal(org!.plan, "paid");
  assert.equal(org!.billingStatus, "active");
  assert.equal(board!.archivedAt, null);
  assert.equal(member!.suspendedAt, null);
  assert.equal(await db.$count(planActions, eq(planActions.clientId, clientId)), 0);
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
