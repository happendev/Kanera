import "../../test/setup.integration.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  activityEvents, boardMembers, boardWatchers, boards, cardAssignees, cardChecklistItems,
  cardChecklists, cardPriorities, cardWatchers, cards, clientGuestSeats, clients,
  directRealtimeOutbox, emailQueue, eventOutbox, lists, notifications, pushQueue, userNotificationWorkspaceRules, workspaceMembers,
} from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { insertTestNotifications } from "../../test/notification-fixtures.js";
import { enrichNotifications } from "../../lib/notifications.js";

void test("self-leave authorisation, cleanup, mandatory deduplicated admin alerts and durable events", async () => {
  const app = await buildIntegrationServer();
  const { user: owner, auth } = await signupOwner(app, { orgName: "Leaving", email: "leave-owner@example.com", displayName: "Owner" });
  const ws = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Leaving" } });
  assert.equal(ws.statusCode, 201);
  const workspaceId = ws.json<{ id: string }>().id;
  const created = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/boards`, headers: auth, payload: { name: "Leave me" } });
  assert.equal(created.statusCode, 201);
  const boardId = created.json<{ id: string }>().id;
  const [admin, orgAdmin, editor, observer] = await insertTestUsers(db, [
    { clientId: owner.clientId, email: "leave-admin@example.com", passwordHash: "hash", displayName: "Workspace admin" },
    { clientId: owner.clientId, email: "leave-org-admin@example.com", passwordHash: "hash", displayName: "Org admin", clientRole: "admin" },
    { clientId: owner.clientId, email: "leave-editor@example.com", passwordHash: "hash", displayName: "Editor" },
    { clientId: owner.clientId, email: "leave-observer@example.com", passwordHash: "hash", displayName: "Observer" },
    { clientId: owner.clientId, email: "leave-suspended-admin@example.com", passwordHash: "hash", displayName: "Suspended", clientRole: "admin", suspendedAt: new Date() },
    { clientId: owner.clientId, email: "leave-removed-admin@example.com", passwordHash: "hash", displayName: "Removed", clientRole: "admin", removedAt: new Date() },
  ]).returning();
  assert.ok(admin && orgAdmin && editor && observer);
  await db.insert(workspaceMembers).values([
    { workspaceId, userId: admin.id, role: "admin" },
    { workspaceId, userId: editor.id, role: "member" },
    { workspaceId, userId: observer.id, role: "member" },
  ]);
  await db.insert(boardMembers).values([
    { boardId, userId: admin.id, role: "editor", pinned: true },
    { boardId, userId: orgAdmin.id, role: "editor" },
    { boardId, userId: editor.id, role: "editor" },
    { boardId, userId: observer.id, role: "observer" },
  ]);
  const headers = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: userId, cid: owner.clientId, role: "member" })}` });
  const remove = (callerId: string, targetId = callerId) => app.inject({ method: "DELETE", url: `/boards/${boardId}/members/${targetId}`, headers: headers(callerId) });
  assert.equal((await remove(editor.id, observer.id)).statusCode, 403);
  for (const inherited of [owner, admin, orgAdmin]) assert.equal((await remove(inherited.id)).statusCode, 400);
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId));
  assert.ok(list);
  const [card] = await db.insert(cards).values({ boardId, listId: list.id, title: "Participation", position: "1000", createdById: owner.id }).returning();
  assert.ok(card);
  await db.insert(cardAssignees).values({ cardId: card.id, userId: editor.id });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: editor.id });
  await db.insert(boardWatchers).values({ boardId, userId: editor.id });
  await db.insert(cardPriorities).values({ cardId: card.id, targetUserId: editor.id, createdById: owner.id, position: "1000" });
  const [checklist] = await db.insert(cardChecklists).values({ cardId: card.id, title: "Tasks", position: "1000" }).returning();
  assert.ok(checklist);
  const [item] = await db.insert(cardChecklistItems).values({ checklistId: checklist.id, text: "Assigned", assigneeId: editor.id, position: "1000" }).returning();
  assert.ok(item);
  await insertTestNotifications(db, { userId: editor.id, cardId: card.id, boardId, workspaceId, reason: "assigned" });
  await db.insert(userNotificationWorkspaceRules).values({ userId: owner.id, workspaceId, paused: true });
  const emailsBefore = await db.$count(emailQueue);
  const pushesBefore = await db.$count(pushQueue);
  assert.equal((await remove(editor.id)).statusCode, 204);
  assert.equal(await db.$count(emailQueue), emailsBefore, "administrative alerts are in-app only");
  assert.equal(await db.$count(pushQueue), pushesBefore, "administrative alerts never enqueue push");
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, editor.id))), 0);
  assert.equal(await db.$count(cardAssignees, eq(cardAssignees.userId, editor.id)), 0);
  assert.equal(await db.$count(cardWatchers, eq(cardWatchers.userId, editor.id)), 0);
  assert.equal(await db.$count(boardWatchers, eq(boardWatchers.userId, editor.id)), 0);
  assert.equal(await db.$count(cardPriorities, eq(cardPriorities.targetUserId, editor.id)), 0);
  assert.equal(await db.$count(notifications, eq(notifications.userId, editor.id)), 0);
  const [cleanItem] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.id, item.id));
  assert.equal(cleanItem?.assigneeId, null);
  assert.equal(await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, editor.id))), 1, "leaving preserves workspace membership");
  const alerts = await db.select().from(notifications).where(and(eq(notifications.boardId, boardId), eq(notifications.reason, "board_member_left")));
  assert.deepEqual(alerts.map(row => row.userId).sort(), [owner.id, admin.id, orgAdmin.id].sort());
  const inbox = await app.inject({ method: "GET", url: `/notifications?boardId=${boardId}`, headers: auth });
  assert.equal(inbox.statusCode, 200);
  assert.equal(inbox.json<{ items: { reason: string }[] }>().items[0]?.reason, "board_member_left", "paused card preferences do not hide administrative alerts");
  const enriched = await enrichNotifications(db, alerts.map(row => row.id));
  for (const row of enriched) {
    assert.equal(row.cardId, null);
    assert.equal(row.boardName, "Leave me");
    assert.equal(row.actorName, "Editor");
    assert.deepEqual(row.activity?.payload, { userId: editor.id, role: "editor", voluntary: true, seatImpact: "none" });
  }
  assert.equal(await db.$count(eventOutbox, and(eq(eventOutbox.boardId, boardId), eq(eventOutbox.eventType, "board:member:removed"))), 1);
  assert.equal(await db.$count(directRealtimeOutbox, and(eq(directRealtimeOutbox.userId, editor.id), eq(directRealtimeOutbox.eventType, "board:member:removed"))), 1);
  assert.equal((await remove(observer.id)).statusCode, 204);
  // Admin removals keep their established audit semantics and do not create leave alerts.
  await db.insert(boardMembers).values({ boardId, userId: observer.id, role: "observer" });
  const count = await db.$count(notifications, eq(notifications.reason, "board_member_left"));
  assert.equal((await remove(owner.id, observer.id)).statusCode, 204);
  assert.equal(await db.$count(notifications, eq(notifications.reason, "board_member_left")), count);
  const activities = await db.select().from(activityEvents).where(and(eq(activityEvents.boardId, boardId), eq(activityEvents.actorId, owner.id), eq(activityEvents.action, "removed")));
  assert.deepEqual(activities.at(-1)?.payload, { userId: observer.id, role: "observer" });
});

void test("guest self-leave retains then frees used capacity without changing purchased seats", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousAllowance = env.HOSTED_FREE_MAX_GUEST_BOARDS;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_MAX_GUEST_BOARDS = 1;
  try {
    const app = await buildIntegrationServer();
    const { user: owner, auth } = await signupOwner(app, { orgName: "Guest leave host", email: "guest-leave-host@example.com", displayName: "Owner" });
    const { user: guest, auth: guestAuth } = await signupOwner(app, { orgName: "Guest home", email: "guest-leave@example.com", displayName: "Guest" });
    const ws = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Guest leave" } });
    assert.equal(ws.statusCode, 201);
    const workspaceId = ws.json<{ id: string }>().id;
    const rows = await db.insert(boards).values([1, 2, 3].map(n => ({ workspaceId, name: `Guest board ${n}`, position: String(n * 1000) }))).returning();
    await db.insert(boardMembers).values(rows.map(row => ({ boardId: row.id, userId: guest.id, role: "editor" as const })));
    await db.insert(clientGuestSeats).values({ clientId: owner.clientId, userId: guest.id });
    await db.update(clients).set({ billingStatus: "active", seatLimit: 5 }).where(eq(clients.id, owner.clientId));
    for (const [index, impact] of ["guest_capacity_retained", "guest_capacity_freed", "none"].entries()) {
      const boardId = rows[index]!.id;
      const result = await app.inject({ method: "DELETE", url: `/boards/${boardId}/members/${guest.id}`, headers: guestAuth });
      assert.equal(result.statusCode, 204, result.body);
      assert.equal(await db.$count(clientGuestSeats, eq(clientGuestSeats.userId, guest.id)), index === 0 ? 1 : 0);
      const [host] = await db.select().from(clients).where(eq(clients.id, owner.clientId));
      assert.equal(host?.seatLimit, 5);
      const alerts = await db.select().from(notifications).where(and(eq(notifications.boardId, boardId), eq(notifications.reason, "board_member_left")));
      assert.equal(alerts.length, 1);
      const [enriched] = await enrichNotifications(db, alerts.map(row => row.id));
      assert.deepEqual(enriched?.activity?.payload, { userId: guest.id, role: "editor", voluntary: true, seatImpact: impact });
    }
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_MAX_GUEST_BOARDS = previousAllowance;
  }
});
