import "../../test/setup.integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import type { PortfolioSummary, SavedWorkView, WorkCatalog, WorkQueryResponse } from "@kanera/shared/dto";
import {
  activityEvents,
  boardGroups,
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cardPriorities,
  cards,
  clients,
  customFields,
  globalWorkSeparators,
  lists,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { agentWorkQueryRoutes } from "./routes.js";

async function seed() {
  const app = await buildIntegrationServer();
  const [homeClient, externalClient] = await db.insert(clients).values([
    { name: "Home org" },
    { name: "Partner org" },
  ]).returning();
  const [viewer, teammate, colleague, partner] = await insertTestUsers(db, [
    { clientId: homeClient!.id, email: "viewer@work.test", passwordHash: "x", displayName: "Viewer", clientRole: "member" },
    { clientId: homeClient!.id, email: "teammate@work.test", passwordHash: "x", displayName: "Teammate", clientRole: "member" },
    { clientId: homeClient!.id, email: "colleague@work.test", passwordHash: "x", displayName: "No-board colleague", clientRole: "member" },
    { clientId: externalClient!.id, email: "partner@work.test", passwordHash: "x", displayName: "Partner", clientRole: "owner" },
  ]).returning();
  const [homeWorkspace, secondWorkspace, partnerWorkspace] = await db.insert(workspaces).values([
    { clientId: homeClient!.id, name: "Delivery" },
    { clientId: homeClient!.id, name: "Product", kind: "board" },
    { clientId: externalClient!.id, name: "Partner space" },
  ]).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: homeWorkspace!.id, userId: viewer!.id, role: "member" },
    { workspaceId: homeWorkspace!.id, userId: teammate!.id, role: "member" },
    { workspaceId: secondWorkspace!.id, userId: viewer!.id, role: "member" },
    { workspaceId: partnerWorkspace!.id, userId: partner!.id, role: "admin" },
  ]);
  const [homeList, secondList, partnerList] = await db.insert(lists).values([
    // Positions deliberately conflict across workspaces: catalog metadata must follow the sidebar's
    // workspace sequence before comparing positions within each workspace.
    { workspaceId: homeWorkspace!.id, name: "Doing", position: "3000.0000000000" },
    { workspaceId: secondWorkspace!.id, name: "Doing", position: "1000.0000000000" },
    { workspaceId: partnerWorkspace!.id, name: "Doing", position: "2000.0000000000" },
  ]).returning();
  await db.insert(cardLabels).values([
    { workspaceId: homeWorkspace!.id, name: "Home label", position: "3000.0000000000" },
    { workspaceId: secondWorkspace!.id, name: "Product label", position: "1000.0000000000" },
    { workspaceId: partnerWorkspace!.id, name: "Partner label", position: "2000.0000000000" },
  ]);
  await db.insert(customFields).values([
    { workspaceId: homeWorkspace!.id, name: "Home field", type: "text", position: "3000.0000000000" },
    { workspaceId: secondWorkspace!.id, name: "Product field", type: "text", position: "1000.0000000000" },
    { workspaceId: partnerWorkspace!.id, name: "Partner field", type: "text", position: "2000.0000000000" },
  ]);
  const [priorityBoardGroup] = await db.insert(boardGroups).values({
    workspaceId: homeWorkspace!.id,
    title: "Priority boards",
    position: "1000.0000000000",
  }).returning();
  const [sharedBoard, restrictedBoard, secondBoard, guestBoard, archivedBoard] = await db.insert(boards).values([
    { workspaceId: homeWorkspace!.id, name: "Shared", position: "1000.0000000000" },
    { workspaceId: homeWorkspace!.id, groupId: priorityBoardGroup!.id, name: "Restricted", position: "2000.0000000000" },
    { workspaceId: secondWorkspace!.id, name: "Standalone-like", position: "1000.0000000000" },
    { workspaceId: partnerWorkspace!.id, name: "Guest launch", position: "1000.0000000000" },
    { workspaceId: homeWorkspace!.id, name: "Archived secret", position: "3000.0000000000", archivedAt: new Date() },
  ]).returning();
  await db.insert(boardMembers).values([
    { boardId: sharedBoard!.id, userId: viewer!.id, role: "editor" },
    { boardId: sharedBoard!.id, userId: teammate!.id, role: "editor" },
    { boardId: restrictedBoard!.id, userId: viewer!.id, role: "observer", assignedItemsOnly: true },
    { boardId: restrictedBoard!.id, userId: teammate!.id, role: "editor" },
    { boardId: secondBoard!.id, userId: viewer!.id, role: "editor" },
    { boardId: guestBoard!.id, userId: viewer!.id, role: "observer" },
    { boardId: guestBoard!.id, userId: partner!.id, role: "editor" },
    { boardId: archivedBoard!.id, userId: viewer!.id, role: "editor" },
  ]);
  const [mine, teammateCard, restrictedMine, restrictedTeammate, otherWorkspaceMine, guestMine, archivedMine] =
    await db.insert(cards).values([
      { boardId: sharedBoard!.id, listId: homeList!.id, title: "My shared card", position: "1000.0000000000", createdById: viewer!.id, dueDateLocalDate: "2026-07-20", dueDateSlot: "anyTime", dueDateTimezone: "UTC" },
      { boardId: sharedBoard!.id, listId: homeList!.id, title: "Team shared card", position: "2000.0000000000", createdById: viewer!.id },
      { boardId: restrictedBoard!.id, listId: homeList!.id, title: "My restricted card", position: "1000.0000000000", createdById: teammate!.id },
      { boardId: restrictedBoard!.id, listId: homeList!.id, title: "Hidden restricted team card", position: "2000.0000000000", createdById: teammate!.id },
      { boardId: secondBoard!.id, listId: secondList!.id, title: "My product card", position: "1000.0000000000", createdById: viewer!.id },
      { boardId: guestBoard!.id, listId: partnerList!.id, title: "My guest card", position: "1000.0000000000", createdById: partner!.id },
      { boardId: archivedBoard!.id, listId: homeList!.id, title: "Archived source card", position: "1000.0000000000", createdById: viewer!.id },
    ]).returning();
  await db.insert(cardAssignees).values([
    { cardId: mine!.id, userId: viewer!.id },
    { cardId: teammateCard!.id, userId: teammate!.id },
    { cardId: restrictedMine!.id, userId: viewer!.id },
    { cardId: restrictedTeammate!.id, userId: teammate!.id },
    { cardId: otherWorkspaceMine!.id, userId: viewer!.id },
    { cardId: guestMine!.id, userId: viewer!.id },
    { cardId: archivedMine!.id, userId: viewer!.id },
  ]);
  const [viewerSeparator, teammateSeparator] = await db.insert(globalWorkSeparators).values([
    {
      workspaceId: homeWorkspace!.id,
      targetUserId: viewer!.id,
      listId: homeList!.id,
      title: "Viewer focus",
      position: "1500.0000000000",
      createdById: viewer!.id,
    },
    {
      workspaceId: homeWorkspace!.id,
      targetUserId: teammate!.id,
      listId: homeList!.id,
      title: "Private teammate focus",
      position: "2500.0000000000",
      createdById: teammate!.id,
    },
  ]).returning();
  const viewerToken = app.jwt.sign({ sub: viewer!.id, cid: homeClient!.id, role: "member" });
  const teammateToken = app.jwt.sign({ sub: teammate!.id, cid: homeClient!.id, role: "member" });
  return {
    app,
    viewer: viewer!,
    teammate: teammate!,
    colleague: colleague!,
    viewerToken,
    teammateToken,
    homeClient: homeClient!,
    homeWorkspace: homeWorkspace!,
    sharedBoard: sharedBoard!,
    restrictedBoard: restrictedBoard!,
    secondBoard: secondBoard!,
    guestBoard: guestBoard!,
    archivedBoard: archivedBoard!,
    homeList: homeList!,
    secondList: secondList!,
    mine: mine!,
    teammateCard: teammateCard!,
    otherWorkspaceMine: otherWorkspaceMine!,
    restrictedMine: restrictedMine!,
    restrictedTeammate: restrictedTeammate!,
    viewerSeparator: viewerSeparator!,
    teammateSeparator: teammateSeparator!,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

void test("global catalog includes guest sources but omits archived and inaccessible metadata", async () => {
  const f = await seed();
  const response = await f.app.inject({ method: "GET", url: "/work/catalog", headers: auth(f.viewerToken) });
  assert.equal(response.statusCode, 200);
  const body = response.json<WorkCatalog>();
  assert.deepEqual(body.boards.map((board) => board.name).sort(), ["Guest launch", "Restricted", "Shared", "Standalone-like"]);
  assert.deepEqual(
    body.boards.map((board) => board.name),
    ["Restricted", "Shared", "Standalone-like", "Guest launch"],
  );
  assert.deepEqual(
    body.workspaces.map((workspace) => workspace.id),
    [f.sharedBoard.workspaceId, f.secondBoard.workspaceId, f.guestBoard.workspaceId],
  );
  const expectedWorkspaceOrder = [
    f.sharedBoard.workspaceId,
    f.secondBoard.workspaceId,
    f.guestBoard.workspaceId,
  ];
  assert.deepEqual(body.lists.map((list) => list.workspaceId), expectedWorkspaceOrder);
  assert.deepEqual(body.labels.map((label) => label.workspaceId), expectedWorkspaceOrder);
  assert.deepEqual(body.customFields.map((field) => field.workspaceId), expectedWorkspaceOrder);
  assert.equal(body.boards.find((board) => board.id === f.restrictedBoard.id)?.assignedItemsOnly, true);
  assert.equal(body.boards.find((board) => board.id === f.guestBoard.id)?.viewerRole, "observer");
  assert.equal(body.workspaces.find((workspace) => workspace.id === f.secondBoard.workspaceId)?.kind, "board");
  assert.ok(body.organisations.some((organisation) => organisation.name === "Partner org" && organisation.external));
  assert.ok(!JSON.stringify(body).includes("Archived secret"));

  const candidates = await f.app.inject({
    method: "GET",
    url: "/work-views/share-candidates",
    headers: auth(f.viewerToken),
  });
  assert.equal(candidates.statusCode, 200);
  assert.ok(candidates.json<Array<{ userId: string }>>().some((user) => user.userId === f.colleague.id));
  assert.ok(!body.people.some((person) => person.userId === f.colleague.id));
});

void test("my and team lenses enforce authentication targets and assigned-item restrictions", async () => {
  const f = await seed();
  const my = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", filters: { assigneeIds: [f.teammate.id] }, limit: 100 },
  });
  assert.equal(my.statusCode, 200);
  assert.deepEqual(
    my.json<WorkQueryResponse>().cards.map((card) => card.title).sort(),
    ["My guest card", "My product card", "My restricted card", "My shared card"],
  );
  assert.deepEqual(my.json<WorkQueryResponse>().separators.map((separator) => separator.title), ["Viewer focus"]);
  assert.ok(my.json<WorkQueryResponse>().separatorWorkspaceIds.includes(f.homeWorkspace.id));

  const team = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "team", limit: 100 },
  });
  assert.equal(team.statusCode, 200);
  assert.deepEqual(team.json<WorkQueryResponse>().cards.map((card) => card.title), ["Team shared card"]);
  assert.deepEqual(team.json<WorkQueryResponse>().separators, []);
  assert.deepEqual(team.json<WorkQueryResponse>().separatorWorkspaceIds, []);
});

void test("Global Work separators organise one person's merged lane without becoming board separators", async () => {
  const f = await seed();
  const createdResponse = await f.app.inject({
    method: "POST",
    url: `/work/workspaces/${f.homeWorkspace.id}/users/${f.viewer.id}/lists/${f.homeList.id}/separators`,
    headers: auth(f.viewerToken),
    payload: { title: "Now", atTop: true },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json<{ id: string; position: string; targetUserId: string }>();
  assert.equal(created.targetUserId, f.viewer.id);

  const movedCardResponse = await f.app.inject({
    method: "POST",
    url: `/cards/${f.mine.id}/move`,
    headers: auth(f.viewerToken),
    payload: {
      listId: f.homeList.id,
      afterItem: { type: "separator", id: created.id },
      globalWorkUserId: f.viewer.id,
    },
  });
  assert.equal(movedCardResponse.statusCode, 200);
  assert.ok(Number(movedCardResponse.json<{ position: string }>().position) > Number(created.position));

  const forbiddenTeamCreate = await f.app.inject({
    method: "POST",
    url: `/work/workspaces/${f.homeWorkspace.id}/users/${f.teammate.id}/lists/${f.homeList.id}/separators`,
    headers: auth(f.viewerToken),
    payload: { title: "Not mine" },
  });
  assert.equal(forbiddenTeamCreate.statusCode, 403);

  const deletedResponse = await f.app.inject({
    method: "DELETE",
    url: `/global-work-separators/${created.id}`,
    headers: auth(f.viewerToken),
  });
  assert.equal(deletedResponse.statusCode, 204);
});

void test("my lens keeps recently completed cards and hides them only when asked", async () => {
  const f = await seed();
  const day = 24 * 60 * 60 * 1000;
  // "My shared card" was completed today; "My product card" long past any workspace window.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.mine.id));
  await db.update(cards)
    .set({ completedAt: new Date(Date.now() - 400 * day) })
    .where(eq(cards.id, f.otherWorkspaceMine.id));

  // Default filters: completing a card must not make it vanish, matching a board's active view.
  const defaults = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", limit: 100 },
  });
  assert.equal(defaults.statusCode, 200);
  const shown = defaults.json<WorkQueryResponse>();
  assert.deepEqual(
    shown.cards.map((card) => card.title).sort(),
    ["My guest card", "My restricted card", "My shared card"],
  );
  assert.equal(shown.totals.completed, 1);

  const hidden = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", filters: { completion: "active" }, limit: 100 },
  });
  assert.equal(hidden.statusCode, 200);
  assert.deepEqual(
    hidden.json<WorkQueryResponse>().cards.map((card) => card.title).sort(),
    ["My guest card", "My restricted card"],
  );
});

void test("global work-done preserves My and Team actor semantics across restricted sources", async () => {
  const f = await seed();
  const now = new Date();
  await db.insert(activityEvents).values([
    {
      boardId: f.sharedBoard.id,
      workspaceId: f.sharedBoard.workspaceId,
      actorId: f.viewer.id,
      entityType: "card",
      entityId: f.mine.id,
      action: "created",
      payload: { listId: f.mine.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.sharedBoard.id,
      workspaceId: f.sharedBoard.workspaceId,
      actorId: f.teammate.id,
      entityType: "card",
      entityId: f.teammateCard.id,
      action: "created",
      payload: { listId: f.teammateCard.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.restrictedBoard.id,
      workspaceId: f.restrictedBoard.workspaceId,
      actorId: f.teammate.id,
      entityType: "card",
      entityId: f.restrictedMine.id,
      action: "created",
      payload: { listId: f.restrictedMine.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.restrictedBoard.id,
      workspaceId: f.restrictedBoard.workspaceId,
      actorId: f.teammate.id,
      entityType: "card",
      entityId: f.restrictedTeammate.id,
      action: "created",
      payload: { listId: f.restrictedTeammate.listId },
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const range = {
    from: new Date(now.getTime() - 60_000).toISOString(),
    to: new Date(now.getTime() + 60_000).toISOString(),
  };

  const my = await f.app.inject({
    method: "POST",
    url: "/work/work-done/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", ...range },
  });
  assert.equal(my.statusCode, 200);
  assert.deepEqual(
    my.json<{ events: Array<{ card: { title: string } }> }>().events.map((event) => event.card.title),
    ["My shared card"],
  );

  const team = await f.app.inject({
    method: "POST",
    url: "/work/work-done/query",
    headers: auth(f.viewerToken),
    payload: { lens: "team", filters: { assigneeIds: [f.teammate.id] }, ...range },
  });
  assert.equal(team.statusCode, 200);
  assert.deepEqual(
    team.json<{ events: Array<{ card: { title: string } }> }>().events.map((event) => event.card.title).sort(),
    ["My restricted card", "Team shared card"],
  );
});

void test("agent work routes return the connected user's cross-board history and current work", async () => {
  const f = await seed();
  const now = new Date();
  await db.insert(activityEvents).values([
    {
      boardId: f.sharedBoard.id,
      workspaceId: f.sharedBoard.workspaceId,
      actorId: f.viewer.id,
      entityType: "card",
      entityId: f.mine.id,
      action: "created",
      payload: { listId: f.mine.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.secondBoard.id,
      workspaceId: f.secondBoard.workspaceId,
      actorId: f.viewer.id,
      entityType: "card",
      entityId: f.otherWorkspaceMine.id,
      action: "created",
      payload: { listId: f.otherWorkspaceMine.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.sharedBoard.id,
      workspaceId: f.sharedBoard.workspaceId,
      actorId: f.teammate.id,
      entityType: "card",
      entityId: f.teammateCard.id,
      action: "created",
      payload: { listId: f.teammateCard.listId },
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const range = {
    from: new Date(now.getTime() - 60_000).toISOString(),
    to: new Date(now.getTime() + 60_000).toISOString(),
  };

  const first = await f.app.inject({
    method: "POST",
    url: "/me/work-history",
    headers: auth(f.viewerToken),
    payload: { ...range, limit: 1 },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json<{
    summary: { totalEvents: number; cardsTouched: number };
    events: Array<{ card: { title: string; url: string } }>;
    sources: { boards: Array<{ name: string }> };
    nextCursor: string | null;
  }>();
  assert.equal(firstBody.summary.totalEvents, 2);
  assert.equal(firstBody.summary.cardsTouched, 2);
  assert.equal(firstBody.events.length, 1);
  assert.match(firstBody.events[0]!.card.url, /^http/);
  assert.ok(firstBody.nextCursor);

  const second = await f.app.inject({
    method: "POST",
    url: "/me/work-history",
    headers: auth(f.viewerToken),
    payload: { ...range, limit: 1, cursor: firstBody.nextCursor },
  });
  assert.equal(second.statusCode, 200);
  const historyTitles = [
    firstBody.events[0]!.card.title,
    second.json<{ events: Array<{ card: { title: string } }>; nextCursor: null }>().events[0]!.card.title,
  ].sort();
  assert.deepEqual(historyTitles, ["My product card", "My shared card"]);

  const current = await f.app.inject({
    method: "POST",
    url: "/me/current-work",
    headers: auth(f.viewerToken),
    payload: { limit: 100 },
  });
  assert.equal(current.statusCode, 200);
  const currentBody = current.json<{
    cards: Array<{ title: string; url: string }>;
    sources: { boards: Array<{ name: string }> };
  }>();
  assert.deepEqual(currentBody.cards.map((card) => card.title).sort(), [
    "My guest card",
    "My product card",
    "My restricted card",
    "My shared card",
  ]);
  assert.ok(currentBody.cards.every((card) => card.url.startsWith("http")));
  assert.ok(currentBody.sources.boards.some((board) => board.name === "Guest launch"));
});

void test("agent work queries review one visible person across a workspace without leaking other actors", async () => {
  const f = await seed();
  await f.app.register(agentWorkQueryRoutes, { prefix: "/agent-public" });
  const now = new Date();
  await db.insert(activityEvents).values([
    {
      boardId: f.sharedBoard.id,
      workspaceId: f.sharedBoard.workspaceId,
      actorId: f.teammate.id,
      entityType: "card",
      entityId: f.teammateCard.id,
      action: "created",
      payload: { listId: f.teammateCard.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.sharedBoard.id,
      workspaceId: f.sharedBoard.workspaceId,
      actorId: f.viewer.id,
      entityType: "card",
      entityId: f.teammateCard.id,
      action: "moved",
      payload: { fromListId: f.homeList.id, toListId: f.homeList.id },
      createdAt: new Date(now.getTime() + 1),
      updatedAt: new Date(now.getTime() + 1),
    },
    {
      boardId: f.restrictedBoard.id,
      workspaceId: f.restrictedBoard.workspaceId,
      actorId: f.teammate.id,
      entityType: "card",
      entityId: f.restrictedTeammate.id,
      action: "created",
      payload: { listId: f.restrictedTeammate.listId },
      createdAt: new Date(now.getTime() + 2),
      updatedAt: new Date(now.getTime() + 2),
    },
  ]);
  const range = {
    from: new Date(now.getTime() - 60_000).toISOString(),
    to: new Date(now.getTime() + 60_000).toISOString(),
  };
  const scope = { allAccessible: false, workspaceIds: [f.homeWorkspace.id] };

  const history = await f.app.inject({
    method: "POST",
    url: "/work/history/query",
    headers: auth(f.viewerToken),
    payload: { userId: f.teammate.id, scope, ...range },
  });
  assert.equal(history.statusCode, 200, history.body);
  const historyBody = history.json<{
    actor: { userId: string; displayName: string };
    summary: { totalEvents: number };
    events: Array<{ actorUserId?: string; completedByUserId?: string; card: { title: string; url: string } }>;
    sources: { boards: Array<{ id: string; url: string }> };
  }>();
  assert.deepEqual(historyBody.actor, { userId: f.teammate.id, displayName: "Teammate" });
  assert.equal(historyBody.summary.totalEvents, 1);
  assert.deepEqual(historyBody.events.map((event) => event.card.title), ["Team shared card"]);
  assert.ok(historyBody.events.every((event) => (event.actorUserId ?? event.completedByUserId) === f.teammate.id));
  assert.ok(historyBody.events[0]!.card.url.startsWith("http"));
  assert.ok(historyBody.sources.boards[0]!.url.startsWith("http"));

  const active = await f.app.inject({
    method: "POST",
    url: "/agent-public/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "team", scope, filters: { assigneeIds: [f.teammate.id], completion: "active" } },
  });
  assert.equal(active.statusCode, 200, active.body);
  const activeBody = active.json<{
    cards: Array<{ title: string; url: string }>;
    sources: { boards: Array<{ url: string }> };
  }>();
  assert.deepEqual(activeBody.cards.map((card) => card.title), ["Team shared card"]);
  assert.ok(activeBody.cards[0]!.url.startsWith("http"));
  assert.ok(activeBody.sources.boards[0]!.url.startsWith("http"));

  const invisible = await f.app.inject({
    method: "POST",
    url: "/work/history/query",
    headers: auth(f.viewerToken),
    payload: { userId: f.colleague.id, scope, ...range },
  });
  assert.equal(invisible.statusCode, 403, invisible.body);
});

void test("native list, label, and custom-field filters remain workspace-qualified with duplicate names", async () => {
  const f = await seed();
  const response = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", filters: { listIds: [f.secondList.id] }, limit: 100 },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json<WorkQueryResponse>().cards.map((card) => card.title), ["My product card"]);

  const productWorkspaceId = f.secondBoard.workspaceId;
  const [homeLabel, productLabel] = await db.insert(cardLabels).values([
    { workspaceId: f.sharedBoard.workspaceId, name: "Risk", position: "1000.0000000000" },
    { workspaceId: productWorkspaceId, name: "Risk", position: "1000.0000000000" },
  ]).returning();
  const allCards = await db.select().from(cards);
  const sharedCard = allCards.find((card) => card.title === "My shared card")!;
  const productCard = allCards.find((card) => card.title === "My product card")!;
  await db.insert(cardLabelAssignments).values([
    { cardId: sharedCard.id, labelId: homeLabel!.id },
    { cardId: productCard.id, labelId: productLabel!.id },
  ]);
  const labelResponse = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", filters: { labelIds: [productLabel!.id] }, limit: 100 },
  });
  assert.deepEqual(labelResponse.json<WorkQueryResponse>().cards.map((card) => card.title), ["My product card"]);

  const [homeField, productField] = await db.insert(customFields).values([
    { workspaceId: f.sharedBoard.workspaceId, name: "Signal", type: "text", position: "1000.0000000000" },
    { workspaceId: productWorkspaceId, name: "Signal", type: "text", position: "1000.0000000000" },
  ]).returning();
  await db.insert(cardCustomFieldValues).values([
    { cardId: sharedCard.id, fieldId: homeField!.id, valueText: "match" },
    { cardId: productCard.id, fieldId: productField!.id, valueText: "match" },
  ]);
  const fieldResponse = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: {
      lens: "my",
      filters: {
        customFieldConditions: [{
          workspaceId: productWorkspaceId,
          fieldId: productField!.id,
          op: "contains",
          value: "match",
        }],
      },
      limit: 100,
    },
  });
  assert.deepEqual(fieldResponse.json<WorkQueryResponse>().cards.map((card) => card.title), ["My product card"]);
});

void test("the Up next filter returns only cards in the signed-in viewer's queue", async () => {
  const f = await seed();
  await db.insert(cardPriorities).values({
    targetUserId: f.viewer.id,
    cardId: f.otherWorkspaceMine.id,
    position: "1000.0000000000",
    createdById: f.viewer.id,
  });

  const response = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", filters: { prioritySetOnly: true }, limit: 100 },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json<WorkQueryResponse>().cards.map((item) => item.title), ["My product card"]);
});

void test("assigned checklist items obey the same card filters as the cards beside them", async () => {
  const f = await seed();
  const [sharedChecklist, productChecklist, teamChecklist] = await db.insert(cardChecklists).values([
    { cardId: f.mine.id, title: "Steps", position: "1000.0000000000" },
    { cardId: f.otherWorkspaceMine.id, title: "Steps", position: "1000.0000000000" },
    { cardId: f.teammateCard.id, title: "Steps", position: "1000.0000000000" },
  ]).returning();
  await db.insert(cardChecklistItems).values([
    { checklistId: sharedChecklist!.id, text: "Draft the brief", position: "1000.0000000000", assigneeId: f.viewer.id },
    { checklistId: productChecklist!.id, text: "Ship the build", position: "1000.0000000000", assigneeId: f.viewer.id },
    { checklistId: teamChecklist!.id, text: "Teammate task", position: "1000.0000000000", assigneeId: f.teammate.id },
  ]);

  const items = async (payload: Record<string, unknown>) => {
    const response = await f.app.inject({
      method: "POST",
      url: "/work/cards/query",
      headers: auth(f.viewerToken),
      payload: { limit: 100, ...payload },
    });
    assert.equal(response.statusCode, 200);
    return response.json<WorkQueryResponse>().checklistItems.map((item) => item.text).sort();
  };

  assert.deepEqual(await items({ lens: "my" }), ["Draft the brief", "Ship the build"]);

  // A list filter selects cards, and an item inherits its card's list.
  assert.deepEqual(await items({ lens: "my", filters: { listIds: [f.secondList.id] } }), ["Ship the build"]);

  // A label lives on the card, so filtering by it must drop items whose card lacks the label.
  const [risk] = await db.insert(cardLabels).values({
    workspaceId: f.sharedBoard.workspaceId,
    name: "Risk",
    position: "1000.0000000000",
  }).returning();
  await db.insert(cardLabelAssignments).values({ cardId: f.mine.id, labelId: risk!.id });
  assert.deepEqual(await items({ lens: "my", filters: { labelIds: [risk!.id] } }), ["Draft the brief"]);

  // Hiding completed work hides open items sitting on a completed card too.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.otherWorkspaceMine.id));
  assert.deepEqual(await items({ lens: "my", filters: { completion: "active" } }), ["Draft the brief"]);
  assert.deepEqual(await items({ lens: "my" }), ["Draft the brief", "Ship the build"]);

  // Team Cards lists items only for the teammate in focus; across all teammates it stays empty.
  assert.deepEqual(await items({ lens: "team", filters: { assigneeIds: [f.teammate.id] } }), ["Teammate task"]);
  assert.deepEqual(await items({ lens: "team" }), []);
});

void test("opaque cursors page every supported sort without duplicates during concurrent changes", async () => {
  const f = await seed();
  const sorts = ["dueAsc", "dueDesc", "titleAsc", "titleDesc", "createdAsc", "createdDesc", "updatedAsc", "updatedDesc"] as const;
  for (const sort of sorts) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await f.app.inject({
        method: "POST",
        url: "/work/cards/query",
        headers: auth(f.viewerToken),
        payload: { lens: "my", sort, limit: 2, ...(cursor ? { cursor } : {}) },
      });
      assert.equal(response.statusCode, 200);
      const page = response.json<WorkQueryResponse>();
      ids.push(...page.cards.map((card) => card.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, ids.length);
  }

  const firstResponse = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", sort: "dueAsc", limit: 1 },
  });
  const first = firstResponse.json<WorkQueryResponse>();
  assert.ok(first.nextCursor);
  const cardsOnlyResponse = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", sort: "dueAsc", limit: 1, cursor: first.nextCursor, includeMetadata: false },
  });
  assert.equal(cardsOnlyResponse.statusCode, 200);
  const cardsOnly = cardsOnlyResponse.json<WorkQueryResponse>();
  assert.equal(cardsOnly.cards.length, 1);
  assert.deepEqual(cardsOnly.checklistItems, []);
  assert.deepEqual(cardsOnly.separators, []);
  assert.deepEqual(cardsOnly.separatorWorkspaceIds, []);
  assert.deepEqual(cardsOnly.totals, {
    cards: 0,
    overdue: 0,
    dueSoon: 0,
    completed: 0,
    checklistItems: 0,
    overdueChecklistItems: 0,
  });
  const unseen = (await db.select().from(cards)).find((card) =>
    card.title === "My product card"
  )!;
  await db.update(cards).set({
    dueDateLocalDate: "2020-01-01",
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
  }).where(eq(cards.id, unseen.id));
  const [newCard] = await db.insert(cards).values({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: "Created between pages",
    position: "9000.0000000000",
    createdById: f.viewer.id,
  }).returning();
  await db.insert(cardAssignees).values({ cardId: newCard!.id, userId: f.viewer.id });

  const pagedIds = [...first.cards.map((card) => card.id)];
  let cursor: string | undefined = first.nextCursor ?? undefined;
  while (cursor) {
    const response: Awaited<ReturnType<typeof f.app.inject>> = await f.app.inject({
      method: "POST",
      url: "/work/cards/query",
      headers: auth(f.viewerToken),
      payload: { lens: "my", sort: "dueAsc", limit: 1, cursor },
    });
    const page = response.json() as WorkQueryResponse;
    pagedIds.push(...page.cards.map((card) => card.id));
    cursor = page.nextCursor ?? undefined;
  }
  assert.equal(new Set(pagedIds).size, 4);
  assert.ok(pagedIds.includes(unseen.id));
  assert.ok(!pagedIds.includes(newCard!.id));

  const invalid = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: { lens: "my", cursor: "not-a-cursor" },
  });
  assert.equal(invalid.statusCode, 400);
});

void test("portfolio summaries match access-filtered card drill-downs", async () => {
  const f = await seed();
  const summaryResponse = await f.app.inject({
    method: "POST",
    url: "/work/portfolio/query",
    headers: auth(f.viewerToken),
    payload: { days: 30 },
  });
  assert.equal(summaryResponse.statusCode, 200);
  const summary = summaryResponse.json<PortfolioSummary>();
  assert.equal(summary.days, 30);
  assert.equal(summary.totals.cards, 5);
  assert.deepEqual(
    summary.buckets.map((bucket) => bucket.boardName),
    ["Restricted", "Shared", "Standalone-like", "Guest launch"],
  );
  assert.ok(!summary.buckets.some((bucket) => bucket.boardId === f.archivedBoard.id));

  const restricted = summary.buckets.find((bucket) => bucket.boardId === f.restrictedBoard.id);
  assert.equal(restricted?.active, 1);
  const drillDown = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.viewerToken),
    payload: {
      lens: "portfolio",
      scope: { allAccessible: false, workspaceIds: [], boardIds: [f.restrictedBoard.id] },
      limit: 100,
    },
  });
  assert.equal(drillDown.statusCode, 200);
  assert.deepEqual(drillDown.json<WorkQueryResponse>().cards.map((card) => card.title), ["My restricted card"]);
});

void test("portfolio activity heatmaps split movement from delivery inside the fixed window", async () => {
  const f = await seed();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ancient = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const event = (
    cardId: string,
    boardId: string,
    workspaceId: string,
    action: string,
    createdAt: Date,
    extra: { feedVisible?: boolean; payload?: Record<string, unknown> } = {},
  ) => ({
    boardId,
    workspaceId,
    actorId: f.viewer.id,
    entityType: "card",
    entityId: cardId,
    action,
    payload: extra.payload ?? {},
    feedVisible: extra.feedVisible ?? true,
    createdAt,
    updatedAt: createdAt,
  });
  const shared = (cardId: string, action: string, createdAt: Date, extra?: { feedVisible?: boolean; payload?: Record<string, unknown> }) =>
    event(cardId, f.sharedBoard.id, f.sharedBoard.workspaceId, action, createdAt, extra);
  await db.insert(activityEvents).values([
    shared(f.mine.id, "moved", now),
    shared(f.teammateCard.id, "moved", now),
    shared(f.mine.id, "moved", yesterday),
    // Completion is written two ways; both count, and an un-completion never reads as delivery.
    shared(f.mine.id, "completed", now),
    shared(f.teammateCard.id, "completion:set", now, { payload: { toValue: true } }),
    shared(f.teammateCard.id, "completion:set", now, { payload: { toValue: false } }),
    // Coalesced/suppressed rows are hidden from the card feed, so they must not colour a square.
    shared(f.mine.id, "moved", yesterday, { feedVisible: false }),
    // Outside the fixed 60-day window.
    shared(f.mine.id, "moved", ancient),
    // Restricted board: the viewer may see restrictedMine but not restrictedTeammate, so only the
    // first may contribute — otherwise the grid leaks the volume of hidden work.
    event(f.restrictedMine.id, f.restrictedBoard.id, f.restrictedBoard.workspaceId, "moved", now),
    event(f.restrictedTeammate.id, f.restrictedBoard.id, f.restrictedBoard.workspaceId, "moved", now),
  ]);

  const response = await f.app.inject({
    method: "POST",
    url: "/work/portfolio/query",
    headers: auth(f.viewerToken),
    payload: { days: 30, timeZone: "UTC" },
  });
  assert.equal(response.statusCode, 200);
  const summary = response.json<PortfolioSummary>();
  assert.equal(summary.activityDays, 60);

  const day = (date: Date) => date.toISOString().slice(0, 10);
  const byDate = new Map(summary.activity.map((entry) => [entry.date, entry]));
  assert.deepEqual(byDate.get(day(now)), { date: day(now), moved: 3, completed: 2 });
  assert.deepEqual(byDate.get(day(yesterday)), { date: day(yesterday), moved: 1, completed: 0 });
  assert.equal(byDate.get(day(ancient)), undefined);

  // The strips report on the same cards as the buckets beside them, so a portfolio filter narrows
  // them too — here down to the single matching card's own activity.
  const filtered = await f.app.inject({
    method: "POST",
    url: "/work/portfolio/query",
    headers: auth(f.viewerToken),
    payload: { days: 30, timeZone: "UTC", filters: { q: "My shared card" } },
  });
  assert.equal(filtered.statusCode, 200);
  const filteredByDate = new Map(
    filtered.json<PortfolioSummary>().activity.map((entry) => [entry.date, entry]),
  );
  assert.deepEqual(filteredByDate.get(day(now)), { date: day(now), moved: 1, completed: 1 });
  assert.deepEqual(filteredByDate.get(day(yesterday)), { date: day(yesterday), moved: 1, completed: 0 });
});

void test("saved views are private by default, share read-only, and strip unavailable sources", async () => {
  const f = await seed();
  const [hoursField] = await db.insert(customFields).values({
    workspaceId: f.sharedBoard.workspaceId,
    name: "Hours",
    type: "number",
    position: "9000.0000000000",
  }).returning();
  const createdResponse = await f.app.inject({
    method: "POST",
    url: "/work-views",
    headers: auth(f.viewerToken),
    payload: {
      name: "Guest delivery",
      lens: "my",
      definition: {
        scope: { allAccessible: false, workspaceIds: [], boardIds: [f.guestBoard.id, f.sharedBoard.id] },
        filters: {},
        groupBy: "board",
        collapsedWorkspaceIds: [f.guestBoard.workspaceId, f.sharedBoard.workspaceId],
        collapsedSectionIds: [f.guestBoard.id, f.sharedBoard.id],
        table: {
          columnVisibility: { labels: true, [`cf:${hoursField!.id}`]: true },
          columnOrder: ["board", `cf:${hoursField!.id}`, "due"],
          columnWidths: { title: 360, [`cf:${hoursField!.id}`]: 180 },
          aggregates: { [hoursField!.id]: ["sum"] },
          aggregateSplitBy: "board",
          collapsedGroupKeys: [`board:${f.guestBoard.id}`, `board:${f.sharedBoard.id}`],
        },
      },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json<SavedWorkView>();
  assert.equal(created.visibility, "private");
  assert.deepEqual(created.definition.collapsedWorkspaceIds, [
    f.guestBoard.workspaceId,
    f.sharedBoard.workspaceId,
  ]);
  assert.deepEqual(created.definition.collapsedSectionIds, [f.guestBoard.id, f.sharedBoard.id]);
  assert.deepEqual(created.definition.table, {
    columnVisibility: { labels: true, [`cf:${hoursField!.id}`]: true },
    columnOrder: ["board", `cf:${hoursField!.id}`, "due"],
    columnWidths: { title: 360, [`cf:${hoursField!.id}`]: 180 },
    aggregates: { [hoursField!.id]: ["sum"] },
    aggregateSplitBy: "board",
    collapsedGroupKeys: [`board:${f.guestBoard.id}`, `board:${f.sharedBoard.id}`],
  });

  const privateList = await f.app.inject({ method: "GET", url: "/work-views", headers: auth(f.teammateToken) });
  assert.deepEqual(privateList.json<SavedWorkView[]>(), []);

  const share = await f.app.inject({
    method: "POST",
    url: `/work-views/${created.id}/shares`,
    headers: auth(f.viewerToken),
    payload: { userId: f.teammate.id },
  });
  assert.equal(share.statusCode, 204);
  const sharedList = await f.app.inject({ method: "GET", url: "/work-views", headers: auth(f.teammateToken) });
  assert.equal(sharedList.statusCode, 200);
  const shared = sharedList.json<SavedWorkView[]>()[0]!;
  assert.equal(shared.editable, false);
  assert.deepEqual(shared.definition.scope.boardIds, [f.sharedBoard.id]);
  assert.deepEqual(shared.definition.collapsedWorkspaceIds, [f.sharedBoard.workspaceId]);
  assert.deepEqual(shared.definition.collapsedSectionIds, [f.sharedBoard.id]);
  assert.deepEqual(shared.definition.table.collapsedGroupKeys, [`board:${f.sharedBoard.id}`]);
  assert.deepEqual(shared.definition.table.aggregates, { [hoursField!.id]: ["sum"] });

  await db.delete(boardMembers).where(and(
    eq(boardMembers.boardId, f.guestBoard.id),
    eq(boardMembers.userId, f.viewer.id),
  ));
  const ownerAfterRevocation = await f.app.inject({ method: "GET", url: "/work-views", headers: auth(f.viewerToken) });
  assert.deepEqual(ownerAfterRevocation.json<SavedWorkView[]>()[0]?.definition.scope.boardIds, [f.sharedBoard.id]);
  assert.deepEqual(
    ownerAfterRevocation.json<SavedWorkView[]>()[0]?.definition.collapsedWorkspaceIds,
    [f.sharedBoard.workspaceId],
  );
  assert.deepEqual(
    ownerAfterRevocation.json<SavedWorkView[]>()[0]?.definition.collapsedSectionIds,
    [f.sharedBoard.id],
  );
  const catalogAfterRevocation = await f.app.inject({ method: "GET", url: "/work/catalog", headers: auth(f.viewerToken) });
  assert.ok(!JSON.stringify(catalogAfterRevocation.json()).includes("Guest launch"));

  const forbiddenUpdate = await f.app.inject({
    method: "PATCH",
    url: `/work-views/${created.id}`,
    headers: auth(f.teammateToken),
    payload: { name: "Hijacked" },
  });
  assert.equal(forbiddenUpdate.statusCode, 403);
});
