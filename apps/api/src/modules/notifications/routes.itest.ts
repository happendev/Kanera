import "../../test/setup.integration.js";
import type { ServerEventName } from "@kanera/shared/events";
import {
  activityEvents,
  boardMembers,
  boardWatchers,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardWatchers,
  cards,
  clients,
  comments,
  directRealtimeOutbox,
  lists,
  notificationSettings,
  notifications,
  pushSubscriptions,
  users,
  workspaceMembers,
  workspaceApiKeys,
} from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { createOverdueNotificationsForCards, createOverdueNotificationsForChecklistItems, runOverdueNotificationSweep } from "../../lib/overdue-notifications.js";
import { waitForNotificationFanoutForTests } from "../../lib/notifications.js";
import { hashOpaqueToken } from "../../lib/tokens.js";
import { ensureSystemWebPushConfig, webPushClient } from "../../lib/web-push.js";
import { setupIo } from "../../realtime/io.js";
import { buildIntegrationServer } from "../../test/integration.js";

async function overdueRowsForCard(cardId: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.cardId, cardId), eq(notifications.reason, "overdue")));
}

async function overdueActivitiesForCard(cardId: string) {
  return db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, cardId), eq(activityEvents.action, "overdue")));
}

function userIds(rows: { userId: string }[]) {
  return rows.map((row) => row.userId).sort();
}

async function waitForDirectNotificationOutboxRows(userId: string, eventType: ServerEventName, count: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(directRealtimeOutbox)
      .where(and(
        eq(directRealtimeOutbox.scope, "user"),
        eq(directRealtimeOutbox.userId, userId),
        eq(directRealtimeOutbox.eventType, eventType),
      ));
    if (rows.length >= count) return rows;
    await sleep(25);
  }
  return db
    .select()
    .from(directRealtimeOutbox)
    .where(and(
      eq(directRealtimeOutbox.scope, "user"),
      eq(directRealtimeOutbox.userId, userId),
      eq(directRealtimeOutbox.eventType, eventType),
    ));
}

async function enableOrgPush(clientId: string) {
  const config = await ensureSystemWebPushConfig();
  await db.update(clients).set({ pushEnabled: true, updatedAt: new Date() }).where(eq(clients.id, clientId));
  return config;
}

async function seed() {
  const app = await buildIntegrationServer();
  await setupIo(app);

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = signup.json();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json();

  const [member] = await db
    .insert(users)
    .values({ clientId: owner.clientId, email: "member@example.com", passwordHash: "x", displayName: "Member" })
    .returning();
  const [other] = await db
    .insert(users)
    .values({ clientId: owner.clientId, email: "other@example.com", passwordHash: "x", displayName: "Other" })
    .returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: member!.id, role: "member" },
    { workspaceId: workspace.id, userId: other!.id, role: "member" },
  ]);
  const memberToken = app.jwt.sign({ sub: member!.id, cid: owner.clientId, role: "member" });
  const otherToken = app.jwt.sign({ sub: other!.id, cid: owner.clientId, role: "member" });

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [publicBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Public", position: "1000.0000000000" })
    .returning();
  const [privateBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Private", position: "2000.0000000000" })
    .returning();
  // Board membership is the access model. Both members belong to the shared board; only `member`
  // belongs to the restricted one, so `other` must not see its cards/notifications.
  await db.insert(boardMembers).values([
    { boardId: publicBoard!.id, userId: member!.id, role: "editor" },
    { boardId: publicBoard!.id, userId: other!.id, role: "editor" },
    { boardId: privateBoard!.id, userId: member!.id, role: "editor" },
  ]);

  const [publicCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: publicBoard!.id, title: "Public card", position: "1000.0000000000", createdById: owner.id })
    .returning();
  const [privateCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: privateBoard!.id, title: "Private card", position: "1000.0000000000", createdById: owner.id })
    .returning();

  const [activity] = await db
    .insert(activityEvents)
    .values({
      boardId: publicBoard!.id,
      workspaceId: workspace.id,
      actorId: owner.id,
      entityType: "card",
      entityId: publicCard!.id,
      action: "updated",
      payload: { title: "Public card" },
    })
    .returning();

  const now = new Date();
  const [unread] = await db
    .insert(notifications)
    .values({
      userId: member!.id,
      activityId: activity!.id,
      cardId: publicCard!.id,
      listId: list!.id,
      boardId: publicBoard!.id,
      workspaceId: workspace.id,
      reason: "watching",
      createdAt: now,
    })
    .returning();
  const [recentRead] = await db
    .insert(notifications)
    .values({
      userId: member!.id,
      cardId: publicCard!.id,
      listId: list!.id,
      boardId: publicBoard!.id,
      workspaceId: workspace.id,
      reason: "assigned",
      readAt: now,
      createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    })
    .returning();
  const [oldRead] = await db
    .insert(notifications)
    .values({
      userId: member!.id,
      cardId: publicCard!.id,
      listId: list!.id,
      boardId: publicBoard!.id,
      workspaceId: workspace.id,
      reason: "watching",
      readAt: now,
      createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
    })
    .returning();
  const [otherUnread] = await db
    .insert(notifications)
    .values({
      userId: other!.id,
      cardId: publicCard!.id,
      listId: list!.id,
      boardId: publicBoard!.id,
      workspaceId: workspace.id,
      reason: "overdue",
      createdAt: now,
    })
    .returning();

  return {
    app,
    workspace,
    owner,
    ownerToken,
    member: member!,
    other: other!,
    memberToken,
    otherToken,
    publicBoard: publicBoard!,
    privateBoard: privateBoard!,
    publicCard: publicCard!,
    privateCard: privateCard!,
    unread: unread!,
    recentRead: recentRead!,
    oldRead: oldRead!,
    otherUnread: otherUnread!,
  };
}

void test("notifications list defaults to unread, supports includeRead, cursor pagination, and unread count", async () => {
  const f = await seed();
  const [attachment] = await db
    .insert(cardAttachments)
    .values({
      cardId: f.publicCard.id,
      clientId: f.workspace.clientId,
      uploadedById: f.owner.id,
      fileName: "proof.jpg",
      mimeType: "image/jpeg",
      byteSize: 123,
      fileKey: `cards/${f.publicCard.id}/proof.jpg`,
      url: `/api/media/${f.owner.clientId}/cards/${f.publicCard.id}/proof.jpg`,
      thumbnailFileKey: `cards/${f.publicCard.id}/proof_thumb.jpg`,
      thumbnailUrl: `/api/media/${f.owner.clientId}/cards/${f.publicCard.id}/proof_thumb.jpg`,
    })
    .returning();
  const [attachmentActivity] = await db
    .insert(activityEvents)
    .values({
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      entityType: "card",
      entityId: f.publicCard.id,
      action: "attachment_added",
      payload: { attachmentId: attachment!.id, fileName: "proof.jpg", mimeType: "image/jpeg" },
    })
    .returning();
  const [attachmentNotification] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      activityId: attachmentActivity!.id,
      cardId: f.publicCard.id,
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      reason: "watching",
      createdAt: new Date(Date.now() + 1000),
    })
    .returning();
  const [comment] = await db
    .insert(comments)
    .values({
      cardId: f.publicCard.id,
      authorId: f.owner.id,
      body: `![image.png](/api/media/${f.owner.clientId}/cards/${f.publicCard.id}/pasted-image.png)`,
    })
    .returning();
  const [commentActivity] = await db
    .insert(activityEvents)
    .values({
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      entityType: "comment",
      entityId: comment!.id,
      action: "created",
      payload: {},
    })
    .returning();
  const [commentNotification] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      activityId: commentActivity!.id,
      cardId: f.publicCard.id,
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      reason: "watching",
      createdAt: new Date(Date.now() + 2000),
    })
    .returning();

  const unreadOnly = await f.app.inject({ method: "GET", url: "/notifications?limit=1", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(unreadOnly.statusCode, 200);
  const unreadOnlyBody = unreadOnly.json();
  assert.deepEqual(unreadOnlyBody.items.map((n: { id: string }) => n.id), [commentNotification!.id]);
  assert.equal(unreadOnlyBody.unreadCount, 3);
  assert.ok(unreadOnlyBody.nextCursor);
  assert.match(unreadOnlyBody.items[0].commentBody, /^!\[image\.png\]\(https?:\/\/.+\/api\/media\/.+pasted-image\.png\?t=.+&e=\d+\)$/);

  const unreadEndpoint = await f.app.inject({ method: "GET", url: "/notifications/unread?limit=1", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(unreadEndpoint.statusCode, 200);
  const unreadEndpointBody = unreadEndpoint.json();
  assert.deepEqual(unreadEndpointBody.items.map((n: { id: string }) => n.id), [commentNotification!.id]);
  assert.equal(unreadEndpointBody.unreadCount, 3);
  assert.ok(unreadEndpointBody.nextCursor);

  const withRead = await f.app.inject({ method: "GET", url: "/notifications?includeRead=true&limit=1", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(withRead.statusCode, 200);
  const firstPage = withRead.json();
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].id, commentNotification!.id);
  assert.equal(firstPage.items[0].viewerRole, "editor");
  assert.equal(firstPage.items[0].cardCompletedAt, null);
  assert.equal(firstPage.items[0].cardArchivedAt, null);
  assert.equal(firstPage.items[0].cardDueDateLocalDate, null);
  assert.equal(firstPage.items[0].cardDueDateSlot, null);
  assert.equal(firstPage.items[0].cardDueDateTimezone, null);
  assert.ok(firstPage.nextCursor);

  const secondPage = await f.app.inject({ method: "GET", url: `/notifications?includeRead=true&limit=10&cursor=${encodeURIComponent(firstPage.nextCursor)}`, headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(secondPage.statusCode, 200);
  const secondPageBody = secondPage.json();
  const ids = secondPageBody.items.map((n: { id: string }) => n.id);
  assert.deepEqual(ids, [attachmentNotification!.id, f.unread.id, f.recentRead.id]);
  const attachmentItem = secondPageBody.items.find((n: { id: string }) => n.id === attachmentNotification!.id);
  assert.ok(attachmentItem);
  assert.match(attachmentItem.attachment.url, /^https?:\/\/.+\/api\/media\/.+\?t=.+&e=\d+$/);
  assert.match(attachmentItem.attachment.thumbnailUrl, /^https?:\/\/.+\/api\/media\/.+_thumb\.jpg\?t=.+&e=\d+$/);
  assert.ok(!ids.includes(f.oldRead.id));

  const count = await f.app.inject({ method: "GET", url: "/notifications/unread-count", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(count.statusCode, 200);
  assert.equal(count.json().count, 3);
});

void test("keyset pagination does not skip notifications that share a createdAt across a page boundary", async () => {
  const f = await seed();
  // Three unread notifications at the exact same instant, older than the seeded
  // `unread` row. With a createdAt-only cursor, paging past the first tie-row
  // would `lt(createdAt, cursor)` and silently drop the remaining ties.
  const tie = new Date(Date.now() - 60 * 60 * 1000);
  const tied = await db
    .insert(notifications)
    .values([0, 1, 2].map(() => ({
      userId: f.member.id,
      cardId: f.publicCard.id,
      listId: null,
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      reason: "watching" as const,
      createdAt: tie,
    })))
    .returning({ id: notifications.id });

  // member's unread set = seeded `unread` (newer) + these 3 ties = 4 rows.
  const expected = new Set([f.unread.id, ...tied.map((r) => r.id)]);

  // Helper parameter (not closure) breaks the cursor→url→res→cursor inference cycle.
  const fetchUnreadPage = async (pageCursor: string | null) => {
    const url = `/notifications/unread?limit=2${pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ""}`;
    const res = await f.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${f.memberToken}` } });
    assert.equal(res.statusCode, 200);
    return res.json() as { items: Array<{ id: string }>; nextCursor: string | null };
  };

  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const body = await fetchUnreadPage(cursor);
    for (const item of body.items) {
      assert.ok(!seen.has(item.id), `notification ${item.id} returned on more than one page`);
      seen.add(item.id);
    }
    cursor = body.nextCursor;
    if (!cursor) break;
  }

  assert.deepEqual([...seen].sort(), [...expected].sort());
});

void test("completed-card normal notifications stay unread while completed overdue notifications are hidden", async () => {
  const f = await seed();
  await db.update(cards).set({ completedAt: new Date("2026-05-21T10:00:00.000Z") }).where(eq(cards.id, f.publicCard.id));
  const [completedWatching] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.publicCard.id,
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      reason: "watching",
      createdAt: new Date(Date.now() + 1000),
    })
    .returning();
  const [completedOverdue] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.publicCard.id,
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      reason: "overdue",
      createdAt: new Date(Date.now() + 2000),
    })
    .returning();
  assert.ok(completedWatching);
  assert.ok(completedOverdue);

  const list = await f.app.inject({
    method: "GET",
    url: "/notifications?limit=10",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(list.statusCode, 200);
  const listedIds = list.json<{ items: { id: string }[]; unreadCount: number }>().items.map((row) => row.id);
  assert.ok(listedIds.includes(completedWatching!.id));
  assert.ok(!listedIds.includes(completedOverdue!.id));
  assert.equal(list.json<{ unreadCount: number }>().unreadCount, 2);

  const unreadList = await f.app.inject({
    method: "GET",
    url: "/notifications/unread?limit=10",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(unreadList.statusCode, 200);
  const unreadListedIds = unreadList.json<{ items: { id: string }[] }>().items.map((row) => row.id);
  assert.ok(unreadListedIds.includes(completedWatching!.id));
  assert.ok(!unreadListedIds.includes(completedOverdue!.id));

  const unreadCount = await f.app.inject({ method: "GET", url: "/notifications/unread-count", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(unreadCount.statusCode, 200);
  assert.equal(unreadCount.json().count, 2);

  const boardCounts = await f.app.inject({ method: "GET", url: "/notifications/board-unread-counts", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(boardCounts.statusCode, 200);
  assert.deepEqual(boardCounts.json(), [{ boardId: f.publicBoard.id, count: 2 }]);

  const cardCounts = await f.app.inject({ method: "GET", url: "/notifications/card-unread-counts", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(cardCounts.statusCode, 200);
  assert.deepEqual(cardCounts.json(), [{ cardId: f.publicCard.id, count: 2 }]);
});

void test("legacy notification rows linked to archived cards are hidden from feeds and every unread aggregate", async () => {
  const f = await seed();
  await db.update(cards).set({ archivedAt: new Date() }).where(eq(cards.id, f.publicCard.id));
  const headers = { authorization: `Bearer ${f.memberToken}` };

  const [all, unread, total, boards, cardsById] = await Promise.all([
    f.app.inject({ method: "GET", url: "/notifications?limit=10&includeRead=true", headers }),
    f.app.inject({ method: "GET", url: "/notifications/unread?limit=10", headers }),
    f.app.inject({ method: "GET", url: "/notifications/unread-count", headers }),
    f.app.inject({ method: "GET", url: "/notifications/board-unread-counts", headers }),
    f.app.inject({ method: "GET", url: "/notifications/card-unread-counts", headers }),
  ]);
  assert.ok([all, unread, total, boards, cardsById].every((response) => response.statusCode === 200));
  assert.deepEqual(all.json<{ items: unknown[] }>().items, []);
  assert.deepEqual(unread.json<{ items: unknown[] }>().items, []);
  assert.equal(total.json<{ count: number }>().count, 0);
  assert.deepEqual(boards.json(), []);
  assert.deepEqual(cardsById.json(), []);
});

void test("notification filter options are sorted by board and user display names", async () => {
  const f = await seed();
  await db.update(users).set({ displayName: "Zed" }).where(eq(users.id, f.owner.id));
  await db.update(users).set({ displayName: "Ada" }).where(eq(users.id, f.other.id));
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, f.workspace.id)).limit(1);
  assert.ok(list);
  const [zuluBoard] = await db
    .insert(boards)
    .values({ workspaceId: f.workspace.id, name: "Zulu", position: "3000.0000000000" })
    .returning();
  const [alphaBoard] = await db
    .insert(boards)
    .values({ workspaceId: f.workspace.id, name: "Alpha", position: "4000.0000000000" })
    .returning();
  const [zuluCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: zuluBoard!.id, title: "Zulu card", position: "1000.0000000000", createdById: f.owner.id })
    .returning();
  const [alphaCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: alphaBoard!.id, title: "Alpha card", position: "1000.0000000000", createdById: f.other.id })
    .returning();
  const [zuluActivity] = await db
    .insert(activityEvents)
    .values({
      boardId: zuluBoard!.id,
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      entityType: "card",
      entityId: zuluCard!.id,
      action: "updated",
      payload: { title: "Zulu card" },
    })
    .returning();
  const [alphaActivity] = await db
    .insert(activityEvents)
    .values({
      boardId: alphaBoard!.id,
      workspaceId: f.workspace.id,
      actorId: f.other.id,
      entityType: "card",
      entityId: alphaCard!.id,
      action: "updated",
      payload: { title: "Alpha card" },
    })
    .returning();
  await db.insert(notifications).values([
    {
      userId: f.member.id,
      activityId: zuluActivity!.id,
      cardId: zuluCard!.id,
      listId: list!.id,
      boardId: zuluBoard!.id,
      workspaceId: f.workspace.id,
      reason: "watching",
    },
    {
      userId: f.member.id,
      activityId: alphaActivity!.id,
      cardId: alphaCard!.id,
      listId: list!.id,
      boardId: alphaBoard!.id,
      workspaceId: f.workspace.id,
      reason: "watching",
    },
  ]);

  const boardOptions = await f.app.inject({
    method: "GET",
    url: "/notifications/boards",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(boardOptions.statusCode, 200);
  assert.deepEqual(
    boardOptions.json<{ boardName: string }[]>().map((row) => row.boardName),
    ["Alpha", "Public", "Zulu"],
  );

  const userOptions = await f.app.inject({
    method: "GET",
    url: "/notifications/users",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(userOptions.statusCode, 200);
  assert.deepEqual(
    userOptions.json<{ displayName: string }[]>().map((row) => row.displayName),
    ["Ada", "Zed"],
  );
});

void test("board unread counts group authenticated user attention by board", async () => {
  const f = await seed();
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.privateCard.id));
  const [privateUnread] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.privateCard.id,
      listId: f.publicCard.listId,
      boardId: f.privateBoard.id,
      workspaceId: f.workspace.id,
      reason: "assigned",
    })
    .returning();
  const [completedOverdue] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.privateCard.id,
      listId: f.publicCard.listId,
      boardId: f.privateBoard.id,
      workspaceId: f.workspace.id,
      reason: "overdue",
    })
    .returning();
  assert.ok(privateUnread);
  assert.ok(completedOverdue);

  const res = await f.app.inject({
    method: "GET",
    url: "/notifications/board-unread-counts",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().sort((a: { boardId: string }, b: { boardId: string }) => a.boardId.localeCompare(b.boardId)),
    [
      { boardId: f.privateBoard.id, count: 1 },
      { boardId: f.publicBoard.id, count: 1 },
    ].sort((a, b) => a.boardId.localeCompare(b.boardId)),
  );
});

void test("card unread counts group authenticated user attention by card", async () => {
  const f = await seed();
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.privateCard.id));
  const [privateUnread] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.privateCard.id,
      listId: f.publicCard.listId,
      boardId: f.privateBoard.id,
      workspaceId: f.workspace.id,
      reason: "assigned",
    })
    .returning();
  const [completedOverdue] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.privateCard.id,
      listId: f.publicCard.listId,
      boardId: f.privateBoard.id,
      workspaceId: f.workspace.id,
      reason: "overdue",
    })
    .returning();
  const [boardOnlyUnread] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      reason: "watching",
    })
    .returning();
  assert.ok(privateUnread);
  assert.ok(completedOverdue);
  assert.ok(boardOnlyUnread);

  const res = await f.app.inject({
    method: "GET",
    url: "/notifications/card-unread-counts",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().sort((a: { cardId: string }, b: { cardId: string }) => a.cardId.localeCompare(b.cardId)),
    [
      { cardId: f.privateCard.id, count: 1 },
      { cardId: f.publicCard.id, count: 1 },
    ].sort((a, b) => a.cardId.localeCompare(b.cardId)),
  );
});

void test("public API mutations update board unread counts through notification fanout", async () => {
  const f = await seed();
  const rawKey = "kanera_live_public_api_notifications_test";
  await db.insert(workspaceApiKeys).values({
    workspaceId: f.workspace.id,
    createdById: f.owner.id,
    name: "Public API",
    keyPrefix: "kanera_live_public",
    keyHash: hashOpaqueToken(rawKey),
    scope: "write",
  });
  await db.insert(cardWatchers).values({ cardId: f.publicCard.id, userId: f.member.id });
  await db.insert(boardWatchers).values({ boardId: f.publicBoard.id, userId: f.owner.id });
  const publicApi = await buildPublicApiServer({ enableWebhookDeliveryScheduler: false });
  try {
    const created = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${f.publicCard.id}/comments`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { body: "Synced from public API" },
    });
    assert.equal(created.statusCode, 201);
    await waitForNotificationFanoutForTests();

    const counts = await f.app.inject({
      method: "GET",
      url: "/notifications/board-unread-counts",
      headers: { authorization: `Bearer ${f.memberToken}` },
    });

    assert.equal(counts.statusCode, 200);
    const boardCount = counts.json().find((row: { boardId: string }) => row.boardId === f.publicBoard.id);
    assert.equal(boardCount?.count, 2);

    const ownerNotifications = await f.app.inject({
      method: "GET",
      url: "/notifications",
      headers: { authorization: `Bearer ${f.ownerToken}` },
    });
    assert.equal(ownerNotifications.statusCode, 200);
    const ownerCommentNotification = ownerNotifications
      .json<{ items: Array<{ boardId: string | null; reason: string; activity: { actorKind: string; action: string } | null }> }>()
      .items.find((row) => row.boardId === f.publicBoard.id && row.activity?.action === "created");
    assert.ok(ownerCommentNotification);
    assert.equal(ownerCommentNotification.reason, "watching");
    assert.equal(ownerCommentNotification.activity?.actorKind, "apiKey");

    const memberOutboxRows = await waitForDirectNotificationOutboxRows(f.member.id, "notification:created", 1);
    assert.ok(
      memberOutboxRows.some((row) => (row.payload as { notification?: { boardId?: string } }).notification?.boardId === f.publicBoard.id),
      "public API notification fanout should persist user-scoped realtime events for durable dispatch",
    );
  } finally {
    await publicApi.close();
  }
});

void test("mark read and mark all read only mutate the authenticated user's unread notifications", async () => {
  const f = await seed();

  const marked = await f.app.inject({
    method: "POST",
    url: "/notifications/read",
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { notificationIds: [f.unread.id, f.otherUnread.id] },
  });
  assert.equal(marked.statusCode, 200);
  assert.deepEqual(marked.json().readIds, [f.unread.id]);

  const [memberUnread] = await db.select().from(notifications).where(eq(notifications.id, f.unread.id)).limit(1);
  const [otherUnread] = await db.select().from(notifications).where(eq(notifications.id, f.otherUnread.id)).limit(1);
  assert.ok(memberUnread?.readAt);
  assert.equal(otherUnread?.readAt, null);

  const allRead = await f.app.inject({
    method: "POST",
    url: "/notifications/read-all",
    headers: { authorization: `Bearer ${f.otherToken}` },
    payload: {},
  });
  assert.equal(allRead.statusCode, 200);
  assert.deepEqual(allRead.json().readIds, [f.otherUnread.id]);
});

void test("mark card notifications read only mutates authenticated user's accessible card notifications", async () => {
  const f = await seed();
  const [otherCardUnread] = await db
    .insert(notifications)
    .values({
      userId: f.member.id,
      cardId: f.privateCard.id,
      listId: f.privateCard.listId,
      boardId: f.privateBoard.id,
      workspaceId: f.workspace.id,
      reason: "assigned",
    })
    .returning();
  assert.ok(otherCardUnread);

  const marked = await f.app.inject({
    method: "POST",
    url: `/notifications/cards/${f.publicCard.id}/read`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: {},
  });
  assert.equal(marked.statusCode, 200);
  const markedBody = marked.json<{ readIds: string[]; readAt: string }>();
  assert.deepEqual(markedBody.readIds, [f.unread.id]);
  assert.ok(markedBody.readAt);

  const [memberCardUnread] = await db.select().from(notifications).where(eq(notifications.id, f.unread.id)).limit(1);
  const [otherUserSameCard] = await db.select().from(notifications).where(eq(notifications.id, f.otherUnread.id)).limit(1);
  const [memberOtherCard] = await db.select().from(notifications).where(eq(notifications.id, otherCardUnread!.id)).limit(1);
  assert.ok(memberCardUnread?.readAt);
  assert.equal(otherUserSameCard?.readAt, null);
  assert.equal(memberOtherCard?.readAt, null);

  // `other` is not a member of the restricted board, so board-membership access control forbids
  // them from marking its card notifications read at all.
  const otherRestrictedBoard = await f.app.inject({
    method: "POST",
    url: `/notifications/cards/${f.privateCard.id}/read`,
    headers: { authorization: `Bearer ${f.otherToken}` },
    payload: {},
  });
  assert.equal(otherRestrictedBoard.statusCode, 403);
});

void test("mark unread only mutates the authenticated user's read notifications", async () => {
  const f = await seed();

  const marked = await f.app.inject({
    method: "POST",
    url: "/notifications/unread",
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { notificationIds: [f.recentRead.id, f.unread.id, f.otherUnread.id] },
  });
  assert.equal(marked.statusCode, 200);
  assert.deepEqual(marked.json().unreadIds, [f.recentRead.id]);

  const [memberRecent] = await db.select().from(notifications).where(eq(notifications.id, f.recentRead.id)).limit(1);
  const [memberUnread] = await db.select().from(notifications).where(eq(notifications.id, f.unread.id)).limit(1);
  const [otherUnread] = await db.select().from(notifications).where(eq(notifications.id, f.otherUnread.id)).limit(1);
  assert.equal(memberRecent?.readAt, null);
  assert.equal(memberUnread?.readAt, null);
  assert.equal(otherUnread?.readAt, null);
});

void test("push config exposes the enabled deployment public key", async () => {
  const f = await seed();
  const config = await enableOrgPush(f.owner.clientId);

  const res = await f.app.inject({
    method: "GET",
    url: "/notifications/push/config",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "enabled",
    enabled: true,
    publicKey: config.publicKey,
  });
});

void test("notification settings default enabled and patch merges type settings", async () => {
  const f = await seed();
  const config = await enableOrgPush(f.owner.clientId);

  const initial = await f.app.inject({
    method: "GET",
    url: "/notifications/settings",
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), {
    userId: f.member.id,
    emailEnabled: true,
    pushEnabled: false,
    types: {
      cardAssigned: { email: true, push: true },
      cardCommentAdded: { email: true, push: true },
      commentMentioned: { email: true, push: true },
      cardDueDateChanged: { email: true, push: true },
      cardOverdue: { email: true, push: true },
    },
    push: {
      status: "enabled",
      enabled: true,
      publicKey: config.publicKey,
    },
  });

  const patched = await f.app.inject({
    method: "PATCH",
    url: "/notifications/settings",
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: {
      emailEnabled: false,
      types: {
        cardAssigned: { push: false },
      },
    },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().emailEnabled, false);
  assert.equal(patched.json().pushEnabled, false);
  assert.deepEqual(patched.json().types.cardAssigned, { email: true, push: false });
  assert.deepEqual(patched.json().types.cardCommentAdded, { email: true, push: true });
  assert.deepEqual(patched.json().types.commentMentioned, { email: true, push: true });

  const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, f.member.id)).limit(1);
  assert.equal(row?.emailEnabled, false);
  assert.equal(row?.cardAssignedEmail, true);
  assert.equal(row?.cardAssignedPush, false);
});

void test("push subscription routes upsert the authenticated user's endpoint and scope deletion", async () => {
  const f = await seed();
  await enableOrgPush(f.owner.clientId);
  const endpoint = "https://push.example.test/subscriptions/member-1";

  const firstPut = await f.app.inject({
    method: "PUT",
    url: "/notifications/push/subscription",
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: {
      endpoint,
      expirationTime: null,
      deviceLabel: "Pixel 9",
      contentEncoding: "aes128gcm",
      keys: {
        p256dh: "member-p256dh",
        auth: "member-auth",
      },
    },
  });
  assert.equal(firstPut.statusCode, 204);

  const secondPut = await f.app.inject({
    method: "PUT",
    url: "/notifications/push/subscription",
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: {
      endpoint,
      expirationTime: null,
      deviceLabel: "Pixel 9 Pro",
      contentEncoding: "aesgcm",
      keys: {
        p256dh: "member-p256dh-updated",
        auth: "member-auth-updated",
      },
    },
  });
  assert.equal(secondPut.statusCode, 204);

  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.userId, f.member.id);
  assert.equal(rows[0]?.clientId, f.owner.clientId);
  assert.equal(rows[0]?.deviceLabel, "Pixel 9 Pro");
  assert.equal(rows[0]?.contentEncoding, "aesgcm");
  assert.equal(rows[0]?.keyP256dh, "member-p256dh-updated");
  assert.equal(rows[0]?.keyAuth, "member-auth-updated");

  const deleteByOther = await f.app.inject({
    method: "DELETE",
    url: "/notifications/push/subscription",
    headers: { authorization: `Bearer ${f.otherToken}` },
    payload: { endpoint },
  });
  assert.equal(deleteByOther.statusCode, 204);

  const stillThere = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  assert.equal(stillThere.length, 1);

  const deleteByOwner = await f.app.inject({
    method: "DELETE",
    url: "/notifications/push/subscription",
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { endpoint },
  });
  assert.equal(deleteByOwner.statusCode, 204);

  const deleted = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  assert.equal(deleted.length, 0);
});

void test("push test sends the authenticated user's active subscriptions", async () => {
  const f = await seed();
  await enableOrgPush(f.owner.clientId);
  const send = mock.method(webPushClient, "sendNotification", async () => undefined as never);
  try {
    await db.insert(pushSubscriptions).values([
      {
        clientId: f.owner.clientId,
        userId: f.member.id,
        endpoint: "https://push.example.test/subscriptions/member-delivery",
        keyP256dh: "member-p256dh",
        keyAuth: "member-auth",
        contentEncoding: "aes128gcm",
      },
      {
        clientId: f.owner.clientId,
        userId: f.member.id,
        endpoint: "https://push.example.test/subscriptions/member-delivery-2",
        keyP256dh: "member-p256dh-2",
        keyAuth: "member-auth-2",
        contentEncoding: "aes128gcm",
      },
    ]);

    const res = await f.app.inject({
      method: "POST",
      url: "/notifications/push/test",
      headers: { authorization: `Bearer ${f.memberToken}` },
      payload: {
        title: "Kanera push smoke test",
        body: "If you see this, Web Push is working.",
        url: "/assigned-work",
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      attempted: 2,
      delivered: 2,
      disabled: 0,
      failed: 0,
    });
    assert.equal(send.mock.calls.length, 2);
    assert.deepEqual(JSON.parse(send.mock.calls[0]?.arguments[1] as string), {
      kind: "test",
      title: "Kanera push smoke test",
      body: "If you see this, Web Push is working.",
      url: "/assigned-work",
      icon: "/assets/favicon/android-chrome-192x192.png",
      badge: "/assets/favicon/notification-badge.png",
    });
  } finally {
    send.mock.restore();
  }
});

void test("push test disables subscriptions rejected as gone", async () => {
  const f = await seed();
  await enableOrgPush(f.owner.clientId);
  const send = mock.method(webPushClient, "sendNotification", async () => {
    throw Object.assign(new Error("gone"), { statusCode: 410, body: "expired" });
  });
  try {
    const [subscription] = await db
      .insert(pushSubscriptions)
      .values({
        clientId: f.owner.clientId,
        userId: f.member.id,
        endpoint: "https://push.example.test/subscriptions/member-gone",
        keyP256dh: "member-p256dh",
        keyAuth: "member-auth",
      })
      .returning();

    const res = await f.app.inject({
      method: "POST",
      url: "/notifications/push/test",
      headers: { authorization: `Bearer ${f.memberToken}` },
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      attempted: 1,
      delivered: 0,
      disabled: 1,
      failed: 0,
    });

    const [updated] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, subscription!.id)).limit(1);
    assert.ok(updated?.disabledAt);
    assert.equal(updated?.failureCount, 1);
    assert.equal(updated?.lastError, "status=410: gone: expired");
  } finally {
    send.mock.restore();
  }
});

void test("overdue notification sweep ignores completed cards", async () => {
  const f = await seed();
  const [completedOverdue] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Done late",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      completedAt: new Date("2026-05-21T10:00:00.000Z"),
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: completedOverdue!.id, userId: f.member.id });

  const inserted = await runOverdueNotificationSweep();
  assert.equal(inserted, 0);

  const rows = await db.select().from(notifications).where(eq(notifications.cardId, completedOverdue!.id));
  assert.equal(rows.length, 0);
});

void test("overdue notification sweep notifies assignees, card watchers, and board watchers once per user", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late watched task",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: overdueCard!.id, userId: f.member.id });
  await db.insert(cardWatchers).values({ cardId: overdueCard!.id, userId: f.member.id });
  await db.insert(cardWatchers).values({ cardId: overdueCard!.id, userId: f.other.id });
  await db.insert(boardWatchers).values({ boardId: f.publicBoard.id, userId: f.owner.id });
  await db.insert(boardWatchers).values({ boardId: f.publicBoard.id, userId: f.other.id });

  const inserted = await runOverdueNotificationSweep();
  assert.equal(inserted, 3);

  const rows = await overdueRowsForCard(overdueCard!.id);
  assert.deepEqual(userIds(rows), [f.member.id, f.other.id, f.owner.id].sort());
});

void test("overdue notification sweep records one system activity per card due date", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late activity task",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "morning",
      dueDateTimezone: "Europe/Dublin",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: overdueCard!.id, userId: f.member.id });

  assert.equal(await runOverdueNotificationSweep(), 1);
  assert.equal(await runOverdueNotificationSweep(), 0);

  const activities = await overdueActivitiesForCard(overdueCard!.id);
  assert.equal(activities.length, 1);
  assert.equal(activities[0]!.actorKind, "system");
  assert.equal(activities[0]!.actorId, null);
  assert.equal(activities[0]!.boardId, f.publicBoard.id);
  assert.equal(activities[0]!.workspaceId, f.workspace.id);
  assert.deepEqual(activities[0]!.payload, {
    dueDateLocalDate: "2026-05-20",
    dueDateSlot: "morning",
    dueDateTimezone: "Europe/Dublin",
  });
});

void test("overdue notification sweep records activity even when no users are notified", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late unobserved task",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
    })
    .returning();

  assert.equal(await runOverdueNotificationSweep(), 0);
  assert.equal((await overdueRowsForCard(overdueCard!.id)).length, 0);
  assert.equal((await overdueActivitiesForCard(overdueCard!.id)).length, 1);
});

void test("overdue notification checks use the card due date timezone, not the recipient timezone", async () => {
  const f = await seed();

  const [card] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late in Los Angeles",
      position: "3000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-24",
      dueDateSlot: "anyTime",
      dueDateTimezone: "America/Los_Angeles",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: card!.id, userId: f.member.id });

  assert.equal(await createOverdueNotificationsForCards(db, [card!.id], new Date("2026-05-25T03:59:00Z")), 0);
  assert.equal(await createOverdueNotificationsForCards(db, [card!.id], new Date("2026-05-25T04:00:00Z")), 1);
});

void test("setting and clearing a card due date stores the actor timezone", async () => {
  const f = await seed();
  await db.update(users).set({ timezone: "America/New_York" }).where(eq(users.id, f.member.id));

  const setRes = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.publicCard.id}`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { dueDateLocalDate: "2026-05-26", dueDateSlot: "morning" },
  });
  assert.equal(setRes.statusCode, 200);
  assert.equal(setRes.json().dueDateTimezone, "America/New_York");

  const clearRes = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.publicCard.id}`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { dueDateLocalDate: null, dueDateSlot: null },
  });
  assert.equal(clearRes.statusCode, 200);
  assert.equal(clearRes.json().dueDateTimezone, null);
});

void test("completed cards do not keep overdue notifications visible", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late task",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: overdueCard!.id, userId: f.member.id });

  const inserted = await runOverdueNotificationSweep();
  assert.equal(inserted, 1);

  const before = await f.app.inject({ method: "GET", url: "/notifications", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(before.statusCode, 200);
  assert.ok(before.json().items.some((n: { cardId: string | null; reason: string }) => n.cardId === overdueCard!.id && n.reason === "overdue"));

  const completed = await f.app.inject({
    method: "PATCH",
    url: `/cards/${overdueCard!.id}/completion`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);

  const rows = await db.select().from(notifications).where(eq(notifications.cardId, overdueCard!.id));
  assert.equal(rows.length, 0);

  const after = await f.app.inject({ method: "GET", url: "/notifications?includeRead=true", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().items.some((n: { cardId: string | null; reason: string }) => n.cardId === overdueCard!.id && n.reason === "overdue"), false);

  const count = await f.app.inject({ method: "GET", url: "/notifications/unread-count", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(count.statusCode, 200);
  assert.equal(count.json().count, 1);
});

void test("uncompleting a still-overdue card immediately recreates overdue notifications for current recipients", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late reopened task",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: overdueCard!.id, userId: f.member.id });
  await db.insert(cardWatchers).values({ cardId: overdueCard!.id, userId: f.other.id });
  await db.insert(boardWatchers).values({ boardId: f.publicBoard.id, userId: f.owner.id });

  assert.equal(await runOverdueNotificationSweep(), 3);
  const beforeComplete = await overdueRowsForCard(overdueCard!.id);
  assert.deepEqual(userIds(beforeComplete), [f.member.id, f.other.id, f.owner.id].sort());

  const completed = await f.app.inject({
    method: "PATCH",
    url: `/cards/${overdueCard!.id}/completion`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal((await overdueRowsForCard(overdueCard!.id)).length, 0);

  await db.delete(cardWatchers).where(and(eq(cardWatchers.cardId, overdueCard!.id), eq(cardWatchers.userId, f.other.id)));
  const uncompleted = await f.app.inject({
    method: "PATCH",
    url: `/cards/${overdueCard!.id}/completion`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: false },
  });
  assert.equal(uncompleted.statusCode, 200);

  const reopenedRows = await overdueRowsForCard(overdueCard!.id);
  assert.deepEqual(userIds(reopenedRows), [f.member.id, f.owner.id].sort());
  assert.ok(reopenedRows.every((row) => row.readAt === null));

  const activities = await db
    .select({ action: activityEvents.action, coalescedCount: activityEvents.coalescedCount })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, overdueCard!.id)));
  assert.deepEqual(
    activities.map((row) => ({ action: row.action, coalescedCount: row.coalescedCount })).sort((a, b) => a.action.localeCompare(b.action)),
    [
      { action: "completion:set", coalescedCount: 2 },
      { action: "overdue", coalescedCount: 1 },
    ],
  );
});

void test("bulk completion clears overdue notifications for completed cards", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late task for bulk complete",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: overdueCard!.id, userId: f.member.id });

  const inserted = await runOverdueNotificationSweep();
  assert.equal(inserted, 1);

  const completed = await f.app.inject({
    method: "POST",
    url: `/boards/${f.publicBoard.id}/lists/${f.publicCard.listId}/cards/completion`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);

  const rows = await db.select().from(notifications).where(eq(notifications.cardId, overdueCard!.id));
  assert.equal(rows.length, 0);

  const after = await f.app.inject({ method: "GET", url: "/notifications?includeRead=true", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().items.some((n: { cardId: string | null; reason: string }) => n.cardId === overdueCard!.id && n.reason === "overdue"), false);
});

void test("bulk uncompletion immediately recreates overdue notifications for still-overdue cards", async () => {
  const f = await seed();

  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Late bulk reopened task",
      position: "2000.0000000000",
      createdById: f.owner.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: overdueCard!.id, userId: f.member.id });
  await db.insert(cardWatchers).values({ cardId: overdueCard!.id, userId: f.other.id });
  await db.insert(boardWatchers).values({ boardId: f.publicBoard.id, userId: f.owner.id });

  assert.equal(await runOverdueNotificationSweep(), 3);

  const completed = await f.app.inject({
    method: "POST",
    url: `/boards/${f.publicBoard.id}/lists/${f.publicCard.listId}/cards/completion`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal((await overdueRowsForCard(overdueCard!.id)).length, 0);

  await db.delete(cardWatchers).where(and(eq(cardWatchers.cardId, overdueCard!.id), eq(cardWatchers.userId, f.other.id)));
  const uncompleted = await f.app.inject({
    method: "POST",
    url: `/boards/${f.publicBoard.id}/lists/${f.publicCard.listId}/cards/completion`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: false },
  });
  assert.equal(uncompleted.statusCode, 200);

  const reopenedRows = await overdueRowsForCard(overdueCard!.id);
  assert.deepEqual(userIds(reopenedRows), [f.member.id, f.owner.id].sort());

  const activities = await db
    .select({ action: activityEvents.action })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, overdueCard!.id)));
  assert.deepEqual(activities.map((row) => row.action).sort(), ["completed", "overdue", "uncompleted"]);
});

void test("card and board watch endpoints enforce access, are idempotent, and delete only the current user's watch", async () => {
  const f = await seed();

  const publicCardWatch = await f.app.inject({ method: "PUT", url: `/cards/${f.publicCard.id}/watch`, headers: { authorization: `Bearer ${f.memberToken}` }, payload: {} });
  assert.equal(publicCardWatch.statusCode, 204);
  const publicCardWatchAgain = await f.app.inject({ method: "PUT", url: `/cards/${f.publicCard.id}/watch`, headers: { authorization: `Bearer ${f.memberToken}` }, payload: {} });
  assert.equal(publicCardWatchAgain.statusCode, 204);
  assert.equal((await db.select().from(cardWatchers).where(eq(cardWatchers.cardId, f.publicCard.id))).length, 1);

  // `other` is not a member of the restricted board, so board-membership access control forbids
  // watching its cards.
  const otherBoardWatch = await f.app.inject({ method: "PUT", url: `/cards/${f.privateCard.id}/watch`, headers: { authorization: `Bearer ${f.otherToken}` }, payload: {} });
  assert.equal(otherBoardWatch.statusCode, 403);

  await db.insert(cardWatchers).values({ cardId: f.publicCard.id, userId: f.other.id });
  const deleteOwn = await f.app.inject({ method: "DELETE", url: `/cards/${f.publicCard.id}/watch`, headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(deleteOwn.statusCode, 204);
  const remainingCardWatches = await db.select().from(cardWatchers).where(eq(cardWatchers.cardId, f.publicCard.id));
  assert.deepEqual(remainingCardWatches.map((w) => w.userId), [f.other.id]);

  const publicBoardWatch = await f.app.inject({ method: "PUT", url: `/boards/${f.publicBoard.id}/watch`, headers: { authorization: `Bearer ${f.memberToken}` }, payload: {} });
  assert.equal(publicBoardWatch.statusCode, 204);
  const publicBoardWatchAgain = await f.app.inject({ method: "PUT", url: `/boards/${f.publicBoard.id}/watch`, headers: { authorization: `Bearer ${f.memberToken}` }, payload: {} });
  assert.equal(publicBoardWatchAgain.statusCode, 204);
  assert.equal((await db.select().from(boardWatchers).where(eq(boardWatchers.boardId, f.publicBoard.id))).length, 1);

  const otherBoardBoardWatch = await f.app.inject({ method: "PUT", url: `/boards/${f.privateBoard.id}/watch`, headers: { authorization: `Bearer ${f.otherToken}` }, payload: {} });
  assert.equal(otherBoardBoardWatch.statusCode, 403);

  await db.insert(boardWatchers).values({ boardId: f.publicBoard.id, userId: f.other.id });
  const deleteBoardOwn = await f.app.inject({ method: "DELETE", url: `/boards/${f.publicBoard.id}/watch`, headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(deleteBoardOwn.statusCode, 204);
  const remainingBoardWatches = await db.select().from(boardWatchers).where(eq(boardWatchers.boardId, f.publicBoard.id));
  assert.deepEqual(remainingBoardWatches.map((w) => w.userId), [f.other.id]);
});

void test("card and board watcher list endpoints enforce access and return sorted watcher users", async () => {
  const f = await seed();
  await db.update(users).set({ displayName: "Zed" }).where(eq(users.id, f.owner.id));
  await db.update(users).set({ displayName: "Ada" }).where(eq(users.id, f.member.id));
  await db.insert(cardWatchers).values([
    { cardId: f.publicCard.id, userId: f.owner.id },
    { cardId: f.publicCard.id, userId: f.member.id },
  ]);
  await db.insert(boardWatchers).values([
    { boardId: f.publicBoard.id, userId: f.owner.id },
    { boardId: f.publicBoard.id, userId: f.member.id },
  ]);

  const cardWatchersResponse = await f.app.inject({ method: "GET", url: `/cards/${f.publicCard.id}/watchers`, headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(cardWatchersResponse.statusCode, 200);
  assert.deepEqual(cardWatchersResponse.json().map((row: { userId: string; displayName: string; avatarUrl: string | null }) => row), [
    { userId: f.member.id, displayName: "Ada", avatarUrl: null },
    { userId: f.owner.id, displayName: "Zed", avatarUrl: null },
  ]);

  const boardWatchersResponse = await f.app.inject({ method: "GET", url: `/boards/${f.publicBoard.id}/watchers`, headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(boardWatchersResponse.statusCode, 200);
  assert.deepEqual(boardWatchersResponse.json().map((row: { userId: string; displayName: string; avatarUrl: string | null }) => row), [
    { userId: f.member.id, displayName: "Ada", avatarUrl: null },
    { userId: f.owner.id, displayName: "Zed", avatarUrl: null },
  ]);

  // A non-member cannot list watchers on a board they cannot access.
  const otherBoardCardWatchers = await f.app.inject({ method: "GET", url: `/cards/${f.privateCard.id}/watchers`, headers: { authorization: `Bearer ${f.otherToken}` } });
  assert.equal(otherBoardCardWatchers.statusCode, 403);
  const otherBoardWatchers = await f.app.inject({ method: "GET", url: `/boards/${f.privateBoard.id}/watchers`, headers: { authorization: `Bearer ${f.otherToken}` } });
  assert.equal(otherBoardWatchers.statusCode, 403);
  const missingCard = await f.app.inject({ method: "GET", url: "/cards/00000000-0000-0000-0000-000000000000/watchers", headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(missingCard.statusCode, 404);
});

async function checklistOverdueRowsForItem(itemId: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.checklistItemId, itemId), eq(notifications.reason, "checklist_item_overdue")));
}

async function seedOverdueChecklistItem(f: Awaited<ReturnType<typeof seed>>, overrides?: { assigneeId?: string | null; completedAt?: Date | null }) {
  const [overdueCard] = await db
    .insert(cards)
    .values({
      listId: f.publicCard.listId,
      boardId: f.publicBoard.id,
      title: "Card with checklist",
      position: "3000.0000000000",
      createdById: f.owner.id,
    })
    .returning();
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: overdueCard!.id, title: "Steps", position: "1000.0000000000" })
    .returning();
  const [item] = await db
    .insert(cardChecklistItems)
    .values({
      checklistId: checklist!.id,
      text: "Ship it",
      position: "1000.0000000000",
      assigneeId: overrides && "assigneeId" in overrides ? overrides.assigneeId ?? null : f.member.id,
      completedAt: overrides?.completedAt ?? null,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      dueDateTimezone: "UTC",
    })
    .returning();
  return { card: overdueCard!, checklist: checklist!, item: item! };
}

const overdueNow = new Date("2026-05-25T12:00:00.000Z");

void test("checklist item overdue sweep notifies only the assigned user", async () => {
  const f = await seed();
  const { card, item } = await seedOverdueChecklistItem(f);
  // A card watcher must NOT receive a checklist-item overdue notification.
  await db.insert(cardWatchers).values({ cardId: card.id, userId: f.other.id });

  const inserted = await createOverdueNotificationsForChecklistItems(db, [item.id], overdueNow);
  assert.equal(inserted, 1);

  const rows = await checklistOverdueRowsForItem(item.id);
  assert.deepEqual(userIds(rows), [f.member.id]);
});

void test("checklist item overdue sweep ignores completed items", async () => {
  const f = await seed();
  const { item } = await seedOverdueChecklistItem(f, { completedAt: new Date("2026-05-21T10:00:00.000Z") });

  const inserted = await createOverdueNotificationsForChecklistItems(db, [item.id], overdueNow);
  assert.equal(inserted, 0);
  assert.equal((await checklistOverdueRowsForItem(item.id)).length, 0);
});

void test("checklist item overdue sweep ignores items without an assignee", async () => {
  const f = await seed();
  const { item } = await seedOverdueChecklistItem(f, { assigneeId: null });

  const inserted = await createOverdueNotificationsForChecklistItems(db, [item.id], overdueNow);
  assert.equal(inserted, 0);
  assert.equal((await checklistOverdueRowsForItem(item.id)).length, 0);
});

void test("checklist item overdue sweep checks the item due date timezone, not the recipient", async () => {
  const f = await seed();
  const { card, item } = await seedOverdueChecklistItem(f);
  await db
    .update(cardChecklistItems)
    .set({ dueDateTimezone: "America/New_York", dueDateSlot: "endOfWorkDay" })
    .where(eq(cardChecklistItems.id, item.id));
  void card;

  assert.equal(await createOverdueNotificationsForChecklistItems(db, [item.id], new Date("2026-05-20T20:59:00.000Z")), 0);
  assert.equal(await createOverdueNotificationsForChecklistItems(db, [item.id], new Date("2026-05-20T21:00:00.000Z")), 1);
});

void test("completing an overdue checklist item clears its overdue notification", async () => {
  const f = await seed();
  const { card, checklist, item } = await seedOverdueChecklistItem(f);

  assert.equal(await createOverdueNotificationsForChecklistItems(db, [item.id], overdueNow), 1);
  assert.equal((await checklistOverdueRowsForItem(item.id)).length, 1);

  const completed = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: { authorization: `Bearer ${f.memberToken}` },
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);

  assert.equal((await checklistOverdueRowsForItem(item.id)).length, 0);
});
