import "../../test/setup.integration.js";
import { NOTIFICATION_REASON, boards, cards, eventOutbox, lists, notifications } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

// Emits are fire-and-forget (emitToBoard -> void publishRealtimeEvent), so the
// outbox rows land after the HTTP response. Poll until the expected count appears.
async function waitForBoardOutboxEvents(boardId: string, eventType: string, minCount: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await db
      .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(eq(eventOutbox.boardId, boardId))
      .orderBy(asc(eventOutbox.id));
    if (rows.filter((row) => row.eventType === eventType).length >= minCount) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db
    .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(eq(eventOutbox.boardId, boardId))
    .orderBy(asc(eventOutbox.id));
}

// Card order is workspace-list-scoped, so merging lists must thread one insertion
// cursor across boards. The pre-fix per-board logic minted overlapping positions
// (each board restarted from the target's own top), scrambling cross-board priority.
void test("merging a list threads one cursor so cross-board cards keep order without colliding", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Merge Lists",
      email: "owner-merge-lists@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  // Two boards share the workspace-scoped lists.
  const [boardA, boardB] = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "A", position: "1000.0000000000", visibility: "workspace" },
      { workspaceId: workspace.id, name: "B", position: "2000.0000000000", visibility: "workspace" },
    ])
    .returning();
  assert.ok(boardA);
  assert.ok(boardB);

  const [sourceList, targetList] = await db
    .insert(lists)
    .values([
      { workspaceId: workspace.id, name: "Source", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Target", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(sourceList);
  assert.ok(targetList);

  // Source list interleaves cards from both boards by position.
  await db.insert(cards).values([
    { listId: sourceList.id, boardId: boardA.id, title: "S-A1", position: "1000.0000000000", createdById: user.id },
    { listId: sourceList.id, boardId: boardB.id, title: "S-B1", position: "2000.0000000000", createdById: user.id },
    { listId: sourceList.id, boardId: boardA.id, title: "S-A2", position: "3000.0000000000", createdById: user.id },
  ]);
  // Target already holds a card; merged cards must land ahead of it without colliding.
  await db.insert(cards).values([
    { listId: targetList.id, boardId: boardB.id, title: "T-B1", position: "1000.0000000000", createdById: user.id },
  ]);

  const merged = await app.inject({
    method: "POST",
    url: `/lists/${sourceList.id}/cards/move`,
    headers: auth,
    payload: { targetListId: targetList.id },
  });
  assert.equal(merged.statusCode, 200);
  assert.deepEqual(merged.json(), { moved: 3 });

  const targetCards = await db
    .select({ boardId: cards.boardId, title: cards.title, position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, targetList.id), isNull(cards.archivedAt)))
    .orderBy(asc(cards.position));

  // Every position is unique within the list (no per-board collisions)...
  assert.equal(new Set(targetCards.map((c) => c.position)).size, targetCards.length);
  // ...the merged cards keep their cross-board source order and sit ahead of the
  // pre-existing target card.
  assert.deepEqual(targetCards.map((c) => c.title), ["S-A1", "S-B1", "S-A2", "T-B1"]);

  // Source list is emptied.
  const remaining = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.listId, sourceList.id), isNull(cards.archivedAt)));
  assert.equal(remaining.length, 0);

  // Each board only hears about its own cards' moves: two for board A, one for board B.
  const boardAEvents = await waitForBoardOutboxEvents(boardA.id, "card:moved", 2);
  const boardAMoves = boardAEvents.filter((row) => row.eventType === "card:moved");
  assert.equal(boardAMoves.length, 2);
  assert.ok(boardAMoves.every((row) => (row.payload as { toListId: string }).toListId === targetList.id));

  const boardBEvents = await waitForBoardOutboxEvents(boardB.id, "card:moved", 1);
  assert.equal(boardBEvents.filter((row) => row.eventType === "card:moved").length, 1);
});

void test("archiving every card in a list deletes only those cards' notifications", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: {
    orgName: "Acme List Archive Notifications", email: "owner-list-archive-notifications@example.com",
    password: "Abc12345", displayName: "Owner",
  } });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceResponse = await app.inject({
    method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" },
  });
  const workspace = workspaceResponse.json<{ id: string }>();
  const [sourceList, otherList] = await db.insert(lists).values([
    { workspaceId: workspace.id, name: "Source", position: "1000.0000000000" },
    { workspaceId: workspace.id, name: "Other", position: "2000.0000000000" },
  ]).returning();
  const [board] = await db.insert(boards).values({
    workspaceId: workspace.id, name: "Board", position: "1000.0000000000", visibility: "workspace",
  }).returning();
  assert.ok(sourceList && otherList && board);
  const [sourceCard, otherCard] = await db.insert(cards).values([
    { listId: sourceList.id, boardId: board.id, title: "Archive", position: "1000.0000000000", createdById: user.id },
    { listId: otherList.id, boardId: board.id, title: "Keep", position: "1000.0000000000", createdById: user.id },
  ]).returning();
  assert.ok(sourceCard && otherCard);
  await db.insert(notifications).values([
    { userId: user.id, cardId: sourceCard.id, listId: sourceList.id, boardId: board.id, workspaceId: workspace.id, reason: NOTIFICATION_REASON.ASSIGNED },
    { userId: user.id, cardId: otherCard.id, listId: otherList.id, boardId: board.id, workspaceId: workspace.id, reason: NOTIFICATION_REASON.ASSIGNED },
  ]);

  const archived = await app.inject({
    method: "PATCH", url: `/lists/${sourceList.id}/cards/archive`, headers: auth, payload: {},
  });
  assert.equal(archived.statusCode, 200);
  assert.equal(await db.$count(notifications, eq(notifications.cardId, sourceCard.id)), 0);
  assert.equal(await db.$count(notifications, eq(notifications.cardId, otherCard.id)), 1);
});
