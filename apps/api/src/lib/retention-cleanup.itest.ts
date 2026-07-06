import "../test/setup.integration.js";
import {
  activityEvents,
  adminAuditLogs,
  adminInvites,
  adminRefreshTokens,
  adminUsers,
  automationRuns,
  automations,
  boardInvitations,
  boards,
  clients,
  emailVerificationCodes,
  inviteTokens,
  notifications,
  passwordResetTokens,
  refreshTokens,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../db.js";
import { cleanupAutomationRuns } from "./automations.js";
import {
  runActivityRetentionCleanup,
  runAdminAuditRetentionCleanup,
  runAuthTokenRetentionCleanup,
  runNotificationRetentionCleanup,
} from "./retention-cleanup.js";
import { encryptSecret } from "./secrets.js";
import { cleanupWebhookDeliveries } from "./webhooks.js";

// The retention functions only ever call log.info/log.warn; a noop stub keeps the tests quiet.
const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;

async function seedWorkspace() {
  const suffix = randomUUID();
  const [client] = await db.insert(clients).values({ name: `Retention ${suffix}` }).returning();
  const [user] = await db.insert(users).values({ clientId: client!.id, email: `${suffix}@example.com`, passwordHash: "x", displayName: "Owner" }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Retention" }).returning();
  assert.ok(user && workspace);
  return { user, workspace };
}

void test("webhook cleanup applies separate terminal delivery retention windows", async () => {
  const { user, workspace } = await seedWorkspace();
  const [endpoint] = await db.insert(webhookEndpoints).values({ workspaceId: workspace.id, createdById: user.id, name: "Events", url: "https://example.test/hook", encryptedSecret: encryptSecret("secret") }).returning();
  assert.ok(endpoint);
  const now = new Date("2026-07-01T00:00:00.000Z");
  await db.insert(webhookDeliveries).values([
    { endpointId: endpoint.id, workspaceId: workspace.id, eventType: "old-success", payload: { id: randomUUID(), type: "test", workspaceId: workspace.id, occurredAt: now.toISOString(), data: {} }, status: "success", updatedAt: new Date("2026-06-23T23:59:59.000Z") },
    { endpointId: endpoint.id, workspaceId: workspace.id, eventType: "kept-success", payload: { id: randomUUID(), type: "test", workspaceId: workspace.id, occurredAt: now.toISOString(), data: {} }, status: "success", updatedAt: new Date("2026-06-24T00:00:00.000Z") },
    { endpointId: endpoint.id, workspaceId: workspace.id, eventType: "old-failed", payload: { id: randomUUID(), type: "test", workspaceId: workspace.id, occurredAt: now.toISOString(), data: {} }, status: "failed", updatedAt: new Date("2026-06-16T23:59:59.000Z") },
    { endpointId: endpoint.id, workspaceId: workspace.id, eventType: "kept-failed", payload: { id: randomUUID(), type: "test", workspaceId: workspace.id, occurredAt: now.toISOString(), data: {} }, status: "failed", updatedAt: new Date("2026-06-17T00:00:00.000Z") },
    { endpointId: endpoint.id, workspaceId: workspace.id, eventType: "old-queued", payload: { id: randomUUID(), type: "test", workspaceId: workspace.id, occurredAt: now.toISOString(), data: {} }, status: "queued", updatedAt: new Date("2026-01-01T00:00:00.000Z") },
  ]);

  assert.equal(await cleanupWebhookDeliveries(undefined, now), 2);
  const remaining = await db.select({ eventType: webhookDeliveries.eventType }).from(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, workspace.id));
  assert.deepEqual(new Set(remaining.map((row) => row.eventType)), new Set(["kept-success", "kept-failed", "old-queued"]));
});

void test("automation run cleanup retains six calendar months of history", async () => {
  const { workspace } = await seedWorkspace();
  const [automation] = await db.insert(automations).values({ workspaceId: workspace.id, position: "1000.0000000000", triggerType: "card_marked_complete" }).returning();
  assert.ok(automation);
  const runs = await db.insert(automationRuns).values([
    { automationId: automation.id, outcome: "effectful", ranAt: new Date("2025-12-31T23:59:59.000Z") },
    { automationId: automation.id, outcome: "failed", ranAt: new Date("2026-01-01T00:00:00.000Z") },
  ]).returning();

  assert.equal(await cleanupAutomationRuns(undefined, new Date("2026-07-01T00:00:00.000Z")), 1);
  const remaining = await db.select().from(automationRuns).where(eq(automationRuns.automationId, automation.id));
  assert.deepEqual(remaining.map((run) => run.id), [runs[1]!.id]);
});

const NOW = new Date("2026-07-01T00:00:00.000Z");

void test("notification retention prunes read past 90d and anything past 365d", async () => {
  const { user, workspace } = await seedWorkspace();
  const base = { userId: user.id, workspaceId: workspace.id, reason: "assigned" as const };
  const inserted = await db.insert(notifications).values([
    // read before the 90d cutoff (2026-04-02) → deleted
    { ...base, readAt: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-02-01T00:00:00.000Z") },
    // read after the cutoff → kept
    { ...base, readAt: new Date("2026-06-20T00:00:00.000Z"), createdAt: new Date("2026-06-01T00:00:00.000Z") },
    // never read but older than the 365d max (2025-07-01) → deleted
    { ...base, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    // recent unread → kept
    { ...base, createdAt: new Date("2026-06-01T00:00:00.000Z") },
  ]).returning({ id: notifications.id });

  assert.equal(await runNotificationRetentionCleanup({ db, log: noopLog }, NOW), 2);
  const remaining = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, user.id));
  assert.deepEqual(
    new Set(remaining.map((r) => r.id)),
    new Set([inserted[1]!.id, inserted[3]!.id]),
  );
});

void test("activity retention prunes events older than the configured window", async () => {
  const { workspace } = await seedWorkspace();
  const base = { workspaceId: workspace.id, entityType: "card", entityId: randomUUID(), action: "created" };
  const inserted = await db.insert(activityEvents).values([
    // older than 730d cutoff (2024-07-02) → deleted
    { ...base, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    // recent → kept
    { ...base, createdAt: new Date("2026-06-01T00:00:00.000Z") },
  ]).returning({ id: activityEvents.id });

  assert.equal(await runActivityRetentionCleanup({ db, log: noopLog }, NOW), 1);
  const remaining = await db.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.workspaceId, workspace.id));
  assert.deepEqual(remaining.map((r) => r.id), [inserted[1]!.id]);
});

void test("admin audit retention prunes logs older than three years", async () => {
  const suffix = randomUUID();
  const [admin] = await db.insert(adminUsers).values({ email: `admin-${suffix}@example.com`, passwordHash: "x", displayName: "Admin" }).returning();
  assert.ok(admin);
  const base = { adminUserId: admin.id, action: "user.suspend", targetType: "user" };
  const inserted = await db.insert(adminAuditLogs).values([
    // older than 1095d cutoff (~2023-07-02) → deleted
    { ...base, createdAt: new Date("2023-01-01T00:00:00.000Z") },
    // recent → kept
    { ...base, createdAt: new Date("2026-06-01T00:00:00.000Z") },
  ]).returning({ id: adminAuditLogs.id });

  assert.equal(await runAdminAuditRetentionCleanup({ db, log: noopLog }, NOW), 1);
  const remaining = await db.select({ id: adminAuditLogs.id }).from(adminAuditLogs).where(eq(adminAuditLogs.adminUserId, admin.id));
  assert.deepEqual(remaining.map((r) => r.id), [inserted[1]!.id]);
});

void test("auth token retention purges terminal tokens/invites past the 30d grace", async () => {
  const { user, workspace } = await seedWorkspace();
  const clientId = workspace.clientId;
  const suffix = randomUUID();
  const [admin] = await db.insert(adminUsers).values({ email: `admin-${suffix}@example.com`, passwordHash: "x", displayName: "Admin" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  assert.ok(admin && board);

  // Cutoff is NOW - 30d = 2026-06-01. `expired`/`old-revoked` etc. are terminal before it → deleted;
  // `active`/`recent-revoked`/`open-invite` are still live or terminal after it → kept.
  const expired = new Date("2026-05-01T00:00:00.000Z");
  const future = new Date("2026-12-01T00:00:00.000Z");
  const oldTerminal = new Date("2026-04-01T00:00:00.000Z");
  const recentTerminal = new Date("2026-06-25T00:00:00.000Z");

  await db.insert(refreshTokens).values([
    { userId: user.id, tokenHash: `rt-expired-${suffix}`, expiresAt: expired }, // expired → deleted
    { userId: user.id, tokenHash: `rt-active-${suffix}`, expiresAt: future }, // active → kept
    { userId: user.id, tokenHash: `rt-oldrevoked-${suffix}`, expiresAt: future, revokedAt: oldTerminal }, // revoked long ago → deleted
    { userId: user.id, tokenHash: `rt-newrevoked-${suffix}`, expiresAt: future, revokedAt: recentTerminal }, // revoked recently → kept
  ]);

  await db.insert(adminRefreshTokens).values([
    { adminUserId: admin.id, tokenHash: `art-expired-${suffix}`, expiresAt: expired },
    { adminUserId: admin.id, tokenHash: `art-active-${suffix}`, expiresAt: future },
  ]);
  await db.insert(passwordResetTokens).values([
    { userId: user.id, tokenHash: `prt-used-${suffix}`, expiresAt: future, usedAt: oldTerminal }, // used long ago → deleted
    { userId: user.id, tokenHash: `prt-active-${suffix}`, expiresAt: future }, // active → kept
  ]);
  await db.insert(emailVerificationCodes).values([
    { email: `evc-old-${suffix}@example.com`, codeHash: "x", purpose: "signup", expiresAt: expired }, // expired → deleted
    { email: `evc-active-${suffix}@example.com`, codeHash: "x", purpose: "signup", expiresAt: future }, // active → kept
  ]);
  await db.insert(inviteTokens).values([
    { clientId, tokenHash: `it-revoked-${suffix}`, createdById: user.id, revokedAt: oldTerminal }, // revoked long ago → deleted
    { clientId, tokenHash: `it-open-${suffix}`, createdById: user.id }, // open invite, no expiry/revoke → kept
  ]);
  await db.insert(adminInvites).values([
    { email: `ai-accepted-${suffix}@example.com`, displayName: "X", tokenHash: `ai-acc-${suffix}`, invitedById: admin.id, expiresAt: future, acceptedAt: oldTerminal }, // accepted long ago → deleted
    { email: `ai-open-${suffix}@example.com`, displayName: "Y", tokenHash: `ai-open-${suffix}`, invitedById: admin.id, expiresAt: future }, // pending → kept
  ]);
  await db.insert(boardInvitations).values([
    { clientId, boardId: board.id, email: `bi-accepted-${suffix}@example.com`, tokenHash: `bi-acc-${suffix}`, invitedById: user.id, expiresAt: future, acceptedAt: oldTerminal }, // accepted long ago → deleted
    { clientId, boardId: board.id, email: `bi-open-${suffix}@example.com`, tokenHash: `bi-open-${suffix}`, invitedById: user.id, expiresAt: future }, // pending → kept
  ]);

  // 8 terminal-past-grace rows: refresh_token contributes 2 (expired + old-revoked), the other six
  // tables one each.
  assert.equal(await runAuthTokenRetentionCleanup({ db, log: noopLog }, NOW), 8);

  const rtLeft = await db.select({ h: refreshTokens.tokenHash }).from(refreshTokens).where(eq(refreshTokens.userId, user.id));
  assert.deepEqual(new Set(rtLeft.map((r) => r.h)), new Set([`rt-active-${suffix}`, `rt-newrevoked-${suffix}`]));
  const itLeft = await db.select({ h: inviteTokens.tokenHash }).from(inviteTokens).where(eq(inviteTokens.clientId, clientId));
  assert.deepEqual(itLeft.map((r) => r.h), [`it-open-${suffix}`]);
  const biLeft = await db.select({ h: boardInvitations.tokenHash }).from(boardInvitations).where(eq(boardInvitations.boardId, board.id));
  assert.deepEqual(biLeft.map((r) => r.h), [`bi-open-${suffix}`]);
});
