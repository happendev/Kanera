import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduleResponse } from "@kanera/shared/dto";
import { boardMembers, boards, cardAssignees, cards, cardScheduleState, boardScheduleState, lists, scheduleRecheckQueue, workspaceMembers } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db.js";
import { runScheduleRecheckSweep } from "../../lib/automations.js";
import { agentWorkQueryRoutes } from "../work/routes.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

// These need deterministic database state/locks: E2E cannot reliably force stale concurrent reads,
// inspect worker latches, or count SQL queries independently of background processes.
async function fixture(seed: string) {
  const app = await buildIntegrationServer();
  await app.register(agentWorkQueryRoutes, { prefix: "/agent-public" });
  const owner = await signupOwner(app, { seed });
  const workspace = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Planning regression" } });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const workspaceId = workspace.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).limit(1);
  assert.ok(list);
  const board = async (name: string) => (await db.insert(boards).values({ workspaceId, name, position: "1000" }).returning())[0]!;
  const create = async (boardId: string, title: string, start = "2030-06-03", due = "2030-06-05") => {
    const response = await app.inject({ method: "POST", url: `/boards/${boardId}/lists/${list.id}/cards`, headers: owner.auth, payload: { title, startDateLocalDate: start, dueDateLocalDate: due } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ id: string; key: string; title: string }>();
  };
  const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/cards/${id}`, headers: owner.auth, payload });
  const link = async (source: string, target: string) => {
    const response = await app.inject({ method: "POST", url: `/cards/${source}/relations`, headers: owner.auth, payload: { targetCardId: target, direction: "blocks" } });
    assert.equal(response.statusCode, 201, response.body);
  };
  const read = async (boardId: string) => {
    const response = await app.inject({ method: "POST", url: "/cards/schedule", headers: owner.auth, payload: { boardId } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ScheduleResponse>();
  };
  return { app, owner, workspaceId, list, board, create, patch, link, read };
}

void test("complete chains include cards beyond 400 and invalidate transitive board latches", async () => {
  const f = await fixture("schedule-full-chain");
  try {
    const aBoard = await f.board("Upstream"), bBoard = await f.board("Middle"), cBoard = await f.board("Large destination");
    await db.insert(cards).values(Array.from({ length: 401 }, (_, index) => ({ boardId: cBoard.id, listId: f.list.id, title: `Backlog ${index}`, position: String(index + 1), createdById: f.owner.user.id })));
    const a = await f.create(aBoard.id, "A", "2030-06-03", "2030-06-20");
    const b = await f.create(bBoard.id, "B");
    const c = await f.create(cBoard.id, "C");
    await f.link(a.id, b.id); await f.link(b.id, c.id);
    const response = await f.read(cBoard.id);
    assert.equal(response.truncated, false);
    assert.equal(response.cards.length, 404);
    assert.ok(response.cards.some((card) => card.id === a.id));
    assert.equal(response.cards.find((card) => card.id === c.id)?.earliestFinish, "2030-06-28");
    await runScheduleRecheckSweep();
    assert.equal((await db.select().from(cardScheduleState).where(eq(cardScheduleState.cardId, c.id))).length, 1);
    assert.equal((await db.select().from(boardScheduleState).where(eq(boardScheduleState.boardId, cBoard.id)))[0]?.projectedFinish, "2030-06-28");
    assert.equal((await f.patch(a.id, { dueDateLocalDate: "2030-06-21" })).statusCode, 200);
    assert.ok((await db.select().from(scheduleRecheckQueue)).some((row) => row.boardId === cBoard.id), "changing A queues C's board across two relations");
    await runScheduleRecheckSweep();
    assert.equal((await db.select().from(boardScheduleState).where(eq(boardScheduleState.boardId, cBoard.id)))[0]?.projectedFinish, "2030-07-01");
  } finally { await f.app.close(); }
});

void test("concurrent single and bulk date changes validate the locked current range", async () => {
  const f = await fixture("schedule-date-race");
  try {
    const board = await f.board("Concurrent");
    for (const bulk of [false, true]) {
      const card = await f.create(board.id, "Race", "2030-06-03", "2030-06-20");
      const lock = await pool.connect();
      await lock.query("begin");
      await lock.query("select id from card where id=$1 for update", [card.id]);
      const start = f.patch(card.id, { startDateLocalDate: "2030-06-15" });
      const due = bulk ? f.app.inject({ method: "PATCH", url: `/boards/${board.id}/cards/bulk/due-date`, headers: f.owner.auth, payload: { cardIds: [card.id], dueDateLocalDate: "2030-06-10" } })
        : f.patch(card.id, { dueDateLocalDate: "2030-06-10" });
      // inject thenables must start before waiting on pg_stat_activity.
      const pending = Promise.all([Promise.resolve(start), Promise.resolve(due)]);
      try {
        let waiters = 0;
        for (let attempt = 0; attempt < 100 && waiters < 2; attempt++) {
          const result = await pool.query("select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'");
          waiters = Number(result.rows[0].count);
          if (waiters < 2) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(waiters >= 2, "both requests reached their locking read/write");
      } finally { await lock.query("commit"); lock.release(); }
      const responses = await pending;
      assert.equal(responses[1]!.statusCode, 200, responses[1]!.body);
      assert.ok([200, 400].includes(responses[0]!.statusCode), responses[0]!.body);
      const [saved] = await db.select().from(cards).where(eq(cards.id, card.id));
      assert.ok(saved?.startDateLocalDate && saved.dueDateLocalDate && saved.startDateLocalDate <= saved.dueDateLocalDate);
      await assert.rejects(pool.query("update card set start_date_local_date=$1 where id=$2", ["2030-06-30", card.id]), /cards_start_before_due_ck/);
    }
  } finally { await f.app.close(); }
});

void test("scheduling comments redact private and assigned-only blocker identities", async () => {
  const f = await fixture("schedule-private-comment");
  try {
    const publicBoard = await f.board("Public"), privateBoard = await f.board("Private");
    const [member] = await insertTestUsers(db, { clientId: f.owner.user.clientId, email: "schedule-private-member@example.com", passwordHash: "x", displayName: "Member" }).returning();
    assert.ok(member);
    await db.insert(workspaceMembers).values({ workspaceId: f.workspaceId, userId: member.id, role: "member" });
    await db.insert(boardMembers).values({ boardId: publicBoard.id, userId: member.id, role: "observer" });
    const created = await f.app.inject({ method: "POST", url: `/workspaces/${f.workspaceId}/automations`, headers: f.owner.auth, payload: { enabled: true, triggerType: "scheduling_conflict_appears", actions: [{ type: "post_comment", config: { template: "Blocked by {{schedule.blocker}} ({{schedule.days}}d)" } }] } });
    assert.equal(created.statusCode, 201, created.body);
    const memberAuth = { authorization: `Bearer ${f.app.jwt.sign({ sub: member.id, cid: f.owner.user.clientId, role: "member" })}` };
    for (const sameBoard of [false, true]) {
      if (sameBoard) await db.update(boardMembers).set({ assignedItemsOnly: true }).where(eq(boardMembers.userId, member.id));
      const secret = await f.create(sameBoard ? publicBoard.id : privateBoard.id, "CONFIDENTIAL acquisition");
      const waiting = await f.create(publicBoard.id, "Waiting", "2030-06-06", "2030-06-07");
      if (sameBoard) await db.insert(cardAssignees).values({ cardId: waiting.id, userId: member.id });
      await f.link(secret.id, waiting.id);
      await runScheduleRecheckSweep();
      assert.equal((await f.patch(secret.id, { dueDateLocalDate: "2030-06-07" })).statusCode, 200);
      await runScheduleRecheckSweep();
      const hidden = await f.app.inject({ method: "GET", url: `/cards/${secret.id}/detail`, headers: memberAuth });
      assert.equal(hidden.statusCode, 403);
      const comments = await f.app.inject({ method: "GET", url: `/cards/${waiting.id}/comments`, headers: memberAuth });
      assert.equal(comments.statusCode, 200);
      assert.ok(comments.body.includes("Blocked by"), "the automation still posts its conflict");
      assert.ok(!comments.body.includes(secret.title) && !comments.body.includes(secret.key), "persisted comments never disclose the inaccessible sibling");
    }
  } finally { await f.app.close(); }
});

void test("portfolio schedule SQL count stays constant as dated boards grow", async (t) => {
  const f = await fixture("schedule-portfolio-batch");
  try {
    const first = await f.board("One"); await f.create(first.id, "Plan");
    let queries = 0;
    const original = pool.query.bind(pool);
    const spy = t.mock.method(pool, "query", function (this: typeof pool, ...args: unknown[]) {
      queries++;
      return Reflect.apply(original, this, args);
    });
    const read = async () => {
      queries = 0;
      const start = performance.now();
      const response = await f.app.inject({ method: "POST", url: "/agent-public/work/portfolio/query", headers: f.owner.auth, payload: { days: 30 } });
      assert.equal(response.statusCode, 200, response.body);
      return { queries, ms: Math.round(performance.now() - start), response };
    };
    const small = await read();
    const more = await db.insert(boards).values(Array.from({ length: 50 }, (_, index) => ({ workspaceId: f.workspaceId, name: `Plan ${index}`, position: String(index + 2000) }))).returning();
    await db.insert(cards).values(more.map((board) => ({ boardId: board.id, listId: f.list.id, title: "Dated", position: "1000", createdById: f.owner.user.id, startDateLocalDate: "2030-06-03", dueDateLocalDate: "2030-06-07", dueDateSlot: "anyTime" as const, dueDateTimezone: "UTC" })));
    const large = await read();
    spy.mock.restore();
    assert.ok(large.queries <= small.queries + 2, `small=${small.queries}, 51 boards=${large.queries}`);
    assert.equal(large.response.json<{ buckets: { schedule?: { projectedFinish: string | null } }[] }>().buckets.filter((bucket) => bucket.schedule?.projectedFinish).length, 51);
    t.diagnostic(`Portfolio: 1 board ${small.queries} SQL / ${small.ms}ms; 51 boards ${large.queries} SQL / ${large.ms}ms`);
  } finally { await f.app.close(); }
});
