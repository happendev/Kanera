import "../test/setup.integration.js";
import {
  activityEvents,
  boardInvitations,
  boards,
  clients,
  emailQueue,
  users,
  workspaces,
  type BillingEmailQueueData,
  type WeeklyAdminRecapEmailQueueData,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../db.js";
import "../test/integration.js";
import { runWeeklyAdminRecapSweep } from "./weekly-admin-recap.js";

const log = { info() {}, error() {}, warn() {} } as never;

void test("weekly admin recap aggregates the prior week, groups upcoming billing dates, and queues once", async () => {
  const [client] = await db.insert(clients).values({
    name: "Northstar",
    plan: "paid",
    billingStatus: "active",
    seatLimit: 6,
    analyticsSubscriptionStartedAt: new Date("2026-05-20T12:00:00Z"),
    currentPeriodEnd: new Date("2026-05-27T12:00:00Z"),
    createdAt: new Date("2026-05-19T12:00:00Z"),
  }).returning();
  const [user] = await db.insert(users).values({
    clientId: client!.id,
    activeClientId: client!.id,
    email: "owner@example.com",
    passwordHash: "x",
    displayName: "Owner",
    createdAt: new Date("2026-05-19T12:00:00Z"),
  }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Delivery" }).returning();
  const [board] = await db.insert(boards).values({
    workspaceId: workspace!.id,
    name: "Launch",
    position: "1000.0000000000",
    createdAt: new Date("2026-05-21T12:00:00Z"),
  }).returning();
  await db.insert(activityEvents).values({
    clientId: client!.id,
    actorId: user!.id,
    entityType: "workspaceMember",
    entityId: user!.id,
    action: "added",
    payload: { inviteId: "00000000-0000-0000-0000-000000000001" },
    createdAt: new Date("2026-05-22T12:00:00Z"),
  });
  await db.insert(boardInvitations).values({
    clientId: client!.id,
    boardId: board!.id,
    email: "guest@example.com",
    tokenHash: "weekly-recap-token",
    invitedById: user!.id,
    acceptedAt: new Date("2026-05-23T12:00:00Z"),
    acceptedByUserId: user!.id,
  });

  const billingBase: BillingEmailQueueData = {
    clientId: client!.id,
    displayName: "Owner",
    orgName: client!.name,
    settingsUrl: "https://app.example.com/settings/account-plan",
  };
  await db.insert(emailQueue).values([
    {
      toEmail: "owner@example.com",
      subject: "Pro active",
      type: "upgraded_to_pro",
      data: { ...billingBase, dedupeKey: "upgrade-1", purchasedSeatCount: 4 },
      createdAt: new Date("2026-05-20T12:00:00Z"),
    },
    {
      toEmail: "admin@example.com",
      subject: "Pro active",
      type: "upgraded_to_pro",
      data: { ...billingBase, dedupeKey: "upgrade-1", purchasedSeatCount: 4 },
      createdAt: new Date("2026-05-20T12:00:01Z"),
    },
    {
      toEmail: "owner@example.com",
      subject: "Seats purchased",
      type: "seat_billed",
      data: { ...billingBase, dedupeKey: "seats-4-6", previousPurchasedSeatCount: 4, purchasedSeatCount: 6 },
      createdAt: new Date("2026-05-22T12:00:00Z"),
    },
  ]);

  const deps = { db, adminEmail: "ops@example.com", adminUrl: "https://admin.example.com", log };
  assert.equal(await runWeeklyAdminRecapSweep(deps, new Date("2026-05-25T06:59:00Z")), 0);
  assert.equal(await runWeeklyAdminRecapSweep(deps, new Date("2026-05-25T07:00:00Z")), 1);
  assert.equal(await runWeeklyAdminRecapSweep(deps, new Date("2026-05-26T12:00:00Z")), 0);

  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "weekly_admin_recap"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, "ops@example.com");
  const data = rows[0]!.data as WeeklyAdminRecapEmailQueueData;
  assert.deepEqual(data.lastWeek, {
    newAccounts: 1,
    newOrganisations: 1,
    invitesAccepted: 2,
    boardsCreated: 1,
    subscriptionsStarted: 1,
    seatsPurchased: 6,
  });
  assert.deepEqual(data.upcoming.renewals, [{
    dateLabel: "27 May 2026",
    organisationCount: 1,
    seatCount: 6,
    organisations: ["Northstar"],
  }]);
});
