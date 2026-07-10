import "../../test/setup.integration.js";
import {
  activityEvents,
  assignedWorkSeparators,
  boardMembers,
  boardSeparators,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  comments,
  customFields,
  lists,
  users,
  workspaceMembers,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

type Fixture = Awaited<ReturnType<typeof seed>>;

interface WorkDoneEvent {
  type: "created" | "moved" | "completed" | "checklistItemCompleted";
  card: { id: string };
  actorUserId?: string | null;
  itemId?: string;
  completedByUserId?: string | null;
}
interface WorkDoneBody {
  events: WorkDoneEvent[];
}

async function seed() {
  const app = await buildIntegrationServer();

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

  // Insert extra workspace members directly.
  const [memberRow] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "member@example.com",
      passwordHash: "x",
      displayName: "Member",
    })
    .returning();
  const [observerRow] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "observer@example.com",
      passwordHash: "x",
      displayName: "Observer",
    })
    .returning();
  // Both are plain workspace members; board access (and the editor/observer distinction) lives on
  // the board_member rows below.
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: memberRow!.id, role: "member" },
    { workspaceId: workspace.id, userId: observerRow!.id, role: "member" },
  ]);

  const memberToken = app.jwt.sign({ sub: memberRow!.id, cid: owner.clientId, role: "member" });
  const observerToken = app.jwt.sign({ sub: observerRow!.id, cid: owner.clientId, role: "member" });

  // Lists are auto-created by workspace; grab the first list.
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  // Board membership is the access model. Both the member and observer belong to the shared board;
  // only the member belongs to the restricted one, so the observer cannot see its cards.
  const [publicBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Public", position: "1000.0000000000" })
    .returning();
  const [privateBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Private", position: "2000.0000000000" })
    .returning();
  await db.insert(boardMembers).values([
    { boardId: publicBoard!.id, userId: memberRow!.id, role: "editor" },
    { boardId: publicBoard!.id, userId: observerRow!.id, role: "observer" },
    { boardId: privateBoard!.id, userId: memberRow!.id, role: "editor" },
  ]);

  // Cards: one on each board assigned to the member, plus one unassigned on the public board.
  const [publicCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: publicBoard!.id, title: "Public task", position: "1000.0000000000", createdById: owner.id })
    .returning();
  const [privateCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: privateBoard!.id, title: "Private task", position: "1000.0000000000", createdById: owner.id })
    .returning();
  const [unassignedCard] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: publicBoard!.id, title: "Unassigned", position: "2000.0000000000", createdById: owner.id })
    .returning();
  await db.insert(cardAssignees).values([
    { cardId: publicCard!.id, userId: memberRow!.id },
    { cardId: privateCard!.id, userId: memberRow!.id },
  ]);

  return {
    app,
    workspace,
    owner,
    ownerToken,
    member: memberRow!,
    memberToken,
    observer: observerRow!,
    observerToken,
    list: list!,
    publicBoard: publicBoard!,
    privateBoard: privateBoard!,
    publicCard: publicCard!,
    privateCard: privateCard!,
    unassignedCard: unassignedCard!,
  };
}

function url(f: Fixture, userId: string) {
  return `/workspaces/${f.workspace.id}/assignees/${userId}/cards`;
}

function aggregateUrl(f: Fixture) {
  return `/workspaces/${f.workspace.id}/assignees/cards`;
}

function completedUrl(f: Fixture, userId: string) {
  return `/workspaces/${f.workspace.id}/assignees/${userId}/completed`;
}

function workDoneUrl(f: Fixture, userId: string, from: string, to: string) {
  return `/workspaces/${f.workspace.id}/assignees/${userId}/work-done?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

function aggregateWorkDoneUrl(f: Fixture, from: string, to: string) {
  return `/workspaces/${f.workspace.id}/assignees/work-done?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

void test("board observer can fetch their own assigned-work view scoped to their boards", async () => {
  const f = await seed();
  // The observer is a plain workspace member and a board observer on the public board only. Any
  // workspace member may fetch their own view (self access); it is scoped to the boards they belong
  // to and carries no cards since nothing is assigned to them.
  const res = await f.app.inject({ method: "GET", url: url(f, f.observer.id), headers: { authorization: `Bearer ${f.observerToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.cards, []);
  assert.deepEqual(body.boards.map((b: { name: string }) => b.name), ["Public"]);
});

void test("member can fetch their own assigned-work view", async () => {
  const f = await seed();
  const ok = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  // Member sees their two assigned cards across both boards.
  const titles = body.cards.map((c: { title: string }) => c.title).sort();
  assert.deepEqual(titles, ["Private task", "Public task"]);
  // Boards in payload include both since member is on both.
  const boardNames = body.boards.map((b: { name: string }) => b.name).sort();
  assert.deepEqual(boardNames, ["Private", "Public"]);
  assert.equal(body.targetUser.userId, f.member.id);
  // The API surfaces the viewer's workspace role; the web client maps it to a board role for card
  // gating, but the payload itself carries "member".
  assert.equal(body.viewerRole, "member");

  const teammate = await f.app.inject({
    method: "GET",
    url: url(f, f.owner.id),
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(teammate.statusCode, 200);
  assert.deepEqual(teammate.json().cards, []);
});

void test("member can fetch a teammate's assigned work scoped to accessible boards", async () => {
  const f = await seed();
  const res = await f.app.inject({
    method: "GET",
    url: url(f, f.member.id),
    headers: { authorization: `Bearer ${f.observerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.boards.map((b: { name: string }) => b.name), ["Public"]);
  assert.deepEqual(body.cards.map((c: { title: string }) => c.title), ["Public task"]);
});

void test("member can fetch aggregate assigned work scoped to accessible boards", async () => {
  const f = await seed();
  const res = await f.app.inject({
    method: "GET",
    url: aggregateUrl(f),
    headers: { authorization: `Bearer ${f.observerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.boards.map((b: { name: string }) => b.name), ["Public"]);
  assert.deepEqual(body.cards.map((c: { title: string }) => c.title), ["Public task"]);
});

void test("assigned-work completed endpoint filters accessible assigned completed cards", async () => {
  const f = await seed();
  await db.update(cards).set({ completedAt: new Date("2026-05-24T10:00:00.000Z") }).where(eq(cards.id, f.publicCard.id));
  await db.update(cards).set({ completedAt: new Date("2026-05-23T10:00:00.000Z") }).where(eq(cards.id, f.privateCard.id));
  await db.update(cards).set({
    completedAt: new Date("2026-05-25T10:00:00.000Z"),
    archivedAt: new Date("2026-05-26T10:00:00.000Z"),
  }).where(eq(cards.id, f.unassignedCard.id));

  const res = await f.app.inject({
    method: "GET",
    url: `${completedUrl(f, f.member.id)}?limit=1`,
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(res.statusCode, 200);
  const first = res.json<{ cards: { id: string }[]; nextCursor: string | null }>();
  assert.deepEqual(first.cards.map((card) => card.id), [f.publicCard.id]);
  assert.ok(first.nextCursor);

  const second = await f.app.inject({
    method: "GET",
    url: `${completedUrl(f, f.member.id)}?cursor=${encodeURIComponent(first.nextCursor!)}`,
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json<{ cards: { id: string }[] }>().cards.map((card) => card.id), [f.privateCard.id]);

  const boardFiltered = await f.app.inject({
    method: "GET",
    url: `${completedUrl(f, f.member.id)}?boardId=${f.privateBoard.id}`,
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(boardFiltered.statusCode, 200);
  assert.deepEqual(boardFiltered.json<{ cards: { id: string }[] }>().cards.map((card) => card.id), [f.privateCard.id]);

  // The observer is a workspace member fetching their own completed cards: allowed, but empty
  // since nothing is assigned to them.
  const observerCompleted = await f.app.inject({
    method: "GET",
    url: completedUrl(f, f.observer.id),
    headers: { authorization: `Bearer ${f.observerToken}` },
  });
  assert.equal(observerCompleted.statusCode, 200);
  assert.deepEqual(observerCompleted.json<{ cards: { id: string }[] }>().cards, []);
});

void test("assigned-work work-done filters by historical actor, not assignee", async () => {
  const f = await seed();
  const now = new Date();
  const from = new Date(now.getTime() - 60_000).toISOString();
  const to = new Date(now.getTime() + 60_000).toISOString();

  await db.insert(activityEvents).values([
    {
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      entityType: "card",
      entityId: f.publicCard.id,
      action: "created",
      payload: { listId: f.publicCard.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      actorId: f.member.id,
      entityType: "card",
      entityId: f.unassignedCard.id,
      action: "created",
      payload: { listId: f.unassignedCard.listId },
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const [memberChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: f.unassignedCard.id, title: "Member completion checks", position: "1000.0000000000" })
    .returning();
  assert.ok(memberChecklist);
  const [memberItem] = await db
    .insert(cardChecklistItems)
    .values({
      checklistId: memberChecklist.id,
      text: "Completed by member",
      position: "1000.0000000000",
      completedAt: now,
      completedById: f.member.id,
    })
    .returning();
  assert.ok(memberItem);
  const [ownerChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: f.publicCard.id, title: "Owner completion checks", position: "1000.0000000000" })
    .returning();
  assert.ok(ownerChecklist);
  await db.insert(cardChecklistItems).values({
    checklistId: ownerChecklist.id,
    text: "Completed by owner",
    position: "1000.0000000000",
    completedAt: now,
    completedById: f.owner.id,
  });

  const res = await f.app.inject({
    method: "GET",
    url: workDoneUrl(f, f.member.id, from, to),
    headers: { authorization: `Bearer ${f.memberToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<WorkDoneBody>();
  const created = body.events.filter((e) => e.type === "created");
  assert.deepEqual(created.map((e) => e.card.id), [f.unassignedCard.id]);
  assert.equal(created[0]?.actorUserId, f.member.id);
  const checklist = body.events.filter((e) => e.type === "checklistItemCompleted");
  assert.deepEqual(checklist.map((e) => e.itemId), [memberItem.id]);
  assert.equal(checklist[0]?.completedByUserId, f.member.id);
});

void test("aggregate assigned-work work-done includes teammate activity and excludes self", async () => {
  const f = await seed();
  const now = new Date();
  const from = new Date(now.getTime() - 60_000).toISOString();
  const to = new Date(now.getTime() + 60_000).toISOString();

  await db.insert(activityEvents).values([
    {
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      entityType: "card",
      entityId: f.publicCard.id,
      action: "created",
      payload: { listId: f.publicCard.listId },
      createdAt: now,
      updatedAt: now,
    },
    {
      boardId: f.publicBoard.id,
      workspaceId: f.workspace.id,
      actorId: f.member.id,
      entityType: "card",
      entityId: f.unassignedCard.id,
      action: "created",
      payload: { listId: f.unassignedCard.listId },
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const [memberChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: f.unassignedCard.id, title: "Team completion checks", position: "1000.0000000000" })
    .returning();
  assert.ok(memberChecklist);
  const [memberItem] = await db
    .insert(cardChecklistItems)
    .values({
      checklistId: memberChecklist.id,
      text: "Teammate completed item",
      position: "1000.0000000000",
      completedAt: now,
      completedById: f.member.id,
    })
    .returning();
  assert.ok(memberItem);
  const [ownerChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: f.publicCard.id, title: "Self completion checks", position: "1000.0000000000" })
    .returning();
  assert.ok(ownerChecklist);
  await db.insert(cardChecklistItems).values({
    checklistId: ownerChecklist.id,
    text: "Self completed item",
    position: "1000.0000000000",
    completedAt: now,
    completedById: f.owner.id,
  });

  const res = await f.app.inject({
    method: "GET",
    url: aggregateWorkDoneUrl(f, from, to),
    headers: { authorization: `Bearer ${f.ownerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<WorkDoneBody>();
  // Teammate (member) activity is included; the viewer's own (owner) activity is excluded.
  const created = body.events.filter((e) => e.type === "created");
  assert.deepEqual(created.map((e) => e.card.id), [f.unassignedCard.id]);
  assert.equal(created[0]?.actorUserId, f.member.id);
  const checklist = body.events.filter((e) => e.type === "checklistItemCompleted");
  assert.deepEqual(checklist.map((e) => e.itemId), [memberItem.id]);
  assert.equal(checklist[0]?.completedByUserId, f.member.id);
});

void test("workspace owner (org admin) can fetch any member's assigned-work view", async () => {
  const f = await seed();
  const res = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.ownerToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Owner is org admin, sees all workspace boards including private ones.
  const boardNames = body.boards.map((b: { name: string }) => b.name).sort();
  assert.deepEqual(boardNames, ["Private", "Public"]);
});

void test("assigned-work payload includes checklist items assigned to the target user on page load", async () => {
  const f = await seed();
  await db.update(cards).set({ completedAt: new Date("2026-05-24T10:00:00.000Z") }).where(eq(cards.id, f.unassignedCard.id));
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: f.unassignedCard.id, title: "Launch checklist", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const [item] = await db
    .insert(cardChecklistItems)
    .values({
      checklistId: checklist.id,
      text: "Confirm DNS cutover",
      position: "1000.0000000000",
      assigneeId: f.member.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "morning",
      dueDateTimezone: "UTC",
    })
    .returning();
  assert.ok(item);

  const res = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    cards: { id: string }[];
    checklistItems: {
      itemId: string;
      text: string;
      cardId: string;
      cardTitle: string;
      checklistId: string;
      listId: string;
      boardId: string;
      boardName: string;
      boardIcon: string | null;
      assigneeId: string;
      dueDateLocalDate: string | null;
      dueDateSlot: string | null;
      dueDateTimezone: string | null;
    }[];
  }>();

  assert.equal(body.cards.some((card) => card.id === f.unassignedCard.id), false);
  assert.deepEqual(body.checklistItems, [
    {
      itemId: item.id,
      text: "Confirm DNS cutover",
      cardId: f.unassignedCard.id,
      cardTitle: "Unassigned",
      checklistId: checklist.id,
      listId: f.unassignedCard.listId,
      boardId: f.publicBoard.id,
      boardName: "Public",
      boardIcon: null,
      assigneeId: f.member.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "morning",
      dueDateTimezone: "UTC",
    },
  ]);
});

void test("workspace owner can fetch aggregate teammate assigned work", async () => {
  const f = await seed();
  const [secondMember] = await db
    .insert(users)
    .values({ clientId: f.owner.clientId, email: "second-member@example.com", passwordHash: "x", displayName: "Second Member" })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: f.workspace.id, userId: secondMember!.id, role: "member" });
  const [secondCard] = await db
    .insert(cards)
    .values({ listId: f.publicCard.listId, boardId: f.publicBoard.id, title: "Second teammate task", position: "3000.0000000000", createdById: f.owner.id })
    .returning();
  await db.insert(cardAssignees).values({ cardId: secondCard!.id, userId: secondMember!.id });

  const res = await f.app.inject({ method: "GET", url: aggregateUrl(f), headers: { authorization: `Bearer ${f.ownerToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const titles = body.cards.map((c: { title: string }) => c.title).sort();
  assert.deepEqual(titles, ["Private task", "Public task", "Second teammate task"]);
  assert.equal(body.targetUser.userId, "all");
  assert.equal(body.targetUser.displayName, "All");
});

void test("aggregate assigned work includes every workspace board for org admins", async () => {
  const f = await seed();
  // Org admins retain implicit access to every board in their org even without a board_member row.
  const [adminRow] = await db
    .insert(users)
    .values({ clientId: f.owner.clientId, clientRole: "admin", email: "aggregate-wsadmin@example.com", passwordHash: "x", displayName: "Admin" })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: f.workspace.id, userId: adminRow!.id, role: "admin" });
  const adminToken = f.app.jwt.sign({ sub: adminRow!.id, cid: f.owner.clientId, role: "admin" });

  const res = await f.app.inject({ method: "GET", url: aggregateUrl(f), headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.boards.map((b: { name: string }) => b.name), ["Public", "Private"]);
  assert.deepEqual(body.cards.map((c: { title: string }) => c.title).sort(), ["Private task", "Public task"]);
});

void test("aggregate assigned work deduplicates cards assigned to multiple teammates", async () => {
  const f = await seed();
  const [secondMember] = await db
    .insert(users)
    .values({ clientId: f.owner.clientId, email: "dedupe-member@example.com", passwordHash: "x", displayName: "Dedupe Member" })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: f.workspace.id, userId: secondMember!.id, role: "member" });
  await db.insert(cardAssignees).values({ cardId: f.publicCard.id, userId: secondMember!.id });

  const res = await f.app.inject({ method: "GET", url: aggregateUrl(f), headers: { authorization: `Bearer ${f.ownerToken}` } });
  assert.equal(res.statusCode, 200);
  const publicMatches = res.json().cards.filter((c: { id: string }) => c.id === f.publicCard.id);
  assert.equal(publicMatches.length, 1);
});

void test("org admins can see cards on every workspace board", async () => {
  const f = await seed();
  // Org admins have implicit access to every board in their org, even with no board_member row.
  const [adminRow] = await db
    .insert(users)
    .values({ clientId: f.owner.clientId, clientRole: "admin", email: "wsadmin@example.com", passwordHash: "x", displayName: "Admin" })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: f.workspace.id, userId: adminRow!.id, role: "admin" });
  const adminToken = f.app.jwt.sign({ sub: adminRow!.id, cid: f.owner.clientId, role: "admin" });

  const res = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const boardNames = body.boards.map((b: { name: string }) => b.name);
  assert.deepEqual(boardNames, ["Public", "Private"]);
  const titles = body.cards.map((c: { title: string }) => c.title);
  assert.deepEqual(titles.sort(), ["Private task", "Public task"]);
});

void test("assigned-work view reflects a card's list after it moves", async () => {
  const f = await seed();
  // Add a second list so a move actually changes lists.
  const [secondList] = await db
    .insert(lists)
    .values({ workspaceId: f.workspace.id, name: "Doing", position: "9999.0000000000" })
    .returning();
  // Simulate the card move (the existing /cards/:id/move route is exercised by the
  // unit-level board tests; here we only verify the assigned-work view re-reads the
  // updated list id, since the integration server does not initialise realtime).
  await db.update(cards).set({ listId: secondList!.id }).where(eq(cards.id, f.publicCard.id));

  const res = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(res.statusCode, 200);
  const reloaded = res.json().cards.find((c: { id: string }) => c.id === f.publicCard.id);
  assert.ok(reloaded);
  assert.equal(reloaded.listId, secondList!.id);
});

void test("assigned-work payload enriches assigned cards with labels assignees fields comments attachments due dates and cover", async () => {
  const f = await seed();
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Blocked", color: "rose", position: "1000.0000000000" })
    .returning();
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Priority", type: "text", position: "1000.0000000000" })
    .returning();
  await db.insert(cardLabelAssignments).values({ cardId: f.publicCard.id, labelId: label!.id });
  await db.insert(cardCustomFieldValues).values({ cardId: f.publicCard.id, fieldId: field!.id, valueText: "High" });
  await db.insert(comments).values({ cardId: f.publicCard.id, authorId: f.owner.id, body: "Heads up" });
  const [cover] = await db
    .insert(cardAttachments)
    .values({
      cardId: f.publicCard.id,
      clientId: f.workspace.clientId,
      uploadedById: f.owner.id,
      fileName: "cover.png",
      mimeType: "image/png",
      byteSize: 1234,
      fileKey: "covers/cover.png",
      url: "/media/covers/cover.png",
      coverImageFileKey: "covers/cover-small.png",
      coverImageUrl: "/media/covers/cover-small.png",
    })
    .returning();
  await db
    .update(cards)
    .set({
      description: "Detailed task",
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "morning",
      coverAttachmentId: cover!.id,
    })
    .where(eq(cards.id, f.publicCard.id));

  const res = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const enriched = body.cards.find((c: { id: string }) => c.id === f.publicCard.id);
  assert.ok(enriched);
  assert.deepEqual(enriched.labelIds, [label!.id]);
  assert.deepEqual(enriched.assigneeIds, [f.member.id]);
  assert.equal(enriched.customFieldValues.length, 1);
  assert.equal(enriched.customFieldValues[0].fieldId, field!.id);
  assert.equal(enriched.customFieldValues[0].valueText, "High");
  assert.equal(enriched.commentCount, 1);
  assert.equal(enriched.attachmentCount, 1);
  assert.equal(enriched.hasDescription, true);
  assert.equal(enriched.dueDateLocalDate, "2026-05-20");
  assert.equal(enriched.dueDateSlot, "morning");
  assert.equal(typeof enriched.coverUrl, "string");
  assert.ok(enriched.coverUrl.length > 0);
  assert.equal(body.memberStats.find((s: { userId: string }) => s.userId === f.member.id)?.overdueCards, 1);
});

void test("assigned-work separators are isolated from board separators and aggregate views", async () => {
  const f = await seed();
  await db.insert(boardSeparators).values({
    boardId: f.publicBoard.id,
    listId: f.list.id,
    title: "Board separator",
    color: null,
    position: "1200.0000000000",
    createdById: f.owner.id,
  });

  const assignedBefore = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.ownerToken}` } });
  assert.equal(assignedBefore.statusCode, 200);
  assert.deepEqual(assignedBefore.json().separators, []);

  const created = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/assignees/${f.member.id}/lists/${f.list.id}/separators`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { title: "Assigned separator", color: "blue" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().targetUserId, f.member.id);

  const assignedAfter = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.ownerToken}` } });
  assert.equal(assignedAfter.statusCode, 200);
  assert.deepEqual(assignedAfter.json().separators.map((s: { title: string }) => s.title), ["Assigned separator"]);

  const boardOpen = await f.app.inject({
    method: "POST",
    url: `/boards/${f.publicBoard.id}/open`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
  });
  assert.equal(boardOpen.statusCode, 200);
  assert.deepEqual(boardOpen.json().separators.map((s: { title: string }) => s.title), ["Board separator"]);

  const aggregateCreate = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/assignees/all/lists/${f.list.id}/separators`,
    headers: { authorization: `Bearer ${f.ownerToken}` },
    payload: { title: "Nope" },
  });
  assert.equal(aggregateCreate.statusCode, 400);

  const rows = await db.select().from(assignedWorkSeparators).where(eq(assignedWorkSeparators.targetUserId, f.member.id));
  assert.equal(rows.length, 1);
});

void test("assigned-work overdue stats ignore completed cards", async () => {
  const f = await seed();
  await db
    .update(cards)
    .set({
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      completedAt: new Date("2026-05-21T10:00:00.000Z"),
    })
    .where(eq(cards.id, f.publicCard.id));

  const res = await f.app.inject({ method: "GET", url: url(f, f.member.id), headers: { authorization: `Bearer ${f.memberToken}` } });
  assert.equal(res.statusCode, 200);
  const stat = res.json().memberStats.find((s: { userId: string }) => s.userId === f.member.id);
  assert.equal(stat?.overdueCards ?? 0, 0);
});
