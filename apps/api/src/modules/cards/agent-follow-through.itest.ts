import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { activityEvents, boardMembers, cardAssignees, cardLabelAssignments, cardLabels, cards, cardWatchers, emailQueue, lists, notifications, workspaceMembers } from "@kanera/shared/schema";
import type { NotificationInboxPage } from "@kanera/shared/dto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { waitForNotificationFanoutForTests } from "../../lib/notifications.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { mintAgentToken, signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

interface WireCard { id: string; title: string; listId: string; position: string; dueDateLocalDate: string | null; dueDateSlot: string | null }

async function setup() {
  const app = await buildIntegrationServer();
  const publicApi = await buildPublicApiServer({ enableWebhookDeliveryScheduler: false });
  const suffix = randomUUID();
  const owner = await signupOwner(app, { orgName: "Acme", displayName: "Owner", email: `owner-${suffix}@example.com` });
  const createdWorkspace = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery", initialBoard: { name: "Roadmap" } } });
  assert.equal(createdWorkspace.statusCode, 201, createdWorkspace.body);
  const ws = createdWorkspace.json<{ id: string; initialBoard: { id: string } }>();
  const [firstList] = await db.select().from(lists).where(eq(lists.workspaceId, ws.id)).orderBy(asc(lists.position)).limit(1);
  assert.ok(firstList);
  const workspace = { id: ws.id, boardId: ws.initialBoard.id, listId: firstList.id };
  const [member] = await insertTestUsers(db, { clientId: owner.user.clientId, email: `member-${suffix}@example.com`, passwordHash: "x", displayName: "Member" }).returning();
  assert.ok(member);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "member" });
  await db.insert(boardMembers).values([
    { boardId: workspace.boardId, userId: owner.user.id, role: "editor" },
    { boardId: workspace.boardId, userId: member.id, role: "editor" },
  ]).onConflictDoNothing();
  const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" })}` };
  const labels = await db.select().from(cardLabels).where(eq(cardLabels.workspaceId, workspace.id)).orderBy(asc(cardLabels.position));
  assert.ok(labels.length >= 1, "workspace seeds default labels");
  const agent = await mintAgentToken(publicApi, owner.user, "Claude");
  return { app, publicApi, owner, workspace, member, memberAuth, label: labels[0]!, agent };
}

// The inbox only reads rows a few seconds old so a forward cursor never steps past an uncommitted
// one; age every row for this user instead of sleeping.
async function settleNotifications(userId: string) {
  await waitForNotificationFanoutForTests();
  await db.update(notifications).set({ createdAt: sql`${notifications.createdAt} - interval '10 seconds'` }).where(eq(notifications.userId, userId));
}

void test("an agent creates fully described cards, alone or in bulk, and its owner watches them", async () => {
  const { publicApi, owner, workspace, member, label, agent } = await setup();

  const created = await publicApi.inject({
    method: "POST",
    url: `/api/v1/boards/${workspace.boardId}/lists/${workspace.listId}/cards`,
    headers: { authorization: agent.authorization },
    payload: { title: "Draft the launch post", labelIds: [label.id], assigneeIds: [member.id], dueDateLocalDate: "2026-12-01", dueDateSlot: "morning" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const card = created.json<WireCard>();
  assert.equal(card.dueDateLocalDate, "2026-12-01");
  assert.equal(card.dueDateSlot, "morning");
  assert.deepEqual((await db.select().from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, card.id))).map((row) => row.labelId), [label.id]);
  assert.deepEqual((await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id))).map((row) => row.userId), [member.id]);
  // The owner delegated this work, so they follow it.
  assert.deepEqual((await db.select().from(cardWatchers).where(eq(cardWatchers.cardId, card.id))).map((row) => row.userId), [owner.user.id]);
  const [createdActivity] = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "created")));
  assert.equal(createdActivity?.actorKind, "agent");
  assert.deepEqual((createdActivity?.payload as { labelIds?: string[] }).labelIds, [label.id]);

  const bulk = await publicApi.inject({
    method: "POST",
    url: `/api/v1/boards/${workspace.boardId}/cards/bulk/create`,
    headers: { authorization: agent.authorization },
    payload: { cards: [
      { listId: workspace.listId, title: "Plan step one", labelIds: [label.id] },
      { listId: workspace.listId, title: "Plan step two", assigneeIds: [member.id], dueDateLocalDate: "2026-12-02" },
    ] },
  });
  assert.equal(bulk.statusCode, 201, bulk.body);
  const result = bulk.json<{ created: number; cards: WireCard[] }>();
  assert.equal(result.created, 2);
  assert.deepEqual(result.cards.map((row) => row.title), ["Plan step one", "Plan step two"]);
  assert.ok(Number(result.cards[0]!.position) < Number(result.cards[1]!.position), "request order is list order");
  assert.ok(Number(card.position) < Number(result.cards[0]!.position), "bulk cards append to the bottom");
  assert.equal(result.cards[1]!.dueDateSlot, "anyTime");
  const watched = await db.select().from(cardWatchers).where(inArray(cardWatchers.cardId, result.cards.map((row) => row.id)));
  assert.equal(watched.length, 2);

  // One invalid card rejects the batch before anything is written, and says which one.
  const rejected = await publicApi.inject({
    method: "POST",
    url: `/api/v1/boards/${workspace.boardId}/cards/bulk/create`,
    headers: { authorization: agent.authorization },
    payload: { cards: [
      { listId: workspace.listId, title: "Never created" },
      { listId: workspace.listId, title: "Bad label", labelIds: [randomUUID()] },
    ] },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json<{ message: string }>().message, /^cards\[1\]: one or more label ids are invalid/);
  assert.equal((await db.select().from(cards).where(eq(cards.title, "Never created"))).length, 0);
});

void test("the owner hears about their agent's work by email, and the agent polls the inbox forward", async () => {
  const { app, publicApi, owner, workspace, memberAuth, agent } = await setup();
  const created = await publicApi.inject({
    method: "POST",
    url: `/api/v1/boards/${workspace.boardId}/lists/${workspace.listId}/cards`,
    headers: { authorization: agent.authorization },
    payload: { title: "Agent task" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const card = created.json<WireCard>();

  // An agent mentioning its owner reaches them by email (agents are never self-suppressed), named
  // the way the inbox chip reads.
  const mention = await publicApi.inject({
    method: "POST",
    url: `/api/v1/cards/${card.id}/comments`,
    headers: { authorization: agent.authorization },
    payload: { body: `@[Owner](kanera-user:${owner.user.id}) the draft is ready for review` },
  });
  assert.equal(mention.statusCode, 201, mention.body);
  const [mentionEmail] = await db.select().from(emailQueue).where(and(eq(emailQueue.toEmail, owner.email), eq(emailQueue.type, "comment_mentioned")));
  assert.equal((mentionEmail?.data as { actorName?: string } | undefined)?.actorName, "Owner via Claude");

  const reply = await app.inject({ method: "POST", url: `/cards/${card.id}/comments`, headers: memberAuth, payload: { body: "Looks good, ship it" } });
  assert.equal(reply.statusCode, 201, reply.body);
  await settleNotifications(owner.user.id);

  const poll = async (query: string) => {
    const response = await publicApi.inject({ method: "GET", url: `/api/v1/notifications${query}`, headers: { authorization: agent.authorization } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<NotificationInboxPage>();
  };

  // By default the agent reads back only what other people did: the reply, not its own writes.
  const baseline = await poll("");
  assert.ok(baseline.items.length >= 1);
  assert.ok(baseline.items.every((item) => item.actor?.self !== true), "own writes are filtered out");
  const replyItem = baseline.items.find((item) => item.commentExcerpt === "Looks good, ship it");
  assert.ok(replyItem, "the member's reply reaches the agent");
  assert.equal(replyItem.card?.id, card.id);
  assert.match(replyItem.summary, /^Member /);

  const withSelf = await poll("?includeSelf=true");
  const selfItem = withSelf.items.find((item) => item.actor?.self);
  assert.ok(selfItem, "includeSelf returns the agent's own writes");
  assert.equal(selfItem.actor?.agentName, "Claude");
  assert.match(selfItem.summary, /^Owner via Claude /);

  // Forward polling: nothing new, then exactly the next reply.
  const quiet = await poll(`?since=${encodeURIComponent(baseline.cursor)}`);
  assert.deepEqual(quiet.items, []);
  assert.equal(quiet.cursor, baseline.cursor, "an empty poll keeps the cursor");
  const second = await app.inject({ method: "POST", url: `/cards/${card.id}/comments`, headers: memberAuth, payload: { body: "One more thing" } });
  assert.equal(second.statusCode, 201);
  await settleNotifications(owner.user.id);
  const next = await poll(`?since=${encodeURIComponent(quiet.cursor)}`);
  assert.deepEqual(next.items.map((item) => item.commentExcerpt), ["One more thing"]);
  assert.equal(next.hasMore, false);
});
