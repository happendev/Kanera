import "../test/setup.integration.js";
import "../test/integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  activityEvents, boards, cardAssignees, cardChecklistItems, cardChecklists, cards, clients, lists, workspaces,
} from "@kanera/shared/schema";
import type { WorkDoneEvent } from "@kanera/shared/dto";
import { db, pool } from "../db.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import { loadWorkDone, loadWorkDonePage, type LoadWorkDoneOptions } from "./work-done.js";

// E2E covers live API/browser flows in performance-backend.spec.ts. It cannot reliably place
// historical records across viewer-local midnight, at equal sub-millisecond timestamps, or create
// legacy non-boolean completion payloads. Those concrete failures need a deterministic DB fixture:
// - dropping/duplicating a move run across a cursor, merging separate days or completion-separated runs;
// - false/string completion payloads breaking a run, hidden feed rows disappearing, lost last actor/path;
// - checklist/card timestamp ties sorting differently, or summaries depending on page size;
// - actor/title/assigned-only filters or archived cards leaking into the bounded projection;
// - a concurrent deletion between key selection and hydration yielding an empty continuation page.
void test("bounded history matches full history across day, run, cursor and visibility boundaries", async () => {
  const [client] = await db.insert(clients).values({ name: "History parity" }).returning();
  const [actor, viewer] = await insertTestUsers(db, [
    { clientId: client!.id, email: "actor@history-parity.test", passwordHash: "x", displayName: "Actor" },
    { clientId: client!.id, email: "viewer@history-parity.test", passwordHash: "x", displayName: "Viewer" },
  ]).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "History" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "History", position: "1" }).returning();
  const [list] = await db.insert(lists).values({ workspaceId: workspace!.id, name: "Todo", position: "1" }).returning();
  const [moving, checklistCard, hidden, archived] = await db.insert(cards).values([
    { title: "Moving", position: "1" }, { title: "Checklist", position: "2" },
    { title: "Hidden", position: "3" }, { title: "Archived", position: "4", archivedAt: new Date() },
  ].map((card) => ({ ...card, boardId: board!.id, listId: list!.id, createdById: actor!.id }))).returning();
  await db.insert(cardAssignees).values({ cardId: moving!.id, userId: viewer!.id });
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const at = (time: string) => new Date(`${day}T${time}Z`);
  const event = (cardId: string, action: string, time: string, payload: object = {}) => ({
    boardId: board!.id, workspaceId: workspace!.id, actorId: actor!.id,
    entityType: "card", entityId: cardId, action, payload, createdAt: at(time),
  });
  const rows = await db.insert(activityEvents).values([
    event(moving!.id, "created", "18:00:00"),
    event(moving!.id, "moved", "18:10:00", { fromListId: list!.id, toListId: list!.id }),
    event(moving!.id, "completion:set", "18:11:00", { toValue: false }),
    { ...event(moving!.id, "moved", "18:12:00", { toListId: list!.id }), feedVisible: false },
    event(moving!.id, "completion:set", "18:13:00", { toValue: "true" }),
    event(moving!.id, "moved", "18:14:00", { toListId: list!.id }),
    event(moving!.id, "completion:set", "18:15:00", { toValue: true }),
    event(moving!.id, "moved", "18:16:00", { fromListId: list!.id, toListId: list!.id }),
    event(moving!.id, "moved", "18:29:59", { toListId: list!.id }),
    { ...event(moving!.id, "moved", "18:30:00", { toListId: list!.id }), actorKind: "agent" as const, agentName: "History agent" },
    event(checklistCard!.id, "created", "18:30:00"),
    event(hidden!.id, "created", "18:35:00"),
    event(archived!.id, "created", "18:36:00"),
    { ...event(checklistCard!.id, "completed", "18:40:00"), actorId: viewer!.id },
  ]).returning();
  // The wire cursor has milliseconds; these distinct DB instants deliberately share one wire time.
  await db.update(activityEvents).set({ createdAt: sql`${`${day}T18:30:00.000500Z`}::timestamptz` }).where(eq(activityEvents.id, rows[9]!.id));
  // Two 01:30 instants during New York's autumn clock change are still one local day/run.
  // Fixed historical/future fixture dates are intentional: this helper tests bucketing, while the
  // HTTP layer separately validates the moving 60-day query window.
  await db.insert(activityEvents).values([
    "2026-11-01T03:55:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z",
    "2026-11-02T04:55:00Z", "2026-11-02T05:05:00Z",
  ].map((createdAt) => ({
    ...event(moving!.id, "moved", "18:00:00", { toListId: list!.id }), createdAt: new Date(createdAt),
  })));
  const [checklist] = await db.insert(cardChecklists).values({ cardId: checklistCard!.id, title: "Checklist", position: "1" }).returning();
  await db.insert(cardChecklistItems).values({ checklistId: checklist!.id, text: "Completed item", position: "1", assigneeId: viewer!.id, completedById: actor!.id, completedAt: at("18:30:00") });
  const base: LoadWorkDoneOptions = {
    clientId: client!.id, boardIds: [board!.id], from: at("00:00:00"), to: new Date(at("00:00:00").getTime() + 86_400_000),
    actorUserId: actor!.id, timeZone: "Asia/Kolkata",
  };
  const daylightSaving: LoadWorkDoneOptions = {
    ...base, from: new Date("2026-11-01T03:00:00Z"), to: new Date("2026-11-02T06:00:00Z"), timeZone: "America/New_York",
  };
  const cases: LoadWorkDoneOptions[] = [
    base, daylightSaving, { ...base, timeZone: "UTC" }, { ...base, q: "Moving" },
    { ...base, actorUserId: viewer!.id }, { ...base, actorUserId: undefined },
    { ...base, visibilityUserId: viewer!.id, visibilityRestrictedBoardIds: [board!.id] },
    { ...base, listIds: [list!.id] }, { ...base, actorUserIds: [] }, { ...base, boardIds: [] },
  ];
  for (const options of cases) {
    const expected = (await loadWorkDone(options)).events;
    assert.ok(expected.every((entry) => entry.card.id !== archived!.id));
    const expectedSummary = { created: 0, moved: 0, completed: 0, checklistItemCompleted: 0, cardsTouched: new Set(expected.map((entry) => entry.card.id)).size, totalEvents: expected.length };
    for (const entry of expected) expectedSummary[entry.type]++;
    for (const limit of [1, 2, 3, 100]) {
      const actual: WorkDoneEvent[] = [];
      let cursor: { at: string; id: string } | undefined;
      for (let index = 0; index <= expected.length; index++) {
        const page = await loadWorkDonePage(options, { limit, cursor });
        assert.deepEqual(page.summary, expectedSummary);
        actual.push(...page.events);
        if (!page.hasMore) break;
        const last = page.events.at(-1);
        assert.ok(last, "a continuation must make progress");
        cursor = { at: last.at, id: last.id };
      }
      assert.deepEqual(actual, expected, JSON.stringify({ limit, options }));
    }
  }
  assert.equal((await loadWorkDone(daylightSaving)).events.length, 3, "fall-back repeats an hour, not a local-day boundary");
  const original = (await loadWorkDone(base)).events;
  assert.equal(original.filter((entry) => entry.type === "moved").length, 3, "completion and viewer midnight each split move runs");
  const firstRun = original.find((entry) => entry.id === rows[1]!.id);
  assert.equal(firstRun?.type, "moved");
  if (firstRun?.type === "moved") assert.equal(firstRun.listPath.length, 4, "false/string completions do not break the path; hidden feed moves remain included");
  const latestMove = original.find((entry) => entry.id === rows[9]!.id);
  assert.equal(latestMove?.type, "moved");
  if (latestMove?.type === "moved") assert.equal(latestMove.agentName, "History agent");

  // Release a hooked connection back to the pool so the page transaction acquires it. Delete on
  // a separate real connection immediately after selection, before hydration is allowed to run.
  // This controls only the race timing; both reads and the concurrent write execute in Postgres.
  const connection = await pool.connect();
  const target = connection as unknown as { query: (...args: unknown[]) => unknown };
  const originalQuery = target.query.bind(connection);
  let deletedDuringPage = false;
  target.query = (...args) => {
    const query = args[0] as { text?: string } | string;
    const text = typeof query === "string" ? query : query.text ?? "";
    const result = originalQuery(...args);
    if (!deletedDuringPage && text.trimStart().startsWith("with activity_source as")) {
      deletedDuringPage = true;
      return (result as Promise<unknown>).then(async (rows) => {
        await db.delete(cards).where(eq(cards.id, moving!.id));
        return rows;
      });
    }
    return result;
  };
  connection.release();
  try {
    const snapshot = await loadWorkDonePage(base, { limit: 100 });
    assert.equal(deletedDuringPage, true, "the deletion must actually run between selection and hydration");
    assert.deepEqual(snapshot.events, original, "all phases must read the same snapshot despite deletion");
    assert.equal((await db.select().from(cards).where(eq(cards.id, moving!.id))).length, 0);
  } finally {
    target.query = originalQuery;
  }
});
