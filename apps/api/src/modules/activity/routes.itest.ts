import "../../test/setup.integration.js";
import {
  activityEvents,
  boardMembers,
  boards,
  cardAssignees,
  cardChecklists,
  cardChecklistItems,
  cards,
  lists,
  notifications,
  users,
  workspaceMembers,
} from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let last = await read();
  for (let attempt = 0; attempt < 20 && !predicate(last); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    last = await read();
  }
  return last;
}

void test("board activity shows card creation before same-timestamp card activity", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Board Activity Order",
      email: "owner-board-activity-order@example.com",
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
  const [card] = await db
    .insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Ordered activity", position: "1000.0000000000", createdById: owner.id })
    .returning();
  assert.ok(card);

  const createdAt = new Date("2026-05-21T00:00:00.000Z");
  await db.insert(activityEvents).values([
    {
      boardId: board.id,
      workspaceId: workspace.id,
      actorId: owner.id,
      entityType: "card",
      entityId: card.id,
      action: "completed",
      payload: {},
      createdAt,
      updatedAt: createdAt,
    },
    {
      boardId: board.id,
      workspaceId: workspace.id,
      actorId: owner.id,
      entityType: "card",
      entityId: card.id,
      action: "created",
      payload: {},
      createdAt,
      updatedAt: createdAt,
    },
  ]);

  const activity = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/activity`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(activity.statusCode, 200);
  const body = activity.json<{ type: "activity"; data: { action: string } }[]>();
  assert.deepEqual(body.map((item) => item.data.action).slice(0, 2), ["created", "completed"]);
});

void test("checklist item creation and deletion do not create activity or notifications", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Activity",
      email: "owner-activity@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json();

  const [assignee] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "assignee-activity@example.com",
      passwordHash: "x",
      displayName: "Assignee",
    })
    .returning();
  assert.ok(assignee);

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: assignee.id,
    role: "member",
  });

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

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Checklist activity",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);

  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });

  const [checklist] = await db
    .insert(cardChecklists)
    .values({
      cardId: card.id,
      title: "Launch",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(checklist);

  const createItem = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/checklists/${checklist.id}/items`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { text: "Draft release note" },
  });
  assert.equal(createItem.statusCode, 201);

  const item = createItem.json();

  const [createdActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklistItem:created")))
    .orderBy(activityEvents.createdAt)
    .limit(1);
  assert.equal(createdActivity, undefined);

  const boardActivity = await app.inject({
    method: "GET",
    url: `/boards/${board.id}/activity`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(boardActivity.statusCode, 200);
  assert.equal(
    boardActivity.json().some((item: { type: string; data: { action?: string } }) =>
      item.type === "activity" && item.data.action === "checklistItem:created"
    ),
    false,
  );

  const createdNotifications = await db
    .select()
    .from(notifications)
    .innerJoin(activityEvents, eq(notifications.activityId, activityEvents.id))
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklistItem:created")));
  assert.equal(createdNotifications.length, 0);

  const deleteItem = await app.inject({
    method: "DELETE",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(deleteItem.statusCode, 204);

  const [deletedActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklistItem:deleted")))
    .orderBy(activityEvents.createdAt)
    .limit(1);
  assert.equal(deletedActivity, undefined);

  const deletedNotifications = await db
    .select()
    .from(notifications)
    .innerJoin(activityEvents, eq(notifications.activityId, activityEvents.id))
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklistItem:deleted")));
  assert.equal(deletedNotifications.length, 0);
});

void test("quickly deleting a newly created checklist hides the creation activity and removes notifications", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Checklist Mistake",
      email: "owner-checklist-mistake@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json();

  const [assignee] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "assignee-checklist-mistake@example.com",
      passwordHash: "x",
      displayName: "Assignee",
    })
    .returning();
  assert.ok(assignee);

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: assignee.id,
    role: "member",
  });

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

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Checklist mistake",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);

  await db.insert(cardAssignees).values({ cardId: card.id, userId: assignee.id });

  const createChecklist = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/checklists`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { title: "Accidental checklist" },
  });
  assert.equal(createChecklist.statusCode, 201);
  const checklist = createChecklist.json();

  const createdNotifications = await waitFor(
    () => db
      .select()
      .from(notifications)
      .innerJoin(activityEvents, eq(notifications.activityId, activityEvents.id))
      .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:created"))),
    (rows) => rows.length > 0,
  );
  assert.equal(createdNotifications.length, 1);

  const deleteChecklist = await app.inject({
    method: "DELETE",
    url: `/cards/${card.id}/checklists/${checklist.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(deleteChecklist.statusCode, 204);

  const [createdActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:created")))
    .limit(1);
  assert.ok(createdActivity);
  assert.equal(createdActivity.feedVisible, false);

  const [deletedActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:deleted")))
    .limit(1);
  assert.equal(deletedActivity, undefined);

  const remainingNotifications = await waitFor(
    () => db
      .select()
      .from(notifications)
      .innerJoin(activityEvents, eq(notifications.activityId, activityEvents.id))
      .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:created"))),
    (rows) => rows.length === 0,
  );
  assert.equal(remainingNotifications.length, 0);
});

void test("checklist deletion only logs and notifies when the checklist contained items", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Checklist Delete",
      email: "owner-checklist-delete@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json();

  const [deleter] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "deleter-checklist-delete@example.com",
      passwordHash: "x",
      displayName: "Deleter",
    })
    .returning();
  assert.ok(deleter);

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: deleter.id,
    role: "member",
  });

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
  // Board membership is the access model: the deleter needs an explicit board_member row to act.
  await db.insert(boardMembers).values({ boardId: board.id, userId: deleter.id, role: "editor" });

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Checklist delete",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: owner.id });

  const createChecklist = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/checklists`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { title: "Someone else's checklist" },
  });
  assert.equal(createChecklist.statusCode, 201);
  const checklist = createChecklist.json();
  const deleterToken = app.jwt.sign({ sub: deleter.id, cid: owner.clientId, role: "member" });

  const deleteChecklist = await app.inject({
    method: "DELETE",
    url: `/cards/${card.id}/checklists/${checklist.id}`,
    headers: { authorization: `Bearer ${deleterToken}` },
  });
  assert.equal(deleteChecklist.statusCode, 204);

  const [createdActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:created")))
    .limit(1);
  assert.ok(createdActivity);
  assert.equal(createdActivity.feedVisible, true);

  const [deletedActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:deleted")))
    .limit(1);
  assert.equal(deletedActivity, undefined);

  const emptyDeleteNotifications = await db
    .select()
    .from(notifications)
    .innerJoin(activityEvents, eq(notifications.activityId, activityEvents.id))
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:deleted")));
  assert.equal(emptyDeleteNotifications.length, 0);

  const createPopulatedChecklist = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/checklists`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { title: "Populated checklist" },
  });
  assert.equal(createPopulatedChecklist.statusCode, 201);
  const populatedChecklist = createPopulatedChecklist.json();

  const createItem = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/checklists/${populatedChecklist.id}/items`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { text: "Important work" },
  });
  assert.equal(createItem.statusCode, 201);

  const deletePopulatedChecklist = await app.inject({
    method: "DELETE",
    url: `/cards/${card.id}/checklists/${populatedChecklist.id}`,
    headers: { authorization: `Bearer ${deleterToken}` },
  });
  assert.equal(deletePopulatedChecklist.statusCode, 204);

  const [populatedDeletedActivity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:deleted")))
    .limit(1);
  assert.ok(populatedDeletedActivity);
  assert.equal(populatedDeletedActivity.actorId, deleter.id);

  const populatedDeleteNotifications = await waitFor(
    () => db
      .select({ userId: notifications.userId })
      .from(notifications)
      .innerJoin(activityEvents, eq(notifications.activityId, activityEvents.id))
      .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:deleted"))),
    (rows) => rows.length > 0,
  );
  assert.deepEqual(populatedDeleteNotifications, [{ userId: owner.id }]);
});

void test("completing the final checklist item records a checklist completion activity", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Checklist Complete",
      email: "owner-checklist-complete@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json();

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

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Checklist complete",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);

  const [checklist] = await db
    .insert(cardChecklists)
    .values({
      cardId: card.id,
      title: "Launch",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(checklist);

  const [doneItem, finalItem] = await db
    .insert(cardChecklistItems)
    .values([
      { checklistId: checklist.id, text: "Draft", position: "1000.0000000000", completedAt: new Date(), completedById: owner.id },
      { checklistId: checklist.id, text: "Publish", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(doneItem);
  assert.ok(finalItem);

  const completeFinal = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${finalItem.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { completed: true },
  });
  assert.equal(completeFinal.statusCode, 200);

  const [activity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:completed")))
    .limit(1);
  assert.ok(activity);
  assert.equal((activity.payload as { checklistId?: string }).checklistId, checklist.id);

  const uncompleteFinal = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${finalItem.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { completed: false },
  });
  assert.equal(uncompleteFinal.statusCode, 200);

  const completeFinalAgain = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${finalItem.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { completed: true },
  });
  assert.equal(completeFinalAgain.statusCode, 200);

  const activities = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:completed")));
  assert.equal(activities.length, 2);
  const retractedActivity = activities.find((row) => row.id === activity.id);
  const currentActivity = activities.find((row) => row.id !== activity.id);
  assert.ok(retractedActivity);
  assert.equal(retractedActivity.feedVisible, false);
  assert.equal(retractedActivity.coalescedCount, 1);
  assert.ok(currentActivity);
  assert.equal(currentActivity.feedVisible, true);
  assert.equal(currentActivity.coalescedCount, 1);

  const [parentItem] = await db
    .insert(cardChecklistItems)
    .values({ checklistId: checklist.id, text: "Ship release", position: "3000.0000000000" })
    .returning();
  assert.ok(parentItem);
  const [nestedChecklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, parentItemId: parentItem.id, title: "Final checks", position: "1000.0000000000" })
    .returning();
  assert.ok(nestedChecklist);
  const [nestedItem] = await db
    .insert(cardChecklistItems)
    .values({ checklistId: nestedChecklist.id, text: "Verify rollout", position: "1000.0000000000" })
    .returning();
  assert.ok(nestedItem);

  const completeNested = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${nestedChecklist.id}/items/${nestedItem.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { completed: true },
  });
  assert.equal(completeNested.statusCode, 200);

  const nestedActivities = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:completed")));
  const nestedActivity = nestedActivities.find((row) =>
    (row.payload as { checklistId?: string }).checklistId === nestedChecklist.id,
  );
  assert.ok(nestedActivity);
  assert.deepEqual(nestedActivity.payload, {
    checklistId: nestedChecklist.id,
    title: "Final checks",
    parentItemId: parentItem.id,
    parentItemText: "Ship release",
    fromValue: false,
    toValue: true,
  });
});
