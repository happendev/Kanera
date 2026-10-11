import "../../test/setup.integration.js";
import type { CardFollowState, WireCardReminderListItem } from "@kanera/shared/dto";
import type { ServerEventName } from "@kanera/shared/events";
import {
  boardMembers,
  boards,
  cardReminders,
  cards,
  directRealtimeOutbox,
  emailQueue,
  lists,
  mcpEventDeliveries,
  mcpEventSubscriptions,
  notifications,
  workspaceApiKeys,
  workspaceMembers,
} from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../../db.js";
import { runCardReminderSweep } from "../../lib/card-follow.js";
import { encryptSecret } from "../../lib/secrets.js";
import { hashOpaqueToken } from "../../lib/tokens.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { setupIo } from "../../realtime/io.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

async function seed() {
  const app = await buildIntegrationServer();
  await setupIo(app);
  const { accessToken: ownerToken, user: owner } = await signupOwner(app, { orgName: "Acme", email: "owner@example.com", displayName: "Owner" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${ownerToken}` }, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();
  const [member] = await insertTestUsers(db, { clientId: owner.clientId, email: "member@example.com", passwordHash: "x", displayName: "Member" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member!.id, role: "member" });
  const memberToken = app.jwt.sign({ sub: member!.id, cid: owner.clientId, role: "member" });
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  // Observer access is enough to follow a card: reminding yourself changes nothing on it.
  await db.insert(boardMembers).values({ boardId: board!.id, userId: member!.id, role: "observer" });
  const [card] = await db.insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Ship the release", position: "1000.0000000000", createdById: owner.id })
    .returning();
  return { app, owner, ownerToken, member: member!, memberToken, workspace, list: list!, board: board!, card: card! };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function setReminder(f: Fixture, cardId: string, remindAt: Date) {
  return f.app.inject({
    method: "PUT",
    url: `/cards/${cardId}/reminder`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { remindAt: remindAt.toISOString() },
  });
}

async function outboxRows(userId: string, eventType: ServerEventName) {
  // emitToUser writes the direct outbox row asynchronously after the response.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await db.select().from(directRealtimeOutbox)
      .where(and(eq(directRealtimeOutbox.userId, userId), eq(directRealtimeOutbox.eventType, eventType)));
    if (rows.length > 0) return rows;
    await sleep(25);
  }
  return [];
}

function signingSecret() {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

void test("a due reminder notifies its owner once, through every channel, and re-arms when rescheduled", async () => {
  const f = await seed();
  const personalKey = "kanera_u_follow_reminder_test";
  const [key] = await db.insert(workspaceApiKeys).values({
    kind: "personal", clientId: f.owner.clientId, createdById: f.member.id, keyPrefix: "kanera_u_follow", keyHash: hashOpaqueToken(personalKey),
  }).returning();
  await db.insert(mcpEventSubscriptions).values({
    id: "sub_reminder", targetUserId: f.member.id, userId: f.member.id, ownerApiKeyId: key!.id,
    name: "reminder.due", arguments: {}, url: "https://agent.example/events", encryptedSecret: encryptSecret(signingSecret()),
    verifiedAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000),
  });

  const remindAt = new Date(Date.now() + 60_000);
  const set = await setReminder(f, f.card.id, remindAt);
  assert.equal(set.statusCode, 200, set.body);
  const state = set.json<CardFollowState>();
  assert.equal(state.reminder?.remindAt, remindAt.toISOString());
  assert.equal(state.reminder?.firedAt, null);

  // Not yet due: nothing fires.
  assert.equal(await runCardReminderSweep(new Date()), 0);

  const due = new Date(remindAt.getTime() + 1_000);
  assert.equal(await runCardReminderSweep(due), 1);
  // A second sweep (or a second worker) finds nothing left to claim.
  assert.equal(await runCardReminderSweep(due), 0);

  const rows = await db.select().from(notifications).where(and(eq(notifications.userId, f.member.id), eq(notifications.reason, "reminder")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cardId, f.card.id);
  const emails = await db.select().from(emailQueue).where(and(eq(emailQueue.toEmail, "member@example.com"), eq(emailQueue.type, "card_reminder")));
  assert.equal(emails.length, 1);
  const deliveries = await db.select().from(mcpEventDeliveries).where(eq(mcpEventDeliveries.subscriptionId, "sub_reminder"));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.payload.name, "reminder.due");
  assert.equal((deliveries[0]!.payload.data as { cardId: string }).cardId, f.card.id);
  const [fired] = await db.select().from(cardReminders).where(eq(cardReminders.cardId, f.card.id));
  assert.ok(fired!.firedAt, "the reminder is stamped as fired");

  // Rescheduling the same card re-arms the one reminder rather than adding a second.
  const later = new Date(Date.now() + 120_000);
  const rearmed = await setReminder(f, f.card.id, later);
  assert.equal(rearmed.statusCode, 200);
  assert.equal(rearmed.json<CardFollowState>().reminder?.firedAt, null);
  assert.equal((await db.select().from(cardReminders).where(eq(cardReminders.cardId, f.card.id))).length, 1);
  assert.equal(await runCardReminderSweep(new Date(later.getTime() + 1_000)), 1);
  assert.equal((await db.select().from(mcpEventDeliveries).where(eq(mcpEventDeliveries.subscriptionId, "sub_reminder"))).length, 2);
});

void test("a reminder fires silently once its card is archived or no longer visible to its owner", async () => {
  const f = await seed();
  const [other] = await db.insert(cards)
    .values({ listId: f.list.id, boardId: f.board.id, title: "Second", position: "2000.0000000000", createdById: f.owner.id })
    .returning();
  const remindAt = new Date(Date.now() + 60_000);
  assert.equal((await setReminder(f, f.card.id, remindAt)).statusCode, 200);
  assert.equal((await setReminder(f, other!.id, remindAt)).statusCode, 200);

  await db.update(cards).set({ archivedAt: new Date() }).where(eq(cards.id, f.card.id));
  await db.delete(boardMembers).where(and(eq(boardMembers.boardId, f.board.id), eq(boardMembers.userId, f.member.id)));

  const listed = await f.app.inject({ method: "GET", url: "/reminders", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json<WireCardReminderListItem[]>(), [], "reminders on unreadable cards are not listed");

  assert.equal(await runCardReminderSweep(new Date(remindAt.getTime() + 1_000)), 2);
  const rows = await db.select().from(notifications).where(eq(notifications.userId, f.member.id));
  assert.equal(rows.length, 0, "no notification describes a card the user can no longer see");
  const emails = await db.select().from(emailQueue).where(eq(emailQueue.type, "card_reminder"));
  assert.equal(emails.length, 0);
});

void test("follow routes validate the time and keep workspace-scoped and read-only credentials out", async () => {
  const f = await seed();
  const past = await setReminder(f, f.card.id, new Date(Date.now() - 60_000));
  assert.equal(past.statusCode, 400);
  const tooFar = await setReminder(f, f.card.id, new Date(Date.now() + 9 * 7 * 24 * 60 * 60 * 1000));
  assert.equal(tooFar.statusCode, 400, "reminders are capped at eight weeks ahead");
  const lastWeek = await setReminder(f, f.card.id, new Date(Date.now() + 7 * 7 * 24 * 60 * 60 * 1000));
  assert.equal(lastWeek.statusCode, 200, lastWeek.body);

  const personalKey = "kanera_u_follow_personal";
  const readKey = "kanera_u_follow_read";
  const workspaceKey = "kanera_w_follow_workspace";
  await db.insert(workspaceApiKeys).values([
    { kind: "personal", clientId: f.owner.clientId, createdById: f.member.id, keyPrefix: "kanera_u_fp", keyHash: hashOpaqueToken(personalKey), scope: "write" },
    { kind: "personal", clientId: f.owner.clientId, createdById: f.member.id, keyPrefix: "kanera_u_fr", keyHash: hashOpaqueToken(readKey), scope: "read" },
    { kind: "workspace", workspaceId: f.workspace.id, createdById: f.owner.id, name: "Integration", keyPrefix: "kanera_w_fw", keyHash: hashOpaqueToken(workspaceKey), scope: "write" },
  ]);
  const publicApi = await buildPublicApiServer({ enableWebhookDeliveryScheduler: false });
  try {
    const watched = await publicApi.inject({ method: "PUT", url: `/api/v1/cards/${f.card.id}/watch`, headers: { authorization: `Bearer ${personalKey}` } });
    assert.equal(watched.statusCode, 200, watched.body);
    assert.equal(watched.json<CardFollowState>().watching, true);
    const watchEvents = await outboxRows(f.member.id, "watch:changed");
    assert.ok(watchEvents.some((row) => (row.payload as { id: string; watching: boolean }).id === f.card.id), "the web session learns about a public-API watch");

    const readOnly = await publicApi.inject({
      method: "PUT", url: `/api/v1/cards/${f.card.id}/reminder`, headers: { authorization: `Bearer ${readKey}` },
      payload: { remindAt: new Date(Date.now() + 60_000).toISOString() },
    });
    assert.equal(readOnly.statusCode, 403);
    const readState = await publicApi.inject({ method: "GET", url: `/api/v1/cards/${f.card.id}/follow`, headers: { authorization: `Bearer ${readKey}` } });
    assert.equal(readState.statusCode, 200);

    const workspaceScoped = await publicApi.inject({ method: "GET", url: "/api/v1/reminders", headers: { authorization: `Bearer ${workspaceKey}` } });
    assert.equal(workspaceScoped.statusCode, 403);
  } finally {
    await publicApi.close();
  }
});

void test("completing a card clears everyone's reminders on it, and reopening it does not bring them back", async () => {
  const f = await seed();
  const remindAt = new Date(Date.now() + 60_000);
  assert.equal((await setReminder(f, f.card.id, remindAt)).statusCode, 200);
  const ownerSet = await f.app.inject({
    method: "PUT", url: `/cards/${f.card.id}/reminder`, headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { remindAt: remindAt.toISOString() },
  });
  assert.equal(ownerSet.statusCode, 200);

  const complete = (completed: boolean) => f.app.inject({
    method: "PATCH", url: `/cards/${f.card.id}/completion`, headers: { authorization: `Bearer ${f.ownerToken}` }, payload: { completed },
  });
  assert.equal((await complete(true)).statusCode, 200);
  assert.deepEqual(await db.select().from(cardReminders).where(eq(cardReminders.cardId, f.card.id)), []);
  const state = await f.app.inject({ method: "GET", url: `/cards/${f.card.id}/follow`, headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(state.json<CardFollowState>().reminder, null);

  assert.equal((await complete(false)).statusCode, 200);
  assert.equal(await runCardReminderSweep(new Date(remindAt.getTime() + 1_000)), 0, "nothing is left to fire");
});
