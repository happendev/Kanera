import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addWorkingDays,
  barDurationDays,
  computeSchedule,
  dateKeyOf,
  dayNumber,
  endForMovedStart,
  finishOf,
  plannedBar,
  workingDaysBetween,
  type ScheduleCardInput,
} from "@kanera/shared/schedule";

// 2026-10-19 is a Monday.
const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";
const FRI = "2026-10-23";
const SAT = "2026-10-24";
const SUN = "2026-10-25";
const NEXT_MON = "2026-10-26";
const NEXT_TUE = "2026-10-27";
const NEXT_WED = "2026-10-28";
const NEXT_FRI = "2026-10-30";

const card = (id: string, start: string | null, due: string | null, done = false): ScheduleCardInput =>
  ({ id, startDateLocalDate: start, dueDateLocalDate: due, done });
const blocks = (id: string, source: string, target: string) => ({ id, sourceCardId: source, targetCardId: target });

void test("working-day arithmetic skips weekends and round-trips date keys", () => {
  assert.equal(dateKeyOf(dayNumber(MON)), MON);
  assert.equal(workingDaysBetween(dayNumber(MON), dayNumber(FRI)), 5);
  assert.equal(workingDaysBetween(dayNumber(MON), dayNumber(NEXT_MON)), 6);
  assert.equal(workingDaysBetween(dayNumber(SAT), dayNumber(SUN)), 0);
  assert.equal(workingDaysBetween(dayNumber(FRI), dayNumber(MON)), 0, "reversed range counts nothing");
  assert.equal(dateKeyOf(addWorkingDays(dayNumber(FRI), 1)), NEXT_MON);
  assert.equal(dateKeyOf(addWorkingDays(dayNumber(NEXT_MON), -1)), FRI);
  assert.equal(dateKeyOf(addWorkingDays(dayNumber(SAT), 0)), SAT, "zero keeps a weekend date");
  assert.equal(dateKeyOf(finishOf(dayNumber(THU), 3)), NEXT_MON, "a three-day bar from Thursday ends Monday");
  assert.equal(dateKeyOf(finishOf(dayNumber(SAT), 1)), NEXT_MON, "a one-day bar on Saturday ends the next working day");
});

void test("a bar keeps its working-day length when moved across a weekend", () => {
  const bar = { start: MON, end: WED };
  assert.equal(barDurationDays(bar), 3);
  assert.equal(endForMovedStart(bar, THU), NEXT_MON);
  assert.equal(barDurationDays({ start: SAT, end: SUN }), 1, "an all-weekend bar still counts one day");
  assert.equal(endForMovedStart({ start: SAT, end: SUN }, MON), TUE, "and moves as calendar days");
});

void test("one date is a point and a start after the due date collapses onto the due date", () => {
  assert.deepEqual(plannedBar({ startDateLocalDate: null, dueDateLocalDate: FRI }), { start: FRI, end: FRI });
  assert.deepEqual(plannedBar({ startDateLocalDate: MON, dueDateLocalDate: null }), { start: MON, end: MON });
  assert.deepEqual(plannedBar({ startDateLocalDate: FRI, dueDateLocalDate: MON }), { start: MON, end: MON });
  assert.equal(plannedBar({ startDateLocalDate: null, dueDateLocalDate: null }), null);
});

void test("the forward pass pushes a dependent to the working day after its blocker finishes", () => {
  const schedule = computeSchedule(
    [card("a", MON, FRI), card("b", MON, TUE), card("c", null, null)],
    [blocks("ab", "a", "b"), blocks("bc", "b", "c")],
  );
  const b = schedule.cards.get("b")!;
  assert.equal(b.earliestStart, NEXT_MON, "b cannot start before a finishes on Friday");
  assert.equal(b.earliestFinish, NEXT_TUE, "and keeps its two-day length");
  assert.equal(b.conflicts.length, 1);
  assert.deepEqual(b.conflicts[0], { kind: "blockerFinishesAfterStart", edgeId: "ab", blockerId: "a", days: 5 });
  const c = schedule.cards.get("c")!;
  assert.equal(c.earliestStart, NEXT_WED, "an undated card inherits a start from its chain");
  assert.equal(c.durationDays, 1);
  assert.deepEqual(schedule.range, { start: MON, end: NEXT_WED });
});

void test("slack and the critical path follow the longest chain in working days", () => {
  // a (5d) -> c (1d); b (1d) -> c. a is the long leg, b has four days of slack.
  const schedule = computeSchedule(
    [card("a", MON, FRI), card("b", MON, MON), card("c", NEXT_MON, NEXT_MON)],
    [blocks("ac", "a", "c"), blocks("bc", "b", "c")],
  );
  assert.equal(schedule.cards.get("a")!.slackDays, 0);
  assert.equal(schedule.cards.get("a")!.critical, true);
  assert.equal(schedule.cards.get("c")!.critical, true);
  assert.equal(schedule.cards.get("b")!.slackDays, 4);
  assert.equal(schedule.cards.get("b")!.latestFinish, FRI);
  assert.equal(schedule.cards.get("b")!.critical, false);
  assert.deepEqual([...schedule.criticalEdgeIds], ["ac"]);
});

void test("a lone card is never critical and a planned gap shows as slack", () => {
  const schedule = computeSchedule([card("a", MON, FRI)], []);
  assert.equal(schedule.cards.get("a")!.slackDays, 0);
  assert.equal(schedule.cards.get("a")!.critical, false, "critical needs a chain");
  const gap = computeSchedule([card("a", MON, TUE), card("b", NEXT_MON, NEXT_FRI)], [blocks("ab", "a", "b")]);
  assert.equal(gap.cards.get("a")!.slackDays, 3, "a may finish Wednesday, Thursday or Friday");
  assert.equal(gap.cards.get("a")!.critical, false);
  assert.equal(gap.cards.get("b")!.conflicts.length, 0);
});

void test("completed cards leave the schedule and release their dependents", () => {
  const schedule = computeSchedule(
    [card("a", MON, NEXT_FRI, true), card("b", TUE, WED)],
    [blocks("ab", "a", "b")],
  );
  const b = schedule.cards.get("b")!;
  assert.equal(b.earliestStart, TUE);
  assert.deepEqual(b.blockerIds, []);
  assert.equal(b.conflicts.length, 0);
  assert.equal(schedule.cards.get("a")!.earliestStart, null);
  assert.deepEqual(schedule.range, { start: TUE, end: WED });
});

void test("edges to cards not on the schedule and undated chains are ignored safely", () => {
  const schedule = computeSchedule([card("a", null, null), card("b", null, null)], [blocks("ab", "a", "b"), blocks("ax", "a", "missing")]);
  assert.equal(schedule.cards.get("a")!.earliestStart, null);
  assert.equal(schedule.cards.get("b")!.slackDays, null);
  assert.equal(schedule.range, null);
  assert.deepEqual(schedule.cards.get("a")!.dependentIds, ["b"]);
});

// Pure-engine failure modes: deep chains overflow recursive passes; finding each conflict by
// scanning every edge becomes quadratic. A browser test cannot reliably isolate either cost.
test("complete long chains remain stack-safe and linear in graph traversal", () => {
  const size = 12_000;
  const inputs = Array.from({ length: size }, (_, index) => card(String(index), MON, MON));
  const edges = inputs.slice(1).map((input, index) => ({ id: `edge-${index}`, sourceCardId: String(index), targetCardId: input.id }));
  const result = computeSchedule(inputs.reverse(), edges);
  assert.equal(result.cards.size, size);
  assert.equal(result.cards.get(String(size - 1))?.earliestFinish, dateKeyOf(addWorkingDays(dayNumber(MON), size - 1)));
  assert.equal(result.criticalEdgeIds.size, size - 1);
  assert.equal(result.cards.get(String(size - 1))?.conflicts.length, 1);
});
