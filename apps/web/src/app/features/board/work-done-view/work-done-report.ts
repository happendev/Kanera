import type { WorkDoneDaySummary, WorkDoneEvent } from "@kanera/shared/dto";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
import { appLocale } from "../../../core/i18n/locale";
import { icu } from "../../../core/i18n/icu";
import { formatDate, formatRelativeTime } from "../../../shared/date-format";
import { addDays, localDateKey } from "../../../shared/day-key.util";
import { WEEKDAY_LABELS, weekdayIndex } from "../../../shared/week-start";
import type { StatTileTone } from "../../../shared/stat-tile.component";
import type { CardLabelPresentation } from "../card-labels.component";
import { blockedByCountOf, blockedChipLabel } from "../card-relations.util";
import { dueDateTimestamp, formatDueDate, isOverdue } from "../due-date.util";
import type { AnyCard } from "../table-view/table-view.types";
import { isInProgressTooLong, timeInProgressMs } from "../time-in-progress.util";
import { isCardInactive } from "@kanera/shared/card-timing";
import { actorUserIdFor } from "./work-done-grouping";

/**
 * The management report rendered by the Work done view's Report layout.
 *
 * Everything here is derived on the client from data the view already holds: the period's work-done
 * events, the previous period's per-day counts (for the deltas) and the live board state (for what
 * needs attention right now). There is deliberately no model or server summarisation involved: every
 * sentence is a template over counts, so the report says exactly what the numbers say and nothing
 * more, in every language the app ships.
 *
 * Sections are dynamic. A board with no labels gets no label section, a board with no select fields
 * gets no field breakdown, and a quiet period says so instead of rendering empty charts.
 *
 * The same model serves one board and the cross-board Global Work pages. The host decides the card
 * set; when it spans several boards it passes `boards` (and `workspaces` when those boards sit in
 * several workspaces), which adds the by-board and by-workspace breakdowns, and `workspaceSettings`,
 * so each card is judged by its own workspace's alert thresholds and time zone rather than one board's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Cards named inside an attention group before the rest roll into a "+n more" line. */
export const ATTENTION_CARD_LIMIT = 6;
/** Bars shown in a breakdown before the tail folds into "Other". */
const BREAKDOWN_LIMIT = 8;
/** Lists shown on a cross-board report, which spans workspaces and so has more lists than one board. */
const CROSS_BOARD_LIST_LIMIT = 12;
/** "Due soon" horizon, matching the board overview's callout. */
const DUE_SOON_DAYS = 7;
/** Fewest completed cards before a median duration is quoted; below this it is one card's story. */
const MIN_DURATION_SAMPLES = 3;

export interface WorkDoneReportList {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  inProgress: boolean;
  /** Cross-workspace hosts only: the workspace's name, under which the list chart groups its bars. */
  group?: string | null;
}

export interface WorkDoneReportField {
  id: string;
  name: string;
  icon: string;
  options: { id: string; name: string; color: string | null }[];
}

/** A workspace the cards may belong to; only meaningful when the report spans more than one. */
export interface WorkDoneReportWorkspace {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}

/** A board the cards may belong to; only meaningful when the report spans more than one. */
export interface WorkDoneReportBoard {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  /** Whether this board tracks time in progress; its cards skip the "too long" group when it does not. */
  inProgressEnabled: boolean;
}

/** The thresholds a card is judged against, from its own workspace. */
export interface WorkDoneReportWorkspaceSettings {
  inProgressAlertDays: number;
  inactiveCardsDays: number;
  /** The workspace's zone, whose working hours tracked time counts. */
  timeZone: string;
}

export interface WorkDoneReportInput {
  /** Inclusive local-day range. */
  from: Date;
  to: Date;
  today: Date;
  now: number;
  /** The period's events, already narrowed by the page filters. */
  events: readonly WorkDoneEvent[];
  /**
   * Per-day counts for the period of the same length immediately before `from`, or null while they
   * are loading or when that period falls outside the queryable window. Null hides every delta.
   */
  previousDays: readonly WorkDoneDaySummary[] | null;
  /** Live board cards; completed and archived ones are filtered out here. */
  cards: readonly AnyCard[];
  lists: readonly WorkDoneReportList[];
  members: readonly WireBoardMemberUser[];
  assigneeIdsByCard: ReadonlyMap<string, readonly string[]>;
  labelIdsByCard: ReadonlyMap<string, readonly string[]>;
  labelsById: ReadonlyMap<string, CardLabelPresentation>;
  /** Select-type custom fields, in workspace order, with their options. */
  selectFields: readonly WorkDoneReportField[];
  fieldValuesByCard: ReadonlyMap<string, ReadonlyMap<string, CardCustomFieldValue>>;
  inProgressEnabled: boolean;
  inProgressAlertDays: number;
  inactiveCardsDays: number;
  /** The workspace's zone, whose working hours tracked time counts. */
  timeZone: string;
  /**
   * Cross-board hosts only. With more than one board the report gains a by-board breakdown and the
   * list chart drops empty lists; a single board (or none) keeps the board page's plain list chart.
   */
  boards?: readonly WorkDoneReportBoard[];
  /** Cross-board hosts only: the workspaces behind `boards`; with more than one, a by-workspace breakdown. */
  workspaces?: readonly WorkDoneReportWorkspace[];
  /**
   * Set when the cards are one person's own (My Cards): the headline then speaks to the viewer as
   * "you" and never as "the team", since every card here is theirs.
   */
  viewerUserId?: string | null;
  /**
   * Cross-board hosts only: per-workspace thresholds keyed by workspace id. A card whose workspace is
   * missing here falls back to the top-level `inProgressAlertDays`, `inactiveCardsDays` and `timeZone`.
   */
  workspaceSettings?: ReadonlyMap<string, WorkDoneReportWorkspaceSettings>;
}

/**
 * Everything a host other than the board page supplies for the report's "right now" half. The board
 * page reads these straight from its route-scoped BoardState; Global Work builds them from its own
 * cross-board cards and catalog and hands them in through this one input.
 */
export interface WorkDoneReportSource {
  /** Title line of the copied text, e.g. "Team Cards". */
  title: string;
  cards: readonly AnyCard[];
  lists: readonly WorkDoneReportList[];
  boards: readonly WorkDoneReportBoard[];
  workspaces: readonly WorkDoneReportWorkspace[];
  /** The signed-in user's id when the cards are theirs alone (My Cards); null for a team-wide view. */
  viewerUserId: string | null;
  members: readonly WireBoardMemberUser[];
  assigneeIdsByCard: ReadonlyMap<string, readonly string[]>;
  labelIdsByCard: ReadonlyMap<string, readonly string[]>;
  fieldValuesByCard: ReadonlyMap<string, ReadonlyMap<string, CardCustomFieldValue>>;
  workspaceSettings: ReadonlyMap<string, WorkDoneReportWorkspaceSettings>;
  /** True while the host is still paging in cards, so the "right now" half is knowingly partial. */
  partial: boolean;
}

export interface ReportKpi {
  key: "completed" | "created" | "moved" | "checklist" | "people" | "inProgress";
  label: string;
  icon: string;
  value: number;
  /** Change against the previous period, or null when no comparison is available. */
  delta: number | null;
  tone: StatTileTone;
}

export interface ReportFlowDay {
  dateKey: string;
  /** Column label; empty when the range is too long to label every day. */
  label: string;
  created: number;
  completed: number;
  moved: number;
  weekend: boolean;
  isToday: boolean;
  tooltip: string;
}

export interface ReportBar {
  id: string;
  name: string;
  icon: string | null;
  /** Colour token of the entity (list, label, option) for its identity swatch; the bar itself is one hue. */
  color: string | null;
  value: number;
  /** 0..1 of the largest bar in the same chart. */
  share: number;
  /** Secondary text after the value, e.g. "3 completed". */
  hint: string | null;
  /** Lists only: cards here are tracked as in progress. */
  inProgress: boolean;
  /** Lists on a cross-workspace report: the workspace heading this bar sits under; null elsewhere. */
  group: string | null;
}

export type ReportAttentionKind = "overdue" | "blocked" | "tooLong" | "dueSoon" | "inProgress" | "inactive" | "unassigned";

export interface ReportAttentionCard {
  card: AnyCard;
  /** Why the card is in the group: "Due 14 Oct", "Blocked by 2 open cards", "In progress 9 days". */
  detail: string;
  assigneeIds: readonly string[];
  /** The card's labels, resolved for chips; unknown ids are dropped. */
  labels: CardLabelPresentation[];
}

export interface ReportAttentionGroup {
  kind: ReportAttentionKind;
  label: string;
  icon: string;
  tone: StatTileTone;
  count: number;
  /** Worst first, capped at ATTENTION_CARD_LIMIT; `count` is the true total. */
  cards: ReportAttentionCard[];
}

export interface ReportPerson {
  /** User id, or `name:<name>` for system/API actors — the same key the day stream uses. */
  key: string;
  userId: string | null;
  name: string;
  avatarUrl: string | null;
  agentName: string | null;
  completed: number;
  /** Everything else they did: created, moved, checklist items. */
  other: number;
  /** 0..1 of the busiest person's total activity. */
  share: number;
  open: number;
  overdue: number;
}

/** One cell of the people-by-day heatmap. */
export interface ReportHeatCell {
  dateKey: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  tooltip: string;
}

export interface ReportHeatRow {
  personKey: string;
  name: string;
  avatarUrl: string | null;
  userId: string | null;
  cells: ReportHeatCell[];
}

export interface ReportFieldBreakdown {
  id: string;
  name: string;
  icon: string;
  bars: ReportBar[];
  /** Open cards with no value for this field. */
  unset: number;
}

export interface WorkDoneReport {
  /** Plain-language summary, one sentence per entry, in reading order. */
  headline: string[];
  kpis: ReportKpi[];
  /** "vs previous 7 days", or null when deltas are unavailable. */
  comparisonLabel: string | null;
  flow: ReportFlowDay[];
  /** The axis maximum: the busiest day, rounded up to the top gridline. */
  flowPeak: number;
  /** Gridline values, ascending, excluding zero. */
  flowTicks: number[];
  openCount: number;
  lists: ReportBar[];
  /** Open cards per board, with completions as the hint; empty unless the cards span several boards. */
  boards: ReportBar[];
  /** Open cards per workspace, with completions as the hint; empty unless the cards span several workspaces. */
  workspaces: ReportBar[];
  attention: ReportAttentionGroup[];
  people: ReportPerson[];
  /** Active people × days of the period, busiest cell darkest; empty when the period is one day. */
  heat: ReportHeatRow[];
  heatColumns: { dateKey: string; label: string; weekend: boolean }[];
  labels: ReportBar[];
  fields: ReportFieldBreakdown[];
  checklist: { done: number; total: number; cards: number } | null;
  cycleTime: { medianMs: number; samples: number } | null;
  trackedTime: { medianMs: number; samples: number } | null;
  onTime: { onTime: number; total: number } | null;
}

function isOpen(card: AnyCard): boolean {
  return !card.completedAt && !card.archivedAt;
}

function workspaceIdOf(card: AnyCard): string | null {
  return "workspaceId" in card && typeof card.workspaceId === "string" ? card.workspaceId : null;
}

/** The thresholds for one card: its workspace's when the host supplied them, else the report's. */
function settingsFor(input: WorkDoneReportInput, card: AnyCard): WorkDoneReportWorkspaceSettings {
  const workspaceId = workspaceIdOf(card);
  const own = workspaceId ? input.workspaceSettings?.get(workspaceId) : undefined;
  return own ?? { inProgressAlertDays: input.inProgressAlertDays, inactiveCardsDays: input.inactiveCardsDays, timeZone: input.timeZone };
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

/** Elapsed time in words for the report's medians: "under an hour", "6 hours", "3 days", "2 weeks". */
function durationWords(ms: number): string {
  if (ms < HOUR_MS) return $localize`:Elapsed time in words, under one hour:under an hour`;
  if (ms < DAY_MS) return icu($localize`:Elapsed time in words:{count, plural, one {# hour} other {# hours}}`, { count: Math.round(ms / HOUR_MS) });
  if (ms < 14 * DAY_MS) return icu($localize`:Elapsed time in words:{count, plural, one {# day} other {# days}}`, { count: Math.round(ms / DAY_MS) });
  return icu($localize`:Elapsed time in words:{count, plural, one {# week} other {# weeks}}`, { count: Math.round(ms / (7 * DAY_MS)) });
}

/**
 * Gridline values for a column chart: at most four, on round numbers, the top one at or above the
 * peak so no column ever pokes out of the plot.
 */
export function niceTicks(peak: number): number[] {
  if (peak <= 0) return [];
  if (peak <= 4) return Array.from({ length: peak }, (_unused, index) => index + 1);
  const rough = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = step; value < peak + step; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}

function actorDisplayName(event: WorkDoneEvent): string {
  if (event.type === "checklistItemCompleted") return event.completedByName;
  return event.agentName
    ? $localize`:A person working through an AI agent, e.g. "Ada via Claude":${event.actorName}:person: via ${event.agentName}:agent:`
    : event.actorName;
}

function actorKey(event: WorkDoneEvent): string {
  // Agent work keys apart from the person's own, exactly as the day stream splits it.
  return actorUserIdFor(event) ?? `name:${actorDisplayName(event)}`;
}

/** Builds the report. Pure: every input is passed in, so the output is a function of its arguments. */
export function buildWorkDoneReport(input: WorkDoneReportInput): WorkDoneReport {
  const { events, now } = input;
  const nowDate = new Date(now);
  const rangeDays = daysBetween(input.from, input.to);
  const openCards = input.cards.filter(isOpen);
  const boardsById = new Map((input.boards ?? []).map((board) => [board.id, board]));
  const multiBoard = boardsById.size > 1;
  // Time in progress is a board setting, so on a cross-board report each card asks its own board.
  const inProgressTracked = (card: AnyCard) => input.inProgressEnabled && (boardsById.get(card.boardId)?.inProgressEnabled ?? true);
  // Every card in a running stint, longest first; the "too long" attention group is its overdue subset.
  const inProgressNow = openCards
    .filter((card) => inProgressTracked(card) && !!card.inProgressSince)
    .sort((a, b) => (toMs(a.inProgressSince) ?? 0) - (toMs(b.inProgressSince) ?? 0));

  // --- Period activity -------------------------------------------------------------------------
  const counts = { created: 0, moved: 0, completed: 0, checklistItemCompleted: 0 };
  const flowByDay = new Map<string, { created: number; completed: number; moved: number }>();
  const completedCards = new Map<string, WorkDoneEvent & { type: "completed" }>();
  for (const event of events) {
    counts[event.type] += 1;
    const key = localDateKey(new Date(event.at));
    let day = flowByDay.get(key);
    if (!day) {
      day = { created: 0, completed: 0, moved: 0 };
      flowByDay.set(key, day);
    }
    if (event.type === "created") day.created += 1;
    else if (event.type === "completed") {
      day.completed += 1;
      // The same card completed twice in a period (reopened in between) is one delivered card.
      completedCards.set(event.card.id, event);
    } else if (event.type === "moved") day.moved += 1;
  }

  const previous = input.previousDays
    ? {
        created: sum(input.previousDays.map((day) => day.created)),
        moved: sum(input.previousDays.map((day) => day.moved)),
        completed: sum(input.previousDays.map((day) => day.completed)),
        checklistItemCompleted: sum(input.previousDays.map((day) => day.checklistItemCompleted)),
      }
    : null;
  const delta = (metric: keyof typeof counts) => (previous ? counts[metric] - previous[metric] : null);

  // --- People ------------------------------------------------------------------------------------
  const peopleByKey = new Map<string, ReportPerson>();
  for (const event of events) {
    const key = actorKey(event);
    let person = peopleByKey.get(key);
    if (!person) {
      person = {
        key,
        userId: actorUserIdFor(event),
        name: actorDisplayName(event),
        avatarUrl: event.type === "checklistItemCompleted" ? event.completedByAvatarUrl : event.actorAvatarUrl,
        agentName: event.type === "checklistItemCompleted" ? null : event.agentName,
        completed: 0,
        other: 0,
        share: 0,
        open: 0,
        overdue: 0,
      };
      peopleByKey.set(key, person);
    }
    if (event.type === "completed") person.completed += 1;
    else person.other += 1;
  }
  // Workload now, for anyone with open assignments — including people who did nothing this period,
  // whose idle open cards are exactly what a coordinator wants to see.
  const membersById = new Map(input.members.map((member) => [member.userId, member]));
  for (const card of openCards) {
    const overdue = isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, nowDate);
    for (const userId of input.assigneeIdsByCard.get(card.id) ?? []) {
      let person = peopleByKey.get(userId);
      if (!person) {
        const member = membersById.get(userId);
        if (!member) continue;
        person = { key: userId, userId, name: member.displayName, avatarUrl: member.avatarUrl, agentName: null, completed: 0, other: 0, share: 0, open: 0, overdue: 0 };
        peopleByKey.set(userId, person);
      }
      person.open += 1;
      if (overdue) person.overdue += 1;
    }
  }
  const activeCount = [...peopleByKey.values()].filter((person) => person.completed + person.other > 0).length;
  const peakActivity = Math.max(0, ...[...peopleByKey.values()].map((person) => person.completed + person.other));
  const people = [...peopleByKey.values()]
    .map((person) => ({ ...person, share: peakActivity ? (person.completed + person.other) / peakActivity : 0 }))
    .sort((a, b) => b.completed - a.completed || (b.completed + b.other) - (a.completed + a.other) || b.open - a.open || a.name.localeCompare(b.name, appLocale()));

  // --- Who worked when ---------------------------------------------------------------------------
  const activityByPersonDay = new Map<string, number>();
  for (const event of events) {
    const key = `${actorKey(event)}|${localDateKey(new Date(event.at))}`;
    activityByPersonDay.set(key, (activityByPersonDay.get(key) ?? 0) + 1);
  }
  const heatPeak = Math.max(0, ...activityByPersonDay.values());
  const heatColumns: WorkDoneReport["heatColumns"] = [];
  for (let offset = 0; offset < rangeDays; offset += 1) {
    const day = addDays(input.from, offset);
    const weekday = day.getDay();
    heatColumns.push({ dateKey: localDateKey(day), label: rangeDays <= 14 ? WEEKDAY_LABELS[weekdayIndex(day)]!.slice(0, 1) : weekday === 1 ? formatDate(day, "short") : "", weekend: weekday === 0 || weekday === 6 });
  }
  const heat: ReportHeatRow[] = rangeDays > 1
    ? people
        .filter((person) => person.completed + person.other > 0)
        .map((person) => ({
          personKey: person.key,
          name: person.name,
          avatarUrl: person.avatarUrl,
          userId: person.userId,
          cells: heatColumns.map((column) => {
            const count = activityByPersonDay.get(`${person.key}|${column.dateKey}`) ?? 0;
            return {
              dateKey: column.dateKey,
              count,
              level: count === 0 ? 0 : (Math.min(4, Math.ceil((count / Math.max(heatPeak, 1)) * 4)) as 1 | 2 | 3 | 4),
              tooltip: $localize`:Tooltip on a cell of the who-worked-when heatmap:${person.name}:person: · ${formatDate(column.dateKey, "weekday")}:day: · ${icu($localize`:Count in a heatmap tooltip:{count, plural, one {# action} other {# actions}}`, { count })}:count:`,
            };
          }),
        }))
    : [];

  // --- KPIs --------------------------------------------------------------------------------------
  const kpis: ReportKpi[] = [
    { key: "completed", label: $localize`:Report metric - cards completed in the period:Completed`, icon: "circle-check", value: counts.completed, delta: delta("completed"), tone: "neutral" },
    { key: "created", label: $localize`:Report metric - cards created in the period:Created`, icon: "plus", value: counts.created, delta: delta("created"), tone: "neutral" },
    { key: "moved", label: $localize`:Report metric - card moves between lists in the period:Moves`, icon: "arrow-right", value: counts.moved, delta: delta("moved"), tone: "neutral" },
    { key: "checklist", label: $localize`:Report metric - checklist items ticked in the period:Checklist items`, icon: "checkbox", value: counts.checklistItemCompleted, delta: delta("checklistItemCompleted"), tone: "neutral" },
    { key: "people", label: $localize`:Report metric - people who did something in the period:People active`, icon: "users", value: activeCount, delta: null, tone: "neutral" },
  ];
  // A "right now" figure among the period's: the running stints, when any board tracks them.
  if (input.inProgressEnabled && (boardsById.size === 0 || [...boardsById.values()].some((board) => board.inProgressEnabled))) {
    kpis.push({ key: "inProgress", label: $localize`:Report metric - cards currently in a running in-progress stint:In progress now`, icon: "progress", value: inProgressNow.length, delta: null, tone: "neutral" });
  }
  const comparisonLabel = previous
    ? icu($localize`:Suffix after a change figure, e.g. "+3 vs previous 7 days":{days, plural, one {vs previous day} other {vs previous # days}}`, { days: rangeDays })
    : null;

  // --- Daily flow --------------------------------------------------------------------------------
  const todayKey = localDateKey(input.today);
  // Every day gets a label up to two weeks; beyond that only Mondays, so a 30-day chart is not a
  // wall of overlapping text.
  const labelEveryDay = rangeDays <= 14;
  const flow: ReportFlowDay[] = [];
  for (let offset = 0; offset < rangeDays; offset += 1) {
    const day = addDays(input.from, offset);
    const dateKey = localDateKey(day);
    const bucket = flowByDay.get(dateKey) ?? { created: 0, completed: 0, moved: 0 };
    const weekday = day.getDay();
    const label = labelEveryDay ? WEEKDAY_LABELS[weekdayIndex(day)]! : weekday === 1 ? formatDate(day, "short") : "";
    flow.push({
      dateKey,
      label,
      ...bucket,
      weekend: weekday === 0 || weekday === 6,
      isToday: dateKey === todayKey,
      tooltip: $localize`:Tooltip on one day of the report's flow chart:${formatDate(day, "weekday")}:day: · ${icu($localize`:Count in a chart tooltip:{count, plural, one {# created} other {# created}}`, { count: bucket.created })}:created: · ${icu($localize`:Count in a chart tooltip:{count, plural, one {# completed} other {# completed}}`, { count: bucket.completed })}:completed: · ${icu($localize`:Count in a chart tooltip - card moves:{count, plural, one {# move} other {# moves}}`, { count: bucket.moved })}:moved:`,
    });
  }
  const busiest = Math.max(0, ...flow.map((day) => Math.max(day.created, day.completed)));
  const flowTicks = niceTicks(busiest);
  // The axis runs to the top gridline, not the tallest bar, or that label would sit above the plot.
  const flowPeak = Math.max(busiest, flowTicks[flowTicks.length - 1] ?? 0);

  // --- Where open work sits ----------------------------------------------------------------------
  // Lists are workspace-scoped, so every board of a workspace shares the same "In progress" list and
  // one bar per list is the honest cross-board picture; the by-board breakdown says whose queue is
  // deep. A cross-board report drops empty lists (several workspaces' lists would be mostly zeros)
  // and folds a long tail; the board page shows every list, empty ones included, in board order.
  const openByList = new Map<string, number>();
  for (const card of openCards) openByList.set(card.listId, (openByList.get(card.listId) ?? 0) + 1);
  const listBars: ReportBar[] = input.lists.map((list) => ({
    id: list.id, name: list.name, icon: list.icon || "list", color: list.color, value: openByList.get(list.id) ?? 0, share: 0, hint: null, inProgress: list.inProgress, group: list.group ?? null,
  }));
  const lists = multiBoard ? foldBars(listBars.filter((bar) => bar.value > 0), CROSS_BOARD_LIST_LIMIT) : foldBars(listBars, Infinity);

  // --- By board ----------------------------------------------------------------------------------
  // Only when the cards span boards: on one board the whole report already is that board.
  let boards: ReportBar[] = [];
  if (multiBoard) {
    const openByBoard = new Map<string, number>();
    const completedByBoard = new Map<string, number>();
    for (const card of openCards) openByBoard.set(card.boardId, (openByBoard.get(card.boardId) ?? 0) + 1);
    for (const event of completedCards.values()) completedByBoard.set(event.boardId, (completedByBoard.get(event.boardId) ?? 0) + 1);
    boards = foldBars(
      [...new Set([...openByBoard.keys(), ...completedByBoard.keys()])]
        .map((boardId) => ({ board: boardsById.get(boardId), open: openByBoard.get(boardId) ?? 0, completed: completedByBoard.get(boardId) ?? 0 }))
        .filter((entry): entry is { board: WorkDoneReportBoard; open: number; completed: number } => !!entry.board)
        .sort((a, b) => b.open - a.open || b.completed - a.completed || a.board.name.localeCompare(b.board.name, appLocale()))
        .map((entry) => ({
          id: entry.board.id,
          name: entry.board.name,
          icon: entry.board.icon || "layout-kanban",
          color: entry.board.color,
          value: entry.open,
          share: 0,
          hint: entry.completed ? icu($localize`:Hint beside a board bar - cards on this board completed in the period:{count, plural, one {# completed} other {# completed}}`, { count: entry.completed }) : null,
          inProgress: false,
          group: null,
        })),
    );
  }

  // --- By workspace ------------------------------------------------------------------------------
  // Only when the boards sit in several workspaces, so a portfolio reader sees which workspace holds
  // the open work and which one delivered.
  const workspacesById = new Map((input.workspaces ?? []).map((workspace) => [workspace.id, workspace]));
  let workspaces: ReportBar[] = [];
  if (workspacesById.size > 1) {
    const openByWorkspace = new Map<string, number>();
    const completedByWorkspace = new Map<string, number>();
    const boardsByWorkspace = new Map<string, Set<string>>();
    for (const card of openCards) {
      const workspaceId = workspaceIdOf(card);
      if (!workspaceId) continue;
      openByWorkspace.set(workspaceId, (openByWorkspace.get(workspaceId) ?? 0) + 1);
      boardsByWorkspace.set(workspaceId, (boardsByWorkspace.get(workspaceId) ?? new Set()).add(card.boardId));
    }
    for (const event of completedCards.values()) {
      const workspaceId = workspaceIdOf(event.card);
      if (workspaceId) completedByWorkspace.set(workspaceId, (completedByWorkspace.get(workspaceId) ?? 0) + 1);
    }
    workspaces = foldBars(
      [...new Set([...openByWorkspace.keys(), ...completedByWorkspace.keys()])]
        .map((workspaceId) => ({ workspace: workspacesById.get(workspaceId), open: openByWorkspace.get(workspaceId) ?? 0, completed: completedByWorkspace.get(workspaceId) ?? 0, boards: boardsByWorkspace.get(workspaceId)?.size ?? 0 }))
        .filter((entry): entry is { workspace: WorkDoneReportWorkspace; open: number; completed: number; boards: number } => !!entry.workspace)
        .sort((a, b) => b.open - a.open || b.completed - a.completed || a.workspace.name.localeCompare(b.workspace.name, appLocale()))
        .map((entry) => ({
          id: entry.workspace.id,
          name: entry.workspace.name,
          icon: entry.workspace.icon || "rocket",
          color: entry.workspace.color,
          value: entry.open,
          share: 0,
          hint: entry.completed ? icu($localize`:Hint beside a workspace bar - cards in this workspace completed in the period:{count, plural, one {# completed} other {# completed}}`, { count: entry.completed }) : null,
          inProgress: false,
          group: null,
        })),
    );
  }

  // --- Needs attention ---------------------------------------------------------------------------
  const dueSoonEnd = localDateKey(addDays(input.today, DUE_SOON_DAYS));
  const attentionCard = (card: AnyCard, detail: string): ReportAttentionCard => ({
    card,
    detail,
    assigneeIds: input.assigneeIdsByCard.get(card.id) ?? [],
    labels: (input.labelIdsByCard.get(card.id) ?? []).map((id) => input.labelsById.get(id)).filter((label): label is CardLabelPresentation => !!label),
  });
  const dueMs = (card: AnyCard) => dueDateTimestamp(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) ?? Number.MAX_SAFE_INTEGER;
  const dueLabel = (card: AnyCard) => $localize`:Attention row detail - when the card is due:Due ${formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone)}:date:`;

  const overdue = openCards
    .filter((card) => isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, nowDate))
    .sort((a, b) => dueMs(a) - dueMs(b));
  const blocked = openCards
    .filter((card) => blockedByCountOf(card) > 0)
    .sort((a, b) => blockedByCountOf(b) - blockedByCountOf(a));
  const tooLong = openCards
    .filter((card) => inProgressTracked(card) && isInProgressTooLong(card, now, settingsFor(input, card).inProgressAlertDays))
    .sort((a, b) => (toMs(a.inProgressSince) ?? 0) - (toMs(b.inProgressSince) ?? 0));
  const dueSoon = openCards
    .filter((card) => !!card.dueDateLocalDate && card.dueDateLocalDate >= todayKey && card.dueDateLocalDate <= dueSoonEnd && !isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, nowDate))
    .sort((a, b) => dueMs(a) - dueMs(b));
  const inactive = openCards
    .filter((card) => isCardInactive(card.updatedAt, now, settingsFor(input, card).inactiveCardsDays))
    .sort((a, b) => (toMs(a.updatedAt) ?? 0) - (toMs(b.updatedAt) ?? 0));
  const unassigned = openCards.filter((card) => (input.assigneeIdsByCard.get(card.id)?.length ?? 0) === 0);
  const listNameById = new Map(input.lists.map((list) => [list.id, list.name]));
  // On a cross-board report the list alone is ambiguous, so a row says which board's list.
  const placeOf = (card: AnyCard) => {
    const list = listNameById.get(card.listId) ?? "";
    const board = multiBoard ? boardsById.get(card.boardId)?.name : null;
    return board ? $localize`:Bar label on a cross-board report - board name then list name:${board}:board: · ${list}:list:` : list;
  };

  const stintWords = (card: AnyCard) => {
    const since = toMs(card.inProgressSince) ?? now;
    return $localize`:Attention row detail - how long the card has been in progress:In progress for ${durationWords(Math.max(0, now - since))}:duration:`;
  };
  const group = (kind: ReportAttentionKind, label: string, icon: string, tone: StatTileTone, cards: AnyCard[], detail: (card: AnyCard) => string): ReportAttentionGroup => ({
    kind, label, icon, tone, count: cards.length, cards: cards.slice(0, ATTENTION_CARD_LIMIT).map((card) => attentionCard(card, detail(card))),
  });
  const attention = [
    group("overdue", $localize`:Report attention group - cards past their due date:Overdue`, "alarm", "danger", overdue, dueLabel),
    group("blocked", $localize`:Report attention group - open cards waiting on another open card:Blocked`, "lock", "danger", blocked, (card) => blockedChipLabel(card) ?? ""),
    group("tooLong", $localize`:Report attention group - cards in progress past the workspace alert:In progress too long`, "clock-exclamation", "warning", tooLong, stintWords),
    group("dueSoon", $localize`:Report attention group - cards due within the next 7 days:Due in the next 7 days`, "calendar-due", "warning", dueSoon, dueLabel),
    group("inProgress", $localize`:Report attention group - cards in a running in-progress stint right now:In progress now`, "progress", "neutral", inProgressNow, (card) => multiBoard ? `${stintWords(card)} · ${placeOf(card)}` : stintWords(card)),
    group("inactive", $localize`:Report attention group - cards with no recent activity:Inactive`, "zzz", "neutral", inactive, (card) => $localize`:Attention row detail - when the card was last touched:Last updated ${formatRelativeTime(card.updatedAt, { now: nowDate })}:when:`),
    group("unassigned", $localize`:Report attention group - open cards with no assignee:Unassigned`, "user-off", "neutral", unassigned, placeOf),
  ].filter((entry) => entry.count > 0);

  // --- Labels ------------------------------------------------------------------------------------
  const openByLabel = new Map<string, number>();
  const completedByLabel = new Map<string, number>();
  for (const card of openCards) for (const labelId of input.labelIdsByCard.get(card.id) ?? []) openByLabel.set(labelId, (openByLabel.get(labelId) ?? 0) + 1);
  for (const event of completedCards.values()) for (const labelId of event.card.labelIds) completedByLabel.set(labelId, (completedByLabel.get(labelId) ?? 0) + 1);
  const labels = foldBars(
    [...new Set([...openByLabel.keys(), ...completedByLabel.keys()])]
      .map((labelId) => ({ label: input.labelsById.get(labelId), open: openByLabel.get(labelId) ?? 0, completed: completedByLabel.get(labelId) ?? 0 }))
      .filter((entry): entry is { label: CardLabelPresentation; open: number; completed: number } => !!entry.label)
      .sort((a, b) => b.open - a.open || b.completed - a.completed || a.label.name.localeCompare(b.label.name, appLocale()))
      .map((entry) => ({
        id: entry.label.id,
        name: entry.label.name,
        icon: null,
        color: entry.label.color,
        value: entry.open,
        share: 0,
        hint: entry.completed ? icu($localize`:Hint beside a label bar - cards with this label completed in the period:{count, plural, one {# completed} other {# completed}}`, { count: entry.completed }) : null,
        inProgress: false,
        group: null,
      })),
  );

  // --- Select fields -----------------------------------------------------------------------------
  const fields: ReportFieldBreakdown[] = [];
  for (const field of input.selectFields) {
    const byOption = new Map<string, number>();
    let unset = 0;
    for (const card of openCards) {
      const optionIds = input.fieldValuesByCard.get(card.id)?.get(field.id)?.valueOptionIds ?? [];
      if (!optionIds.length) unset += 1;
      for (const optionId of optionIds) byOption.set(optionId, (byOption.get(optionId) ?? 0) + 1);
    }
    if (!byOption.size) continue;
    // Options keep their configured order: select fields are often ordinal (priority, size), and
    // reordering them by count would hide that.
    const bars = foldBars(
      field.options
        .filter((option) => byOption.has(option.id))
        .map((option) => ({ id: option.id, name: option.name, icon: null, color: option.color, value: byOption.get(option.id) ?? 0, share: 0, hint: null, inProgress: false, group: null })),
    );
    fields.push({ id: field.id, name: field.name, icon: field.icon, bars, unset });
  }

  // --- Checklist progress on open work -----------------------------------------------------------
  let checklistDone = 0;
  let checklistTotal = 0;
  let checklistCards = 0;
  for (const card of openCards) {
    if (!("checklistTotalCount" in card) || !card.checklistTotalCount) continue;
    checklistCards += 1;
    checklistTotal += card.checklistTotalCount;
    checklistDone += card.checklistDoneCount;
  }
  const checklist = checklistTotal ? { done: checklistDone, total: checklistTotal, cards: checklistCards } : null;

  // --- Delivery timing, from the cards completed this period ------------------------------------
  const cycleSamples: number[] = [];
  const trackedSamples: number[] = [];
  let dueTotal = 0;
  let dueOnTime = 0;
  for (const event of completedCards.values()) {
    const card = event.card;
    const completedAt = toMs(card.completedAt) ?? toMs(event.at)!;
    const createdAt = toMs(card.createdAt);
    if (createdAt !== null && completedAt >= createdAt) cycleSamples.push(completedAt - createdAt);
    if (inProgressTracked(card) && card.inProgressSeconds > 0) trackedSamples.push(timeInProgressMs(card, now, settingsFor(input, card).timeZone));
    const due = dueDateTimestamp(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
    if (due !== null) {
      dueTotal += 1;
      if (completedAt <= due) dueOnTime += 1;
    }
  }
  const cycleTime = cycleSamples.length >= MIN_DURATION_SAMPLES ? { medianMs: median(cycleSamples), samples: cycleSamples.length } : null;
  const trackedTime = trackedSamples.length >= MIN_DURATION_SAMPLES ? { medianMs: median(trackedSamples), samples: trackedSamples.length } : null;
  const onTime = dueTotal >= 2 ? { onTime: dueOnTime, total: dueTotal } : null;

  // --- Headline ----------------------------------------------------------------------------------
  const headline: string[] = [];
  const totalActivity = counts.created + counts.moved + counts.completed + counts.checklistItemCompleted;
  if (totalActivity === 0) {
    headline.push($localize`:Report headline when nothing happened in the period:No cards were worked on in this period.`);
  } else {
    const active = people.filter((person) => person.completed + person.other > 0);
    const viewerOnly = !!input.viewerUserId && active.every((person) => person.userId === input.viewerUserId);
    if (viewerOnly) {
      headline.push(icu(
        $localize`:Report headline sentence on My Cards, addressed to the viewer:You completed {completed, plural, =0 {no cards} one {# card} other {# cards}} and started {created, plural, =0 {no new ones} one {# new one} other {# new ones}}.`,
        { completed: counts.completed, created: counts.created },
      ));
    } else if (input.viewerUserId) {
      // Others acted on the viewer's cards too, so neither "you" nor "the team" is the subject.
      headline.push(icu(
        $localize`:Report headline sentence on My Cards when other people also acted on the viewer's cards:Across your cards, {completed, plural, =0 {none were completed} one {# was completed} other {# were completed}} and {created, plural, =0 {none started} one {# started} other {# started}}.`,
        { completed: counts.completed, created: counts.created },
      ));
    } else {
      headline.push(icu(
        $localize`:Report headline sentence. "solo" is yes when exactly one person was active, and "name" is that person:{solo, select, yes {{name}} other {The team}} completed {completed, plural, =0 {no cards} one {# card} other {# cards}} and started {created, plural, =0 {no new ones} one {# new one} other {# new ones}}.`,
        { solo: active.length === 1 ? "yes" : "no", name: active[0]?.name ?? "", completed: counts.completed, created: counts.created },
      ));
    }
    if (previous) {
      const trend = counts.completed > previous.completed ? "up" : counts.completed < previous.completed ? "down" : "same";
      headline.push(icu(
        $localize`:Report headline sentence comparing completions with the previous period of the same length:{trend, select, up {That is up from} down {That is down from} other {That matches}} {previous, plural, one {# completion} other {# completions}} in the previous {days, plural, one {day} other {# days}}.`,
        { trend, previous: previous.completed, days: rangeDays },
      ));
    }
    const net = counts.created - counts.completed;
    if (net > 0) headline.push(icu($localize`:Report headline sentence - more cards were created than completed:More cards were started than finished, so open work grew by {count, plural, one {# card} other {# cards}}.`, { count: net }));
    else if (net < 0) headline.push(icu($localize`:Report headline sentence - more cards were completed than created:More cards were finished than started, so open work shrank by {count, plural, one {# card} other {# cards}}.`, { count: -net }));
    else if (counts.created > 0) headline.push($localize`:Report headline sentence - as many cards were created as completed:Starts and finishes balanced out, so open work stayed level.`);
    if (active.length > 1) {
      headline.push(icu($localize`:Report headline sentence - how many people did something:{count, plural, other {# people were active}}.`, { count: active.length }));
      const [first, second] = active;
      // On My Cards the leader is usually the viewer; "You completed the most" of your own cards says nothing.
      if (first && first.userId !== input.viewerUserId && first.completed >= 2 && first.completed > (second?.completed ?? 0)) {
        headline.push(icu($localize`:Report headline sentence - the person who completed the most cards:{name} completed the most ({count, plural, one {# card} other {# cards}}).`, { name: first.name, count: first.completed }));
      }
    }
  }
  if (onTime) headline.push(icu($localize`:Report headline sentence - delivery against due dates:{onTime} of {total, plural, one {the # completed card} other {the # completed cards}} with a due date finished on time.`, { onTime: onTime.onTime, total: onTime.total }));
  if (cycleTime) headline.push($localize`:Report headline sentence - median time from creation to completion:Completed cards took a median of ${durationWords(cycleTime.medianMs)}:duration: from creation to completion.`);
  if (trackedTime) headline.push($localize`:Report headline sentence - median tracked working time in progress:They spent a median of ${durationWords(trackedTime.medianMs)}:duration: of working time in progress.`);
  if (overdue.length) headline.push(icu($localize`:Report headline sentence - cards past their due date right now:{count, plural, one {# card is overdue} other {# cards are overdue}}.`, { count: overdue.length }));
  if (blocked.length) headline.push(icu($localize`:Report headline sentence - cards waiting on other open cards right now:{count, plural, one {# card is blocked by other work} other {# cards are blocked by other work}}.`, { count: blocked.length }));
  if (tooLong.length) {
    const thresholds = new Set(tooLong.map((card) => settingsFor(input, card).inProgressAlertDays));
    headline.push(thresholds.size === 1
      ? icu($localize`:Report headline sentence - cards in progress past the workspace alert:{count, plural, one {# card has} other {# cards have}} been in progress longer than {days, plural, one {# day} other {# days}}.`, { count: tooLong.length, days: [...thresholds][0] })
      // Several workspaces, several thresholds: no single number is true for every card named.
      : icu($localize`:Report headline sentence - cards in progress past their own workspace's alert, thresholds differ:{count, plural, one {# card has} other {# cards have}} been in progress longer than its workspace allows.`, { count: tooLong.length }));
  }
  if (!overdue.length && !blocked.length && !tooLong.length) headline.push($localize`:Report headline sentence when no card is overdue, blocked or stuck:Nothing is overdue, blocked or stuck right now.`);
  if (dueSoon.length) headline.push(icu($localize`:Report headline sentence - cards due within the next 7 days:{count, plural, one {# card is} other {# cards are}} due in the next 7 days.`, { count: dueSoon.length }));
  if (inProgressNow.length) headline.push(icu($localize`:Report headline sentence - cards in a running in-progress stint right now:{count, plural, one {# card is} other {# cards are}} in progress right now.`, { count: inProgressNow.length }));

  return {
    headline,
    kpis,
    comparisonLabel,
    flow,
    flowPeak,
    flowTicks,
    openCount: openCards.length,
    lists,
    boards,
    workspaces,
    attention,
    people,
    heat,
    heatColumns,
    labels,
    fields,
    checklist,
    cycleTime,
    trackedTime,
    onTime,
  };
}

/** Caps a breakdown at `limit` bars, folding the tail into "Other", then scales shares. */
function foldBars(bars: ReportBar[], limit = BREAKDOWN_LIMIT): ReportBar[] {
  let result = bars;
  if (bars.length > limit) {
    const kept = bars.slice(0, limit - 1);
    const rest = bars.slice(limit - 1);
    result = [...kept, { id: "other", name: $localize`:Chart bar folding the smallest categories together:Other`, icon: null, color: null, value: sum(rest.map((bar) => bar.value)), share: 0, hint: null, inProgress: false, group: null }];
  }
  const peak = Math.max(0, ...result.map((bar) => bar.value));
  return result.map((bar) => ({ ...bar, share: peak ? bar.value / peak : 0 }));
}

/**
 * The report as plain text, for pasting into a status update. Mirrors the rendered order: headline,
 * the period's numbers, then what needs attention with the cards named.
 */
export function buildReportText(report: WorkDoneReport, title: string): string {
  const lines: string[] = [title, "", report.headline.join(" "), ""];
  for (const kpi of report.kpis) {
    const delta = kpi.delta === null ? "" : ` (${new Intl.NumberFormat(appLocale(), { signDisplay: "exceptZero" }).format(kpi.delta)})`;
    lines.push(`${kpi.label}: ${kpi.value}${delta}`);
  }
  if (report.attention.length) {
    lines.push("", $localize`:Heading in the copied report text:Needs attention`);
    for (const group of report.attention) {
      lines.push(`${group.label} (${group.count})`);
      for (const entry of group.cards) lines.push(`- ${entry.card.key} ${entry.card.title} · ${entry.detail}`);
      const more = group.count - group.cards.length;
      if (more > 0) lines.push(icu($localize`:Line in the copied report text for cards not named individually:- {count, plural, one {and # more} other {and # more}}`, { count: more }));
    }
  }
  return lines.join("\n").trim();
}
