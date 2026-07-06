import "../../test/setup.integration.js";
import { ACTIVITY_ACTION, ACTIVITY_ENTITY_TYPE, NOTIFICATION_REASON, activityEvents, boardMembers, boards, boardWatchers, cardChecklistItems, cardChecklists, cardChecklistTemplateApplications, cardLabelAssignments, cardLabels, cards, cardAssignees, cardWatchers, checklistTemplateItems, checklistTemplates, directRealtimeOutbox, eventOutbox, internalLinks, lists, notifications, users, workspaceMembers, type ActivityAction } from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db, pool } from "../../db.js";
import { queueNotificationFanout, waitForNotificationFanoutForTests } from "../../lib/notifications.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

async function waitForBoardOutboxEvents(boardId: string, eventTypes: string[]) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await db
      .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(eq(eventOutbox.boardId, boardId))
      // Rebalance-before-move is a product invariant. uuidv7 IDs can tie-break differently for
      // same-millisecond fire-and-forget inserts, so assert the persisted emission order instead.
      .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
    if (eventTypes.every((eventType) => rows.some((row) => row.eventType === eventType))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db
    .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(eq(eventOutbox.boardId, boardId))
    .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
}

async function seedChecklistTemplateApplyFixture(testName: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: `Acme ${testName}`,
      email: `owner-${testName}@example.com`,
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
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Manual template card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);

  async function createTemplate(title: string, items: string[], archivedAt: Date | null = null) {
    const [last] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.workspaceId, workspace.id)).orderBy(desc(checklistTemplates.position)).limit(1);
    const [template] = await db
      .insert(checklistTemplates)
      .values({
        workspaceId: workspace.id,
        title,
        position: last ? (Number(last.position) + 1000).toFixed(10) : "1000.0000000000",
        archivedAt,
      })
      .returning();
    assert.ok(template);
    if (items.length > 0) {
      await db.insert(checklistTemplateItems).values(items.map((text, index) => ({
        templateId: template.id,
        text,
        position: ((index + 1) * 1000).toFixed(10),
      })));
    }
    return template;
  }

  return { app, auth, workspace, board, card, createTemplate };
}

async function seedDescriptionActivityPayloadFixture(testName: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: `Acme ${testName}`,
      email: `owner-${testName}@example.com`,
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
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Original title",
      description: "Original description",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();
  assert.ok(card);
  return { app, auth, card };
}

void test("card detail does not wait for internal-link repair", async () => {
  const f = await seedChecklistTemplateApplyFixture("detail-link-repair-background");
  const [link] = await db
    .insert(internalLinks)
    .values({
      workspaceId: f.workspace.id,
      sourceType: "card",
      sourceId: f.card.id,
      targetType: "board",
      targetId: f.board.id,
    })
    .returning();
  assert.ok(link);

  const lock = await pool.connect();
  let request: Promise<{ statusCode: number }> | undefined;
  try {
    await lock.query("begin");
    await lock.query(`select id from "internal_link" where id = $1 for update`, [link.id]);
    request = f.app.inject({ method: "GET", url: `/cards/${f.card.id}/detail`, headers: f.auth });
    const activeRequest = request;
    const completedWithoutRepair = await Promise.race([
      activeRequest.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    assert.equal(completedWithoutRepair, true);
  } finally {
    await lock.query("rollback");
    lock.release();
  }
  assert.equal((await request!).statusCode, 200);
  for (let attempt = 0; attempt < 40 && await db.$count(internalLinks, eq(internalLinks.id, link.id)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await db.$count(internalLinks, eq(internalLinks.id, link.id)), 0);
});

async function latestCardUpdateActivityPayload(cardId: string): Promise<Record<string, unknown>> {
  const [activity] = await db
    .select({ payload: activityEvents.payload })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, cardId), eq(activityEvents.action, "updated")))
    .orderBy(desc(activityEvents.createdAt))
    .limit(1);
  assert.ok(activity);
  return activity.payload as Record<string, unknown>;
}

void test("card detail can manually apply active workspace checklist templates once", async () => {
  const f = await seedChecklistTemplateApplyFixture("manual-checklist-template-apply");
  const template = await f.createTemplate("Definition of Done", ["Test", "Ship"]);
  const archivedTemplate = await f.createTemplate("Archived checklist", ["Hidden"], new Date());

  const otherWorkspaceCreated = await f.app.inject({
    method: "POST",
    url: "/workspaces",
    headers: f.auth,
    payload: { name: "Other workspace" },
  });
  assert.equal(otherWorkspaceCreated.statusCode, 201);
  const otherWorkspace = otherWorkspaceCreated.json<{ id: string }>();
  const [otherTemplate] = await db
    .insert(checklistTemplates)
    .values({ workspaceId: otherWorkspace.id, title: "Other workspace checklist", position: "1000.0000000000" })
    .returning();
  assert.ok(otherTemplate);

  const applied = await f.app.inject({
    method: "POST",
    url: `/cards/${f.card.id}/checklist-templates/apply`,
    headers: f.auth,
    payload: { templateIds: [template.id, archivedTemplate.id, otherTemplate.id] },
  });
  assert.equal(applied.statusCode, 200);
  const body = applied.json<{ checklists: { id: string; title: string; items: { text: string; position: string }[] }[]; skippedTemplateIds: string[] }>();
  assert.deepEqual(body.checklists.map((checklist) => checklist.title), ["Definition of Done"]);
  assert.deepEqual(body.checklists[0]?.items.map((item) => item.text), ["Test", "Ship"]);
  assert.deepEqual(body.skippedTemplateIds.sort(), [archivedTemplate.id, otherTemplate.id].sort());

  const seededChecklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, f.card.id));
  assert.equal(seededChecklists.length, 1);
  const seededItems = await db
    .select({ text: cardChecklistItems.text })
    .from(cardChecklistItems)
    .where(inArray(cardChecklistItems.checklistId, seededChecklists.map((checklist) => checklist.id)))
    .orderBy(asc(cardChecklistItems.position));
  assert.deepEqual(seededItems.map((item) => item.text), ["Test", "Ship"]);

  const detail = await f.app.inject({
    method: "GET",
    url: `/cards/${f.card.id}/detail`,
    headers: f.auth,
  });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json<{ appliedChecklistTemplateIds: string[] }>().appliedChecklistTemplateIds, [template.id]);

  const secondApply = await f.app.inject({
    method: "POST",
    url: `/cards/${f.card.id}/checklist-templates/apply`,
    headers: f.auth,
    payload: { templateIds: [template.id] },
  });
  assert.equal(secondApply.statusCode, 200);
  assert.deepEqual(secondApply.json<{ checklists: unknown[]; skippedTemplateIds: string[] }>(), {
    checklists: [],
    skippedTemplateIds: [template.id],
  });

  const checklistsAfterSecondApply = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, f.card.id));
  assert.equal(checklistsAfterSecondApply.length, 1);
  const ledger = await db.select().from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, f.card.id));
  assert.deepEqual(ledger.map((row) => row.templateId), [template.id]);

  const activity = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, f.card.id), eq(activityEvents.action, "checklist:created")));
  assert.equal(activity.length, 1);
  assert.equal((activity[0]?.payload as { fromTemplateId?: string } | undefined)?.fromTemplateId, template.id);

  const outboxRows = await db
    .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(and(eq(eventOutbox.boardId, f.board.id), eq(eventOutbox.eventType, "card:checklist:created")));
  assert.equal(outboxRows.length, 1);
  assert.equal((outboxRows[0]?.payload as { cardId?: string } | undefined)?.cardId, f.card.id);
});

void test("card description update activity stores before and after markdown", async () => {
  const f = await seedDescriptionActivityPayloadFixture("description-diff-payload");

  const updated = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.card.id}`,
    headers: f.auth,
    payload: { description: "Revised description" },
  });
  assert.equal(updated.statusCode, 200);

  const payload = await latestCardUpdateActivityPayload(f.card.id);
  assert.equal(payload.description, "Revised description");
  assert.equal(payload.fromValue, "Original description");
  assert.equal(payload.toValue, "Revised description");
});

void test("mixed card update activity stores description before and after markdown", async () => {
  const f = await seedDescriptionActivityPayloadFixture("mixed-description-diff-payload");

  const updated = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.card.id}`,
    headers: f.auth,
    payload: { title: "Updated title", description: "Updated description" },
  });
  assert.equal(updated.statusCode, 200);

  const payload = await latestCardUpdateActivityPayload(f.card.id);
  assert.equal(payload.title, "Updated title");
  assert.equal(payload.description, "Updated description");
  assert.equal(payload.fromValue, "Original description");
  assert.equal(payload.toValue, "Updated description");
});

async function seedAssigneeActivityFixture(testName: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: `Acme ${testName}`,
      email: `owner-${testName}@example.com`,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Assignment card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const seededCard = card;
  const [jacques, amelia] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: `jacques-${testName}@example.com`, passwordHash: "x", displayName: "Jacques Nieuwoudt" },
      { clientId: user.clientId, email: `amelia-${testName}@example.com`, passwordHash: "x", displayName: "Amelia Stone" },
    ])
    .returning();
  assert.ok(jacques);
  assert.ok(amelia);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: jacques.id, role: "member" },
    { workspaceId: workspace.id, userId: amelia.id, role: "member" },
  ]);
  // Board membership is the access model, and only non-observer board members can be assigned work.
  await db.insert(boardMembers).values([
    { boardId: board.id, userId: jacques.id, role: "editor" },
    { boardId: board.id, userId: amelia.id, role: "editor" },
  ]);

  async function setAssignees(userIds: string[]) {
    const response = await app.inject({
      method: "PUT",
      url: `/cards/${seededCard.id}/assignees`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { userIds },
    });
    assert.equal(response.statusCode, 200);
  }

  async function assigneeActivityRows() {
    return db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.entityId, seededCard.id), eq(activityEvents.action, "assignees:set")));
  }

  return { card: seededCard, jacques, amelia, setAssignees, assigneeActivityRows };
}

void test("workspace members must be added to a board before they can be assigned", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme readded-private-assignee",
      email: "owner-readded-private-assignee@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Private Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Private assignment", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [teammate] = await db
    .insert(users)
    .values({ clientId: user.clientId, email: "readded-private-assignee@example.com", passwordHash: "x", displayName: "Teammate" })
    .returning();
  assert.ok(teammate);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: teammate.id, role: "member" });

  // Board membership is the access model: a workspace member who is not on the board cannot be
  // assigned. Assignment never auto-adds them — an admin must add them to the board first.
  const beforeMembership = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: auth,
    payload: { userIds: [teammate.id] },
  });
  assert.equal(beforeMembership.statusCode, 400);
  assert.equal((await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id))).length, 0);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, teammate.id))), 0);

  const added = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/members`,
    headers: auth,
    payload: { userId: teammate.id, role: "editor" },
  });
  assert.equal(added.statusCode, 201);

  const afterMembership = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: auth,
    payload: { userIds: [teammate.id] },
  });
  assert.equal(afterMembership.statusCode, 200);
  const assignments = await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id));
  assert.deepEqual(assignments.map((assignment) => assignment.userId), [teammate.id]);

  const outboxRows = await waitForBoardOutboxEvents(board.id, ["card:assignees:set"]);
  assert.ok(outboxRows.some((row) =>
    row.eventType === "card:assignees:set" &&
    (row.payload as { cardId?: string; assigneeIds?: string[] }).cardId === card.id &&
    ((row.payload as { assigneeIds?: string[] }).assigneeIds?.includes(teammate.id) ?? false)
  ));
});

void test("card creation can assign eligible users and rejects unassignable users", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme create-assigned-card",
      email: "owner-create-assigned-card@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [assignee, observer] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: "assignee-create-card@example.com", passwordHash: "x", displayName: "Assignee" },
      { clientId: user.clientId, email: "observer-create-card@example.com", passwordHash: "x", displayName: "Observer" },
    ])
    .returning();
  assert.ok(assignee);
  assert.ok(observer);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: assignee.id, role: "member" },
    { workspaceId: workspace.id, userId: observer.id, role: "member" },
  ]);
  // Assignability is gated on non-observer board membership: the editor can own work, the board
  // observer cannot.
  await db.insert(boardMembers).values([
    { boardId: board.id, userId: assignee.id, role: "editor" },
    { boardId: board.id, userId: observer.id, role: "observer" },
  ]);

  const created = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/cards`,
    headers: auth,
    payload: { title: "Assigned from work", assigneeIds: [assignee.id], atTop: true },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();
  const assignments = await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id));
  assert.deepEqual(assignments.map((assignment) => assignment.userId), [assignee.id]);

  const outboxRows = await waitForBoardOutboxEvents(board.id, ["card:created", "card:assignees:set"]);
  assert.ok(outboxRows.some((row) => row.eventType === "card:created" && (row.payload as { card?: { id?: string } }).card?.id === card.id));
  assert.ok(outboxRows.some((row) => row.eventType === "card:assignees:set" && (row.payload as { cardId?: string; assigneeIds?: string[] }).cardId === card.id));

  const rejected = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/cards`,
    headers: auth,
    payload: { title: "Observer work", assigneeIds: [observer.id] },
  });
  assert.equal(rejected.statusCode, 400);
});

void test("cross-org board guests with editor access are assignable to cards and checklist items", async () => {
  const app = await buildIntegrationServer();
  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme guest assignment",
      email: "owner-guest-assignment@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const { accessToken, user: owner } = ownerSignup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Guest work", position: "1000.0000000000", createdById: owner.id })
    .returning();
  assert.ok(card);
  const [checklist] = await db.insert(cardChecklists).values({ cardId: card.id, title: "Steps", position: "1000.0000000000" }).returning();
  assert.ok(checklist);
  const [item] = await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Review", position: "1000.0000000000" }).returning();
  assert.ok(item);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "External guest assignment",
      email: "guest-assignment-editor@external.test",
      password: "Abc12345",
      displayName: "Guest Editor",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { user: guest } = guestSignup.json<{ user: { id: string; clientId: string } }>();
  assert.notEqual(guest.clientId, owner.clientId);

  const observerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "External guest observer",
      email: "guest-assignment-observer@external.test",
      password: "Abc12345",
      displayName: "Guest Observer",
    },
  });
  assert.equal(observerSignup.statusCode, 200);
  const { user: observer } = observerSignup.json<{ user: { id: string; clientId: string } }>();
  assert.notEqual(observer.clientId, owner.clientId);

  await db.insert(boardMembers).values([
    { boardId: board.id, userId: guest.id, role: "editor" },
    { boardId: board.id, userId: observer.id, role: "observer" },
  ]);

  const assignCard = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: ownerAuth,
    payload: { userIds: [guest.id] },
  });
  assert.equal(assignCard.statusCode, 200);
  const assignments = await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id));
  assert.deepEqual(assignments.map((assignment) => assignment.userId), [guest.id]);

  const assignChecklistItem = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: ownerAuth,
    payload: { assigneeId: guest.id },
  });
  assert.equal(assignChecklistItem.statusCode, 200);
  const [storedItem] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.id, item.id)).limit(1);
  assert.equal(storedItem?.assigneeId, guest.id);

  const rejectObserverCard = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: ownerAuth,
    payload: { userIds: [observer.id] },
  });
  assert.equal(rejectObserverCard.statusCode, 400);

  const rejectObserverChecklist = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: ownerAuth,
    payload: { assigneeId: observer.id },
  });
  assert.equal(rejectObserverChecklist.statusCode, 400);
});

async function seedLabelActivityFixture(testName: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: `Acme ${testName}`,
      email: `owner-${testName}@example.com`,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Label card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const seededCard = card;
  const [bug, urgent] = await db
    .insert(cardLabels)
    .values([
      { workspaceId: workspace.id, name: "Bug", color: "rose", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Urgent", color: "amber", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(bug);
  assert.ok(urgent);

  async function setLabels(labelIds: string[]) {
    const response = await app.inject({
      method: "PUT",
      url: `/cards/${seededCard.id}/labels`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { labelIds },
    });
    assert.equal(response.statusCode, 200);
  }

  async function labelActivityRows() {
    return db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.entityId, seededCard.id), eq(activityEvents.action, "labels:set")));
  }

  return { card: seededCard, bug, urgent, setLabels, labelActivityRows };
}

void test("public API card creation and edits do not auto-watch as the API key owner", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Public Cards",
      email: "owner-public-cards@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: workspace.id,
      name: "Board",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(board);

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Import sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const secret = key.json<{ secret: string }>().secret;

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: testUploadsDir("test-public-uploads"),
  });
  try {
    const created = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${board.id}/lists/${list.id}/cards`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { title: "Imported card" },
    });
    assert.equal(created.statusCode, 201);
    const card = created.json<{ id: string }>();

    const watchesAfterCreate = await db
      .select()
      .from(cardWatchers)
      .where(eq(cardWatchers.cardId, card.id));
    assert.deepEqual(watchesAfterCreate, []);

    const updated = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${card.id}`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { title: "Imported card, renamed" },
    });
    assert.equal(updated.statusCode, 200);

    const watchesAfterUpdate = await db
      .select()
      .from(cardWatchers)
      .where(eq(cardWatchers.cardId, card.id));
    assert.deepEqual(watchesAfterUpdate, []);

    const [source] = await db
      .insert(cards)
      .values({
        listId: list.id,
        boardId: board.id,
        title: "Source card",
        position: "2000.0000000000",
        createdById: user.id,
      })
      .returning();
    assert.ok(source);

    const duplicated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${source.id}/duplicate`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {},
    });
    assert.equal(duplicated.statusCode, 201);
    const duplicate = duplicated.json<{ id: string }>();

    const watchesAfterDuplicate = await db
      .select()
      .from(cardWatchers)
      .where(eq(cardWatchers.cardId, duplicate.id));
    assert.deepEqual(watchesAfterDuplicate, []);
  } finally {
    await publicApi.close();
  }
});

void test("board watchers are notified when another user completes a card", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Completion Watchers",
      email: "owner-completion-watchers@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [actor] = await db
    .insert(users)
    .values({ clientId: user.clientId, email: "actor-completion-watchers@example.com", passwordHash: "x", displayName: "Actor" })
    .returning();
  assert.ok(actor);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: actor.id, role: "member" });
  // Board membership is the access model: the actor needs an explicit board_member row to act.
  await db.insert(boardMembers).values({ boardId: board.id, userId: actor.id, role: "editor" });
  const actorAuth = { authorization: `Bearer ${app.jwt.sign({ sub: actor.id, cid: user.clientId, role: "member" })}` };
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Complete me", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  await db.insert(boardWatchers).values([
    { boardId: board.id, userId: user.id },
    { boardId: board.id, userId: actor.id },
  ]);

  const completed = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/completion`,
    headers: actorAuth,
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({ userId: notifications.userId, action: activityEvents.action, reason: notifications.reason })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.action, "completion:set")));
  assert.deepEqual(rows, [{ userId: user.id, action: "completion:set", reason: "watching" }]);
});

void test("description edits notify assignees but not card or board watchers", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Description Notifications",
      email: "owner-description-notifications@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Describe me", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [assignee, cardWatcher, boardWatcher] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: "assignee-description-notifications@example.com", passwordHash: "x", displayName: "Assignee" },
      { clientId: user.clientId, email: "card-watcher-description-notifications@example.com", passwordHash: "x", displayName: "Card Watcher" },
      { clientId: user.clientId, email: "board-watcher-description-notifications@example.com", passwordHash: "x", displayName: "Board Watcher" },
    ])
    .returning();
  assert.ok(assignee);
  assert.ok(cardWatcher);
  assert.ok(boardWatcher);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: assignee.id, role: "member" },
    { workspaceId: workspace.id, userId: cardWatcher.id, role: "member" },
    { workspaceId: workspace.id, userId: boardWatcher.id, role: "member" },
  ]);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.id });
  await db.insert(boardWatchers).values({ boardId: board.id, userId: boardWatcher.id });

  const updated = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}`,
    headers: ownerAuth,
    payload: { description: "A more useful description." },
  });
  assert.equal(updated.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({
      userId: notifications.userId,
      action: activityEvents.action,
      coalesceKey: activityEvents.coalesceKey,
      reason: notifications.reason,
    })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.coalesceKey, "card:description")));
  assert.deepEqual(rows, [{
    userId: assignee.id,
    action: "updated",
    coalesceKey: "card:description",
    reason: "assigned",
  }]);
});

void test("checklist item text edits notify assignees but not card or board watchers", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Checklist Item Notifications",
      email: "owner-checklist-item-notifications@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Checklist card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, title: "Tasks", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const [item] = await db
    .insert(cardChecklistItems)
    .values({ checklistId: checklist.id, text: "1fetch", position: "1000.0000000000" })
    .returning();
  assert.ok(item);
  const [assignee, cardWatcher, boardWatcher] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: "assignee-checklist-item-notifications@example.com", passwordHash: "x", displayName: "Assignee" },
      { clientId: user.clientId, email: "card-watcher-checklist-item-notifications@example.com", passwordHash: "x", displayName: "Card Watcher" },
      { clientId: user.clientId, email: "board-watcher-checklist-item-notifications@example.com", passwordHash: "x", displayName: "Board Watcher" },
    ])
    .returning();
  assert.ok(assignee);
  assert.ok(cardWatcher);
  assert.ok(boardWatcher);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: assignee.id, role: "member" },
    { workspaceId: workspace.id, userId: cardWatcher.id, role: "member" },
    { workspaceId: workspace.id, userId: boardWatcher.id, role: "member" },
  ]);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.id });
  await db.insert(boardWatchers).values({ boardId: board.id, userId: boardWatcher.id });

  const updated = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: ownerAuth,
    payload: { text: "1Fetch" },
  });
  assert.equal(updated.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({
      userId: notifications.userId,
      action: activityEvents.action,
      coalesceKey: activityEvents.coalesceKey,
      reason: notifications.reason,
    })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.coalesceKey, `checklistItem:${item.id}:text`)));
  assert.deepEqual(rows, [{
    userId: assignee.id,
    action: "checklistItem:updated",
    coalesceKey: `checklistItem:${item.id}:text`,
    reason: "assigned",
  }]);
});

void test("label changes notify assignees but not card or board watchers", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Label Notifications",
      email: "owner-label-notifications@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Label me", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: workspace.id, name: "Blocked", color: "#ef4444", position: "1000.0000000000" })
    .returning();
  assert.ok(label);
  const [assignee, cardWatcher, boardWatcher] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: "assignee-label-notifications@example.com", passwordHash: "x", displayName: "Assignee" },
      { clientId: user.clientId, email: "card-watcher-label-notifications@example.com", passwordHash: "x", displayName: "Card Watcher" },
      { clientId: user.clientId, email: "board-watcher-label-notifications@example.com", passwordHash: "x", displayName: "Board Watcher" },
    ])
    .returning();
  assert.ok(assignee);
  assert.ok(cardWatcher);
  assert.ok(boardWatcher);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: assignee.id, role: "member" },
    { workspaceId: workspace.id, userId: cardWatcher.id, role: "member" },
    { workspaceId: workspace.id, userId: boardWatcher.id, role: "member" },
  ]);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.id });
  await db.insert(boardWatchers).values({ boardId: board.id, userId: boardWatcher.id });

  const updated = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/labels`,
    headers: ownerAuth,
    payload: { labelIds: [label.id] },
  });
  assert.equal(updated.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({
      userId: notifications.userId,
      action: activityEvents.action,
      reason: notifications.reason,
    })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.action, "labels:set")));
  assert.deepEqual(rows, [{
    userId: assignee.id,
    action: "labels:set",
    reason: "assigned",
  }]);
});

void test("metadata card activity notifies assignees but not card or board watchers", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Metadata Notifications",
      email: "owner-metadata-notifications@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Metadata card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [assignee, cardWatcher, boardWatcher] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: "assignee-metadata-notifications@example.com", passwordHash: "x", displayName: "Assignee" },
      { clientId: user.clientId, email: "card-watcher-metadata-notifications@example.com", passwordHash: "x", displayName: "Card Watcher" },
      { clientId: user.clientId, email: "board-watcher-metadata-notifications@example.com", passwordHash: "x", displayName: "Board Watcher" },
    ])
    .returning();
  assert.ok(assignee);
  assert.ok(cardWatcher);
  assert.ok(boardWatcher);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: assignee.id, role: "member" },
    { workspaceId: workspace.id, userId: cardWatcher.id, role: "member" },
    { workspaceId: workspace.id, userId: boardWatcher.id, role: "member" },
  ]);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.id });
  await db.insert(boardWatchers).values({ boardId: board.id, userId: boardWatcher.id });

  const actions = [
    ACTIVITY_ACTION.ATTACHMENT_ADDED,
    ACTIVITY_ACTION.ATTACHMENT_REMOVED,
    ACTIVITY_ACTION.COVER_REMOVED,
    ACTIVITY_ACTION.COVER_SET,
    ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_CLEARED,
    ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
  ] satisfies ActivityAction[];
  const insertedActivities = await db
    .insert(activityEvents)
    .values(actions.map((action) => ({
      boardId: board.id,
      workspaceId: workspace.id,
      actorId: user.id,
      entityType: ACTIVITY_ENTITY_TYPE.CARD,
      entityId: card.id,
      action,
      payload: action === ACTIVITY_ACTION.ATTACHMENT_ADDED ? { attachmentId: randomUUID() } : {},
    })))
    .returning();
  for (const activity of insertedActivities) queueNotificationFanout(activity);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({
      userId: notifications.userId,
      action: activityEvents.action,
      reason: notifications.reason,
    })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), inArray(activityEvents.action, actions)));
  assert.deepEqual(
    rows.map((row) => ({ userId: row.userId, action: row.action, reason: row.reason })).sort((a, b) => a.action.localeCompare(b.action)),
    actions.map((action) => ({ userId: assignee.id, action, reason: NOTIFICATION_REASON.ASSIGNED })).sort((a, b) => a.action.localeCompare(b.action)),
  );
});

void test("assignee changes notify card and board watchers", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Assignee Watcher Notifications",
      email: "owner-assignee-watcher-notifications@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Assignee card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [assignee, cardWatcher, boardWatcher] = await db
    .insert(users)
    .values([
      { clientId: user.clientId, email: "assignee-watcher-notifications@example.com", passwordHash: "x", displayName: "Assignee" },
      { clientId: user.clientId, email: "card-watcher-assignee-notifications@example.com", passwordHash: "x", displayName: "Card Watcher" },
      { clientId: user.clientId, email: "board-watcher-assignee-notifications@example.com", passwordHash: "x", displayName: "Board Watcher" },
    ])
    .returning();
  assert.ok(assignee);
  assert.ok(cardWatcher);
  assert.ok(boardWatcher);
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: assignee.id, role: "member" },
    { workspaceId: workspace.id, userId: cardWatcher.id, role: "member" },
    { workspaceId: workspace.id, userId: boardWatcher.id, role: "member" },
  ]);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.id });
  await db.insert(boardWatchers).values({ boardId: board.id, userId: boardWatcher.id });

  const [activity] = await db
    .insert(activityEvents)
    .values({
      boardId: board.id,
      workspaceId: workspace.id,
      actorId: user.id,
      entityType: ACTIVITY_ENTITY_TYPE.CARD,
      entityId: card.id,
      action: ACTIVITY_ACTION.ASSIGNEES_SET,
      payload: { assigneeIds: [assignee.id] },
    })
    .returning();
  assert.ok(activity);
  queueNotificationFanout(activity);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({
      userId: notifications.userId,
      reason: notifications.reason,
    })
    .from(notifications)
    .where(eq(notifications.activityId, activity.id));
  assert.deepEqual(
    rows.map((row) => ({ userId: row.userId, reason: row.reason })).sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: assignee.id, reason: NOTIFICATION_REASON.ASSIGNED },
      { userId: boardWatcher.id, reason: NOTIFICATION_REASON.WATCHING },
      { userId: cardWatcher.id, reason: NOTIFICATION_REASON.WATCHING },
    ].sort((a, b) => a.userId.localeCompare(b.userId)),
  );
});

void test("cross-board card copy and move place the card at the top of the destination list", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Board Transfers",
      email: "owner-board-transfers@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [sourceBoard, targetBoard] = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "Source", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Target", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(sourceBoard);
  assert.ok(targetBoard);
  const [source, movedSource, existing] = await db
    .insert(cards)
    .values([
      { listId: list.id, boardId: sourceBoard.id, title: "Copy source", position: "1000.0000000000", createdById: user.id },
      { listId: list.id, boardId: sourceBoard.id, title: "Move source", position: "2000.0000000000", createdById: user.id },
      { listId: list.id, boardId: targetBoard.id, title: "Existing target", position: "1000.0000000000", createdById: user.id },
    ])
    .returning();
  assert.ok(source);
  assert.ok(movedSource);
  assert.ok(existing);

  const copied = await app.inject({
    method: "POST",
    url: `/cards/${source.id}/duplicate`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { boardId: targetBoard.id },
  });
  assert.equal(copied.statusCode, 201);
  const copy = copied.json<{ id: string }>();

  let targetCards = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.boardId, targetBoard.id))
    .orderBy(asc(cards.position));
  assert.equal(targetCards[0]?.id, copy.id);

  const moved = await app.inject({
    method: "POST",
    url: `/cards/${movedSource.id}/move-to-board`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { boardId: targetBoard.id },
  });
  assert.equal(moved.statusCode, 200);

  targetCards = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.boardId, targetBoard.id))
    .orderBy(asc(cards.position));
  assert.equal(targetCards[0]?.id, movedSource.id);
});

void test("cross-workspace card copy without listId uses one same-name target list", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Cross Workspace Copy Match",
      email: "owner-cross-workspace-copy-match@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const sourceWorkspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Source workspace" } });
  const targetWorkspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Target workspace" } });
  assert.equal(sourceWorkspaceCreated.statusCode, 201);
  assert.equal(targetWorkspaceCreated.statusCode, 201);
  const sourceWorkspace = sourceWorkspaceCreated.json<{ id: string }>();
  const targetWorkspace = targetWorkspaceCreated.json<{ id: string }>();

  const [sourceList] = await db.select().from(lists).where(eq(lists.workspaceId, sourceWorkspace.id)).orderBy(asc(lists.position)).limit(1);
  assert.ok(sourceList);
  const [targetList] = await db.select().from(lists).where(and(eq(lists.workspaceId, targetWorkspace.id), eq(lists.name, sourceList.name))).limit(1);
  assert.ok(targetList);
  const [sourceBoard, targetBoard] = await db
    .insert(boards)
    .values([
      { workspaceId: sourceWorkspace.id, name: "Source", position: "1000.0000000000" },
      { workspaceId: targetWorkspace.id, name: "Target", position: "1000.0000000000" },
    ])
    .returning();
  assert.ok(sourceBoard);
  assert.ok(targetBoard);
  const [source] = await db
    .insert(cards)
    .values({ listId: sourceList.id, boardId: sourceBoard.id, title: "Copy source", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(source);

  const copied = await app.inject({
    method: "POST",
    url: `/cards/${source.id}/duplicate`,
    headers: auth,
    payload: { boardId: targetBoard.id },
  });
  assert.equal(copied.statusCode, 201);
  const copy = copied.json<{ listId: string }>();
  assert.equal(copy.listId, targetList.id);
});

void test("cross-workspace card copy without listId rejects when no same-name target list exists", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Cross Workspace Copy No Match",
      email: "owner-cross-workspace-copy-no-match@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const sourceWorkspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Source workspace" } });
  const targetWorkspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Target workspace" } });
  assert.equal(sourceWorkspaceCreated.statusCode, 201);
  assert.equal(targetWorkspaceCreated.statusCode, 201);
  const sourceWorkspace = sourceWorkspaceCreated.json<{ id: string }>();
  const targetWorkspace = targetWorkspaceCreated.json<{ id: string }>();

  const [sourceList] = await db
    .insert(lists)
    .values({ workspaceId: sourceWorkspace.id, name: "Only source has this", position: "9000.0000000000" })
    .returning();
  assert.ok(sourceList);
  const [sourceBoard, targetBoard] = await db
    .insert(boards)
    .values([
      { workspaceId: sourceWorkspace.id, name: "Source", position: "1000.0000000000" },
      { workspaceId: targetWorkspace.id, name: "Target", position: "1000.0000000000" },
    ])
    .returning();
  assert.ok(sourceBoard);
  assert.ok(targetBoard);
  const [source] = await db
    .insert(cards)
    .values({ listId: sourceList.id, boardId: sourceBoard.id, title: "Copy source", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(source);

  const copied = await app.inject({
    method: "POST",
    url: `/cards/${source.id}/duplicate`,
    headers: auth,
    payload: { boardId: targetBoard.id },
  });
  assert.equal(copied.statusCode, 400);
  assert.equal(copied.json<{ message: string }>().message, "target list required");
});

void test("copied support-session card history labels the acted-as user, not the support operator", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Copied Support History",
      email: "bernard-copied-support-history@example.com",
      password: "Abc12345",
      displayName: "Bernard Van Erk",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const sourceWorkspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Source workspace" } });
  const targetWorkspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Target workspace" } });
  assert.equal(sourceWorkspaceCreated.statusCode, 201);
  assert.equal(targetWorkspaceCreated.statusCode, 201);
  const sourceWorkspace = sourceWorkspaceCreated.json<{ id: string }>();
  const targetWorkspace = targetWorkspaceCreated.json<{ id: string }>();

  const [sourceList] = await db.select().from(lists).where(eq(lists.workspaceId, sourceWorkspace.id)).orderBy(asc(lists.position)).limit(1);
  assert.ok(sourceList);
  const [sourceBoard, targetBoard] = await db
    .insert(boards)
    .values([
      { workspaceId: sourceWorkspace.id, name: "Source", position: "1000.0000000000" },
      { workspaceId: targetWorkspace.id, name: "Target", position: "1000.0000000000" },
    ])
    .returning();
  assert.ok(sourceBoard);
  assert.ok(targetBoard);
  const [source] = await db
    .insert(cards)
    .values({ listId: sourceList.id, boardId: sourceBoard.id, title: "Support history source", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(source);
  await db.insert(activityEvents).values({
    boardId: sourceBoard.id,
    workspaceId: sourceWorkspace.id,
    actorId: user.id,
    actorKind: "support",
    supportActorEmail: "dylan@happen.software",
    entityType: "card",
    entityId: source.id,
    action: "completed",
    payload: {},
    createdAt: new Date("2026-07-03T10:48:00.000Z"),
  });

  const copied = await app.inject({
    method: "POST",
    url: `/cards/${source.id}/duplicate`,
    headers: auth,
    payload: { boardId: targetBoard.id },
  });
  assert.equal(copied.statusCode, 201);
  const copy = copied.json<{ id: string }>();

  const [copiedHistorical] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.boardId, targetBoard.id), eq(activityEvents.entityId, copy.id), eq(activityEvents.action, "completed")))
    .limit(1);
  assert.ok(copiedHistorical);
  assert.equal(copiedHistorical.actorKind, "system");
  assert.equal(copiedHistorical.supportActorEmail, null);
  const payload = copiedHistorical.payload as { copiedActorName?: string };
  assert.equal(payload.copiedActorName, "Bernard Van Erk");
});

void test("card duplicate persists rebalance before created event", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Duplicate Rebalance",
      email: "owner-duplicate-rebalance@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [source, next] = await db
    .insert(cards)
    .values([
      { listId: list.id, boardId: board.id, title: "Source", position: "1.0000000000", createdById: user.id },
      { listId: list.id, boardId: board.id, title: "Next", position: "1.0000000005", createdById: user.id },
    ])
    .returning();
  assert.ok(source);
  assert.ok(next);

  const duplicated = await app.inject({
    method: "POST",
    url: `/cards/${source.id}/duplicate`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(duplicated.statusCode, 201);
  const duplicate = duplicated.json<{ id: string }>();

  const outboxRows = await waitForBoardOutboxEvents(board.id, ["card:rebalanced", "card:created"]);
  const orderedTypes = outboxRows
    .filter((row) => row.eventType === "card:rebalanced" || ((row.payload as { card?: { id?: string } }).card?.id === duplicate.id && row.eventType === "card:created"))
    .map((row) => row.eventType);
  assert.deepEqual(orderedTypes, ["card:rebalanced", "card:created"]);
});

void test("same-list card reorder does not create activity feed noise", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Reorder",
      email: "owner-reorder@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [first, moved] = await db
    .insert(cards)
    .values([
      { listId: list.id, boardId: board.id, title: "First", position: "1000.0000000000", createdById: user.id },
      { listId: list.id, boardId: board.id, title: "Moved", position: "2000.0000000000", createdById: user.id },
    ])
    .returning();
  assert.ok(first);
  assert.ok(moved);

  const reordered = await app.inject({
    method: "POST",
    url: `/cards/${moved.id}/move`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { listId: list.id, beforeCardId: first.id },
  });
  assert.equal(reordered.statusCode, 200);

  const moveActivities = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, moved.id), eq(activityEvents.action, "moved")));
  assert.equal(moveActivities.length, 0);
});

void test("card move accepts cross-board anchors in the same workspace list", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Cross Board Priority",
      email: "owner-cross-board-priority@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [boardA, boardB] = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "A", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "B", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(boardA);
  assert.ok(boardB);
  const [after, before, moved] = await db
    .insert(cards)
    .values([
      { listId: list.id, boardId: boardB.id, title: "Board B first", position: "1000.0000000000", createdById: user.id },
      { listId: list.id, boardId: boardB.id, title: "Board B second", position: "3000.0000000000", createdById: user.id },
      { listId: list.id, boardId: boardA.id, title: "Board A moved", position: "5000.0000000000", createdById: user.id },
    ])
    .returning();
  assert.ok(after);
  assert.ok(before);
  assert.ok(moved);

  const reordered = await app.inject({
    method: "POST",
    url: `/cards/${moved.id}/move`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { listId: list.id, afterCardId: after.id, beforeCardId: before.id },
  });
  assert.equal(reordered.statusCode, 200);
  const body = reordered.json<{ position: string }>();
  assert.ok(Number(body.position) > Number(after.position));
  assert.ok(Number(body.position) < Number(before.position));

  const [stored] = await db.select().from(cards).where(eq(cards.id, moved.id)).limit(1);
  assert.equal(stored?.boardId, boardA.id);
  assert.equal(stored?.position, body.position);

  const outboxRows = await waitForBoardOutboxEvents(boardA.id, ["card:moved"]);
  assert.ok(outboxRows.some((row) => row.eventType === "card:moved" && (row.payload as { cardId?: string }).cardId === moved.id));
});

void test("card move rejects anchors from another list", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Wrong Anchor List",
      email: "owner-wrong-anchor-list@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const existingLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).orderBy(asc(lists.position));
  const sourceList = existingLists[0];
  assert.ok(sourceList);
  const [otherList] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Other", position: "2000.0000000000" })
    .returning();
  assert.ok(otherList);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [moved, wrongAnchor] = await db
    .insert(cards)
    .values([
      { listId: sourceList.id, boardId: board.id, title: "Moved", position: "1000.0000000000", createdById: user.id },
      { listId: otherList.id, boardId: board.id, title: "Wrong anchor", position: "1000.0000000000", createdById: user.id },
    ])
    .returning();
  assert.ok(moved);
  assert.ok(wrongAnchor);

  const reordered = await app.inject({
    method: "POST",
    url: `/cards/${moved.id}/move`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { listId: sourceList.id, afterCardId: wrongAnchor.id },
  });
  assert.equal(reordered.statusCode, 400);
});

void test("same-list card reorder emits rebalance before moved when neighbours are too close", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Rebalance Route",
      email: "owner-rebalance-route@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [boardA, boardB] = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "A", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "B", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(boardA);
  assert.ok(boardB);
  const [first, second, moved] = await db
    .insert(cards)
    .values([
      { listId: list.id, boardId: boardB.id, title: "First", position: "1.0000000000", createdById: user.id },
      { listId: list.id, boardId: boardB.id, title: "Second", position: "1.0000000005", createdById: user.id },
      { listId: list.id, boardId: boardA.id, title: "Moved", position: "2000.0000000000", createdById: user.id },
    ])
    .returning();
  assert.ok(first);
  assert.ok(second);
  assert.ok(moved);

  const reordered = await app.inject({
    method: "POST",
    url: `/cards/${moved.id}/move`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { listId: list.id, afterCardId: first.id },
  });
  assert.equal(reordered.statusCode, 200);
  assert.equal(reordered.json<{ position: string }>().position, "2000.0000000000");

  const rows = await db
    .select({ id: cards.id, boardId: cards.boardId, position: cards.position })
    .from(cards)
    .where(eq(cards.listId, list.id))
    .orderBy(asc(cards.position));
  assert.deepEqual(rows.map((row) => row.id), [first.id, moved.id, second.id]);
  assert.deepEqual(rows.map((row) => row.position), ["1000.0000000000", "2000.0000000000", "3000.0000000000"]);

  const boardAOutboxRows = await waitForBoardOutboxEvents(boardA.id, ["card:rebalanced", "card:moved"]);
  assert.deepEqual(boardAOutboxRows.map((row) => row.eventType), ["card:rebalanced", "card:moved"]);
  assert.deepEqual((boardAOutboxRows[0]!.payload as { positions: { id: string; position: string }[] }).positions, [
    { id: moved.id, position: "2000.0000000000" },
  ]);
  assert.equal((boardAOutboxRows[1]!.payload as { cardId: string; position: string; prevPosition: string }).cardId, moved.id);
  assert.equal((boardAOutboxRows[1]!.payload as { cardId: string; position: string; prevPosition: string }).position, "2000.0000000000");

  const boardBOutboxRows = await waitForBoardOutboxEvents(boardB.id, ["card:rebalanced"]);
  assert.deepEqual(boardBOutboxRows.map((row) => row.eventType), ["card:rebalanced"]);
  assert.deepEqual((boardBOutboxRows[0]!.payload as { positions: { id: string; position: string }[] }).positions, [
    { id: first.id, position: "1000.0000000000" },
    { id: second.id, position: "3000.0000000000" },
  ]);
});

void test("card label activity hides quick add then remove correction", async () => {
  const f = await seedLabelActivityFixture("label-correction-add-remove");

  await f.setLabels([f.bug.id]);
  await f.setLabels([]);

  const rows = await f.labelActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, false);
  assert.equal(rows[0]!.coalescedCount, 2);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).fromValue, []);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).toValue, []);
});

void test("card label activity hides quick remove then add correction", async () => {
  const f = await seedLabelActivityFixture("label-correction-remove-add");
  await db.insert(cardLabelAssignments).values({ cardId: f.card.id, labelId: f.bug.id });

  await f.setLabels([]);
  await f.setLabels([f.bug.id]);

  const rows = await f.labelActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, false);
  assert.equal(rows[0]!.coalescedCount, 2);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).fromValue, [f.bug.id]);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).toValue, [f.bug.id]);
});

void test("card label activity coalesces quick different-label changes into visible net change", async () => {
  const f = await seedLabelActivityFixture("label-correction-different-labels");
  await db.insert(cardLabelAssignments).values({ cardId: f.card.id, labelId: f.bug.id });

  await f.setLabels([]);
  await f.setLabels([f.urgent.id]);

  const rows = await f.labelActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, true);
  assert.equal(rows[0]!.coalescedCount, 2);
  const payload = rows[0]!.payload as Record<string, unknown>;
  assert.deepEqual(payload.fromValue, [f.bug.id]);
  assert.deepEqual(payload.toValue, [f.urgent.id]);
  assert.deepEqual(payload.addedLabelNames, ["Urgent"]);
  assert.deepEqual(payload.removedLabelNames, ["Bug"]);
});

void test("card assignee activity hides quick assign then unassign correction", async () => {
  const f = await seedAssigneeActivityFixture("assignee-correction-add-remove");

  await f.setAssignees([f.jacques.id]);
  await f.setAssignees([]);

  const rows = await f.assigneeActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, false);
  assert.equal(rows[0]!.coalescedCount, 2);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).fromValue, []);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).toValue, []);
});

void test("card assignee activity hides quick unassign then reassign correction", async () => {
  const f = await seedAssigneeActivityFixture("assignee-correction-remove-add");
  await db.insert(cardAssignees).values({ cardId: f.card.id, userId: f.jacques.id });

  await f.setAssignees([]);
  await f.setAssignees([f.jacques.id]);

  const rows = await f.assigneeActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, false);
  assert.equal(rows[0]!.coalescedCount, 2);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).fromValue, [f.jacques.id]);
  assert.deepEqual((rows[0]!.payload as Record<string, unknown>).toValue, [f.jacques.id]);
});

void test("card assignee activity coalesces quick additive changes into one visible row", async () => {
  const f = await seedAssigneeActivityFixture("assignee-correction-additive");

  await f.setAssignees([f.jacques.id]);
  await f.setAssignees([f.jacques.id, f.amelia.id]);

  const rows = await f.assigneeActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, true);
  assert.equal(rows[0]!.coalescedCount, 2);
  const payload = rows[0]!.payload as Record<string, unknown>;
  assert.deepEqual(payload.fromValue, []);
  assert.deepEqual(payload.toValue, [f.amelia.id, f.jacques.id].sort());
  assert.deepEqual(payload.assigneeNamesById, {
    [f.jacques.id]: "Jacques Nieuwoudt",
    [f.amelia.id]: "Amelia Stone",
  });
});

void test("card assignee activity coalesces quick assignee swaps into net change", async () => {
  const f = await seedAssigneeActivityFixture("assignee-correction-swap");
  await db.insert(cardAssignees).values({ cardId: f.card.id, userId: f.jacques.id });

  await f.setAssignees([]);
  await f.setAssignees([f.amelia.id]);

  const rows = await f.assigneeActivityRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.feedVisible, true);
  assert.equal(rows[0]!.coalescedCount, 2);
  const payload = rows[0]!.payload as Record<string, unknown>;
  assert.deepEqual(payload.fromValue, [f.jacques.id]);
  assert.deepEqual(payload.toValue, [f.amelia.id]);
  assert.deepEqual(payload.assigneeNamesById, {
    [f.jacques.id]: "Jacques Nieuwoudt",
    [f.amelia.id]: "Amelia Stone",
  });
});

void test("assigning a checklist item does not add the user to card assignees but still notifies them", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Checklist Decouple",
      email: "owner-checklist-decouple@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  // Workspace members are assignable without explicit board membership.
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Parent card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, title: "Tasks", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const [item] = await db
    .insert(cardChecklistItems)
    .values({ checklistId: checklist.id, text: "Do the thing", position: "1000.0000000000" })
    .returning();
  assert.ok(item);

  const [assignee] = await db
    .insert(users)
    .values({ clientId: user.clientId, email: "assignee-checklist-decouple@example.com", passwordHash: "x", displayName: "Assignee" })
    .returning();
  assert.ok(assignee);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: assignee.id, role: "member" });
  // Only non-observer board members can be assigned work, including checklist items.
  await db.insert(boardMembers).values({ boardId: board.id, userId: assignee.id, role: "editor" });

  const patched = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: ownerAuth,
    payload: { assigneeId: assignee.id },
  });
  assert.equal(patched.statusCode, 200);

  // Decoupled: the checklist item carries the assignee, but the parent card's assignees are untouched.
  const [storedItem] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.id, item.id)).limit(1);
  assert.equal(storedItem!.assigneeId, assignee.id);
  const cardAssigneeRows = await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id));
  assert.equal(cardAssigneeRows.length, 0);

  // The assignee still gets a direct "assigned" notification. syncDirectNotificationForActivity is
  // fire-and-forget, so poll briefly for it.
  let assignedNotification: { reason: string } | undefined;
  for (let attempt = 0; attempt < 40 && !assignedNotification; attempt += 1) {
    const rows = await db
      .select({ reason: notifications.reason })
      .from(notifications)
      .where(and(eq(notifications.cardId, card.id), eq(notifications.userId, assignee.id)));
    assignedNotification = rows[0];
    if (!assignedNotification) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(assignedNotification, "expected an assigned notification for the checklist assignee");
  assert.equal(assignedNotification!.reason, "assigned");
});

void test("bulk checklist item assignment updates all items and records one activity", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Checklist Bulk",
      email: "owner-checklist-bulk@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: ownerAuth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Parent card", position: "1000.0000000000", createdById: user.id })
    .returning();
  assert.ok(card);
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, title: "Tasks", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const insertedItems = await db
    .insert(cardChecklistItems)
    .values([
      { checklistId: checklist.id, text: "One", position: "1000.0000000000" },
      { checklistId: checklist.id, text: "Two", position: "2000.0000000000" },
      { checklistId: checklist.id, text: "Three", position: "3000.0000000000" },
    ])
    .returning();
  assert.equal(insertedItems.length, 3);

  const [assignee] = await db
    .insert(users)
    .values({ clientId: user.clientId, email: "assignee-checklist-bulk@example.com", passwordHash: "x", displayName: "Assignee" })
    .returning();
  assert.ok(assignee);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: assignee.id, role: "member" });
  // Only non-observer board members can be assigned work, including checklist items.
  await db.insert(boardMembers).values({ boardId: board.id, userId: assignee.id, role: "editor" });

  const patched = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/bulk`,
    headers: ownerAuth,
    payload: { assigneeId: assignee.id },
  });
  assert.equal(patched.statusCode, 200);
  const body = patched.json<{ items: { id: string; assigneeId: string | null }[] }>();
  assert.deepEqual(body.items.map((item) => item.id).sort(), insertedItems.map((item) => item.id).sort());
  assert.ok(body.items.every((item) => item.assigneeId === assignee.id));

  const storedItems = await db
    .select({ id: cardChecklistItems.id, assigneeId: cardChecklistItems.assigneeId })
    .from(cardChecklistItems)
    .where(eq(cardChecklistItems.checklistId, checklist.id));
  assert.equal(storedItems.length, 3);
  assert.ok(storedItems.every((item) => item.assigneeId === assignee.id));

  const activities = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, ACTIVITY_ACTION.CHECKLIST_ITEM_ASSIGNEE_SET)));
  assert.equal(activities.length, 1);
  assert.equal((activities[0]!.payload as { bulk?: boolean; itemCount?: number }).bulk, true);
  assert.equal((activities[0]!.payload as { bulk?: boolean; itemCount?: number }).itemCount, 3);
});

void test("single and bulk card archive delete card notifications and emit recipient-scoped removal events", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: {
    orgName: "Acme Archive Notifications", email: "owner-archive-notifications@example.com",
    password: "Abc12345", displayName: "Owner",
  } });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceResponse = await app.inject({
    method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" },
  });
  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db.insert(boards).values({
    workspaceId: workspace.id, name: "Board", position: "1000.0000000000",
  }).returning();
  assert.ok(board);
  const [recipient] = await db.insert(users).values({
    clientId: user.clientId, email: "recipient-archive-notifications@example.com",
    passwordHash: "x", displayName: "Recipient",
  }).returning();
  assert.ok(recipient);
  const [singleCard, bulkCard, unrelatedCard] = await db.insert(cards).values([
    { listId: list.id, boardId: board.id, title: "Single", position: "1000.0000000000", createdById: user.id },
    { listId: list.id, boardId: board.id, title: "Bulk", position: "2000.0000000000", createdById: user.id },
    { listId: list.id, boardId: board.id, title: "Keep", position: "3000.0000000000", createdById: user.id },
  ]).returning();
  assert.ok(singleCard && bulkCard && unrelatedCard);
  const insertedNotifications = await db.insert(notifications).values([
    { userId: user.id, cardId: singleCard.id, listId: list.id, boardId: board.id, workspaceId: workspace.id, reason: NOTIFICATION_REASON.ASSIGNED },
    { userId: recipient.id, cardId: singleCard.id, listId: list.id, boardId: board.id, workspaceId: workspace.id, reason: NOTIFICATION_REASON.WATCHING },
    { userId: user.id, cardId: bulkCard.id, listId: list.id, boardId: board.id, workspaceId: workspace.id, reason: NOTIFICATION_REASON.ASSIGNED },
    { userId: user.id, cardId: unrelatedCard.id, listId: list.id, boardId: board.id, workspaceId: workspace.id, reason: NOTIFICATION_REASON.ASSIGNED },
  ]).returning();

  const singleArchived = await app.inject({
    method: "PATCH", url: `/cards/${singleCard.id}/archive`, headers: auth, payload: { archived: true },
  });
  assert.equal(singleArchived.statusCode, 200);
  assert.equal(await db.$count(notifications, eq(notifications.cardId, singleCard.id)), 0);

  const bulkArchived = await app.inject({
    method: "PATCH", url: `/boards/${board.id}/cards/bulk/archive`, headers: auth,
    payload: { cardIds: [bulkCard.id], archived: true },
  });
  assert.equal(bulkArchived.statusCode, 200);
  assert.equal(await db.$count(notifications, eq(notifications.cardId, bulkCard.id)), 0);
  assert.equal(await db.$count(notifications, eq(notifications.cardId, unrelatedCard.id)), 1);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const count = await db.$count(directRealtimeOutbox, eq(directRealtimeOutbox.eventType, "notification:deleted"));
    if (count >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const deletionEvents = await db
    .select({ userId: directRealtimeOutbox.userId, payload: directRealtimeOutbox.payload })
    .from(directRealtimeOutbox)
    .where(eq(directRealtimeOutbox.eventType, "notification:deleted"));
  const ownerDeletedIds = deletionEvents.filter((event) => event.userId === user.id)
    .flatMap((event) => (event.payload as { notificationIds: string[] }).notificationIds);
  const recipientDeletedIds = deletionEvents.filter((event) => event.userId === recipient.id)
    .flatMap((event) => (event.payload as { notificationIds: string[] }).notificationIds);
  assert.deepEqual(ownerDeletedIds.sort(), [insertedNotifications[0]!.id, insertedNotifications[2]!.id].sort());
  assert.deepEqual(recipientDeletedIds, [insertedNotifications[1]!.id]);
  assert.ok(!ownerDeletedIds.includes(insertedNotifications[3]!.id));

  const unarchived = await app.inject({
    method: "PATCH", url: `/cards/${singleCard.id}/archive`, headers: auth, payload: { archived: false },
  });
  assert.equal(unarchived.statusCode, 200);
  assert.equal(await db.$count(notifications, eq(notifications.cardId, singleCard.id)), 0);
});
