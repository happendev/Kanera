import "../../test/setup.integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import type {
  WorkPrioritiesResponse,
  WorkPriorityQueueSnapshot,
  WorkPriorityQueuesResponse,
  WorkPriorityTargetsResponse,
  WorkQueryResponse,
} from "@kanera/shared/dto";
import {
  activityEvents,
  boardMembers,
  boards,
  cardAssignees,
  cardPriorities,
  cards,
  clients,
  directRealtimeOutbox,
  lists,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import type { AuthClaims } from "../../auth/plugin.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { runCompletedPriorityCleanup } from "../../lib/completed-priority-cleanup.js";
import { buildIntegrationServer } from "../../test/integration.js";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * Two organisations, three workspaces, a restricted board and a guest board.
 *
 * The important asymmetry: `wsAdmin` administers `wsA` but is only a plain member of `wsB`, and is
 * not a member of the partner org's guest board at all. That single fixture exercises the whole
 * per-card authorisation rule and the redaction path in one queue.
 */
async function seed() {
  const app = await buildIntegrationServer();
  const [homeClient, partnerClient] = await db.insert(clients).values([
    { name: "Home org" },
    { name: "Partner org" },
  ]).returning();
  const [orgAdmin, wsAdmin, plainMember, target, partner] = await insertTestUsers(db, [
    { clientId: homeClient!.id, email: "owner@prio.test", passwordHash: "x", displayName: "Org owner", clientRole: "owner" },
    { clientId: homeClient!.id, email: "wsadmin@prio.test", passwordHash: "x", displayName: "Workspace admin", clientRole: "member" },
    { clientId: homeClient!.id, email: "member@prio.test", passwordHash: "x", displayName: "Plain member", clientRole: "member" },
    { clientId: homeClient!.id, email: "target@prio.test", passwordHash: "x", displayName: "Target", clientRole: "member" },
    { clientId: partnerClient!.id, email: "partner@prio.test", passwordHash: "x", displayName: "Partner", clientRole: "owner" },
  ]).returning();

  const [wsA, wsB, wsP] = await db.insert(workspaces).values([
    { clientId: homeClient!.id, name: "Delivery" },
    { clientId: homeClient!.id, name: "Product" },
    { clientId: partnerClient!.id, name: "Partner space" },
  ]).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: wsA!.id, userId: wsAdmin!.id, role: "admin" },
    { workspaceId: wsA!.id, userId: plainMember!.id, role: "member" },
    { workspaceId: wsA!.id, userId: target!.id, role: "member" },
    // Only a member here: the same admin must be forbidden from ranking wsB cards.
    { workspaceId: wsB!.id, userId: wsAdmin!.id, role: "member" },
    { workspaceId: wsB!.id, userId: target!.id, role: "member" },
    { workspaceId: wsP!.id, userId: partner!.id, role: "admin" },
  ]);

  const [listA, listB, listP] = await db.insert(lists).values([
    { workspaceId: wsA!.id, name: "Doing", position: "1000.0000000000" },
    { workspaceId: wsB!.id, name: "Doing", position: "1000.0000000000" },
    { workspaceId: wsP!.id, name: "Doing", position: "1000.0000000000" },
  ]).returning();

  const [boardA, boardB, guestBoard] = await db.insert(boards).values([
    { workspaceId: wsA!.id, name: "Delivery board", position: "1000.0000000000" },
    { workspaceId: wsB!.id, name: "Product board", position: "1000.0000000000" },
    { workspaceId: wsP!.id, name: "Guest launch", position: "1000.0000000000" },
  ]).returning();
  await db.insert(boardMembers).values([
    { boardId: boardA!.id, userId: wsAdmin!.id, role: "editor" },
    { boardId: boardA!.id, userId: plainMember!.id, role: "editor" },
    { boardId: boardA!.id, userId: target!.id, role: "editor" },
    // wsAdmin can see these cards but has no admin authority over wsB.
    { boardId: boardB!.id, userId: wsAdmin!.id, role: "editor" },
    { boardId: boardB!.id, userId: target!.id, role: "editor" },
    // wsAdmin is deliberately absent: this is the entry that must come back redacted.
    { boardId: guestBoard!.id, userId: target!.id, role: "observer" },
    { boardId: guestBoard!.id, userId: partner!.id, role: "editor" },
  ]);

  const [cardA1, cardA2, cardB1, cardG1, unassigned] = await db.insert(cards).values([
    { boardId: boardA!.id, listId: listA!.id, title: "DEV-726", position: "1000.0000000000", createdById: target!.id },
    { boardId: boardA!.id, listId: listA!.id, title: "DEV-564", position: "2000.0000000000", createdById: target!.id },
    { boardId: boardB!.id, listId: listB!.id, title: "DEV-755", position: "1000.0000000000", createdById: target!.id },
    { boardId: guestBoard!.id, listId: listP!.id, title: "DEV-901", position: "1000.0000000000", createdById: partner!.id },
    { boardId: boardA!.id, listId: listA!.id, title: "Nobody's card", position: "3000.0000000000", createdById: target!.id },
  ]).returning();
  await db.insert(cardAssignees).values([
    { cardId: cardA1!.id, userId: target!.id },
    { cardId: cardA2!.id, userId: target!.id },
    { cardId: cardB1!.id, userId: target!.id },
    { cardId: cardG1!.id, userId: target!.id },
  ]);

  // `isOrgAdmin` reads the JWT role claim (the same way loadVisibleGlobalWorkSeparators does), so an
  // org owner's token must carry it or they are indistinguishable from a plain member.
  const token = (
    userId: string,
    clientId: string,
    role: "member" | "owner" = "member",
    extra: Partial<AuthClaims> = {},
  ) => app.jwt.sign({ sub: userId, cid: clientId, role, ...extra });
  return {
    app,
    orgAdmin: orgAdmin!,
    wsAdmin: wsAdmin!,
    plainMember: plainMember!,
    target: target!,
    wsA: wsA!,
    wsB: wsB!,
    boardA: boardA!,
    boardB: boardB!,
    guestBoard: guestBoard!,
    listA: listA!,
    cardA1: cardA1!,
    cardA2: cardA2!,
    cardB1: cardB1!,
    cardG1: cardG1!,
    unassigned: unassigned!,
    orgAdminToken: token(orgAdmin!.id, homeClient!.id, "owner"),
    wsAdminToken: token(wsAdmin!.id, homeClient!.id),
    wsAdminWorkspaceReadToken: token(wsAdmin!.id, homeClient!.id, "member", {
      authKind: "apiKey", apiKeyKind: "workspace", apiKeyScope: "read", apiKeyWorkspaceId: wsA!.id,
    }),
    wsAdminWorkspaceWriteToken: token(wsAdmin!.id, homeClient!.id, "member", {
      authKind: "apiKey", apiKeyKind: "workspace", apiKeyScope: "write", apiKeyWorkspaceId: wsA!.id,
    }),
    wsAdminPersonalReadToken: token(wsAdmin!.id, homeClient!.id, "member", {
      authKind: "apiKey", apiKeyKind: "personal", apiKeyScope: "read",
    }),
    plainMemberToken: token(plainMember!.id, homeClient!.id),
    targetToken: token(target!.id, homeClient!.id),
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function addPriority(f: Fixture, token: string, cardId: string, anchors: Record<string, unknown> = { beforeId: null }) {
  return f.app.inject({
    method: "POST",
    url: `/work/priorities/${f.target.id}/cards`,
    headers: auth(token),
    payload: { cardId, ...anchors },
  });
}

async function readQueue(f: Fixture, token: string, query = ""): Promise<WorkPrioritiesResponse> {
  const response = await f.app.inject({
    method: "GET",
    url: `/work/priorities/${f.target.id}${query}`,
    headers: auth(token),
  });
  assert.equal(response.statusCode, 200);
  return response.json<WorkPrioritiesResponse>();
}

void test("a priority queue spans workspaces and orders cards from different boards", async () => {
  const f = await seed();
  assert.equal((await addPriority(f, f.targetToken, f.cardA1.id)).statusCode, 201);
  assert.equal((await addPriority(f, f.targetToken, f.cardB1.id)).statusCode, 201);
  assert.equal((await addPriority(f, f.targetToken, f.cardA2.id)).statusCode, 201);

  const queue = await readQueue(f, f.targetToken);
  assert.deepEqual(queue.items.map((item) => item.card?.title), ["DEV-726", "DEV-755", "DEV-564"]);
  assert.deepEqual(queue.items.map((item) => item.rank), [1, 2, 3]);
  assert.equal(queue.totalCount, 3);
  assert.equal(queue.hiddenCount, 0);
  assert.equal(queue.canReorder, true);
  // Two different workspaces in one position order is the whole point of not keying by workspace.
  assert.deepEqual(
    [...new Set(queue.items.map((item) => item.card?.workspaceId))].sort(),
    [f.wsA.id, f.wsB.id].sort(),
  );
});

void test("write authorisation is per card, against that card's own workspace", async () => {
  const f = await seed();

  // Admin of wsA: allowed on a wsA card...
  assert.equal((await addPriority(f, f.wsAdminToken, f.cardA1.id)).statusCode, 201);
  // ...and forbidden on a wsB card in the same person's queue, where they are only a member.
  const forbidden = await addPriority(f, f.wsAdminToken, f.cardB1.id);
  assert.equal(forbidden.statusCode, 403);
  assert.ok(!forbidden.body.includes("Product"), "the 403 body must not enumerate workspaces");
  assert.ok(!forbidden.body.includes(f.wsB.id));

  // Org owners/admins pass in every workspace of their organisation.
  assert.equal((await addPriority(f, f.orgAdminToken, f.cardB1.id)).statusCode, 201);
  // A plain member may not sequence someone else's work.
  assert.equal((await addPriority(f, f.plainMemberToken, f.cardA2.id)).statusCode, 403);

  // Anyone may always rank for themselves.
  const own = await f.app.inject({
    method: "POST",
    url: `/work/priorities/${f.plainMember.id}/cards`,
    headers: auth(f.plainMemberToken),
    payload: { cardId: f.cardA1.id, beforeId: null },
  });
  // ...provided the card is actually theirs; it is not, so this is the assignment guard, not access.
  assert.equal(own.statusCode, 400);
});

void test("creating an entry validates assignment and card visibility", async () => {
  const f = await seed();

  const notAssigned = await addPriority(f, f.targetToken, f.unassigned.id);
  assert.equal(notAssigned.statusCode, 400);
  assert.match(notAssigned.json<{ message?: string }>().message ?? "", /not assigned/);

  // A card on a board the actor is not a member of must not be distinguishable from one that is
  // absent: assertCardAccess owns that, and it runs before the target-user authorisation gate, so a
  // 403 would confirm the card exists.
  const invisible = await addPriority(f, f.plainMemberToken, f.cardB1.id);
  // assertCardAccess owns this and runs before the target-user gate, so the denial is about the card,
  // not the queue. It is deliberately opaque: the response must disclose nothing about the card.
  assert.ok([403, 404].includes(invisible.statusCode), invisible.body);
  assert.ok(!invisible.body.includes("DEV-755"));
  assert.ok(!invisible.body.includes(f.boardB.id));

  assert.equal((await addPriority(f, f.targetToken, f.cardA1.id)).statusCode, 201);
  // A defined conflict, not a unique-index violation surfacing as an internal error.
  const duplicate = await addPriority(f, f.targetToken, f.cardA1.id);
  assert.equal(duplicate.statusCode, 409);
  const rows = await db.select().from(cardPriorities).where(eq(cardPriorities.cardId, f.cardA1.id));
  assert.equal(rows.length, 1);

  // The queue is live work: a completed or archived card would be a dormant entry invisible to the
  // very client that asked for it, so the add is rejected instead.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.cardA2.id));
  const completed = await addPriority(f, f.targetToken, f.cardA2.id);
  assert.equal(completed.statusCode, 400);
  assert.match(completed.json<{ message?: string }>().message ?? "", /completed or archived/);
  await db.update(cards).set({ completedAt: null, archivedAt: new Date() }).where(eq(cards.id, f.cardA2.id));
  assert.equal((await addPriority(f, f.targetToken, f.cardA2.id)).statusCode, 400);

  // Exactly one anchor: both names two different edges, and two ids has no defined winner.
  assert.equal((await addPriority(f, f.targetToken, f.cardB1.id, { afterId: null, beforeId: null })).statusCode, 400);
  assert.equal((await addPriority(f, f.targetToken, f.cardB1.id, {})).statusCode, 400);
});

void test("the queue is capped at 50 entries", async () => {
  const f = await seed();
  const filler = await db.insert(cards).values(
    Array.from({ length: 50 }, (_, index) => ({
      boardId: f.boardA.id,
      listId: f.listA.id,
      title: `Filler ${index}`,
      position: `${(index + 10) * 1000}.0000000000`,
      createdById: f.target.id,
    })),
  ).returning();
  await db.insert(cardAssignees).values(filler.map((card) => ({ cardId: card.id, userId: f.target.id })));
  await db.insert(cardPriorities).values(filler.map((card, index) => ({
    targetUserId: f.target.id,
    cardId: card.id,
    position: `${(index + 1) * 1000}.0000000000`,
    createdById: f.target.id,
  })));

  const overflow = await addPriority(f, f.targetToken, f.cardA1.id);
  assert.equal(overflow.statusCode, 400);
  assert.match(overflow.json<{ message?: string }>().message ?? "", /at most 50/);

  // The cap counts the same assigned, active rows the client sees. Unassigning one frees a slot even
  // though its dormant priority row survives for a corrected assignment to restore later.
  await db.delete(cardAssignees).where(and(
    eq(cardAssignees.cardId, filler[0]!.id),
    eq(cardAssignees.userId, f.target.id),
  ));
  const afterUnassignment = await addPriority(f, f.targetToken, f.cardA1.id);
  assert.equal(afterUnassignment.statusCode, 201);
  assert.equal(afterUnassignment.json<WorkPrioritiesResponse>().totalCount, 50);

  const targetRows = await f.app.inject({
    method: "GET",
    url: "/work/priority-targets",
    headers: auth(f.targetToken),
  });
  assert.equal(targetRows.statusCode, 200);
  assert.equal(targetRows.json<WorkPriorityTargetsResponse>().targets[0]?.queueSize, 50);

  // Completion uses the same live predicate and therefore frees another slot too.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, filler[1]!.id));
  const afterCompletion = await addPriority(f, f.targetToken, f.cardA2.id);
  assert.equal(afterCompletion.statusCode, 201);
  assert.equal(afterCompletion.json<WorkPrioritiesResponse>().totalCount, 50);
});

void test("anchors must still be assigned, active and present in the live queue", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardA2.id);
  await addPriority(f, f.targetToken, f.cardB1.id);
  const initial = await readQueue(f, f.targetToken);
  const movingId = initial.items.find((item) => item.card?.id === f.cardA1.id)!.id;
  const anchorId = initial.items.find((item) => item.card?.id === f.cardA2.id)!.id;
  const moveAfterStaleAnchor = () => f.app.inject({
    method: "POST",
    url: `/card-priorities/${movingId}/move`,
    headers: auth(f.targetToken),
    payload: { afterId: anchorId },
  });

  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.cardA2.id));
  assert.equal((await moveAfterStaleAnchor()).statusCode, 400);

  await db.update(cards).set({ completedAt: null, archivedAt: new Date() }).where(eq(cards.id, f.cardA2.id));
  assert.equal((await moveAfterStaleAnchor()).statusCode, 400);

  await db.update(cards).set({ archivedAt: null }).where(eq(cards.id, f.cardA2.id));
  await db.delete(cardAssignees).where(and(
    eq(cardAssignees.cardId, f.cardA2.id),
    eq(cardAssignees.userId, f.target.id),
  ));
  assert.equal((await moveAfterStaleAnchor()).statusCode, 400);

  await db.delete(cards).where(eq(cards.id, f.cardA2.id));
  assert.equal((await moveAfterStaleAnchor()).statusCode, 400);
});

void test("anchors place entries at the head and tail, and a no-op move writes nothing", async () => {
  const f = await seed();
  const first = (await addPriority(f, f.targetToken, f.cardA1.id)).json<WorkPrioritiesResponse>();
  assert.equal(first.items.length, 1);

  // beforeId: null appends, afterId: null prepends.
  await addPriority(f, f.targetToken, f.cardB1.id, { beforeId: null });
  await addPriority(f, f.targetToken, f.cardA2.id, { afterId: null });
  let queue = await readQueue(f, f.targetToken);
  assert.deepEqual(queue.items.map((item) => item.card?.title), ["DEV-564", "DEV-726", "DEV-755"]);

  // Move the head to the tail.
  const head = queue.items[0]!;
  const moved = await f.app.inject({
    method: "POST",
    url: `/card-priorities/${head.id}/move`,
    headers: auth(f.targetToken),
    payload: { beforeId: null },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(
    moved.json<WorkPrioritiesResponse>().items.map((item) => item.card?.title),
    ["DEV-726", "DEV-755", "DEV-564"],
  );

  const activityBefore = await db.select().from(activityEvents).where(eq(activityEvents.entityId, head.id));
  queue = await readQueue(f, f.targetToken);
  const noOp = await f.app.inject({
    method: "POST",
    url: `/card-priorities/${head.id}/move`,
    headers: auth(f.targetToken),
    // Re-anchoring to its current neighbour resolves to the position it already holds.
    payload: { afterId: queue.items[1]!.id },
  });
  assert.equal(noOp.statusCode, 200);
  const activityAfter = await db.select().from(activityEvents).where(eq(activityEvents.entityId, head.id));
  assert.equal(activityAfter.length, activityBefore.length, "a no-op move must not write activity");
});

void test("rank is numbered over the target's set, and invisible entries are redacted placeholders", async () => {
  const f = await seed();
  // Built as the target so every card lands, including the guest-board one wsAdmin cannot see.
  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardG1.id);
  await addPriority(f, f.targetToken, f.cardA2.id);
  await addPriority(f, f.targetToken, f.cardB1.id);

  const asTarget = await readQueue(f, f.targetToken);
  assert.deepEqual(asTarget.items.map((item) => item.rank), [1, 2, 3, 4]);
  assert.equal(asTarget.hiddenCount, 0, "the target is never partially sighted");

  const asAdmin = await readQueue(f, f.wsAdminToken);
  assert.equal(asAdmin.totalCount, 4);
  assert.equal(asAdmin.hiddenCount, 1);
  // Not renumbered to 1, 2, 3 for the three visible entries: the manager and the assignee must say
  // the same numbers about the same cards.
  assert.deepEqual(asAdmin.items.map((item) => item.rank), [1, 2, 3, 4]);
  assert.equal(asAdmin.items[1]!.card, null);
  // The board/list names are redacted with the card, or the placeholder would disclose where it lives.
  assert.equal(asAdmin.items[1]!.context, null);
  assert.equal(asAdmin.items[0]!.context?.boardName, "Delivery board");
  assert.deepEqual(
    asAdmin.items.map((item) => item.card?.title ?? null),
    ["DEV-726", null, "DEV-564", "DEV-755"],
  );
  assert.ok(!JSON.stringify(asAdmin).includes("DEV-901"));
  // Reordering must still work past an invisible neighbour: interpolation uses the full queue.
  const moved = await f.app.inject({
    method: "POST",
    url: `/card-priorities/${asAdmin.items[2]!.id}/move`,
    headers: auth(f.wsAdminToken),
    payload: { afterId: null },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(
    moved.json<WorkPrioritiesResponse>().items.map((item) => item.card?.title ?? null),
    ["DEV-564", "DEV-726", null, "DEV-755"],
  );

  // An anchor the actor cannot see is rejected outright rather than silently reinterpreted.
  const blindAnchor = await f.app.inject({
    method: "POST",
    url: `/card-priorities/${asAdmin.items[0]!.id}/move`,
    headers: auth(f.wsAdminToken),
    payload: { afterId: asAdmin.items[1]!.id },
  });
  assert.equal(blindAnchor.statusCode, 400);
  assert.match(blindAnchor.json<{ message?: string }>().message ?? "", /anchor is not visible/);
});

void test("archived, completed and unassigned cards leave the queue but keep their row", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardA2.id);
  await addPriority(f, f.targetToken, f.cardB1.id);

  const rankOf = (queue: WorkPrioritiesResponse, title: string) =>
    queue.items.find((item) => item.card?.title === title)?.rank ?? null;
  assert.equal(rankOf(await readQueue(f, f.targetToken), "DEV-755"), 3);

  // Archive the middle entry: it leaves the read, its row survives, and the tail keeps its number
  // relative to what remains.
  await db.update(cards).set({ archivedAt: new Date() }).where(eq(cards.id, f.cardA2.id));
  let queue = await readQueue(f, f.targetToken);
  assert.deepEqual(queue.items.map((item) => item.card?.title), ["DEV-726", "DEV-755"]);
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.cardId, f.cardA2.id))).length, 1);
  await db.update(cards).set({ archivedAt: null }).where(eq(cards.id, f.cardA2.id));
  assert.equal(rankOf(await readQueue(f, f.targetToken), "DEV-564"), 2, "un-archiving restores the rank");

  // Completing a card takes it out of the queue entirely — a queue answers "what's next", and done
  // work is never next. Unlike a board list, there is no recently-completed grace window here.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.cardA1.id));
  queue = await readQueue(f, f.targetToken);
  assert.deepEqual(queue.items.map((item) => item.card?.title), ["DEV-564", "DEV-755"]);
  // Ranks and totalCount are taken over the live set, so the cap the client shows is the cap it hits.
  assert.deepEqual(queue.items.map((item) => item.rank), [1, 2]);
  assert.equal(queue.totalCount, 2);
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.cardId, f.cardA1.id))).length, 1);
  await db.update(cards).set({ completedAt: null }).where(eq(cards.id, f.cardA1.id));
  assert.equal(rankOf(await readQueue(f, f.targetToken), "DEV-726"), 1, "un-completing restores the rank");

  // Un-assigning hides the entry; re-assigning restores it, which is what you want when a
  // mis-assignment is corrected.
  await db.delete(cardAssignees).where(and(eq(cardAssignees.cardId, f.cardB1.id), eq(cardAssignees.userId, f.target.id)));
  assert.equal(rankOf(await readQueue(f, f.targetToken), "DEV-755"), null);
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.cardId, f.cardB1.id))).length, 1);
  await db.insert(cardAssignees).values({ cardId: f.cardB1.id, userId: f.target.id });
  assert.equal(rankOf(await readQueue(f, f.targetToken), "DEV-755"), 3);

  // Limit truncates the response but never the ranking, so Home and My Cards agree.
  const topOne = await readQueue(f, f.targetToken, "?limit=1");
  assert.deepEqual(topOne.items.map((item) => item.rank), [1]);
  assert.equal(topOne.totalCount, 3);
});

void test("the sweep purges entries only once a card has been completed past the grace window", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardA2.id);
  const HOUR = 60 * 60 * 1000;
  const deps = { db, log: f.app.log };

  // Inside the 24h window the row must survive, so un-completing still restores the rank — the
  // window exists exactly for the mis-click case.
  await db.update(cards).set({ completedAt: new Date(Date.now() - HOUR) }).where(eq(cards.id, f.cardA1.id));
  assert.equal(await runCompletedPriorityCleanup(deps), 0);

  // Past the window the entry is deleted for good: reopening the card later re-enters the queue
  // like any other card instead of resurrecting a stale rank.
  await db.update(cards).set({ completedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(cards.id, f.cardA1.id));
  assert.equal(await runCompletedPriorityCleanup(deps), 1);
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.cardId, f.cardA1.id))).length, 0);
  // The live neighbour is untouched.
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.cardId, f.cardA2.id))).length, 1);
});

void test("deleting a card cascades the entry and revoking board access removes it", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardB1.id);

  await db.delete(cards).where(eq(cards.id, f.cardA1.id));
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.targetUserId, f.target.id))).length, 1);

  const cleanup = await db.transaction(async (tx) => {
    return cleanupUserBoardParticipation(tx, {
      userId: f.target.id,
      boardIds: [f.boardB.id],
      actorId: f.orgAdmin.id,
    });
  });
  assert.equal((await db.select().from(cardPriorities).where(eq(cardPriorities.targetUserId, f.target.id))).length, 0);
  // The flag is how routes know to fire the post-commit invalidation ping for the removed user.
  assert.equal(cleanup.removedPriorityEntries, true);
});

void test("queue invalidation reaches every eligible reader, and assignment changes fire it too", async () => {
  const f = await seed();
  const invalidationRecipients = async () => {
    const rows = await db
      .select({ userId: directRealtimeOutbox.userId, payload: directRealtimeOutbox.payload })
      .from(directRealtimeOutbox)
      .where(eq(directRealtimeOutbox.eventType, "cardPriority:invalidated"));
    return rows
      .filter((row) => (row.payload as { targetUserId?: string }).targetUserId === f.target.id)
      .map((row) => row.userId);
  };

  // The queued card lives in wsB, where wsAdmin holds no authority — but wsAdmin administers wsA,
  // which the target belongs to, so they can be *watching* this queue (the entry shows as a
  // redacted placeholder) and their ranks and hiddenCount just changed. The audience follows the
  // read gate (the target's memberships), not the workspaces of the queued cards.
  await addPriority(f, f.targetToken, f.cardB1.id);
  let recipients = await invalidationRecipients();
  assert.ok(recipients.includes(f.target.id));
  assert.ok(recipients.includes(f.wsAdmin.id), "wsA's admin reads this queue and must be pinged");
  assert.ok(recipients.includes(f.orgAdmin.id));
  assert.ok(!recipients.includes(f.plainMember.id), "a plain member cannot read the queue");

  await db.delete(directRealtimeOutbox);
  // Un-assigning the target drops the card out of the live queue without touching its rows, so the
  // assignees route owes the same ping.
  const unassign = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.cardB1.id}/assignees`,
    headers: auth(f.orgAdminToken),
    payload: { userIds: [] },
  });
  assert.equal(unassign.statusCode, 200);
  recipients = await invalidationRecipients();
  assert.ok(recipients.includes(f.target.id));
  assert.ok(recipients.includes(f.wsAdmin.id));
});

void test("priority activity never reaches a card or board feed, nor staleness reporting", async () => {
  const f = await seed();
  const created = await addPriority(f, f.targetToken, f.cardA1.id);
  assert.equal(created.statusCode, 201);

  const rows = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.entityType, "cardPriority"))
    .orderBy(asc(activityEvents.createdAt));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.boardId, null, "a non-null boardId would publish this to the board feed");
  assert.equal(rows[0]!.workspaceId, f.wsA.id);
  const payload = rows[0]!.payload as Record<string, unknown>;
  assert.equal(payload.cardId, undefined, "payload.cardId would corrupt lastActivityBefore reporting");
  assert.equal(payload.priorityCardId, f.cardA1.id);
  assert.equal(payload.targetUserId, f.target.id);

  const boardFeed = await f.app.inject({
    method: "GET",
    url: `/boards/${f.boardA.id}/activity`,
    headers: auth(f.targetToken),
  });
  assert.equal(boardFeed.statusCode, 200);
  assert.ok(!boardFeed.body.includes("cardPriority"));
  assert.ok(!boardFeed.body.includes(rows[0]!.id));

  // A priority write must not make a stale card look worked on.
  const stale = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.targetToken),
    payload: {
      lens: "my",
      limit: 100,
      filters: { lastActivityBefore: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  assert.equal(stale.statusCode, 200);
  assert.ok(
    stale.json<WorkQueryResponse>().cards.some((card) => card.id === f.cardA1.id),
    "the ranked card must still count as stale",
  );
});

void test("work card queries carry the viewer's own rank and nobody else's", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  const response = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.targetToken),
    payload: { lens: "my", limit: 100 },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json<WorkQueryResponse>();
  const ranks = new Map(body.cards.map((card) => [card.id, card.viewerPriorityRank]));
  assert.equal(ranks.get(f.cardA1.id), 1);
  assert.equal(ranks.get(f.cardA2.id), null);
  // A manager's team view wears the manager's own (empty) queue, never the assignee's: the
  // target's sequencing stays behind the permission-gated priorities endpoint.
  const teamResponse = await f.app.inject({
    method: "POST",
    url: "/work/cards/query",
    headers: auth(f.wsAdminToken),
    payload: { lens: "team", limit: 100 },
  });
  assert.equal(teamResponse.statusCode, 200);
  const teamBody = teamResponse.json<WorkQueryResponse>();
  assert.equal(teamBody.cards.find((card) => card.id === f.cardA1.id)?.viewerPriorityRank, null);
  // The rank rides on each card; there is still no separate priorities collection in the response.
  assert.deepEqual(
    Object.keys(body as unknown as Record<string, unknown>).sort(),
    ["cards", "checklistItems", "nextCursor", "separatorWorkspaceIds", "separators", "totals"],
  );
});

void test("priority targets enumerate exactly the queues the caller may read", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);

  // wsAdmin administers wsA only: everyone in wsA is a target, and the target's authority
  // workspaces exclude wsB even though both users are members there (wsAdmin is no admin in it).
  const managerResponse = await f.app.inject({
    method: "GET",
    url: "/work/priority-targets",
    headers: auth(f.wsAdminToken),
  });
  assert.equal(managerResponse.statusCode, 200);
  const manager = managerResponse.json<WorkPriorityTargetsResponse>();
  assert.deepEqual(manager.targets.map((target) => target.userId), [f.wsAdmin.id, f.plainMember.id, f.target.id]);
  assert.equal(manager.targets[0]!.self, true);
  const targetRow = manager.targets.find((target) => target.userId === f.target.id);
  assert.deepEqual(targetRow?.workspaceIds, [f.wsA.id]);
  assert.equal(targetRow?.queueSize, 1);

  // A plain member can read only themselves; the row is present with no authority workspaces
  // because your own queue never needs any.
  const memberResponse = await f.app.inject({
    method: "GET",
    url: "/work/priority-targets",
    headers: auth(f.plainMemberToken),
  });
  assert.equal(memberResponse.statusCode, 200);
  const member = memberResponse.json<WorkPriorityTargetsResponse>();
  assert.deepEqual(
    member.targets.map((target) => ({ userId: target.userId, self: target.self, workspaceIds: target.workspaceIds })),
    [{ userId: f.plainMember.id, self: true, workspaceIds: [] }],
  );
});

void test("workspace credential scope gates cross-user queue discovery and reads", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);

  for (const token of [f.wsAdminWorkspaceReadToken, f.wsAdminWorkspaceWriteToken]) {
    const queue = await f.app.inject({
      method: "GET",
      url: `/work/priorities/${f.target.id}`,
      headers: auth(token),
    });
    assert.equal(queue.statusCode, 403);

    const targets = await f.app.inject({ method: "GET", url: "/work/priority-targets", headers: auth(token) });
    assert.equal(targets.statusCode, 200);
    assert.deepEqual(
      targets.json<WorkPriorityTargetsResponse>().targets.map((target) => target.userId),
      [f.wsAdmin.id],
    );
  }

  const personalReadQueue = await readQueue(f, f.wsAdminPersonalReadToken);
  assert.equal(personalReadQueue.canReorder, false);
  assert.deepEqual(personalReadQueue.reorderableWorkspaceIds, []);
  const personalTargets = await f.app.inject({
    method: "GET",
    url: "/work/priority-targets",
    headers: auth(f.wsAdminPersonalReadToken),
  });
  assert.equal(personalTargets.statusCode, 200);
  assert.deepEqual(
    personalTargets.json<WorkPriorityTargetsResponse>().targets.map((target) => target.userId),
    [f.wsAdmin.id, f.plainMember.id, f.target.id],
  );
  const deniedWrite = await addPriority(f, f.wsAdminPersonalReadToken, f.cardA2.id);
  assert.equal(deniedWrite.statusCode, 403);
});

void test("the batch read returns every readable lane, each identical to the per-target endpoint", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  // The guest-board card: present in the target's queue, redacted for wsAdmin.
  await addPriority(f, f.targetToken, f.cardG1.id);
  await addPriority(f, f.targetToken, f.cardB1.id);

  const batchResponse = await f.app.inject({ method: "GET", url: "/work/priorities", headers: auth(f.wsAdminToken) });
  assert.equal(batchResponse.statusCode, 200);
  const batch = batchResponse.json<WorkPriorityQueuesResponse>();
  // Same eligibility and order as /work/priority-targets: self first, then by display name.
  assert.deepEqual(batch.queues.map((lane) => lane.target.userId), [f.wsAdmin.id, f.plainMember.id, f.target.id]);
  assert.equal(batch.queues[0]!.target.self, true);
  // Empty lanes are included: "nothing queued for this person" is what the overview exists to show.
  assert.equal(batch.queues[1]!.queue.totalCount, 0);
  assert.deepEqual(batch.queues[1]!.queue.items, []);

  // Exact parity with the single-queue endpoint, including redaction, ranks, and write scope — a
  // lane and a focused queue must never disagree.
  const lane = batch.queues.find((candidate) => candidate.target.userId === f.target.id)!.queue;
  assert.deepEqual(lane, await readQueue(f, f.wsAdminToken));
  assert.equal(lane.hiddenCount, 1);
  assert.ok(!JSON.stringify(batch).includes("DEV-901"), "a redacted lane entry must not leak its card");

  // A plain member's overview is just their own lane; nobody else's queue leaks through the batch.
  const memberResponse = await f.app.inject({ method: "GET", url: "/work/priorities", headers: auth(f.plainMemberToken) });
  assert.equal(memberResponse.statusCode, 200);
  const member = memberResponse.json<WorkPriorityQueuesResponse>();
  assert.deepEqual(member.queues.map((candidate) => candidate.target.userId), [f.plainMember.id]);
  assert.ok(!JSON.stringify(member).includes(f.target.id));
});

void test("a plain member cannot read another person's queue", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  const response = await f.app.inject({
    method: "GET",
    url: `/work/priorities/${f.target.id}`,
    headers: auth(f.plainMemberToken),
  });
  assert.equal(response.statusCode, 403);
});

async function queueSnapshots(targetUserId: string): Promise<{ userId: string; payload: WorkPriorityQueueSnapshot }[]> {
  const rows = await db
    .select({ userId: directRealtimeOutbox.userId, payload: directRealtimeOutbox.payload })
    .from(directRealtimeOutbox)
    .where(eq(directRealtimeOutbox.eventType, "cardPriority:queueChanged"));
  return rows
    .flatMap((row) => (row.userId
      ? [{ userId: row.userId, payload: row.payload as WorkPriorityQueueSnapshot }]
      : []))
    .filter((row) => row.payload.targetUserId === targetUserId);
}

void test("the target — and only the target — receives their queue in full over realtime", async () => {
  const f = await seed();
  await db.delete(directRealtimeOutbox);

  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardB1.id);

  const snapshots = await queueSnapshots(f.target.id);
  // Admins are watching a redaction-filtered projection of this queue, and the server holds no
  // AuthClaims for them — so they keep the content-free ping and refetch under their own
  // credentials. Sending them a payload here is exactly the tenancy leak the ping exists to avoid.
  assert.deepEqual([...new Set(snapshots.map((row) => row.userId))], [f.target.id]);
  assert.ok(!(await queueSnapshots(f.target.id)).some((row) => row.userId === f.wsAdmin.id));

  const latest = snapshots.at(-1)!.payload;
  // Fully sighted and contiguously ranked: the target is never partially sighted, so a snapshot
  // never carries a redacted row — including the wsB card an admin of wsA could not see.
  assert.equal(latest.totalCount, 2);
  assert.deepEqual(latest.items.map((item) => item.rank), [1, 2]);
  assert.ok(latest.items.every((item) => item.card !== null && item.context !== null));
  assert.deepEqual(latest.items.map((item) => item.card?.title), ["DEV-726", "DEV-755"]);
  assert.ok(Number.isFinite(Date.parse(latest.snapshotAt)));

  // The event body and the REST body are one projection, so a client can apply either.
  const rest = await readQueue(f, f.targetToken);
  assert.deepEqual(latest.items, rest.items);
  assert.equal(latest.totalCount, rest.totalCount);
});

void test("admins keep only the ping, so the Team Cards lanes path is unchanged", async () => {
  const f = await seed();
  await db.delete(directRealtimeOutbox);
  await addPriority(f, f.targetToken, f.cardA1.id);

  const pings = await db
    .select({ userId: directRealtimeOutbox.userId })
    .from(directRealtimeOutbox)
    .where(eq(directRealtimeOutbox.eventType, "cardPriority:invalidated"));
  const pinged = pings.map((row) => row.userId);
  // The ping's audience is untouched: target plus every admin who may read this queue.
  assert.ok(pinged.includes(f.target.id));
  assert.ok(pinged.includes(f.wsAdmin.id));
  assert.ok(pinged.includes(f.orgAdmin.id));
  // ...and the snapshot rides alongside it for the target, never replacing it.
  assert.ok(pinged.includes(f.target.id));
  assert.equal((await queueSnapshots(f.target.id)).length, 1);
});

void test("a no-op move emits no snapshot at all", async () => {
  const f = await seed();
  const created = await addPriority(f, f.targetToken, f.cardA1.id);
  const [entry] = created.json<WorkPrioritiesResponse>().items;
  await db.delete(directRealtimeOutbox);

  // Drag jitter and client retries resolve to the same position; neither is a change to publish.
  const move = await f.app.inject({
    method: "POST",
    url: `/card-priorities/${entry!.id}/move`,
    headers: auth(f.targetToken),
    payload: { beforeId: null },
  });
  assert.equal(move.statusCode, 200);
  assert.equal((await queueSnapshots(f.target.id)).length, 0);
});

void test("changes that never touch a priority row still snapshot the target's queue", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  await addPriority(f, f.targetToken, f.cardA2.id);
  await db.delete(directRealtimeOutbox);

  // Completion hides an entry through the live-set filter, with no write to card_priority — which
  // is exactly why this is a snapshot rather than a set of create/move/remove deltas.
  const complete = await f.app.inject({
    method: "PATCH",
    url: `/cards/${f.cardA1.id}/completion`,
    headers: auth(f.targetToken),
    payload: { completed: true },
  });
  assert.equal(complete.statusCode, 200);
  let latest = (await queueSnapshots(f.target.id)).at(-1)!.payload;
  assert.deepEqual(latest.items.map((item) => item.card?.title), ["DEV-564"]);
  assert.deepEqual(latest.items.map((item) => item.rank), [1]);
  assert.equal(latest.totalCount, 1);

  await db.delete(directRealtimeOutbox);
  // Un-assigning does the same, and the belt-and-braces assignee join is what makes it show.
  const unassign = await f.app.inject({
    method: "PUT",
    url: `/cards/${f.cardA2.id}/assignees`,
    headers: auth(f.orgAdminToken),
    payload: { userIds: [] },
  });
  assert.equal(unassign.statusCode, 200);
  latest = (await queueSnapshots(f.target.id)).at(-1)!.payload;
  assert.deepEqual(latest.items, []);
  assert.equal(latest.totalCount, 0);
});

void test("the completed-priority sweep still publishes nothing", async () => {
  const f = await seed();
  await addPriority(f, f.targetToken, f.cardA1.id);
  await db
    .update(cards)
    .set({ completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
    .where(eq(cards.id, f.cardA1.id));
  await db.delete(directRealtimeOutbox);

  const removed = await runCompletedPriorityCleanup({ db, log: f.app.log });
  assert.ok(removed > 0);
  // The row was already hidden by the live-set filter, so deleting it renders identically. Emitting
  // here would wake every open client for a change none of them can see.
  assert.equal((await queueSnapshots(f.target.id)).length, 0);
});
