import "../test/setup.integration.js";
import {
  boardWatchers,
  boards,
  cardAssignees,
  cardWatchers,
  cards,
  clients,
  emailQueue,
  lists,
  notificationSettings,
  pushQueue,
  users,
  workspaceMembers,
  workspaceApiKeys,
  type EmailQueueType,
} from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../db.js";
import { buildPublicApiServer } from "../public-api-server.js";
import { createOverdueNotificationsForCards } from "./overdue-notifications.js";
import { hashOpaqueToken } from "./tokens.js";
import { buildIntegrationServer } from "../test/integration.js";

interface SignupResponse {
  accessToken: string;
  user: { id: string; clientId: string };
}

interface WorkspaceResponse {
  id: string;
}

async function seed() {
  const app = await buildIntegrationServer();
  const suffix = randomUUID();
  const ownerEmail = `owner-${suffix}@example.com`;
  const memberEmail = `member-${suffix}@example.com`;
  const otherEmail = `other-${suffix}@example.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      displayName: "Owner",
      email: ownerEmail,
      password: "Abc12345",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = signup.json<SignupResponse>();
  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Inbox", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Prepare launch", position: "1000.0000000000", createdById: owner.id })
    .returning();
  const [member] = await db
    .insert(users)
    .values({ clientId: owner.clientId, email: memberEmail, passwordHash: "x", displayName: "Member" })
    .returning();
  const [other] = await db
    .insert(users)
    .values({ clientId: owner.clientId, email: otherEmail, passwordHash: "x", displayName: "Other" })
    .returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: member!.id, role: "editor" },
    { workspaceId: workspace.id, userId: other!.id, role: "editor" },
  ]);
  const memberToken = app.jwt.sign({ sub: member!.id, cid: owner.clientId, role: "member" });
  return { app, owner, ownerToken, member: member!, memberToken, other: other!, workspace, board: board!, list: list!, card: card!, ownerEmail, memberEmail, otherEmail };
}

async function queuedTypes(...types: EmailQueueType[]) {
  return db.select().from(emailQueue).where(inArray(emailQueue.type, types));
}

async function createApiKey(f: Awaited<ReturnType<typeof seed>>, name = "Zapier sync") {
  const rawKey = `kanera_live_${randomUUID().replaceAll("-", "")}`;
  await db.insert(workspaceApiKeys).values({
    workspaceId: f.workspace.id,
    createdById: f.owner.id,
    name,
    keyPrefix: rawKey.slice(0, 18),
    keyHash: hashOpaqueToken(rawKey),
    scope: "write",
  });
  return rawKey;
}

void test("assigning a new assignee enqueues one assignment email and repeat saves do not duplicate it", async () => {
  const f = await seed();

  const assigned = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.card.id}/assignees`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { userIds: [f.member.id] },
  });
  assert.equal(assigned.statusCode, 200);

  const repeated = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.card.id}/assignees`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { userIds: [f.member.id] },
  });
  assert.equal(repeated.statusCode, 200);

  const rows = await queuedTypes("card_assigned");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, f.memberEmail);
  assert.equal((rows[0]!.data as { cardTitle: string }).cardTitle, "Prepare launch");
});

void test("assignment emails suppress the actor", async () => {
  const f = await seed();

  const assigned = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.card.id}/assignees`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { userIds: [f.owner.id, f.member.id] },
  });
  assert.equal(assigned.statusCode, 200);

  const rows = await queuedTypes("card_assigned");
  assert.deepEqual(rows.map((row) => row.toEmail), [f.memberEmail]);
});

void test("comment creation emails assignees but not card or board watchers", async () => {
  const f = await seed();
  await db.insert(cardAssignees).values({ cardId: f.card.id, userId: f.member.id });
  await db.insert(cardWatchers).values({ cardId: f.card.id, userId: f.other.id });
  await db.insert(boardWatchers).values({ boardId: f.board.id, userId: f.owner.id });

  const commented = await f.app.inject({
    method: "POST",
    url: `/cards/${f.card.id}/comments`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { body: "Please review **today**." },
  });
  assert.equal(commented.statusCode, 201);
  await sleep(50);

  const rows = await queuedTypes("card_comment_added");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, f.memberEmail);
  assert.equal((rows[0]!.data as { commentExcerpt: string }).commentExcerpt, "Please review today.");
});

void test("comment creation emails and pushes mentioned users", async () => {
  const f = await seed();
  await db.update(clients).set({ pushEnabled: true }).where(eq(clients.id, f.owner.clientId));
  await db.insert(notificationSettings).values({ userId: f.member.id, pushEnabled: true });

  const commented = await f.app.inject({
    method: "POST",
    url: `/cards/${f.card.id}/comments`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { body: `@[Member](kanera-user:${f.member.id}) please review **today**.` },
  });
  assert.equal(commented.statusCode, 201);
  await sleep(50);

  const emails = await queuedTypes("comment_mentioned");
  assert.equal(emails.length, 1);
  assert.equal(emails[0]!.toEmail, f.memberEmail);
  assert.equal(emails[0]!.subject, "Mentioned in a comment on Prepare launch");
  assert.equal((emails[0]!.data as { commentExcerpt: string }).commentExcerpt, "@Member please review today.");

  const pushes = await db.select().from(pushQueue).where(and(eq(pushQueue.userId, f.member.id), eq(pushQueue.reason, "mentioned")));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.payload.kind, "comment_mentioned");
  assert.equal(pushes[0]!.payload.title, "Mentioned in a comment");
  assert.equal(pushes[0]!.payload.body, "Owner mentioned you in Inbox / Prepare launch: @Member please review today.");
});

void test("due date set, change, and clear emails assignees with old and new labels", async () => {
  const f = await seed();
  await db.update(clients).set({ pushEnabled: true }).where(eq(clients.id, f.owner.clientId));
  await db.insert(notificationSettings).values({ userId: f.member.id, pushEnabled: true });
  await db.insert(cardAssignees).values({ cardId: f.card.id, userId: f.member.id });

  const set = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.card.id}`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { dueDateLocalDate: "2026-05-26", dueDateSlot: "morning" },
  });
  assert.equal(set.statusCode, 200);
  const changed = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.card.id}`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { dueDateLocalDate: "2026-05-27", dueDateSlot: "endOfWorkDay" },
  });
  assert.equal(changed.statusCode, 200);
  const cleared = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.card.id}`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { dueDateLocalDate: null, dueDateSlot: null },
  });
  assert.equal(cleared.statusCode, 200);

  const rows = await db
    .select()
    .from(emailQueue)
    .where(eq(emailQueue.type, "card_due_date_changed"))
    .orderBy(emailQueue.createdAt);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => {
      const data = row.data as { previousDueLabel: string | null; nextDueLabel: string | null };
      return [data.previousDueLabel, data.nextDueLabel];
    }),
    [
      [null, "May 26, 2026, morning"],
      ["May 26, 2026, morning", "May 27, 2026, end of workday"],
      ["May 27, 2026, end of workday", null],
    ],
  );

  const pushes = await db
    .select()
    .from(pushQueue)
    .where(eq(pushQueue.userId, f.member.id))
    .orderBy(pushQueue.createdAt);
  assert.equal(pushes.length, 3);
  assert.deepEqual(pushes.map((row) => row.reason), ["dueDateChanged", "dueDateChanged", "dueDateChanged"]);
  assert.ok(pushes.every((row) => row.payload.kind === "card_due_date_changed"));
});

void test("overdue emails are queued once for assignees only", async () => {
  const f = await seed();
  await db
    .update(cards)
    .set({ dueDateLocalDate: "2026-05-20", dueDateSlot: "anyTime" })
    .where(eq(cards.id, f.card.id));
  await db.insert(cardAssignees).values({ cardId: f.card.id, userId: f.member.id });
  await db.insert(cardWatchers).values({ cardId: f.card.id, userId: f.other.id });
  await db.insert(boardWatchers).values({ boardId: f.board.id, userId: f.owner.id });

  assert.equal(await createOverdueNotificationsForCards(db, [f.card.id], new Date("2026-05-21T12:00:00Z")), 3);
  assert.equal(await createOverdueNotificationsForCards(db, [f.card.id], new Date("2026-05-21T13:00:00Z")), 0);

  const rows = await db.select().from(emailQueue).where(and(eq(emailQueue.type, "card_overdue"), eq(emailQueue.toEmail, f.memberEmail)));
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.data as { dueLabel: string }).dueLabel, "May 20, 2026");
  const watcherRows = await db.select().from(emailQueue).where(and(eq(emailQueue.type, "card_overdue"), eq(emailQueue.toEmail, f.otherEmail)));
  assert.equal(watcherRows.length, 0);
});

void test("notification settings suppress assignment email while leaving push enabled", async () => {
  const f = await seed();
  await db.update(clients).set({ pushEnabled: true }).where(eq(clients.id, f.owner.clientId));
  await db.insert(notificationSettings).values({
    userId: f.member.id,
    pushEnabled: true,
    cardAssignedEmail: false,
  });

  const assigned = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.card.id}/assignees`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { userIds: [f.member.id] },
  });
  assert.equal(assigned.statusCode, 200);

  const emails = await queuedTypes("card_assigned");
  assert.equal(emails.length, 0);
  const pushes = await db.select().from(pushQueue).where(eq(pushQueue.reason, "assigned"));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.userId, f.member.id);
});

void test("public API email and push notifications use the API key name as actor", async () => {
  const f = await seed();
  await db.update(clients).set({ pushEnabled: true }).where(eq(clients.id, f.owner.clientId));
  await db.insert(notificationSettings).values([
    { userId: f.owner.id, pushEnabled: true },
    { userId: f.member.id, pushEnabled: true },
  ]);
  const rawKey = await createApiKey(f);
  const publicApi = await buildPublicApiServer({ enableWebhookDeliveryScheduler: false });

  try {
    const assigned = await publicApi.inject({
      method: "PUT",
      url: `/api/v1/cards/${f.card.id}/assignees`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { userIds: [f.owner.id, f.member.id] },
    });
    assert.equal(assigned.statusCode, 200);

    const assignmentEmails = await queuedTypes("card_assigned");
    assert.deepEqual(new Set(assignmentEmails.map((row) => row.toEmail)), new Set([f.ownerEmail, f.memberEmail]));
    assert.ok(assignmentEmails.every((row) => (row.data as { actorName: string }).actorName === "Zapier sync"));
    const assignmentPushes = await db.select().from(pushQueue).where(eq(pushQueue.reason, "assigned"));
    assert.deepEqual(new Set(assignmentPushes.map((row) => row.userId)), new Set([f.owner.id, f.member.id]));
    assert.ok(assignmentPushes.every((row) => row.payload.body === "Zapier sync assigned you to Prepare launch"));

    const commented = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${f.card.id}/comments`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { body: "Synced from **Zapier**." },
    });
    assert.equal(commented.statusCode, 201);
    await sleep(50);

    const commentEmails = await queuedTypes("card_comment_added");
    assert.deepEqual(new Set(commentEmails.map((row) => row.toEmail)), new Set([f.ownerEmail, f.memberEmail]));
    assert.ok(commentEmails.every((row) => (row.data as { actorName: string }).actorName === "Zapier sync"));
    const commentPushes = await db.select().from(pushQueue).where(eq(pushQueue.reason, "comment"));
    assert.deepEqual(new Set(commentPushes.map((row) => row.userId)), new Set([f.owner.id, f.member.id]));
    assert.ok(commentPushes.every((row) => row.payload.body === "Zapier sync commented in Inbox / Prepare launch: Synced from Zapier."));

    const dueDateChanged = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${f.card.id}`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { dueDateLocalDate: "2026-05-26", dueDateSlot: "morning" },
    });
    assert.equal(dueDateChanged.statusCode, 200);

    const dueDateEmails = await queuedTypes("card_due_date_changed");
    assert.deepEqual(new Set(dueDateEmails.map((row) => row.toEmail)), new Set([f.ownerEmail, f.memberEmail]));
    assert.ok(dueDateEmails.every((row) => (row.data as { actorName: string }).actorName === "Zapier sync"));
    const dueDatePushes = await db.select().from(pushQueue).where(eq(pushQueue.reason, "dueDateChanged"));
    assert.deepEqual(new Set(dueDatePushes.map((row) => row.userId)), new Set([f.owner.id, f.member.id]));
    assert.ok(dueDatePushes.every((row) => row.payload.body === "Zapier sync changed the due date on Prepare launch"));
  } finally {
    await publicApi.close();
  }
});

void test("push settings require organisation push and user push preference", async () => {
  const f = await seed();
  await db.insert(notificationSettings).values({ userId: f.member.id, pushEnabled: false });

  const assignedWhileOrgDisabled = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.card.id}/assignees`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { userIds: [f.member.id] },
  });
  assert.equal(assignedWhileOrgDisabled.statusCode, 200);
  assert.equal((await db.select().from(pushQueue).where(eq(pushQueue.reason, "assigned"))).length, 0);

  await db.update(clients).set({ pushEnabled: true }).where(eq(clients.id, f.owner.clientId));
  await db.update(notificationSettings).set({ pushEnabled: true, cardAssignedPush: false }).where(eq(notificationSettings.userId, f.member.id));
  const [secondCard] = await db
    .insert(cards)
    .values({ listId: f.list.id, boardId: f.board.id, title: "Follow-up", position: "2000.0000000000", createdById: f.owner.id })
    .returning();
  const assignedWithTypeDisabled = await f.app.inject({
    method: "PUT",
    url: `/cards/${secondCard!.id}/assignees`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { userIds: [f.member.id] },
  });
  assert.equal(assignedWithTypeDisabled.statusCode, 200);
  assert.equal((await db.select().from(pushQueue).where(eq(pushQueue.reason, "assigned"))).length, 0);
});
