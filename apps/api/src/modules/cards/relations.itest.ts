import "../../test/setup.integration.js";
import { activityEvents, automationActions, automations, boardMembers, boards, cardAssignees, cardLabelAssignments, cardLabels, cards, cardSummaryView, cardWatchers, clientMembers, comments, emailQueue, eventOutbox, lists, notifications, workspaceMembers } from "@kanera/shared/schema";
import type { CardRelationsResponse, CardRelationSummary } from "@kanera/shared/dto";
import { and, asc, eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureBlockedDependents, captureUnblockedDependents, lockWorkspaceRelations } from "../../lib/card-relations.js";
import { recordBlockersCleared } from "../../lib/dependency-notifications.js";
import { runCardBlockedAutomations, runCardUnblockedAutomations } from "../../lib/automations.js";
import { db, pool } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

/**
 * Failure modes these cover, which E2E cannot reach reliably:
 * - a blocking cycle slips in (A blocks B blocks A), leaving both cards blocked forever;
 * - a viewer without access to the blocker learns its title, or loses the "blocked" signal entirely;
 * - completing a blocker on one board never re-announces the dependent on its own board, so its
 *   badge stays stale for everyone looking at that board.
 */
async function seedTwoBoards(testName: string) {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: `Acme ${testName}`, email: `owner-${testName}@example.com`, displayName: "Owner" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201, created.body);
  const workspaceId = created.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position)).limit(1);
  assert.ok(list);
  const [sharedBoard, privateBoard] = await db
    .insert(boards)
    .values([
      { workspaceId, name: "Shared", position: "1000.0000000000" },
      { workspaceId, name: "Private", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(sharedBoard && privateBoard);
  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position));
  const workspace = { id: workspaceId, boardId: sharedBoard.id, listId: list.id, otherListId: workspaceLists[1]!.id };
  const insertCard = async (boardId: string, title: string) => {
    const [card] = await db
      .insert(cards)
      .values({ listId: workspace.listId, boardId, title, position: "1000.0000000000", createdById: owner.user.id })
      .returning();
    assert.ok(card);
    return card;
  };
  return { app, owner, workspace, privateBoard, insertCard };
}

async function addRelation(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  headers: Record<string, string>,
  cardId: string,
  targetCardId: string,
  direction: "blocks" | "blocked_by" | "relates_to",
) {
  return app.inject({ method: "POST", url: `/cards/${cardId}/relations`, headers, payload: { targetCardId, direction } });
}

async function blockedByCountInView(cardId: string): Promise<number> {
  const [row] = await db.select({ count: cardSummaryView.blockedByCount }).from(cardSummaryView).where(eq(cardSummaryView.id, cardId));
  return row?.count ?? -1;
}

// Failure modes: an arriving blocker is archived without its handoff/automation, and the response
// reports a stale count. E2E cannot reliably pause between candidate selection and the graph lock.
void test("whole-list archive captures blockers moved into the list while it waits for the graph lock", async () => {
  const { app, owner, workspace, insertCard } = await seedTwoBoards("relation-list-archive-race");
  try {
    const blocker = await insertCard(workspace.boardId, "Arriving blocker");
    const dependent = await insertCard(workspace.boardId, "Waiting on arrival");
    const initial = await insertCard(workspace.boardId, "Already in archive list");
    await db.update(cards).set({ listId: workspace.otherListId }).where(eq(cards.id, initial.id));
    const { member } = await addMember(app, owner.user.clientId, workspace.id, "archive-handoff@example.com", [workspace.boardId]);
    await db.insert(cardAssignees).values({ cardId: dependent.id, userId: member.id });
    assert.equal((await addRelation(app, owner.auth, dependent.id, blocker.id, "blocked_by")).statusCode, 201);
    const rule = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_unblocked", actions: [{ type: "post_comment", config: { template: "Ready after list archive" } }] } });
    assert.equal(rule.statusCode, 201, rule.body);

    let signalLocked!: () => void;
    let releaseMove!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const moveAllowed = new Promise<void>((resolve) => { releaseMove = resolve; });
    const move = db.transaction(async (tx) => {
      await lockWorkspaceRelations(tx, workspace.id);
      signalLocked();
      await moveAllowed;
      await tx.update(cards).set({ listId: workspace.otherListId }).where(eq(cards.id, blocker.id));
    });
    await locked;
    const archive = app.inject({ method: "PATCH", url: `/lists/${workspace.otherListId}/cards/archive`, headers: owner.auth, payload: { boardId: workspace.boardId } });
    let archiveWaiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>("select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event = 'advisory') as waiting");
        if (waiting.rows[0]?.waiting) { archiveWaiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      releaseMove();
      await move;
    }
    const response = await archive;
    assert.ok(archiveWaiting, "the request must wait behind the concurrent move");
    assert.equal(response.statusCode, 200, response.body);
    const [archivedBlocker] = await db.select().from(cards).where(eq(cards.id, blocker.id));
    assert.ok(archivedBlocker?.archivedAt);
    assert.equal(await blockedByCountInView(dependent.id), 0);
    const handoffs = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, dependent.id), eq(activityEvents.action, "blockers:cleared")));
    assert.equal(handoffs.length, 1, "the arriving blocker must generate the ready handoff");
    assert.deepEqual((await db.select().from(comments).where(eq(comments.cardId, dependent.id))).map((row) => row.body), ["Ready after list archive"]);
    assert.deepEqual((await db.select().from(notifications).where(eq(notifications.activityId, handoffs[0]!.id))).map((row) => row.userId), [member.id]);
    assert.equal(response.json<{ archived: number }>().archived, 2);
    const [activity] = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, workspace.otherListId), eq(activityEvents.action, "updated")));
    assert.deepEqual(activity?.payload, { cardsArchived: 2 });
  } finally {
    await app.close();
  }
});

// Failure modes: plan-archived boards still run dependency rules and send handoff messages pointing
// at unavailable work. E2E has no hosted/admin downgrade service; retain the exact persisted state
// here (archived board, active cards and board grants), including both blocked/unblocked boundaries.
void test("dependencies on archived boards do not run rules or send handoffs", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-archived-board");
  try {
    const blocker = await insertCard(workspace.boardId, "Available blocker");
    const dependent = await insertCard(privateBoard.id, "Unavailable dependent");
    const { member } = await addMember(app, owner.user.clientId, workspace.id, "archived-board-handoff@example.com", [workspace.boardId, privateBoard.id]);
    await db.insert(cardAssignees).values({ cardId: dependent.id, userId: member.id });
    assert.equal((await addRelation(app, owner.auth, dependent.id, blocker.id, "blocked_by")).statusCode, 201);
    for (const triggerType of ["card_unblocked", "card_blocked"]) {
      const rule = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
        payload: { enabled: true, triggerType, actions: [{ type: "post_comment", config: { template: "Must not run on an archived board" } }] } });
      assert.equal(rule.statusCode, 201, rule.body);
    }
    const messagesBefore = (await db.select().from(emailQueue)).length;
    const noticesBefore = (await db.select().from(notifications).where(eq(notifications.reason, "dependency"))).length;
    const boundaries = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.boardId, privateBoard.id)))
      .filter((row) => Boolean((row.payload as { dependencyTransition?: string }).dependencyTransition)).length;
    const boundariesBefore = await boundaries();
    await db.update(boards).set({ archivedAt: new Date() }).where(eq(boards.id, privateBoard.id));
    const unavailable = await app.inject({ method: "GET", url: `/cards/${dependent.id}/detail`, headers: owner.auth });
    assert.equal(unavailable.statusCode, 404);
    for (const completed of [true, false]) {
      const response = await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed } });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.deepEqual(await db.select().from(comments).where(eq(comments.cardId, dependent.id)), [], "dependency rules must skip the archived board");
    assert.deepEqual(await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, dependent.id), inArray(activityEvents.action, ["blockers:cleared", "blockers:reopened"]))), []);
    assert.equal((await db.select().from(notifications).where(eq(notifications.reason, "dependency"))).length, noticesBefore);
    assert.equal((await db.select().from(emailQueue)).length, messagesBefore);
    assert.equal(await boundaries(), boundariesBefore);
  } finally {
    await app.close();
  }
});

void test("blocking relations reject direct and transitive cycles and are idempotent", async () => {
  const { app, owner, workspace, insertCard } = await seedTwoBoards("relation-cycles");
  try {
    const a = await insertCard(workspace.boardId, "A");
    const b = await insertCard(workspace.boardId, "B");
    const c = await insertCard(workspace.boardId, "C");

    const ab = await addRelation(app, owner.auth, a.id, b.id, "blocks");
    assert.equal(ab.statusCode, 201, ab.body);
    assert.equal(ab.json<CardRelationSummary>().direction, "blocks");
    // Same relation described from the other end is the same row, returned rather than duplicated.
    const again = await addRelation(app, owner.auth, b.id, a.id, "blocked_by");
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json<CardRelationSummary>().id, ab.json<CardRelationSummary>().id);
    assert.equal(again.json<CardRelationSummary>().direction, "blocked_by");

    assert.equal((await addRelation(app, owner.auth, b.id, a.id, "blocks")).statusCode, 400);
    assert.equal((await addRelation(app, owner.auth, b.id, c.id, "blocks")).statusCode, 201);
    // C → A would close A → B → C → A.
    const transitive = await addRelation(app, owner.auth, c.id, a.id, "blocks");
    assert.equal(transitive.statusCode, 400);
    assert.match(transitive.json<{ message: string }>().message, /cycle/);
    assert.equal((await addRelation(app, owner.auth, a.id, a.id, "relates_to")).statusCode, 400);

    // relates_to is symmetric: either direction is one stored row.
    const rel = await addRelation(app, owner.auth, c.id, a.id, "relates_to");
    assert.equal(rel.statusCode, 201, rel.body);
    const relAgain = await addRelation(app, owner.auth, a.id, c.id, "relates_to");
    assert.equal(relAgain.statusCode, 200);
    assert.equal(relAgain.json<CardRelationSummary>().id, rel.json<CardRelationSummary>().id);

    assert.equal(await blockedByCountInView(b.id), 1);
    assert.equal(await blockedByCountInView(c.id), 1);
    assert.equal(await blockedByCountInView(a.id), 0);

    const removed = await app.inject({ method: "DELETE", url: `/cards/${b.id}/relations/${ab.json<CardRelationSummary>().id}`, headers: owner.auth });
    assert.equal(removed.statusCode, 204);
    assert.equal(await blockedByCountInView(b.id), 0);
    // A relation id cannot be removed through an unrelated card.
    const other = await app.inject({ method: "DELETE", url: `/cards/${b.id}/relations/${rel.json<CardRelationSummary>().id}`, headers: owner.auth });
    assert.equal(other.statusCode, 404);
  } finally {
    await app.close();
  }
});

void test("blockers on boards the viewer cannot open are counted, never listed", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-hidden");
  try {
    const hiddenBlocker = await insertCard(privateBoard.id, "Secret migration");
    const visibleBlocker = await insertCard(workspace.boardId, "Visible prerequisite");
    const blocked = await insertCard(workspace.boardId, "Launch");
    assert.equal((await addRelation(app, owner.auth, blocked.id, hiddenBlocker.id, "blocked_by")).statusCode, 201);
    assert.equal((await addRelation(app, owner.auth, blocked.id, visibleBlocker.id, "blocked_by")).statusCode, 201);

    const [member] = await insertTestUsers(db, {
      clientId: owner.user.clientId,
      email: "member-relation-hidden@example.com",
      passwordHash: "x",
      displayName: "Member",
    }).returning();
    assert.ok(member);
    await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "member" });
    await db.insert(boardMembers).values({ boardId: workspace.boardId, userId: member.id, role: "editor" });
    const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" })}` };

    const relations = await app.inject({ method: "GET", url: `/cards/${blocked.id}/relations`, headers: memberAuth });
    assert.equal(relations.statusCode, 200, relations.body);
    const body = relations.json<CardRelationsResponse>();
    assert.deepEqual(body.relations.map((relation) => relation.card.id), [visibleBlocker.id]);
    assert.equal(body.hiddenBlockerCount, 1);
    assert.doesNotMatch(relations.body, /Secret migration/);

    const detail = await app.inject({ method: "GET", url: `/cards/${blocked.id}/detail`, headers: memberAuth });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json<{ hiddenBlockerCount: number }>().hiddenBlockerCount, 1);
    assert.doesNotMatch(detail.body, /Secret migration/);

    // Board tiles count hidden blockers too, so the badge shows for this member.
    const boardOpen = await app.inject({ method: "POST", url: `/boards/${workspace.boardId}/open`, headers: memberAuth });
    assert.equal(boardOpen.statusCode, 200, boardOpen.body);
    const tile = boardOpen.json<{ cards: { id: string; blockedByCount?: number }[] }>().cards.find((card) => card.id === blocked.id);
    assert.equal(tile?.blockedByCount, 2);

    // The member cannot relate to a card they cannot read, and learns nothing about it.
    const probe = await addRelation(app, memberAuth, blocked.id, hiddenBlocker.id, "relates_to");
    assert.equal(probe.statusCode, 404);
  } finally {
    await app.close();
  }
});

void test("completing or archiving a blocker re-announces its dependent on the dependent's own board", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-fanout");
  try {
    const blocker = await insertCard(privateBoard.id, "Upstream");
    const dependent = await insertCard(workspace.boardId, "Downstream");
    assert.equal((await addRelation(app, owner.auth, blocker.id, dependent.id, "blocks")).statusCode, 201);

    const dependentUpdates = async (transitions = false) => (await db
      .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.boardId, workspace.boardId), eq(eventOutbox.eventType, "card:updated")))
      .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id)))
      .map((row) => row.payload as { card: { id: string }; blockedByCount?: number; dependencyTransition?: string })
      .filter((payload) => payload.card.id === dependent.id && Boolean(payload.dependencyTransition) === transitions);

    assert.deepEqual((await dependentUpdates()).map((payload) => payload.blockedByCount), [1]);

    const completed = await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual((await dependentUpdates()).map((payload) => payload.blockedByCount), [1, 0]);

    await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed: false } });
    const archived = await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/archive`, headers: owner.auth, payload: { archived: true } });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.deepEqual((await dependentUpdates()).map((payload) => payload.blockedByCount), [1, 0, 1, 0]);
    // The transactional boundary snapshots are separate from the normal post-commit refreshes.
    // Both must target the dependent board; only snapshots should drive specialized MCP events.
    assert.deepEqual((await dependentUpdates(true)).map((payload) => payload.dependencyTransition), ["blocked", "unblocked", "blocked", "unblocked"]);
    assert.equal(await blockedByCountInView(dependent.id), 0);
  } finally {
    await app.close();
  }
});

async function addMember(app: Awaited<ReturnType<typeof buildIntegrationServer>>, clientId: string, workspaceId: string, email: string, boardIds: string[]) {
  const [member] = await insertTestUsers(db, { clientId, email, passwordHash: "x", displayName: email.split("@")[0]! }).returning();
  assert.ok(member);
  await db.insert(workspaceMembers).values({ workspaceId, userId: member.id, role: "member" });
  await db.insert(boardMembers).values(boardIds.map((boardId) => ({ boardId, userId: member.id, role: "editor" as const })));
  return { member, auth: { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: clientId, role: "member" })}` } };
}

/**
 * Failure modes: watchers not told their card became blocked (or started blocking); the blocked
 * card's assignee left out because they don't watch it; someone watching both cards told twice;
 * the actor notifying themself; the other card's title leaking into email for a watcher who cannot open it;
 * the "Card dependencies" email toggle not suppressing email while the inbox entry still lands.
 */
void test("adding a blocker notifies both cards' watchers and the blocked card's assignees, once each", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-notify");
  try {
    const blocker = await insertCard(privateBoard.id, "Secret upstream migration");
    const blocked = await insertCard(workspace.boardId, "Downstream launch");
    const restricted = await addMember(app, owner.user.clientId, workspace.id, "restricted-relation-notify@example.com", [workspace.boardId]);
    const insider = await addMember(app, owner.user.clientId, workspace.id, "insider-relation-notify@example.com", [workspace.boardId, privateBoard.id]);
    const assigneeOnly = await addMember(app, owner.user.clientId, workspace.id, "assignee-relation-notify@example.com", [workspace.boardId]);
    const both = await addMember(app, owner.user.clientId, workspace.id, "both-relation-notify@example.com", [workspace.boardId, privateBoard.id]);
    await db.insert(cardWatchers).values([
      { cardId: blocked.id, userId: restricted.member.id },
      { cardId: blocker.id, userId: insider.member.id },
      { cardId: blocked.id, userId: owner.user.id },
      { cardId: blocked.id, userId: both.member.id },
      { cardId: blocker.id, userId: both.member.id },
    ]);
    await db.insert(cardAssignees).values({ cardId: blocked.id, userId: assigneeOnly.member.id });

    assert.equal((await addRelation(app, owner.auth, blocked.id, blocker.id, "blocked_by")).statusCode, 201);

    const rows = await db.select().from(notifications).where(eq(notifications.reason, "dependency"));
    assert.deepEqual(rows.map((row) => `${row.userId}:${row.cardId}`).sort(), [
      `${insider.member.id}:${blocker.id}`,
      `${restricted.member.id}:${blocked.id}`,
      `${assigneeOnly.member.id}:${blocked.id}`,
      // Watching both cards: told once, about the card whose work now waits.
      `${both.member.id}:${blocked.id}`,
    ].sort());
    const emails = await db.select().from(emailQueue).where(eq(emailQueue.type, "card_dependency_added"));
    const byRecipient = new Map(emails.map((row) => [row.toEmail, row.data as { direction: string; otherCardKey: string; otherCardTitle: string | null }]));
    assert.equal(emails.length, 4);
    assert.equal(byRecipient.get("assignee-relation-notify@example.com")?.direction, "blocked_by");
    assert.equal(byRecipient.get("both-relation-notify@example.com")?.direction, "blocked_by");
    const restrictedEmail = byRecipient.get("restricted-relation-notify@example.com");
    assert.equal(restrictedEmail?.direction, "blocked_by");
    assert.equal(restrictedEmail?.otherCardKey, blocker.key);
    assert.equal(restrictedEmail?.otherCardTitle, null);
    assert.equal(byRecipient.get("insider-relation-notify@example.com")?.otherCardTitle, "Downstream launch");
    const restrictedRow = emails.find((row) => row.toEmail === "restricted-relation-notify@example.com");
    assert.doesNotMatch(JSON.stringify(restrictedRow), /Secret upstream migration/);

    // Turning the email channel off keeps the inbox entry but sends no email.
    const optOut = await app.inject({ method: "PATCH", url: "/notifications/settings", headers: insider.auth, payload: { types: { cardDependency: { email: false } } } });
    assert.equal(optOut.statusCode, 200, optOut.body);
    const second = await insertCard(workspace.boardId, "Second downstream");
    assert.equal((await addRelation(app, owner.auth, blocker.id, second.id, "blocks")).statusCode, 201);
    const insiderRows = await db.select().from(notifications).where(and(eq(notifications.reason, "dependency"), eq(notifications.userId, insider.member.id)));
    assert.equal(insiderRows.length, 2);
    const insiderEmails = (await db.select().from(emailQueue).where(eq(emailQueue.type, "card_dependency_added")))
      .filter((row) => row.toEmail === "insider-relation-notify@example.com");
    assert.equal(insiderEmails.length, 1);
  } finally {
    await app.close();
  }
});

/**
 * Failure modes: the trigger firing while another blocker is still open; not firing when the last
 * blocker is completed or archived; firing when an automation (rather than a person) closed the
 * blocker, which would let automation chains cascade through a dependency graph.
 */
void test("card_unblocked runs once the last open blocker is closed by a person or an automation", async () => {
  const { app, owner, workspace, insertCard } = await seedTwoBoards("relation-unblocked");
  try {
    const [label] = await db.insert(cardLabels).values({ workspaceId: workspace.id, name: "Ready", position: "1000.0000000000" }).returning();
    assert.ok(label);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/automations`,
      headers: owner.auth,
      payload: { enabled: true, triggerType: "card_unblocked", actions: [{ type: "add_labels", config: { labelIds: [label.id] } }] },
    });
    assert.equal(created.statusCode, 201, created.body);
    const labelled = async (cardIds: string[]) => (await db.select({ cardId: cardLabelAssignments.cardId }).from(cardLabelAssignments)
      .where(and(inArray(cardLabelAssignments.cardId, cardIds), eq(cardLabelAssignments.labelId, label.id)))).map((row) => row.cardId);

    const first = await insertCard(workspace.boardId, "First blocker");
    const second = await insertCard(workspace.boardId, "Second blocker");
    const waiting = await insertCard(workspace.boardId, "Waiting card");
    await addRelation(app, owner.auth, waiting.id, first.id, "blocked_by");
    await addRelation(app, owner.auth, waiting.id, second.id, "blocked_by");

    await app.inject({ method: "PATCH", url: `/cards/${first.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.deepEqual(await labelled([waiting.id]), [], "one blocker is still open");
    const archived = await app.inject({ method: "PATCH", url: `/cards/${second.id}/archive`, headers: owner.auth, payload: { archived: true } });
    assert.equal(archived.statusCode, 200);
    assert.deepEqual(await labelled([waiting.id]), [waiting.id]);

    // An automation completes this blocker when it enters the second list; the dependent also becomes ready.
    const [completer] = await db.insert(automations).values({
      workspaceId: workspace.id, enabled: true, position: "2000.0000000000", triggerType: "card_enters_list", triggerListId: workspace.otherListId, applyOnMove: true,
    }).returning();
    assert.ok(completer);
    await db.insert(automationActions).values({ automationId: completer.id, type: "set_completion", config: { completed: true }, position: "1000.0000000000" });
    const autoBlocker = await insertCard(workspace.boardId, "Auto-closed blocker");
    const autoWaiting = await insertCard(workspace.boardId, "Waits on automation");
    await addRelation(app, owner.auth, autoWaiting.id, autoBlocker.id, "blocked_by");
    const moved = await app.inject({ method: "POST", url: `/cards/${autoBlocker.id}/move`, headers: owner.auth, payload: { listId: workspace.otherListId, beforeCardId: null } });
    assert.equal(moved.statusCode, 200, moved.body);
    const [closed] = await db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, autoBlocker.id));
    assert.ok(closed?.completedAt, "the automation completed the blocker");
    assert.deepEqual(await labelled([autoWaiting.id]), [autoWaiting.id]);
  } finally {
    await app.close();
  }
});

/**
 * Failure modes: an assignee told their card is ready while another blocker is still open; a
 * watcher left out, or someone both assigned and watching told twice; the person who closed the
 * last blocker notified about their own handoff; a private blocker's title
 * leaking into an assignee's email; the handoff skipped when an automation (here "entering this
 * list completes the card") closes the last blocker, which is the common way blockers finish.
 */
void test("closing a card's last open blocker hands it off to its assignees and watchers, once each", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-handoff");
  try {
    const assignee = await addMember(app, owner.user.clientId, workspace.id, "assignee-relation-handoff@example.com", [workspace.boardId]);
    const watcher = await addMember(app, owner.user.clientId, workspace.id, "watcher-relation-handoff@example.com", [workspace.boardId]);
    const first = await insertCard(workspace.boardId, "Visible blocker");
    const second = await insertCard(privateBoard.id, "Secret upstream work");
    const waiting = await insertCard(workspace.boardId, "Waiting card");
    await db.insert(cardAssignees).values([
      { cardId: waiting.id, userId: assignee.member.id },
      { cardId: waiting.id, userId: owner.user.id },
    ]);
    await db.insert(cardWatchers).values([
      { cardId: waiting.id, userId: assignee.member.id },
      { cardId: waiting.id, userId: watcher.member.id },
      { cardId: waiting.id, userId: owner.user.id },
    ]);
    await addRelation(app, owner.auth, waiting.id, first.id, "blocked_by");
    await addRelation(app, owner.auth, waiting.id, second.id, "blocked_by");
    const handoffs = async (cardId: string) => db.select().from(activityEvents)
      .where(and(eq(activityEvents.entityId, cardId), eq(activityEvents.action, "blockers:cleared")));
    const handoffNotifications = async (cardId: string) => (await db.select().from(notifications)
      .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
      .where(and(eq(notifications.cardId, cardId), eq(activityEvents.action, "blockers:cleared"))))
      .map((row) => row.notification);

    const firstDone = await app.inject({ method: "PATCH", url: `/cards/${first.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal(firstDone.statusCode, 200, firstDone.body);
    assert.equal((await handoffs(waiting.id)).length, 0, "one blocker is still open");

    const archived = await app.inject({ method: "PATCH", url: `/cards/${second.id}/archive`, headers: owner.auth, payload: { archived: true } });
    assert.equal(archived.statusCode, 200, archived.body);
    const [handoff] = await handoffs(waiting.id);
    assert.ok(handoff);
    assert.equal(handoff.actorId, owner.user.id);
    assert.deepEqual(handoff.payload, { otherCardId: second.id, otherCardKey: second.key });
    const rows = await handoffNotifications(waiting.id);
    assert.deepEqual(
      rows.map((row) => `${row.userId}:${row.reason}`).sort(),
      [`${assignee.member.id}:dependency`, `${watcher.member.id}:dependency`].sort(),
      "assignee and watcher once each; the actor is not told about their own handoff",
    );
    const emails = await db.select().from(emailQueue).where(eq(emailQueue.type, "card_unblocked"));
    assert.deepEqual(emails.map((row) => row.toEmail).sort(), ["assignee-relation-handoff@example.com", "watcher-relation-handoff@example.com"]);
    const assigneeEmail = emails.find((row) => row.toEmail === "assignee-relation-handoff@example.com")!;
    const data = assigneeEmail.data as { otherCardKey: string; otherCardTitle: string | null; cardTitle: string };
    assert.equal(data.cardTitle, "Waiting card");
    assert.equal(data.otherCardKey, second.key);
    assert.equal(data.otherCardTitle, null, "the assignee cannot open the private blocker");
    assert.doesNotMatch(JSON.stringify(emails), /Secret upstream work/);

    // Closing an unrelated card later does not repeat the handoff.
    await app.inject({ method: "PATCH", url: `/cards/${(await insertCard(workspace.boardId, "Unrelated")).id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal((await handoffs(waiting.id)).length, 1);

    // An automation completes this blocker when it enters the second list.
    const [completer] = await db.insert(automations).values({
      workspaceId: workspace.id, enabled: true, position: "2000.0000000000", triggerType: "card_enters_list", triggerListId: workspace.otherListId, applyOnMove: true,
    }).returning();
    assert.ok(completer);
    await db.insert(automationActions).values({ automationId: completer.id, type: "set_completion", config: { completed: true }, position: "1000.0000000000" });
    const autoBlocker = await insertCard(workspace.boardId, "Auto-closed blocker");
    const autoWaiting = await insertCard(workspace.boardId, "Waits on automation");
    await db.insert(cardAssignees).values({ cardId: autoWaiting.id, userId: assignee.member.id });
    await addRelation(app, owner.auth, autoWaiting.id, autoBlocker.id, "blocked_by");
    const moved = await app.inject({ method: "POST", url: `/cards/${autoBlocker.id}/move`, headers: owner.auth, payload: { listId: workspace.otherListId, beforeCardId: null } });
    assert.equal(moved.statusCode, 200, moved.body);
    const [autoHandoff] = await handoffs(autoWaiting.id);
    assert.equal(autoHandoff?.actorId, owner.user.id, "credited to the person whose move fired the automation");
    assert.deepEqual((await handoffNotifications(autoWaiting.id)).map((row) => row.userId), [assignee.member.id]);
  } finally {
    await app.close();
  }
});

/** Failure mode: concurrent final-blocker closes miss or duplicate the handoff/automation. */
void test("concurrent final blockers produce one handoff and completed-then-archived does not repeat it", async () => {
  const { app, owner, workspace, insertCard } = await seedTwoBoards("relation-concurrent");
  try {
    const a = await insertCard(workspace.boardId, "First");
    const b = await insertCard(workspace.boardId, "Second");
    const waiting = await insertCard(workspace.boardId, "Waiting");
    await addRelation(app, owner.auth, waiting.id, a.id, "blocked_by");
    await addRelation(app, owner.auth, waiting.id, b.id, "blocked_by");
    const created = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_unblocked", actions: [{ type: "post_comment", config: { template: "Ready exactly once" } }] } });
    assert.equal(created.statusCode, 201, created.body);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const close = (id: string, hold: boolean) => db.transaction(async (tx) => {
      const before = await captureBlockedDependents(tx, workspace.id, [id]);
      if (hold) { enteredResolve(); await release; }
      await tx.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, id));
      const handoffs = await recordBlockersCleared(tx, { before, actorId: owner.user.id });
      const effects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId: workspace.id, clientId: owner.user.clientId });
      return { handoffs, effects };
    });
    const first = close(a.id, true);
    await entered;
    const second = close(b.id, false);
    releaseResolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.handoffs.length), [0, 1]);
    assert.equal(results.flatMap((result) => result.effects.effects).filter((effect) => effect.type === "commentCreated").length, 1);
    const archived = await app.inject({ method: "PATCH", url: `/cards/${a.id}/archive`, headers: owner.auth, payload: { archived: true } });
    assert.equal(archived.statusCode, 200, archived.body);
    const events = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, waiting.id), eq(activityEvents.action, "blockers:cleared")));
    assert.equal(events.length, 1);
  } finally { await app.close(); }
});

// Failure mode: concurrent reopenings both observe zero open blockers and duplicate the blocked
// action/event. Holding the graph lock makes this race deterministic, unlike browser timing.
void test("concurrent blocker reopenings produce one blocked action and boundary event", async () => {
  const { app, owner, workspace, insertCard } = await seedTwoBoards("relation-blocked-race");
  try {
    const a = await insertCard(workspace.boardId, "First");
    const b = await insertCard(workspace.boardId, "Second");
    const waiting = await insertCard(workspace.boardId, "Waiting");
    // Relate first: a completed card is refused as a blocker, so close both only after linking them.
    for (const blocker of [a, b]) assert.equal((await addRelation(app, owner.auth, waiting.id, blocker.id, "blocked_by")).statusCode, 201);
    await db.update(cards).set({ completedAt: new Date() }).where(inArray(cards.id, [a.id, b.id]));
    const created = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_blocked", actions: [{ type: "post_comment", config: { template: "Blocked exactly once" } }] } });
    assert.equal(created.statusCode, 201, created.body);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const reopen = (id: string, hold: boolean) => db.transaction(async (tx) => {
      const cardIds = await captureUnblockedDependents(tx, workspace.id, [id]);
      if (hold) { enteredResolve(); await release; }
      await tx.update(cards).set({ completedAt: null }).where(eq(cards.id, id));
      return runCardBlockedAutomations(tx, { cardIds, workspaceId: workspace.id, clientId: owner.user.clientId });
    });
    const blockedTransitions = async () => (await db.select().from(eventOutbox)).filter((event) => (event.payload as { dependencyTransition?: string }).dependencyTransition === "blocked").length;
    // Linking the first open blocker was the card's first boundary; completing both cleared it.
    const before = await blockedTransitions();
    const first = reopen(a.id, true);
    await entered;
    const second = reopen(b.id, false);
    releaseResolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.effects.filter((effect) => effect.type === "commentCreated").length), [1, 0]);
    assert.equal(await blockedTransitions(), before + 1, "two concurrent reopenings produce one boundary");
  } finally { await app.close(); }
});

/**
 * Failure modes: deleting the list or board that holds a card's last open blocker leaves the
 * dependent showing Blocked forever (the relation rows vanish in the cascade before anything could
 * read them), or skips the ready-to-start handoff that a completion would have produced.
 */
void test("deleting the list or board holding the last blocker hands the dependents off", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-delete");
  try {
    const handoffs = async (cardId: string) => db.select().from(activityEvents)
      .where(and(eq(activityEvents.entityId, cardId), eq(activityEvents.action, "blockers:cleared")));

    // The blocker sits in a second list; deleting that list deletes it, and only it.
    const listBlocker = await insertCard(workspace.boardId, "Blocker in doomed list");
    await db.update(cards).set({ listId: workspace.otherListId }).where(eq(cards.id, listBlocker.id));
    const waitsOnList = await insertCard(workspace.boardId, "Waits on the doomed list");
    await addRelation(app, owner.auth, waitsOnList.id, listBlocker.id, "blocked_by");
    assert.equal(await blockedByCountInView(waitsOnList.id), 1);
    const listDeleted = await app.inject({ method: "DELETE", url: `/lists/${workspace.otherListId}`, headers: owner.auth });
    assert.equal(listDeleted.statusCode, 204, listDeleted.body);
    assert.equal(await blockedByCountInView(waitsOnList.id), 0);
    const [listHandoff] = await handoffs(waitsOnList.id);
    assert.deepEqual(listHandoff?.payload, { otherCardId: listBlocker.id, otherCardKey: listBlocker.key });

    // The blocker sits on another board; deleting that board frees the dependent on this one.
    const boardBlocker = await insertCard(privateBoard.id, "Blocker on doomed board");
    const waitsOnBoard = await insertCard(workspace.boardId, "Waits on the doomed board");
    await addRelation(app, owner.auth, waitsOnBoard.id, boardBlocker.id, "blocked_by");
    assert.equal(await blockedByCountInView(waitsOnBoard.id), 1);
    const boardDeleted = await app.inject({ method: "DELETE", url: `/boards/${privateBoard.id}`, headers: owner.auth });
    assert.equal(boardDeleted.statusCode, 204, boardDeleted.body);
    assert.equal(await blockedByCountInView(waitsOnBoard.id), 0);
    const [boardHandoff] = await handoffs(waitsOnBoard.id);
    assert.deepEqual(boardHandoff?.payload, { otherCardId: boardBlocker.id, otherCardKey: boardBlocker.key });
  } finally {
    await app.close();
  }
});

/**
 * Failure modes: a dependent's assignee is told their card is ready, then the blocker is reopened
 * and nobody hears the card is blocked again; the person who reopened it is told about their own
 * change; a completed card is accepted as a blocker, or a viewer who cannot edit the blocked card
 * marks it as blocked from the blocker's side.
 */
void test("reopening a blocker tells the dependent's people it is blocked again, and blocking needs edit access to the blocked card", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-reopen");
  try {
    const assignee = await addMember(app, owner.user.clientId, workspace.id, "assignee-relation-reopen@example.com", [workspace.boardId]);
    const blocker = await insertCard(workspace.boardId, "Flaky blocker");
    const waiting = await insertCard(workspace.boardId, "Waiting on the flaky one");
    await db.insert(cardAssignees).values({ cardId: waiting.id, userId: assignee.member.id });
    await addRelation(app, owner.auth, waiting.id, blocker.id, "blocked_by");
    await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed: true } });
    const reopened = await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed: false } });
    assert.equal(reopened.statusCode, 200, reopened.body);
    const rows = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, waiting.id), eq(activityEvents.action, "blockers:reopened")));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.payload, { otherCardId: blocker.id, otherCardKey: blocker.key });
    const told = await db.select({ userId: notifications.userId }).from(notifications).where(eq(notifications.activityId, rows[0]!.id));
    assert.deepEqual(told.map((row) => row.userId), [assignee.member.id], "the assignee hears it; the reopener does not");
    const emails = await db.select().from(emailQueue).where(eq(emailQueue.type, "card_unblocked"));
    // The completion sent "ready to start"; the reopening sends "blocked again" to the same assignee.
    assert.deepEqual(emails.map((row) => [row.toEmail, (row.data as { reblocked?: boolean }).reblocked ?? false]), [["assignee-relation-reopen@example.com", false], ["assignee-relation-reopen@example.com", true]]);
    assert.equal(await blockedByCountInView(waiting.id), 1);

    // A completed card holds nothing up, so it cannot be added as a blocker.
    const done = await insertCard(workspace.boardId, "Already done");
    await app.inject({ method: "PATCH", url: `/cards/${done.id}/completion`, headers: owner.auth, payload: { completed: true } });
    const refused = await addRelation(app, owner.auth, waiting.id, done.id, "blocked_by");
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.body, /completed card cannot block/);

    // An observer of the blocked card's board may read it, but cannot mark it as blocked from a card they edit.
    const observer = await addMember(app, owner.user.clientId, workspace.id, "observer-relation-reopen@example.com", [workspace.boardId]);
    await db.update(boardMembers).set({ role: "observer" }).where(and(eq(boardMembers.userId, observer.member.id), eq(boardMembers.boardId, workspace.boardId)));
    const theirs = await insertCard(privateBoard.id, "Observer's own card");
    await db.insert(boardMembers).values({ boardId: privateBoard.id, userId: observer.member.id, role: "editor" });
    const forbidden = await addRelation(app, observer.auth, theirs.id, waiting.id, "blocks");
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    const allowed = await addRelation(app, observer.auth, theirs.id, waiting.id, "relates_to");
    assert.equal(allowed.statusCode, 201, allowed.body);
  } finally {
    await app.close();
  }
});

/**
 * Failure modes: the transaction-stamped boundary row (a pre-automation snapshot) is replayed to
 * browsers after the automation's own emits and reverts the card on screen; a dependent that an
 * automation completed on unblock is still emailed "ready to start"; blocking a card that is already
 * done emails its people that they are blocked; a related card's title, labels or list change and
 * the dependent's Dependencies section never re-reads; archiving a whole list skips the handoff an
 * individual archive would make.
 */
void test("dependency fanout follows the final state: no stale snapshots, no notifications for done cards, neighbours re-read", async () => {
  const { app, owner, workspace, insertCard } = await seedTwoBoards("relation-final-state");
  try {
    const assignee = await addMember(app, owner.user.clientId, workspace.id, "assignee-relation-final@example.com", [workspace.boardId]);
    const linksChangedFor = async (cardId: string) => (await db.select().from(eventOutbox).where(eq(eventOutbox.eventType, "card:links:changed")))
      .filter((event) => (event.payload as { cardId: string }).cardId === cardId).length;

    // Unblocking fires an automation that completes the dependent: the feed keeps the handoff, but
    // nobody is told a completed card is ready to start.
    const created = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_unblocked", actions: [{ type: "set_completion", config: { completed: true } }] } });
    assert.equal(created.statusCode, 201, created.body);
    const blocker = await insertCard(workspace.boardId, "Last blocker");
    const waiting = await insertCard(workspace.boardId, "Auto-completed when ready");
    await db.insert(cardAssignees).values({ cardId: waiting.id, userId: assignee.member.id });
    assert.equal((await addRelation(app, owner.auth, waiting.id, blocker.id, "blocked_by")).statusCode, 201);
    const completed = await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal(completed.statusCode, 200, completed.body);
    const [waitingNow] = await db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, waiting.id));
    assert.ok(waitingNow?.completedAt, "the card_unblocked automation completed the dependent");
    const [cleared] = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, waiting.id), eq(activityEvents.action, "blockers:cleared")));
    assert.ok(cleared, "the handoff stays in the feed: it is what happened");
    assert.deepEqual(await db.select().from(notifications).where(eq(notifications.activityId, cleared.id)), [], "no inbox entry for a card that is already done");
    assert.deepEqual(await db.select().from(emailQueue).where(eq(emailQueue.type, "card_unblocked")), [], "no ready-to-start email either");

    // Boundary rows are for integrations: they carry the pre-automation snapshot, so browsers must
    // never receive them. (A "blocked" row was stamped by the relation, an "unblocked" one here.)
    const boundaries = (await db.select().from(eventOutbox)).filter((event) => (event.payload as { dependencyTransition?: string }).dependencyTransition);
    assert.deepEqual([...new Set(boundaries.map((event) => (event.payload as { dependencyTransition: string }).dependencyTransition))].sort(), ["blocked", "unblocked"]);
    assert.ok(boundaries.every((event) => event.realtimeDispatched), "boundary rows are marked as already dispatched to browsers");

    // Blocking a card that is already done tells nobody: it is not held up by anything. (The first
    // relation above did tell the assignee, while the card was still open.)
    const dependencyNotices = async () => (await db.select().from(notifications).where(eq(notifications.reason, "dependency"))).length;
    const dependencyEmails = async () => (await db.select().from(emailQueue).where(eq(emailQueue.type, "card_dependency_added"))).length;
    const [noticesBefore, emailsBefore] = [await dependencyNotices(), await dependencyEmails()];
    assert.ok(noticesBefore > 0 && emailsBefore > 0, "the open card's assignee was told about the first blocker");
    const other = await insertCard(workspace.boardId, "Open blocker of a done card");
    const linked = await addRelation(app, owner.auth, waiting.id, other.id, "blocked_by");
    assert.equal(linked.statusCode, 201, linked.body);
    assert.equal(await dependencyNotices(), noticesBefore, "a completed dependent's people are not told they are blocked");
    assert.equal(await dependencyEmails(), emailsBefore);

    // A blocker's title, labels and list are shown in the dependent's Dependencies section, which
    // sits on a board that never hears the blocker's own events: each change tells it to re-read.
    const upstream = await insertCard(workspace.boardId, "Upstream");
    const downstream = await insertCard(workspace.boardId, "Downstream");
    const related = await insertCard(workspace.boardId, "Just related");
    assert.equal((await addRelation(app, owner.auth, downstream.id, upstream.id, "blocked_by")).statusCode, 201);
    assert.equal((await addRelation(app, owner.auth, related.id, upstream.id, "relates_to")).statusCode, 201);
    let downstreamReads = await linksChangedFor(downstream.id);
    let relatedReads = await linksChangedFor(related.id);
    const renamed = await app.inject({ method: "PATCH", url: `/cards/${upstream.id}`, headers: owner.auth, payload: { title: "Upstream, renamed" } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.ok(await linksChangedFor(downstream.id) > downstreamReads, "rename: the dependent re-reads");
    assert.ok(await linksChangedFor(related.id) > relatedReads, "rename: the related card re-reads");
    downstreamReads = await linksChangedFor(downstream.id);
    const [label] = await db.insert(cardLabels).values({ workspaceId: workspace.id, name: "Risky", position: "1000.0000000000" }).returning();
    const labelled = await app.inject({ method: "PUT", url: `/cards/${upstream.id}/labels`, headers: owner.auth, payload: { labelIds: [label!.id] } });
    assert.equal(labelled.statusCode, 200, labelled.body);
    assert.ok(await linksChangedFor(downstream.id) > downstreamReads, "labels: the dependent re-reads");
    downstreamReads = await linksChangedFor(downstream.id);
    const moved = await app.inject({ method: "POST", url: `/cards/${upstream.id}/move`, headers: owner.auth, payload: { listId: workspace.otherListId, beforeCardId: null } });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.ok(await linksChangedFor(downstream.id) > downstreamReads, "list: the dependent re-reads");
    // And the dependent's own lifecycle shows on the blocker's side.
    const upstreamReads = await linksChangedFor(upstream.id);
    relatedReads = await linksChangedFor(related.id);
    const downstreamDone = await app.inject({ method: "PATCH", url: `/cards/${downstream.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal(downstreamDone.statusCode, 200, downstreamDone.body);
    assert.ok(await linksChangedFor(upstream.id) > upstreamReads, "completion: the blocker's Blocks section re-reads");
    assert.equal(await linksChangedFor(related.id), relatedReads, "a card related only to the blocker is not touched");

    // Archiving the whole list that holds a card's last open blocker frees it like a single archive.
    const waitsOnList = await insertCard(workspace.boardId, "Waits on the archived list");
    assert.equal((await addRelation(app, owner.auth, waitsOnList.id, upstream.id, "blocked_by")).statusCode, 201);
    assert.equal(await blockedByCountInView(waitsOnList.id), 1);
    const archived = await app.inject({ method: "PATCH", url: `/lists/${workspace.otherListId}/cards/archive`, headers: owner.auth, payload: { boardId: workspace.boardId } });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal(await blockedByCountInView(waitsOnList.id), 0);
    const [listHandoff] = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, waitsOnList.id), eq(activityEvents.action, "blockers:cleared")));
    assert.deepEqual(listHandoff?.payload, { otherCardId: upstream.id, otherCardKey: upstream.key });
  } finally {
    await app.close();
  }
});

/**
 * Failure modes: a member suspended from the organisation (board membership kept) still receives
 * dependency emails naming cards they can no longer open; a retried "blocked by X" returns 400 once
 * X is completed instead of the existing relation; the response and the "you are blocked" email
 * describe the card as it was before a card_blocked automation moved or completed it; the handoff
 * inbox entry points at the list the card was in before a card_unblocked automation moved it; two
 * related cards edited in one bulk request never re-read each other; a card moved to another board
 * arrives there without its open-blocker count.
 */
void test("dependency state is read after locks and automations, and suspended members hear nothing", async () => {
  const { app, owner, workspace, privateBoard, insertCard } = await seedTwoBoards("relation-fresh-state");
  try {
    const suspended = await addMember(app, owner.user.clientId, workspace.id, "suspended-relation-fresh@example.com", [workspace.boardId]);
    const active = await addMember(app, owner.user.clientId, workspace.id, "active-relation-fresh@example.com", [workspace.boardId]);
    await db.update(clientMembers).set({ suspendedAt: new Date() }).where(eq(clientMembers.userId, suspended.member.id));
    const blocker = await insertCard(workspace.boardId, "Confidential blocker");
    const blocked = await insertCard(workspace.boardId, "Blocked work");
    await db.insert(cardAssignees).values([{ cardId: blocked.id, userId: suspended.member.id }, { cardId: blocked.id, userId: active.member.id }]);
    const linked = await addRelation(app, owner.auth, blocked.id, blocker.id, "blocked_by");
    assert.equal(linked.statusCode, 201, linked.body);
    const dependencyRecipients = async () => (await db.select().from(notifications).where(eq(notifications.reason, "dependency"))).map((row) => row.userId);
    assert.deepEqual(await dependencyRecipients(), [active.member.id], "the suspended assignee gets no inbox entry");
    assert.deepEqual((await db.select().from(emailQueue).where(eq(emailQueue.type, "card_dependency_added"))).map((row) => row.toEmail), ["active-relation-fresh@example.com"]);
    const completed = await app.inject({ method: "PATCH", url: `/cards/${blocker.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual((await db.select().from(emailQueue).where(eq(emailQueue.type, "card_unblocked"))).map((row) => row.toEmail), ["active-relation-fresh@example.com"], "nor a handoff email");

    // The relation still exists, so the retry is the outcome the caller asked for, even though the
    // blocker has since been completed and could not be added afresh.
    const retried = await addRelation(app, owner.auth, blocked.id, blocker.id, "blocked_by");
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json<CardRelationSummary>().id, linked.json<CardRelationSummary>().id);
    assert.equal((await addRelation(app, owner.auth, (await insertCard(workspace.boardId, "Fresh dependent")).id, blocker.id, "blocked_by")).statusCode, 400);

    // card_blocked -> move to the second list: the response shows the new list, and the "you are
    // blocked" notification lands in it. card_blocked -> complete: nobody is told they are blocked.
    const mover = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_blocked", actions: [{ type: "move_to_list", config: { listId: workspace.otherListId, placement: "top" } }] } });
    assert.equal(mover.statusCode, 201, mover.body);
    const upstream = await insertCard(workspace.boardId, "Upstream");
    const movedByBlock = await insertCard(workspace.boardId, "Moved when blocked");
    await db.insert(cardAssignees).values({ cardId: movedByBlock.id, userId: active.member.id });
    const blockedResponse = await addRelation(app, owner.auth, upstream.id, movedByBlock.id, "blocks");
    assert.equal(blockedResponse.statusCode, 201, blockedResponse.body);
    const [secondList] = await db.select().from(lists).where(eq(lists.id, workspace.otherListId));
    assert.equal(blockedResponse.json<CardRelationSummary>().card.listName, secondList!.name, "the response shows where the automation put the card");
    const [blockedNotice] = await db.select().from(notifications).where(and(eq(notifications.reason, "dependency"), eq(notifications.cardId, movedByBlock.id)));
    assert.equal(blockedNotice?.listId, workspace.otherListId, "the inbox entry points at the card's current list");
    await db.update(automations).set({ enabled: false }).where(eq(automations.workspaceId, workspace.id));
    const completer = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_blocked", actions: [{ type: "set_completion", config: { completed: true } }] } });
    assert.equal(completer.statusCode, 201, completer.body);
    const doneWhenBlocked = await insertCard(workspace.boardId, "Completed when blocked");
    await db.insert(cardAssignees).values({ cardId: doneWhenBlocked.id, userId: active.member.id });
    const noticesBefore = (await dependencyRecipients()).length;
    const emailsBefore = (await db.select().from(emailQueue).where(eq(emailQueue.type, "card_dependency_added"))).length;
    const completedResponse = await addRelation(app, owner.auth, doneWhenBlocked.id, upstream.id, "blocked_by");
    assert.equal(completedResponse.statusCode, 201, completedResponse.body);
    assert.equal((await dependencyRecipients()).length, noticesBefore, "a card the automation completed is not announced as blocked");
    assert.equal((await db.select().from(emailQueue).where(eq(emailQueue.type, "card_dependency_added"))).length, emailsBefore);
    await db.update(automations).set({ enabled: false }).where(eq(automations.workspaceId, workspace.id));

    // card_unblocked -> move: the handoff's inbox entry points at the list the card was moved to.
    const handoffMover = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/automations`, headers: owner.auth,
      payload: { enabled: true, triggerType: "card_unblocked", actions: [{ type: "move_to_list", config: { listId: workspace.otherListId, placement: "top" } }] } });
    assert.equal(handoffMover.statusCode, 201, handoffMover.body);
    const lastBlocker = await insertCard(workspace.boardId, "Last blocker");
    const readyCard = await insertCard(workspace.boardId, "Moved when ready");
    await db.insert(cardAssignees).values({ cardId: readyCard.id, userId: active.member.id });
    assert.equal((await addRelation(app, owner.auth, readyCard.id, lastBlocker.id, "blocked_by")).statusCode, 201);
    const released = await app.inject({ method: "PATCH", url: `/cards/${lastBlocker.id}/completion`, headers: owner.auth, payload: { completed: true } });
    assert.equal(released.statusCode, 200, released.body);
    const [handoffNotice] = await db.select({ listId: notifications.listId }).from(notifications)
      .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
      .where(and(eq(notifications.cardId, readyCard.id), eq(activityEvents.action, "blockers:cleared")));
    assert.equal(handoffNotice?.listId, workspace.otherListId, "the handoff points at where the automation moved the card");

    // Two related cards relabelled together: each shows the other's labels, so both re-read.
    const linksChangedFor = async (cardId: string) => (await db.select().from(eventOutbox).where(eq(eventOutbox.eventType, "card:links:changed")))
      .filter((event) => (event.payload as { cardId: string }).cardId === cardId).length;
    const left = await insertCard(workspace.boardId, "Left");
    const right = await insertCard(workspace.boardId, "Right");
    assert.equal((await addRelation(app, owner.auth, left.id, right.id, "relates_to")).statusCode, 201);
    const [leftReads, rightReads] = [await linksChangedFor(left.id), await linksChangedFor(right.id)];
    const [label] = await db.insert(cardLabels).values({ workspaceId: workspace.id, name: "Together", position: "1000.0000000000" }).returning();
    const bulk = await app.inject({ method: "PATCH", url: `/boards/${workspace.boardId}/cards/bulk/labels`, headers: owner.auth, payload: { cardIds: [left.id, right.id], mode: "add", labelIds: [label!.id] } });
    assert.equal(bulk.statusCode, 200, bulk.body);
    assert.ok(await linksChangedFor(left.id) > leftReads, "bulk labels: the left card re-reads the right card's labels");
    assert.ok(await linksChangedFor(right.id) > rightReads, "bulk labels: and vice versa");

    // A blocked card moved to another board arrives there with its count, not as an unblocked card.
    const stillBlocked = await insertCard(workspace.boardId, "Crosses boards while blocked");
    assert.equal((await addRelation(app, owner.auth, stillBlocked.id, upstream.id, "blocked_by")).statusCode, 201);
    const crossed = await app.inject({ method: "POST", url: `/cards/${stillBlocked.id}/move-to-board`, headers: owner.auth, payload: { boardId: privateBoard.id } });
    assert.equal(crossed.statusCode, 200, crossed.body);
    const arrivals = (await db.select().from(eventOutbox).where(and(eq(eventOutbox.boardId, privateBoard.id), eq(eventOutbox.eventType, "card:created"))))
      .map((event) => event.payload as { card: { id: string }; blockedByCount?: number })
      .filter((payload) => payload.card.id === stillBlocked.id);
    assert.deepEqual(arrivals.map((payload) => payload.blockedByCount), [1]);
  } finally {
    await app.close();
  }
});
