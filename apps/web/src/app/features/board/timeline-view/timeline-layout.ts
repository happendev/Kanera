import type { WireCardSummary } from "@kanera/shared/events";
import { dateKeyOf, dayNumber, isWorkingDay, plannedBar } from "@kanera/shared/schedule";
import type { CardAssigneePresentation } from "../card.component";
import type { CardLabelPresentation } from "../card-labels.component";
import type { AnyCard, AnyList } from "../table-view/table-view.types";
import { formatDate } from "../../../shared/date-format";

/**
 * Pure layout for the Timeline (Gantt) view. The component hands over the board's cards, lists and
 * dependency edges and gets back a horizontal scale, header tiers, grouped rows and bar geometry it
 * can bind straight into the template. Nothing here reads the DOM, so the same data always draws the
 * same chart and the arithmetic can be unit tested without a browser.
 *
 * All positions are in CSS pixels along one shared day scale: `x = (day - range.startDay) * pxPerDay`.
 */

/**
 * The zoom is continuous: pixels per calendar day, anywhere between these bounds. The default draws
 * weeks with a few months on screen; the bounds give a two-day bar room for a short title at the
 * near end and about two years across a desktop chart at the far end, where month names still fit
 * their cells.
 */
export const MIN_PX_PER_DAY = 2.5;
export const MAX_PX_PER_DAY = 80;
export const DEFAULT_PX_PER_DAY = 16;

export function clampPxPerDay(px: number): number {
  return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, px));
}

/**
 * Which header tiers a scale draws: days once a day number fits its cell, weeks once a "12 Oct"
 * label fits a week, months below that. The thresholds are where the labels stop fitting, so the
 * header changes granularity as a zoom passes through them rather than at fixed steps.
 */
export type TimelineScale = "day" | "week" | "month";
export function timelineScale(pxPerDay: number): TimelineScale {
  return pxPerDay >= 22 ? "day" : pxPerDay >= 7 ? "week" : "month";
}

/** Below this width a bar becomes a point marker, so a one-day card never vanishes when zoomed out. */
const POINT_MAX_WIDTH = 12;

/** Width of the left name pane, where titles live; the chart begins right of it. */
export const NAME_PANE_WIDTH = 300;
export const NAME_PANE_WIDTH_NARROW = 164;
/** Bounds when the viewer drags the pane's edge: room for a title at least, never most of the chart. */
export const NAME_PANE_WIDTH_MIN = 200;
export const NAME_PANE_WIDTH_MAX = 720;

export const ROW_HEIGHT = 36;
export const ROW_HEIGHT_COMPACT = 30;
/** Card rows when any card carries labels: the chips get a line of their own under the title. */
export const ROW_HEIGHT_LABELLED = 48;
export const ROW_HEIGHT_LABELLED_COMPACT = 42;
export const GROUP_ROW_HEIGHT = 32;

export interface TimelineRange {
  /** Inclusive day numbers (see `@kanera/shared/schedule`). Always Monday to Sunday. */
  startDay: number;
  endDay: number;
}

export interface TimelineBar {
  start: string;
  end: string;
}

export interface TimelineGroupBy {
  /** `board` only means something where the chart spans boards (My Cards, Team Cards). */
  kind: "board" | "list" | "assignee" | "label" | "none";
}
export type TimelineGroupByKind = TimelineGroupBy["kind"];

export interface TimelineCardRow {
  kind: "card";
  id: string;
  card: AnyCard;
  bar: TimelineBar | null;
  /** Day-scale geometry; null for an unscheduled card, whose lane is empty until it is placed. */
  x: number | null;
  width: number | null;
  point: boolean;
  groupKey: string;
}

export interface TimelineGroupRow {
  kind: "group";
  id: string;
  key: string;
  label: string;
  /** Colour token of the thing grouped by (a list or label), for the summary bar's tint. */
  color: string | null;
  icon: string | null;
  count: number;
  scheduled: number;
  /** Summary span over the group's scheduled cards; null when nothing in it is dated. */
  span: TimelineBar | null;
  x: number | null;
  width: number | null;
  collapsed: boolean;
  /** The grouped-by value, for a drop or create that should inherit it (unused for now). */
  listId: string | null;
}

export type TimelineRow = TimelineGroupRow | TimelineCardRow;

export interface HeaderCell {
  key: string;
  x: number;
  width: number;
  label: string;
  /** Minor cells only: a non-working day, or today. */
  tone: "weekend" | "today" | "";
}

export interface TimelineHeader {
  major: HeaderCell[];
  minor: HeaderCell[];
}

const WEEK_DAYS = 7;

/** The Monday on or before a day number. Day 0 (1 January 1970) was a Thursday, three days after a Monday. */
export function mondayOf(day: number): number {
  return day - ((((day + 3) % 7) + 7) % 7);
}

/** Days of padding either side of the planned work: room before the first bar and to drag the last. */
const RANGE_PAD_DAYS = 28;

/**
 * The scale covers every planned bar plus today, padded so the first bar does not touch the name
 * pane and there is room to drag the last one later, then widened to whole weeks so the header's
 * week cells never start half way. The start never depends on the zoom, so a day keeps its place
 * relative to the scale's origin while zooming and the view can hold the day under the pointer
 * still. `minimumDays` lets the caller stretch the end until the chart fills the window.
 */
export function timelineRange(bars: readonly TimelineBar[], todayKey: string, minimumDays = 42): TimelineRange {
  const today = dayNumber(todayKey);
  let min = today;
  let max = today;
  for (const bar of bars) {
    min = Math.min(min, dayNumber(bar.start));
    max = Math.max(max, dayNumber(bar.end));
  }
  const startDay = mondayOf(min - RANGE_PAD_DAYS);
  const endDay = mondayOf(Math.max(max + RANGE_PAD_DAYS, startDay + minimumDays)) + WEEK_DAYS - 1;
  return { startDay, endDay };
}

export function rangeWidth(range: TimelineRange, pxPerDay: number): number {
  return (range.endDay - range.startDay + 1) * pxPerDay;
}

export function xOf(day: number, range: TimelineRange, pxPerDay: number): number {
  return (day - range.startDay) * pxPerDay;
}

/** The day under an x offset into the chart, clamped into the range. */
export function dayAt(x: number, range: TimelineRange, pxPerDay: number): number {
  const day = range.startDay + Math.floor(x / pxPerDay);
  return Math.min(range.endDay, Math.max(range.startDay, day));
}

function barGeometry(bar: TimelineBar, range: TimelineRange, pxPerDay: number): { x: number; width: number; point: boolean } {
  const start = dayNumber(bar.start);
  const end = dayNumber(bar.end);
  const width = (end - start + 1) * pxPerDay;
  return { x: xOf(start, range, pxPerDay), width, point: width <= POINT_MAX_WIDTH };
}

/**
 * Two header tiers per scale (see `timelineScale`). Day: months over days. Week: months over weeks
 * (labelled by their Monday). Month: years over months. The labels come from the shared date
 * formatter so the tiers follow the interface language and its day/month order.
 */
export function timelineHeader(range: TimelineRange, pxPerDay: number, todayKey: string): TimelineHeader {
  const px = pxPerDay;
  const scale = timelineScale(px);
  const today = dayNumber(todayKey);
  const minor: HeaderCell[] = [];
  const major: HeaderCell[] = [];

  if (scale === "day") {
    for (let day = range.startDay; day <= range.endDay; day += 1) {
      const key = dateKeyOf(day);
      minor.push({ key, x: xOf(day, range, px), width: px, label: String(Number(key.slice(8, 10))), tone: day === today ? "today" : isWorkingDay(day) ? "" : "weekend" });
    }
    pushMonths(major, range, px);
  } else if (scale === "week") {
    for (let day = range.startDay; day <= range.endDay; day += WEEK_DAYS) {
      const key = dateKeyOf(day);
      const containsToday = today >= day && today < day + WEEK_DAYS;
      minor.push({ key, x: xOf(day, range, px), width: px * WEEK_DAYS, label: formatDate(key, "short", { now: new Date(0) }).replace(/,? \d{4}$/, ""), tone: containsToday ? "today" : "" });
    }
    pushMonths(major, range, px);
  } else {
    let day = range.startDay;
    while (day <= range.endDay) {
      const key = dateKeyOf(day);
      const [year, month] = key.split("-").map(Number);
      const monthStart = dayNumber(`${year}-${String(month).padStart(2, "0")}-01`);
      const nextMonth = month === 12 ? dayNumber(`${year! + 1}-01-01`) : dayNumber(`${year}-${String(month! + 1).padStart(2, "0")}-01`);
      const from = Math.max(monthStart, range.startDay);
      const to = Math.min(nextMonth - 1, range.endDay);
      const containsToday = today >= from && today <= to;
      minor.push({ key: key.slice(0, 7), x: xOf(from, range, px), width: (to - from + 1) * px, label: formatDate(dateKeyOf(from), "month"), tone: containsToday ? "today" : "" });
      day = nextMonth;
    }
    // Years over months.
    let yearDay = range.startDay;
    while (yearDay <= range.endDay) {
      const year = Number(dateKeyOf(yearDay).slice(0, 4));
      const yearStart = dayNumber(`${year}-01-01`);
      const nextYear = dayNumber(`${year + 1}-01-01`);
      const from = Math.max(yearStart, range.startDay);
      const to = Math.min(nextYear - 1, range.endDay);
      major.push({ key: String(year), x: xOf(from, range, px), width: (to - from + 1) * px, label: String(year), tone: "" });
      yearDay = nextYear;
    }
  }
  return { major, minor };
}

function pushMonths(major: HeaderCell[], range: TimelineRange, px: number): void {
  let day = range.startDay;
  while (day <= range.endDay) {
    const key = dateKeyOf(day);
    const [year, month] = key.split("-").map(Number);
    const nextMonth = month === 12 ? dayNumber(`${year! + 1}-01-01`) : dayNumber(`${year}-${String(month! + 1).padStart(2, "0")}-01`);
    const to = Math.min(nextMonth - 1, range.endDay);
    // Spell the year: the header is the chart's only date anchor, and a plan often crosses a year end.
    major.push({ key: key.slice(0, 7), x: xOf(day, range, px), width: (to - day + 1) * px, label: formatDate(dateKeyOf(day), "monthYear"), tone: "" });
    day = nextMonth;
  }
}

/** Weekend bands at the day and week scales; at the month scale they would be noise. */
export function weekendBands(range: TimelineRange, pxPerDay: number): { x: number; width: number }[] {
  if (timelineScale(pxPerDay) === "month") return [];
  const bands: { x: number; width: number }[] = [];
  const px = pxPerDay;
  for (let day = range.startDay; day <= range.endDay; day += 1) {
    if (isWorkingDay(day)) continue;
    const last = bands[bands.length - 1];
    const x = xOf(day, range, px);
    if (last && last.x + last.width === x) last.width += px;
    else bands.push({ x, width: px });
  }
  return bands;
}

/** What a group heading shows for a board when the chart spans several. */
export interface TimelineBoardSummary {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
}

export interface GroupingContext {
  lists: readonly AnyList[];
  /** Boards the cards sit on; only read for the `board` grouping, so a single-board host omits it. */
  boards?: ReadonlyMap<string, TimelineBoardSummary>;
  labelsByCard: ReadonlyMap<string, CardLabelPresentation[]>;
  assigneesByCard: ReadonlyMap<string, CardAssigneePresentation[]>;
  collapsedGroupKeys: ReadonlySet<string>;
  labels: {
    unassigned: string;
    noLabel: string;
    allCards: string;
    unscheduled: string;
  };
}

export const UNSCHEDULED_GROUP_KEY = "unscheduled";

/**
 * Rows in reading order: each group's header, then its cards sorted by planned start (undated cards
 * last) and due date, then card position as the board shows it. Cards without any date gather in
 * one trailing "Unscheduled" group whatever the grouping, so the chart's groups only ever hold work
 * that has a place on the scale and the undated backlog is one list to pull from.
 */
export function buildTimelineRows(
  cards: readonly AnyCard[],
  groupBy: TimelineGroupByKind,
  range: TimelineRange,
  pxPerDay: number,
  context: GroupingContext,
): TimelineRow[] {
  type Bucket = { key: string; label: string; color: string | null; icon: string | null; listId: string | null; order: number; cards: AnyCard[] };
  const buckets = new Map<string, Bucket>();
  const unscheduled: AnyCard[] = [];
  const bucketFor = (key: string, make: () => Omit<Bucket, "key" | "cards">): Bucket => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, cards: [], ...make() };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const listOrder = new Map(context.lists.map((list, index) => [list.id, index]));

  for (const card of cards) {
    if (!plannedBar(card)) {
      unscheduled.push(card);
      continue;
    }
    switch (groupBy) {
      case "board": {
        const board = context.boards?.get(card.boardId);
        // Boards sort by name: a cross-board chart has no board order of its own to follow.
        bucketFor(`board:${card.boardId}`, () => ({
          label: board?.name ?? "",
          color: board?.iconColor ?? null,
          icon: board?.icon ?? "layout-kanban",
          listId: null,
          order: 0,
        })).cards.push(card);
        break;
      }
      case "list": {
        const list = context.lists.find((candidate) => candidate.id === card.listId);
        bucketFor(`list:${card.listId}`, () => ({
          label: list?.name ?? "",
          color: list?.color ?? null,
          icon: list?.icon ?? "list",
          listId: card.listId,
          order: listOrder.get(card.listId) ?? Number.MAX_SAFE_INTEGER,
        })).cards.push(card);
        break;
      }
      case "assignee": {
        const people = context.assigneesByCard.get(card.id) ?? [];
        if (!people.length) {
          bucketFor("assignee:none", () => ({ label: context.labels.unassigned, color: null, icon: "user-off", listId: null, order: Number.MAX_SAFE_INTEGER })).cards.push(card);
        } else {
          // A card with several assignees sits in each of their groups: the chart answers "what is
          // on this person's plate", and leaving the card out of one lane would hide it from them.
          for (const person of people) {
            bucketFor(`assignee:${person.userId}`, () => ({ label: person.displayName, color: null, icon: "user", listId: null, order: 0 })).cards.push(card);
          }
        }
        break;
      }
      case "label": {
        const labels = context.labelsByCard.get(card.id) ?? [];
        if (!labels.length) {
          bucketFor("label:none", () => ({ label: context.labels.noLabel, color: null, icon: "tag-off", listId: null, order: Number.MAX_SAFE_INTEGER })).cards.push(card);
        } else {
          for (const label of labels) {
            bucketFor(`label:${label.id}`, () => ({ label: label.name, color: label.color, icon: "tag", listId: null, order: 0 })).cards.push(card);
          }
        }
        break;
      }
      case "none":
        bucketFor("all", () => ({ label: context.labels.allCards, color: null, icon: null, listId: null, order: 0 })).cards.push(card);
        break;
    }
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const rows: TimelineRow[] = [];
  const emitGroup = (bucket: Bucket) => {
    const collapsed = context.collapsedGroupKeys.has(bucket.key);
    const sortedCards = [...bucket.cards].sort(compareScheduled);
    let span: TimelineBar | null = null;
    for (const card of sortedCards) {
      const bar = plannedBar(card);
      if (!bar) continue;
      if (!span) {
        span = { ...bar };
        continue;
      }
      if (bar.start < span.start) span.start = bar.start;
      if (bar.end > span.end) span.end = bar.end;
    }
    const geometry = span ? barGeometry(span, range, pxPerDay) : null;
    rows.push({
      kind: "group",
      id: `group:${bucket.key}`,
      key: bucket.key,
      label: bucket.label,
      color: bucket.color,
      icon: bucket.icon,
      count: bucket.cards.length,
      scheduled: span ? sortedCards.length : 0,
      span,
      x: geometry?.x ?? null,
      width: geometry?.width ?? null,
      collapsed,
      listId: bucket.listId,
    });
    if (collapsed) return;
    for (const card of sortedCards) {
      const bar = plannedBar(card);
      const geometry = bar ? barGeometry(bar, range, pxPerDay) : null;
      rows.push({ kind: "card", id: `${bucket.key}/${card.id}`, card, bar, x: geometry?.x ?? null, width: geometry?.width ?? null, point: geometry?.point ?? false, groupKey: bucket.key });
    }
  };
  // "None" needs no header when it is the only group: the chart is simply the board.
  if (groupBy === "none" && sortedBuckets.length === 1 && !unscheduled.length) {
    const bucket = sortedBuckets[0]!;
    for (const card of [...bucket.cards].sort(compareScheduled)) {
      const bar = plannedBar(card)!;
      const geometry = barGeometry(bar, range, pxPerDay);
      rows.push({ kind: "card", id: `${bucket.key}/${card.id}`, card, bar, x: geometry.x, width: geometry.width, point: geometry.point, groupKey: bucket.key });
    }
    return rows;
  }
  for (const bucket of sortedBuckets) emitGroup(bucket);
  if (unscheduled.length) {
    emitGroup({ key: UNSCHEDULED_GROUP_KEY, label: context.labels.unscheduled, color: null, icon: "calendar-off", listId: null, order: Number.MAX_SAFE_INTEGER, cards: unscheduled.sort(comparePosition) });
  }
  return rows;
}

function compareScheduled(a: AnyCard, b: AnyCard): number {
  const barA = plannedBar(a);
  const barB = plannedBar(b);
  if (barA && barB) {
    if (barA.start !== barB.start) return barA.start < barB.start ? -1 : 1;
    if (barA.end !== barB.end) return barA.end < barB.end ? -1 : 1;
  } else if (barA !== barB) {
    return barA ? -1 : 1;
  }
  return comparePosition(a, b);
}

function comparePosition(a: AnyCard, b: AnyCard): number {
  const diff = Number(a.position) - Number(b.position);
  return Number.isNaN(diff) ? 0 : diff;
}

/**
 * A finish-to-start connector from the end of one bar to the start of the next: out of the blocker,
 * down (or up) to the dependent's row, into its start. When the dependent starts left of where the
 * blocker ends (a conflict), the wire loops back under the rows so the arrowhead still enters from
 * the left and the overlap is visible as a doubling back.
 */
export function dependencyPath(from: { x: number; y: number }, to: { x: number; y: number }, rowHeight: number): string {
  const stub = 10;
  const radius = 4;
  if (to.x >= from.x + stub * 2) {
    const midX = from.x + stub;
    const dir = to.y > from.y ? 1 : -1;
    if (to.y === from.y) return `M ${from.x} ${from.y} H ${to.x}`;
    return [
      `M ${from.x} ${from.y}`,
      `H ${midX - radius}`,
      `q ${radius} 0 ${radius} ${dir * radius}`,
      `V ${to.y - dir * radius}`,
      `q 0 ${dir * radius} ${radius} ${dir * radius}`,
      `H ${to.x}`,
    ].join(" ");
  }
  // Loop: right out of the blocker, drop below its row, back left past the dependent's start, then
  // down/up into it.
  const outX = from.x + stub;
  const backX = to.x - stub;
  const underY = from.y + rowHeight / 2 - 2;
  return [
    `M ${from.x} ${from.y}`,
    `H ${outX}`,
    `V ${underY}`,
    `H ${backX}`,
    `V ${to.y}`,
    `H ${to.x}`,
  ].join(" ");
}

export function todayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The cards' planned bars, for the range computation. */
export function plannedBars(cards: readonly Pick<WireCardSummary, "startDateLocalDate" | "dueDateLocalDate">[]): TimelineBar[] {
  const bars: TimelineBar[] = [];
  for (const card of cards) {
    const bar = plannedBar(card);
    if (bar) bars.push(bar);
  }
  return bars;
}
