import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  boards,
  cards,
  clientMembers,
  clients,
  lists,
  notificationSettings,
  notifications,
  pushQueue,
  pushSubscriptions,
  workspaces,
} from "@kanera/shared/schema";
import { db } from "../db.js";
import { enqueueCardAssignedEmails } from "./assignee-email-notifications.js";
import { recordActivity } from "./activity.js";
import type { Mailer } from "./mailer.js";
import { countUnreadNotifications, notifyUserForActivity } from "./notifications.js";
import { deliverPushRow } from "./push-queue.js";
import { ensureSystemWebPushConfig, webPushClient } from "./web-push.js";
import { buildIntegrationServer } from "../test/integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";

void test("two-org notifications retain event org labels, aggregate globally, and deliver push to the user's device", async () => {
  const app = await buildIntegrationServer();
  const [orgA, orgB] = await db.insert(clients).values([
    { name: "Notification Org A" },
    { name: "Notification Org B", pushEnabled: true },
  ]).returning();
  const [recipient] = await insertTestUsers(db, {
    clientId: orgA!.id,
    clientRole: "member",
    email: "notification-recipient@example.com",
    passwordHash: "hash",
    displayName: "Recipient",
  }).returning();
  await db.insert(clientMembers).values({ clientId: orgB!.id, userId: recipient!.id, clientRole: "member" });
  const [actorA] = await insertTestUsers(db, {
    clientId: orgA!.id,
    clientRole: "owner",
    email: "notification-actor-a@example.com",
    passwordHash: "hash",
    displayName: "Actor A",
  }).returning();
  const [actorB] = await insertTestUsers(db, {
    clientId: orgB!.id,
    clientRole: "owner",
    email: "notification-actor-b@example.com",
    passwordHash: "hash",
    displayName: "Actor B",
  }).returning();
  const [workspaceA, workspaceB] = await db.insert(workspaces).values([
    { clientId: orgA!.id, name: "Notification workspace A" },
    { clientId: orgB!.id, name: "Notification workspace B" },
  ]).returning();
  const [boardA, boardB] = await db.insert(boards).values([
    { workspaceId: workspaceA!.id, name: "Notification board A", position: "1000.0000000000" },
    { workspaceId: workspaceB!.id, name: "Notification board B", position: "1000.0000000000" },
  ]).returning();
  const [listA, listB] = await db.insert(lists).values([
    { workspaceId: workspaceA!.id, name: "Todo A", position: "1000.0000000000" },
    { workspaceId: workspaceB!.id, name: "Todo B", position: "1000.0000000000" },
  ]).returning();
  const [cardA, cardB] = await db.insert(cards).values([
    { boardId: boardA!.id, listId: listA!.id, title: "Card A", position: "1000.0000000000", createdById: actorA!.id },
    { boardId: boardB!.id, listId: listB!.id, title: "Card B", position: "1000.0000000000", createdById: actorB!.id },
  ]).returning();
  const activityA = await recordActivity(db, {
    boardId: boardA!.id, workspaceId: workspaceA!.id, clientId: orgA!.id, actorId: actorA!.id,
    entityType: "card", entityId: cardA!.id, action: "updated", payload: { cardId: cardA!.id },
  });
  const activityB = await recordActivity(db, {
    boardId: boardB!.id, workspaceId: workspaceB!.id, clientId: orgB!.id, actorId: actorB!.id,
    entityType: "card", entityId: cardB!.id, action: "updated", payload: { cardId: cardB!.id },
  });
  await notifyUserForActivity({ userId: recipient!.id, activity: activityA, reason: "assigned" });
  await notifyUserForActivity({ userId: recipient!.id, activity: activityB, reason: "assigned" });

  const stored = await db.select({ clientId: notifications.clientId }).from(notifications).where(eq(notifications.userId, recipient!.id));
  assert.deepEqual(stored.map((row) => row.clientId).sort(), [orgA!.id, orgB!.id].sort());
  assert.equal(await countUnreadNotifications(recipient!.id), 2);
  const authToken = app.jwt.sign({ sub: recipient!.id, cid: orgA!.id, role: "member" });
  const listed = await app.inject({ method: "GET", url: "/notifications?includeRead=true", headers: { authorization: `Bearer ${authToken}` } });
  assert.equal(listed.statusCode, 200, listed.body);
  const listedItems = listed.json<{ items: Array<{ clientId: string; orgName: string }> }>().items;
  assert.deepEqual(new Map(listedItems.map((item) => [item.clientId, item.orgName])), new Map([
    [orgA!.id, "Notification Org A"],
    [orgB!.id, "Notification Org B"],
  ]));
  const orgCounts = await app.inject({ method: "GET", url: "/notifications/org-unread-counts", headers: { authorization: `Bearer ${authToken}` } });
  assert.equal(orgCounts.statusCode, 200, orgCounts.body);
  assert.deepEqual(orgCounts.json<Array<{ clientId: string; count: number }>>().sort((a, b) => a.clientId.localeCompare(b.clientId)), [
    { clientId: orgA!.id, count: 1 },
    { clientId: orgB!.id, count: 1 },
  ].sort((a, b) => a.clientId.localeCompare(b.clientId)));

  await db.insert(notificationSettings).values({ userId: recipient!.id, emailEnabled: false, pushEnabled: true });
  await ensureSystemWebPushConfig();
  await enqueueCardAssignedEmails({
    tx: db,
    mailer: {} as Mailer,
    webOrigin: "https://kanera.example.test",
    cardId: cardB!.id,
    actorId: actorB!.id,
    recipientUserIds: [recipient!.id],
  });
  const [queued] = await db.select().from(pushQueue).where(and(eq(pushQueue.userId, recipient!.id), eq(pushQueue.clientId, orgB!.id))).limit(1);
  assert.ok(queued, "push must be queued under the event organisation");
  await db.insert(pushSubscriptions).values({
    clientId: orgA!.id,
    userId: recipient!.id,
    endpoint: "https://push.example.test/cross-org-device",
    keyP256dh: "cross-org-p256dh",
    keyAuth: "cross-org-auth",
    contentEncoding: "aes128gcm",
  });
  const send = mock.method(webPushClient, "sendNotification", async () => undefined as never);
  try {
    assert.deepEqual(await deliverPushRow(db, queued!), { delivered: 1, disabled: 0, failed: 0 });
    assert.equal(send.mock.callCount(), 1);
  } finally {
    send.mock.restore();
  }
});
