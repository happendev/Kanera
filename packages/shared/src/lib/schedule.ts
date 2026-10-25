/**
 * The scheduling engine behind the Timeline view: the classic critical-path method over cards and
 * their `blocks` relations, measured in working days.
 *
 * Dependency-free on purpose, like `due-date-slots.ts`: the web app runs it on every board edit, the
 * API will run it for agents and the "push successors" reschedule, and none of them may disagree
 * about which card has slack. Everything here works on YYYY-MM-DD calendar dates (the shape cards
 * store), never on instants, so no time zone or DST arithmetic can move a bar by a day.
 *
 * Vocabulary, as Gantt tools use it:
 * - A card's *planned* bar runs from its start date to its due date. A card with only a due date is a
 *   point on that day; a card with only a start date is a point on its start.
 * - `blocks` is finish-to-start: the blocked card can start no earlier than the working day after its
 *   blocker finishes.
 * - The forward pass gives each card its earliest start and finish given its blockers; the backward
 *   pass gives the latest it can finish without delaying the end of its chain. The gap is slack, and
 *   a chained card with no slack is on the critical path.
 *
 * Completed cards are out of the schedule: they neither move nor hold anything up. Archived cards
 * are the caller's business (the board already filters them).
 */

export interface ScheduleCardInput {
  id: string;
  startDateLocalDate: string | null;
  dueDateLocalDate: string | null;
  /** Completed cards anchor nothing: a finished blocker no longer holds its dependents. */
  done: boolean;
}

/** A `blocks` relation: `sourceCardId` must finish before `targetCardId` starts. */
export interface ScheduleEdgeInput {
  id: string;
  sourceCardId: string;
  targetCardId: string;
}

export type ScheduleConflictKind =
  /** An open blocker's planned finish is on or after this card's planned start. */
  | "blockerFinishesAfterStart";

export interface ScheduleConflict {
  kind: ScheduleConflictKind;
  edgeId: string;
  blockerId: string;
  /** Working days the card would have to move right for the blocker to finish first. */
  days: number;
}

export interface ScheduledCard {
  id: string;
  done: boolean;
  /** The planned bar, normalised: a single date fills both ends; neither date leaves both null. */
  plannedStart: string | null;
  plannedEnd: string | null;
  /** Working days the bar covers, inclusive; a point is one day; an undated card counts as one. */
  durationDays: number;
  /**
   * From the forward pass. For a dated card this never precedes its planned start; a card without
   * dates inherits a start from its blockers, and stays null when nothing anchors it.
   */
  earliestStart: string | null;
  earliestFinish: string | null;
  /** From the backward pass, against the end of this card's chain. Null for unanchored cards. */
  latestStart: string | null;
  latestFinish: string | null;
  /** Working days between earliest and latest finish. Null when the card is unanchored. */
  slackDays: number | null;
  /** On the critical path: chained to at least one other open card and without slack. */
  critical: boolean;
  /** Blockers (open, dated) that finish on or after this card's planned start. */
  conflicts: ScheduleConflict[];
  blockerIds: string[];
  dependentIds: string[];
}

export interface Schedule {
  cards: Map<string, ScheduledCard>;
  /** Edge ids on the critical path: both ends critical, and the blocker finishing right before. */
  criticalEdgeIds: Set<string>;
  /** Earliest planned start and latest planned or earliest finish over every open dated card. */
  range: { start: string; end: string } | null;
}

/**
 * Which weekdays count as working days, Sunday first as `Date#getUTCDay` numbers them. The default
 * is Monday to Friday, matching time in progress (`time-in-progress.ts`); per-workspace calendars
 * and holidays plug in here later without touching the passes below.
 */
export type WorkCalendar = { workingWeekdays: ReadonlySet<number> };
export const DEFAULT_WORK_CALENDAR: WorkCalendar = { workingWeekdays: new Set([1, 2, 3, 4, 5]) };

const DAY_MS = 86_400_000;

/** Whole days since 1970-01-01 for a YYYY-MM-DD key; plain calendar arithmetic, no zone. */
export function dayNumber(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.round(Date.UTC(year!, month! - 1, day!) / DAY_MS);
}

export function dateKeyOf(dayNumber: number): string {
  const date = new Date(dayNumber * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function isWorkingDay(dayNumber: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): boolean {
  // Day 0 was a Thursday (4).
  return calendar.workingWeekdays.has((((dayNumber + 4) % 7) + 7) % 7);
}

/** Working days from `from` to `to` inclusive (both as day numbers); 0 when `to` precedes `from`. */
export function workingDaysBetween(from: number, to: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  if (to < from) return 0;
  // Whole weeks first so a year-long bar costs a handful of iterations, not 365.
  const weeks = Math.floor((to - from + 1) / 7);
  let count = weeks * calendar.workingWeekdays.size;
  for (let day = from + weeks * 7; day <= to; day += 1) if (isWorkingDay(day, calendar)) count += 1;
  return count;
}

/** The first working day on or after `dayNumber`. */
export function nextWorkingDayOnOrAfter(dayNumber: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  let day = dayNumber;
  // A calendar with no working days would never terminate; treat it as every day working.
  if (calendar.workingWeekdays.size === 0) return day;
  while (!isWorkingDay(day, calendar)) day += 1;
  return day;
}

/** The last working day on or before `dayNumber`. */
export function lastWorkingDayOnOrBefore(dayNumber: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  let day = dayNumber;
  if (calendar.workingWeekdays.size === 0) return day;
  while (!isWorkingDay(day, calendar)) day -= 1;
  return day;
}

/**
 * Moves `dayNumber` by `count` working days: positive steps forward, negative back, zero stays (even
 * on a weekend, since a planned date is what it is). The result lands on a working day.
 */
export function addWorkingDays(dayNumber: number, count: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  if (count === 0 || calendar.workingWeekdays.size === 0) return dayNumber + count;
  let day = dayNumber;
  let remaining = Math.abs(count);
  const step = count > 0 ? 1 : -1;
  // Leave at least one step to land on a working day even when the origin is a weekend.
  const weeks = Math.floor((remaining - 1) / calendar.workingWeekdays.size);
  day += weeks * 7 * step;
  remaining -= weeks * calendar.workingWeekdays.size;
  while (remaining > 0) {
    day += step;
    if (isWorkingDay(day, calendar)) remaining -= 1;
  }
  return day;
}

/**
 * The end day of a bar that starts on `start` and covers `durationDays` working days, inclusive. A
 * start on a weekend counts from the next working day, so a one-day card planned for Saturday ends
 * on Monday rather than before it began.
 */
export function finishOf(start: number, durationDays: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  const first = nextWorkingDayOnOrAfter(start, calendar);
  return addWorkingDays(first, Math.max(1, durationDays) - 1, calendar);
}

/** The start day of a bar that ends on `end` and covers `durationDays` working days, inclusive. */
export function startOf(end: number, durationDays: number, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  const last = lastWorkingDayOnOrBefore(end, calendar);
  return addWorkingDays(last, -(Math.max(1, durationDays) - 1), calendar);
}

/**
 * Normalises a card's two dates into a bar. One date makes a point; a start after the due date
 * (which the API rejects, but imports or old rows may hold) collapses onto the due date so the
 * deadline, the date people were promised, is the one the bar keeps.
 */
export function plannedBar(card: Pick<ScheduleCardInput, "startDateLocalDate" | "dueDateLocalDate">): { start: string; end: string } | null {
  const start = card.startDateLocalDate;
  const end = card.dueDateLocalDate;
  if (!start && !end) return null;
  if (!start) return { start: end!, end: end! };
  if (!end) return { start, end: start };
  return start <= end ? { start, end } : { start: end, end };
}

/** Working days a bar covers, inclusive; a point or a bar that is all weekend still counts one. */
export function barDurationDays(bar: { start: string; end: string } | null, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): number {
  if (!bar) return 1;
  return Math.max(1, workingDaysBetween(dayNumber(bar.start), dayNumber(bar.end), calendar));
}

/**
 * Keeps a bar's working-day length while moving its start: how the Timeline moves a card without
 * changing how much work it represents. Returns the new end date.
 */
export function endForMovedStart(bar: { start: string; end: string }, newStart: string, calendar: WorkCalendar = DEFAULT_WORK_CALENDAR): string {
  // A bar that is only weekend days has no working length to keep: it moves as plain calendar days.
  const weekdaysOnly = workingDaysBetween(dayNumber(bar.start), dayNumber(bar.end), calendar) > 0;
  if (!weekdaysOnly) return dateKeyOf(dayNumber(newStart) + (dayNumber(bar.end) - dayNumber(bar.start)));
  return dateKeyOf(finishOf(dayNumber(newStart), barDurationDays(bar, calendar), calendar));
}

export function computeSchedule(
  inputCards: readonly ScheduleCardInput[],
  edges: readonly ScheduleEdgeInput[],
  calendar: WorkCalendar = DEFAULT_WORK_CALENDAR,
): Schedule {
  const cards = new Map<string, ScheduledCard>();
  for (const input of inputCards) {
    const bar = plannedBar(input);
    cards.set(input.id, {
      id: input.id,
      done: input.done,
      plannedStart: bar?.start ?? null,
      plannedEnd: bar?.end ?? null,
      durationDays: barDurationDays(bar, calendar),
      earliestStart: null,
      earliestFinish: null,
      latestStart: null,
      latestFinish: null,
      slackDays: null,
      critical: false,
      conflicts: [],
      blockerIds: [],
      dependentIds: [],
    });
  }
  // Only edges between open cards on the schedule take part: a finished blocker releases its
  // dependents, and an edge to a card the caller did not pass (off the board, no access) cannot be
  // placed, so it does not constrain anything.
  const liveEdges = edges.filter((edge) => {
    const source = cards.get(edge.sourceCardId);
    const target = cards.get(edge.targetCardId);
    return source && target && !source.done && !target.done && edge.sourceCardId !== edge.targetCardId;
  });
  const incoming = new Map<string, ScheduleEdgeInput[]>();
  for (const edge of liveEdges) {
    const targets = incoming.get(edge.targetCardId) ?? [];
    targets.push(edge);
    incoming.set(edge.targetCardId, targets);
    cards.get(edge.sourceCardId)!.dependentIds.push(edge.targetCardId);
    cards.get(edge.targetCardId)!.blockerIds.push(edge.sourceCardId);
  }

  // Iterative postorder avoids overflowing the JS stack on long cross-board chains. The API
  // keeps blocks acyclic; marking on entry also makes a corrupt cycle terminate safely.
  const order: string[] = [];
  const visited = new Set<string>();
  for (const root of cards.values()) {
    if (root.done || visited.has(root.id)) continue;
    const stack: { id: string; exit: boolean }[] = [{ id: root.id, exit: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.exit) { order.push(frame.id); continue; }
      if (visited.has(frame.id)) continue;
      visited.add(frame.id);
      stack.push({ id: frame.id, exit: true });
      const blockers = cards.get(frame.id)!.blockerIds;
      for (let index = blockers.length - 1; index >= 0; index--) stack.push({ id: blockers[index]!, exit: false });
    }
  }
  const earliest = new Map<string, { start: number; finish: number } | null>();
  for (const id of order) {
    const card = cards.get(id)!;
    let start: number | null = card.plannedStart ? dayNumber(card.plannedStart) : null;
    for (const blockerId of card.blockerIds) {
      const blocker = earliest.get(blockerId);
      if (!blocker) continue;
      const afterBlocker = addWorkingDays(blocker.finish, 1, calendar);
      if (start === null || afterBlocker > start) start = afterBlocker;
    }
    earliest.set(id, start === null ? null : { start, finish: finishOf(start, card.durationDays, calendar) });
  }

  // Backward pass, per chain: the chain finishes when its last open card does, and every card may
  // finish as late as its tightest dependent allows.
  const chainOf = new Map<string, string>();
  const chainFinish = new Map<string, number>();
  const assignChain = (id: string, chainId: string) => {
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      if (chainOf.has(current)) continue;
      chainOf.set(current, chainId);
      const card = cards.get(current)!;
      for (const neighbour of card.blockerIds) stack.push(neighbour);
      for (const neighbour of card.dependentIds) stack.push(neighbour);
    }
  };
  for (const card of cards.values()) if (!card.done) assignChain(card.id, card.id);
  for (const card of cards.values()) {
    const placed = earliest.get(card.id);
    if (!placed) continue;
    const chainId = chainOf.get(card.id)!;
    chainFinish.set(chainId, Math.max(chainFinish.get(chainId) ?? placed.finish, placed.finish));
  }
  const latest = new Map<string, { start: number; finish: number } | null>();
  for (const id of [...order].reverse()) {
    const card = cards.get(id)!;
    let finish: number | null = null;
    for (const dependentId of card.dependentIds) {
      const dependent = latest.get(dependentId);
      if (!dependent) continue;
      const beforeDependent = addWorkingDays(dependent.start, -1, calendar);
      if (finish === null || beforeDependent < finish) finish = beforeDependent;
    }
    if (finish === null) {
      const chainEnd = chainFinish.get(chainOf.get(id)!);
      const placed = earliest.get(id);
      // An unanchored card at the end of a chain has no finish to be late against.
      finish = chainEnd === undefined || !placed ? null : chainEnd;
    }
    const result = finish === null ? null : { start: startOf(finish, card.durationDays, calendar), finish };
    latest.set(id, result);
  }

  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;
  for (const card of cards.values()) {
    if (card.done) continue;
    const placed = earliest.get(card.id) ?? null;
    const late = latest.get(card.id) ?? null;
    if (placed) {
      card.earliestStart = dateKeyOf(placed.start);
      card.earliestFinish = dateKeyOf(placed.finish);
    }
    if (late) {
      card.latestStart = dateKeyOf(late.start);
      card.latestFinish = dateKeyOf(late.finish);
    }
    if (placed && late) {
      // Slack is the working days the finish could slip; a planned finish before its earliest one
      // never happens (earliest never precedes planned), so this is never negative.
      card.slackDays = Math.max(0, workingDaysBetween(placed.finish + 1, late.finish, calendar));
      card.critical = card.slackDays === 0 && (card.blockerIds.length > 0 || card.dependentIds.length > 0);
    }
    for (const edge of incoming.get(card.id) ?? []) {
      const blockerId = edge.sourceCardId;
      const blocker = cards.get(blockerId)!;
      if (!blocker.plannedEnd || !card.plannedStart) continue;
      const blockerEnd = dayNumber(blocker.plannedEnd);
      const start = dayNumber(card.plannedStart);
      if (blockerEnd < start) continue;
      card.conflicts.push({
        kind: "blockerFinishesAfterStart",
        edgeId: edge.id,
        blockerId,
        days: Math.max(1, workingDaysBetween(start + 1, addWorkingDays(blockerEnd, 1, calendar), calendar)),
      });
    }
    if (card.plannedStart) {
      const start = dayNumber(card.plannedStart);
      rangeStart = rangeStart === null ? start : Math.min(rangeStart, start);
    }
    const end = placed ? placed.finish : card.plannedEnd ? dayNumber(card.plannedEnd) : null;
    if (end !== null) rangeEnd = rangeEnd === null ? end : Math.max(rangeEnd, end);
  }

  const criticalEdgeIds = new Set<string>();
  for (const edge of liveEdges) {
    const source = cards.get(edge.sourceCardId)!;
    const target = cards.get(edge.targetCardId)!;
    if (!source.critical || !target.critical) continue;
    const sourceFinish = earliest.get(source.id);
    const targetStart = earliest.get(target.id);
    // Of a critical card's blockers, only the one that actually sets its start is on the path.
    if (sourceFinish && targetStart && addWorkingDays(sourceFinish.finish, 1, calendar) === targetStart.start) criticalEdgeIds.add(edge.id);
  }

  return {
    cards,
    criticalEdgeIds,
    range: rangeStart !== null && rangeEnd !== null ? { start: dateKeyOf(rangeStart), end: dateKeyOf(Math.max(rangeStart, rangeEnd)) } : null,
  };
}
