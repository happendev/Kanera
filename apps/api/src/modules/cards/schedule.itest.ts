import "../../test/setup.integration.js";
import type { ScheduleResponse } from "@kanera/shared/dto";
import { boardMembers, boards, cards, lists, workspaceMembers } from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

/**
 * Failure modes these cover, which E2E cannot pin down bar by bar:
 * - the server's verdict drifts from the shared engine (slack, critical path, conflict days);
 * - an undated card is counted as scheduled, or a dated one as unscheduled;
 * - a card on a board the viewer cannot open is placed on the chart (title, dates leak), or its
 *   edge constrains a card the viewer can see;
 * - a workspace scope stops at one board, or a board scope swallows unrelated boards;
 * - projectedFinish, latestDue and slipDays disagree with the chain the cards describe.
 *
 * Dates sit in June 2030: 3 June is a Monday, so weekends fall on 8/9 and 15/16 June.
 */
void test("schedule places chains, flags conflicts and hides cards the viewer cannot open", async () => {
  const app = await buildIntegrationServer();
  try {
    const owner = await signupOwner(app, { orgName: "Acme schedule", email: "owner-schedule@example.com", displayName: "Owner" });
    const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
    assert.equal(created.statusCode, 201, created.body);
    const workspaceId = created.json<{ id: string }>().id;
    const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position)).limit(1);
    assert.ok(list);
    const [board, other, hidden] = await db.insert(boards).values([
      { workspaceId, name: "Plan", position: "1000.0000000000" },
      { workspaceId, name: "Other", position: "2000.0000000000" },
      { workspaceId, name: "Private", position: "3000.0000000000" },
    ]).returning();
    assert.ok(board && other && hidden);
    const insert = async (boardId: string, title: string, start: string | null, due: string | null) => {
      const [card] = await db.insert(cards).values({
        listId: list.id, boardId, title, position: "1000.0000000000", createdById: owner.user.id,
        startDateLocalDate: start, dueDateLocalDate: due, ...(due && { dueDateSlot: "anyTime" as const, dueDateTimezone: "UTC" }),
      }).returning();
      assert.ok(card);
      return card;
    };
    const blocks = async (blockerId: string, blockedId: string) => {
      const response = await app.inject({ method: "POST", url: `/cards/${blockerId}/relations`, headers: owner.auth, payload: { targetCardId: blockedId, direction: "blocks" } });
      assert.equal(response.statusCode, 201, response.body);
    };

    // A → B → C is the critical chain; D also blocks C with room to spare; E waits on A but is
    // planned to start before A finishes; F has no dates; G is on a board the member cannot open.
    const a = await insert(board.id, "A", "2030-06-03", "2030-06-05");
    const b = await insert(board.id, "B", "2030-06-06", "2030-06-10");
    const c = await insert(board.id, "C", "2030-06-10", "2030-06-12");
    const d = await insert(board.id, "D", "2030-06-03", "2030-06-04");
    const e = await insert(board.id, "E", "2030-06-04", "2030-06-06");
    const f = await insert(board.id, "F", null, null);
    const g = await insert(hidden.id, "G", "2030-06-03", "2030-06-04");
    const h = await insert(other.id, "H", "2030-06-17", "2030-06-18");
    const done = await insert(board.id, "Done", "2030-06-03", "2030-06-20");
    await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, done.id));
    await blocks(a.id, b.id);
    await blocks(b.id, c.id);
    await blocks(d.id, c.id);
    await blocks(a.id, e.id);
    await blocks(g.id, c.id);

    const [member] = await insertTestUsers(db, { clientId: owner.user.clientId, email: "member-schedule@example.com", passwordHash: "x", displayName: "Member" }).returning();
    assert.ok(member);
    await db.insert(workspaceMembers).values({ workspaceId, userId: member.id, role: "member" });
    await db.insert(boardMembers).values([
      { boardId: board.id, userId: member.id, role: "editor" as const },
      { boardId: other.id, userId: member.id, role: "observer" as const },
    ]);
    const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" })}` };
    const read = async (headers: Record<string, string>, payload: object) => {
      const response = await app.inject({ method: "POST", url: "/cards/schedule", headers, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ScheduleResponse>();
    };
    const byTitle = (schedule: ScheduleResponse) => new Map(schedule.cards.map((card) => [card.title, card]));

    const plan = await read(memberAuth, { boardId: board.id });
    const cardsOf = byTitle(plan);
    assert.deepEqual([...cardsOf.keys()].sort(), ["A", "B", "C", "D", "E", "F"], "open board cards only; the private blocker stays off the chart");
    assert.deepEqual(plan.cards.filter((card) => card.critical).map((card) => card.title).sort(), ["A", "B", "C"]);
    assert.equal(cardsOf.get("D")?.slackDays, 4, "D can finish as late as the Friday before C's latest start");
    assert.equal(cardsOf.get("E")?.slackDays, 3);
    assert.deepEqual(cardsOf.get("C")?.blockerIds.sort(), [b.id, d.id].sort(), "the private blocker constrains nothing the member sees");
    assert.deepEqual(cardsOf.get("C")?.conflicts.map((conflict) => ({ blockerId: conflict.blockerId, days: conflict.days })), [{ blockerId: b.id, days: 1 }]);
    assert.deepEqual(cardsOf.get("E")?.conflicts.map((conflict) => ({ blockerId: conflict.blockerId, days: conflict.days })), [{ blockerId: a.id, days: 2 }]);
    assert.deepEqual([cardsOf.get("C")?.earliestStart, cardsOf.get("C")?.earliestFinish], ["2030-06-11", "2030-06-13"], "C can only start the day after B's real finish");
    assert.deepEqual([cardsOf.get("F")?.plannedStart, cardsOf.get("F")?.slackDays, cardsOf.get("F")?.critical], [null, null, false]);
    assert.equal(plan.edges.length, 4);
    assert.equal(plan.criticalEdgeIds.length, 2, "A→B and B→C; D→C has slack");
    assert.deepEqual(plan.summary, {
      scheduledCount: 5, unscheduledCount: 1, conflictCount: 2, criticalCount: 3,
      range: { start: "2030-06-03", end: "2030-06-13" },
      projectedFinish: "2030-06-13", latestDue: "2030-06-12", slipDays: 1,
    });
    assert.deepEqual(plan.boards.map((entry) => entry.name), ["Plan"]);
    assert.equal(plan.truncated, false);
    assert.match(cardsOf.get("A")?.url ?? "", /\/o\/[^/]+\/c\/[A-Z0-9]+-\d+$/u);
    assert.ok(!JSON.stringify(plan).includes(g.id), "the private card's id never appears");

    const owners = await read(owner.auth, { boardId: board.id });
    const ownerCards = byTitle(owners);
    assert.ok(ownerCards.has("G"), "a viewer who can open the private board sees the blocker one hop away");
    assert.deepEqual(ownerCards.get("C")?.blockerIds.sort(), [b.id, d.id, g.id].sort());
    assert.equal(owners.summary.scheduledCount, 6);

    const workspace = await read(memberAuth, { workspaceId });
    assert.deepEqual([...byTitle(workspace).keys()].sort(), ["A", "B", "C", "D", "E", "F", "H"], "the workspace scope spans both readable boards");
    assert.ok(!workspace.cards.some((card) => card.id === h.id && card.critical));
    assert.deepEqual(workspace.boards.map((entry) => entry.name).sort(), ["Other", "Plan"]);
    assert.deepEqual([workspace.summary.projectedFinish, workspace.summary.latestDue, workspace.summary.slipDays], ["2030-06-13", "2030-06-18", 0], "an unrelated later card holds the plan");
    assert.equal(workspace.summary.range?.end, "2030-06-18");

    const denied = await app.inject({ method: "POST", url: "/cards/schedule", headers: memberAuth, payload: { boardId: hidden.id } });
    assert.equal(denied.statusCode, 403);
    const rejected = await app.inject({ method: "POST", url: "/cards/schedule", headers: memberAuth, payload: { boardId: board.id, workspaceId } });
    assert.equal(rejected.statusCode, 400, "exactly one scope");
    assert.ok(f.id && e.id);
  } finally {
    await app.close();
  }
});
