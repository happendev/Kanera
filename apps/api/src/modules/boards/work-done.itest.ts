import "../../test/setup.integration.js";
import { activityEvents, boardMembers, boards, cardAssignees, cardChecklistItems, cardChecklists, cards, lists, users, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface WorkDoneEvent {
  id: string;
  type: "created" | "moved" | "completed" | "checklistItemCompleted";
  at: string;
  card: { id: string; title: string };
  boardId: string;
  listId: string;
  // Card events
  actorUserId?: string | null;
  actorName?: string;
  // moved
  listPath?: string[];
  // checklistItemCompleted
  itemId?: string;
  text?: string;
  checklistTitle?: string;
  completedByUserId?: string | null;
  completedByName?: string;
}

void test("work-done emits created/moved/checklist events that day as separate rows", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Work Done",
      email: "owner-work-done@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<{ accessToken: string; user: { id: string } }>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<{ id: string }>();

  const [todoList] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(todoList);
  const [doingList] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Doing", position: "2000.0000000000" })
    .returning();
  assert.ok(doingList);

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  // The card now lives in Doing — it was created in To Do and moved today.
  const [card] = await db
    .insert(cards)
    .values({ listId: doingList.id, boardId: board.id, title: "Ship it", position: "1000.0000000000", createdById: owner.id })
    .returning();
  assert.ok(card);

  const now = new Date();
  await db.insert(activityEvents).values([
    {
      boardId: board.id,
      workspaceId: workspace.id,
      actorId: owner.id,
      entityType: "card",
      entityId: card.id,
      action: "created",
      payload: { listId: todoList.id },
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: new Date(now.getTime() - 60_000),
    },
    {
      boardId: board.id,
      workspaceId: workspace.id,
      actorId: owner.id,
      entityType: "card",
      entityId: card.id,
      action: "moved",
      payload: { fromListId: todoList.id, toListId: doingList.id },
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, title: "Release checks", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const [completedItem] = await db
    .insert(cardChecklistItems)
    .values({
      checklistId: checklist.id,
      text: "Verify production deploy",
      position: "1000.0000000000",
      completedAt: now,
      completedById: owner.id,
    })
    .returning();
  assert.ok(completedItem);

  const [otherBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Other", position: "2000.0000000000" })
    .returning();
  assert.ok(otherBoard);
  const [otherCard] = await db
    .insert(cards)
    .values({ listId: doingList.id, boardId: otherBoard.id, title: "Other card", position: "1000.0000000000", createdById: owner.id })
    .returning();
  assert.ok(otherCard);
  const [otherChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: otherCard.id, title: "Other checks", position: "1000.0000000000" })
    .returning();
  assert.ok(otherChecklist);
  await db.insert(cardChecklistItems).values({
    checklistId: otherChecklist.id,
    text: "Wrong board item",
    position: "1000.0000000000",
    completedAt: now,
    completedById: owner.id,
  });

  const [archivedCard] = await db
    .insert(cards)
    .values({ listId: doingList.id, boardId: board.id, title: "Archived card", position: "2000.0000000000", createdById: owner.id, archivedAt: now })
    .returning();
  assert.ok(archivedCard);
  const [archivedChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: archivedCard.id, title: "Archived checks", position: "1000.0000000000" })
    .returning();
  assert.ok(archivedChecklist);
  await db.insert(cardChecklistItems).values({
    checklistId: archivedChecklist.id,
    text: "Archived completed item",
    position: "1000.0000000000",
    completedAt: now,
    completedById: owner.id,
  });

  const from = new Date(now.getTime() - DAY_MS / 2).toISOString();
  const to = new Date(now.getTime() + DAY_MS / 2).toISOString();

  const res = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { events } = res.json<{ events: WorkDoneEvent[] }>();
  // created + moved are now separate rows, plus the checklist completion: 3 events.
  assert.equal(events.length, 3);
  // Sorted by `at` descending: the checklist item and move share `now`, the create is older.
  assert.equal(events[events.length - 1]!.type, "created", "oldest event is the create");

  const createdEvent = events.find((e) => e.type === "created");
  assert.ok(createdEvent);
  assert.equal(createdEvent.card.id, card.id);
  assert.equal(createdEvent.listId, doingList.id);
  assert.equal(createdEvent.actorUserId, owner.id);
  assert.equal(createdEvent.actorName, "Owner");

  const movedEvent = events.find((e) => e.type === "moved");
  assert.ok(movedEvent);
  assert.equal(movedEvent.card.id, card.id);
  assert.deepEqual(movedEvent.listPath, [todoList.id, doingList.id]);
  assert.equal(movedEvent.actorUserId, owner.id);

  const checklistEvent = events.find((e) => e.type === "checklistItemCompleted");
  assert.ok(checklistEvent);
  assert.equal(checklistEvent.itemId, completedItem.id);
  assert.equal(checklistEvent.text, "Verify production deploy");
  assert.equal(checklistEvent.checklistTitle, "Release checks");
  assert.equal(checklistEvent.card.id, card.id);
  assert.equal(checklistEvent.card.title, "Ship it");
  assert.equal(checklistEvent.boardId, board.id);
  assert.equal(checklistEvent.listId, doingList.id);
  assert.equal(checklistEvent.completedByUserId, owner.id);
  assert.equal(checklistEvent.completedByName, "Owner");

  // Events are sorted by `at` descending.
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(new Date(events[i - 1]!.at).getTime() >= new Date(events[i]!.at).getTime(), "descending by at");
  }

  const searched = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&q=${encodeURIComponent("production")}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(searched.statusCode, 200);
  const searchedBody = searched.json<{ events: WorkDoneEvent[] }>();
  // "production" matches only the checklist item text, not the card title.
  assert.deepEqual(searchedBody.events.map((e) => e.type), ["checklistItemCompleted"]);
  assert.equal(searchedBody.events[0]?.itemId, completedItem.id);

  // A day with no activity returns no events.
  const quietFrom = new Date(now.getTime() - 5 * DAY_MS).toISOString();
  const quietTo = new Date(now.getTime() - 5 * DAY_MS + DAY_MS / 2).toISOString();
  const quiet = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(quietFrom)}&to=${encodeURIComponent(quietTo)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(quiet.statusCode, 200);
  assert.deepEqual(quiet.json<{ events: WorkDoneEvent[] }>(), { events: [] });

  // Days older than the 60-day cap are rejected.
  const staleFrom = new Date(now.getTime() - 61 * DAY_MS).toISOString();
  const staleTo = new Date(now.getTime() - 61 * DAY_MS + DAY_MS / 2).toISOString();
  const stale = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(staleFrom)}&to=${encodeURIComponent(staleTo)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(stale.statusCode, 400);
});

/** Minimal board/list scaffold for the focused coalesce/completion tests below. */
async function seedBoard(email: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme", email, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<{ accessToken: string; user: { id: string } }>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<{ id: string }>();

  const [todoList] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(todoList);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  return { app, accessToken, owner, workspace, todoList, board };
}

void test("work-done only returns directly or checklist-assigned cards to restricted members", async () => {
  const { app, owner, workspace, todoList, board } = await seedBoard("restricted-work-done@example.com");
  const [workspaceRow] = await db.select({ clientId: workspaces.clientId }).from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
  assert.ok(workspaceRow);
  const [restrictedUser] = await db.insert(users).values({
    clientId: workspaceRow.clientId,
    email: "restricted-history@example.com",
    passwordHash: "hash",
    displayName: "Restricted",
  }).returning();
  assert.ok(restrictedUser);
  await db.insert(boardMembers).values({ boardId: board.id, userId: restrictedUser.id, role: "observer", assignedItemsOnly: true });

  const [directCard, checklistCard, hiddenCard] = await db.insert(cards).values([
    { listId: todoList.id, boardId: board.id, title: "Direct work", position: "1000.0000000000", createdById: owner.id },
    { listId: todoList.id, boardId: board.id, title: "Checklist work", position: "2000.0000000000", createdById: owner.id },
    { listId: todoList.id, boardId: board.id, title: "Hidden work", position: "3000.0000000000", createdById: owner.id },
  ]).returning();
  assert.ok(directCard && checklistCard && hiddenCard);
  await db.insert(cardAssignees).values({ cardId: directCard.id, userId: restrictedUser.id });
  const [checklist] = await db.insert(cardChecklists).values({ cardId: checklistCard.id, title: "Owned tasks", position: "1000.0000000000" }).returning();
  assert.ok(checklist);
  await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "My step", position: "1000.0000000000", assigneeId: restrictedUser.id });

  const now = new Date();
  await db.insert(activityEvents).values([directCard, checklistCard, hiddenCard].map((card) => ({
    boardId: board.id,
    workspaceId: workspace.id,
    actorId: owner.id,
    entityType: "card" as const,
    entityId: card.id,
    action: "created" as const,
    payload: {},
    createdAt: now,
    updatedAt: now,
  })));

  const token = app.jwt.sign({ sub: restrictedUser.id, cid: workspaceRow.clientId, role: "member" });
  const response = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(new Date(now.getTime() - DAY_MS / 2).toISOString())}&to=${encodeURIComponent(new Date(now.getTime() + DAY_MS / 2).toISOString())}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const ids = response.json<{ events: WorkDoneEvent[] }>().events.map((event) => event.card.id).sort();
  assert.deepEqual(ids, [directCard.id, checklistCard.id].sort());
});

void test("work-done surfaces cards marked complete (both paths) and ignores un-completions", async () => {
  const { app, accessToken, owner, workspace, todoList, board } = await seedBoard("complete-work-done@example.com");

  // Bulk "complete list" path writes a plain `completed` action.
  const [bulkCard] = await db
    .insert(cards)
    .values({ listId: todoList.id, boardId: board.id, title: "Finish report", position: "1000.0000000000", createdById: owner.id })
    .returning();
  // Single-card toggle writes a coalesced `completion:set` with payload.toValue.
  const [toggledCard] = await db
    .insert(cards)
    .values({ listId: todoList.id, boardId: board.id, title: "Toggled task", position: "2000.0000000000", createdById: owner.id })
    .returning();
  const [reopenedViaSet] = await db
    .insert(cards)
    .values({ listId: todoList.id, boardId: board.id, title: "Reopened via set", position: "3000.0000000000", createdById: owner.id })
    .returning();
  const [uncompletedCard] = await db
    .insert(cards)
    .values({ listId: todoList.id, boardId: board.id, title: "Reopened task", position: "4000.0000000000", createdById: owner.id })
    .returning();
  assert.ok(bulkCard && toggledCard && reopenedViaSet && uncompletedCard);

  const now = new Date();
  await db.insert(activityEvents).values([
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: bulkCard.id,
      action: "completed", payload: {}, createdAt: now, updatedAt: now,
    },
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: toggledCard.id,
      action: "completion:set", payload: { toValue: true }, createdAt: now, updatedAt: now,
    },
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: reopenedViaSet.id,
      action: "completion:set", payload: { toValue: false }, createdAt: now, updatedAt: now,
    },
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: uncompletedCard.id,
      action: "uncompleted", payload: {}, createdAt: now, updatedAt: now,
    },
  ]);

  const from = new Date(now.getTime() - DAY_MS / 2).toISOString();
  const to = new Date(now.getTime() + DAY_MS / 2).toISOString();
  const res = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { events } = res.json<{ events: WorkDoneEvent[] }>();
  // Both completion paths surface; the `completion:set` un-completion and `uncompleted` are excluded.
  assert.ok(events.every((e) => e.type === "completed"));
  assert.deepEqual(
    events.map((e) => e.card.id).sort(),
    [bulkCard.id, toggledCard.id].sort(),
  );
});

void test("work-done coalesces consecutive same-card moves into one row", async () => {
  const { app, accessToken, owner, workspace, todoList, board } = await seedBoard("coalesce-work-done@example.com");

  const [listB] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Doing", position: "2000.0000000000" })
    .returning();
  const [listC] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Review", position: "3000.0000000000" })
    .returning();
  const [listD] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Done", position: "4000.0000000000" })
    .returning();
  assert.ok(listB && listC && listD);

  const [card] = await db
    .insert(cards)
    .values({ listId: listD.id, boardId: board.id, title: "Bounced card", position: "1000.0000000000", createdById: owner.id })
    .returning();
  assert.ok(card);

  const now = new Date();
  await db.insert(activityEvents).values([
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: card.id,
      action: "moved", payload: { fromListId: todoList.id, toListId: listB.id },
      createdAt: new Date(now.getTime() - 30_000), updatedAt: new Date(now.getTime() - 30_000),
    },
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: card.id,
      action: "moved", payload: { fromListId: listB.id, toListId: listC.id },
      createdAt: new Date(now.getTime() - 20_000), updatedAt: new Date(now.getTime() - 20_000),
    },
    {
      boardId: board.id, workspaceId: workspace.id, actorId: owner.id, entityType: "card", entityId: card.id,
      action: "moved", payload: { fromListId: listC.id, toListId: listD.id },
      createdAt: new Date(now.getTime() - 10_000), updatedAt: new Date(now.getTime() - 10_000),
    },
  ]);

  const from = new Date(now.getTime() - DAY_MS / 2).toISOString();
  const to = new Date(now.getTime() + DAY_MS / 2).toISOString();
  const res = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/work-done?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { events } = res.json<{ events: WorkDoneEvent[] }>();
  assert.equal(events.length, 1, "three moves coalesce into one row");
  const moved = events[0]!;
  assert.equal(moved.type, "moved");
  // The row keeps the full journey across every list the card passed through.
  assert.deepEqual(moved.listPath, [todoList.id, listB.id, listC.id, listD.id]);
});
