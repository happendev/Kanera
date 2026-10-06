import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import type {
  WorkCatalogBoard,
  WorkCatalogList,
  WorkCatalogPerson,
  WorkDoneEvent,
  WorkDoneResponse,
  WorkFilters,
  WorkCatalogWorkspace,
  WorkPriorityQueue,
  WorkQueryResponse,
  WorkScope,
} from "@kanera/shared/dto";
import { expandCardSummary, type WireCardSummary } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { AvatarComponent } from "../../shared/avatar.component";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import { formatRelativeTime } from "../../shared/date-format";
import { addDays, startOfLocalDay, viewerTimeZone } from "../../shared/day-key.util";
import { MinuteClockService } from "../../shared/minute-clock.service";
import { priorityRankHeat } from "../../shared/priority-rank";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { dueDateTimestamp, formatDueDate, isDueSoon, isOverdue } from "../board/due-date.util";
import { isInProgressTooLong, timeInProgressChip, type TimeInProgressChip } from "../board/time-in-progress.util";

type OverviewCard = WireCardSummary & { workspaceId: string };

/** How far back "recently active" and "done" look. Matches Work done's default 7-day preset. */
export const OVERVIEW_ACTIVITY_DAYS = 7;
const IN_PROGRESS_LIMIT = 5;
const RECENT_LIMIT = 3;
const UP_NEXT_LIMIT = 3;
const ASSIGNED_LIMIT = 5;
const DONE_LIMIT = 3;
const UNOWNED_LIMIT = 5;
/** A drill-down lists more than a summary section, but still hands off to the board past this. */
const DRILL_DOWN_LIMIT = 12;

type DueTone = "overdue" | "soon" | "muted";

/**
 * One card line: title, then board · list, then its chips on their own line so a long title or board
 * name never squeezes the due date or time away (and vice versa).
 */
type OverviewRow = {
  card: WireCardSummary;
  boardName: string;
  boardIconClass: string;
  boardIconColor: string | null;
  listName: string;
  /** Tracked time in progress: running (accent), past its workspace alert (amber) or stopped (muted). */
  time: TimeInProgressChip | null;
  due: { text: string; tone: DueTone } | null;
  /** What the person did and when ("Moved 2h ago", "Done yesterday"), for activity-derived rows. */
  note: string | null;
  rank?: number;
};

/** The person stats double as toggles: each opens that set of cards in place of the summary. */
export type OverviewStat = "open" | "inProgress" | "overdue" | "done";

type StatItem = { key: OverviewStat; label: string; value: number; tone: "active" | "aging" | "alert" | null; tooltip: string };

type PersonOverview = {
  person: WorkCatalogPerson;
  open: number;
  inProgress: number;
  /** In-progress cards whose current stint is past their workspace's alert. */
  inProgressTooLong: number;
  overdue: number;
  done: number;
  stats: StatItem[];
  lastActiveAt: string | null;
  inProgressRows: OverviewRow[];
  inProgressMore: number;
  recent: OverviewRow[];
  /** null when this viewer may not read the person's queue; the section is then omitted. */
  upNext: { rows: OverviewRow[]; total: number; hidden: number } | null;
  assigned: OverviewRow[];
  assignedMore: number;
  doneRows: OverviewRow[];
  /** The selected stat's cards, replacing the summary sections; null when none is selected. */
  drillDown: { stat: OverviewStat; label: string; icon: string; tone: string; rows: OverviewRow[]; more: number; empty: string } | null;
};

/** A person's own action on a card, reduced to what the overview needs. */
type Touch = { at: string; verb: string };

/**
 * Team Cards' manager overview: one panel per teammate answering "what are they busy with, and what
 * is next for them" without opening each person's board in turn.
 *
 * Each section is a different, named signal:
 * - "In progress" is their open cards in the workspace's *in-progress* lists, longest-running first,
 *   each with its time in progress. This is declared workflow state, so a card nobody touched for a
 *   week still shows (with a week on its clock), which is exactly what a manager needs to see.
 * - "Recently active" is the person's *own* recent activity (moves, new cards, checklist ticks) on
 *   open cards outside those lists — review hand-offs, triage. Activity by anyone else (a manager
 *   re-triaging, an agent) does not count, or the panel would report someone else's work as theirs.
 * - "Up next" is the head of their curated queue, when this viewer may read it.
 * - "Assigned" is the rest of their open cards, soonest due first, because most of a person's
 *   agenda is never queued.
 * - The stats (Open, In progress, Overdue, Done 7d) are toggles: selecting one swaps the summary
 *   for that whole set of cards, and selecting it again returns to the summary.
 *
 * The card-derived sections follow the page's scope, search and filters; the queue does not, for
 * the same reason as the lanes display (rank must not lie because a filter hides a card), so its
 * numbers are the person's true ranks.
 */
@Component({
  selector: "k-team-overview",
  standalone: true,
  imports: [AvatarComponent, NgTemplateOutlet, TooltipDirective],
  templateUrl: "./team-overview.component.html",
  styleUrl: "./team-overview.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeamOverviewComponent {
  private readonly api = inject(ApiClient);
  private readonly clock = inject(MinuteClockService);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  protected readonly rankHeat = priorityRankHeat;
  protected readonly activityDays = OVERVIEW_ACTIVITY_DAYS;

  readonly people = input<WorkCatalogPerson[]>([]);
  readonly cards = input<OverviewCard[]>([]);
  readonly queues = input<WorkPriorityQueue[]>([]);
  readonly lists = input<WorkCatalogList[]>([]);
  readonly boards = input<WorkCatalogBoard[]>([]);
  /** Each workspace's time-in-progress alert; a card's clock turns amber past its own workspace's. */
  readonly workspaces = input<WorkCatalogWorkspace[]>([]);
  readonly scope = input<WorkScope | null>(null);
  readonly filters = input<WorkFilters | null>(null);
  /** False while the page cannot query, e.g. offline; the activity feed is not cached. */
  readonly enabled = input(true);
  /** Bumped by the host on reconciles and realtime echoes, like the Work done display's. */
  readonly refreshVersion = input(0);
  readonly selectedCardId = input<string | null>(null);

  readonly cardOpened = output<WireCardSummary>();
  /** Opens the person's own cards (board display, focused on them). */
  readonly personFocused = output<string>();

  readonly events = signal<WorkDoneEvent[]>([]);
  readonly activityError = signal<string | null>(null);
  readonly activityLoading = signal(false);
  readonly showQuiet = signal(false);
  /** Each person's selected stat, by user id. Absent means the summary. */
  readonly selectedStats = signal<ReadonlyMap<string, OverviewStat>>(new Map());
  private loadSeq = 0;
  private loadedKey: string | null = null;

  /**
   * In-progress work nobody owns. Every panel is a person, so an unassigned card in an In progress
   * list would otherwise be invisible here, and it is exactly the work a manager needs to hand out.
   * A separate query because the team lens only returns cards assigned to teammates.
   */
  readonly unowned = signal<{ cards: WireCardSummary[]; total: number } | null>(null);
  private unownedSeq = 0;

  constructor() {
    effect(() => {
      this.scope();
      this.filters();
      this.enabled();
      this.refreshVersion();
      void this.loadActivity();
      void this.loadUnowned();
    });
  }

  private readonly alertDaysByWorkspace = computed(() => new Map(this.workspaces().map((workspace) => [workspace.id, workspace.inProgressAlertDays])));
  private readonly timeZoneByWorkspace = computed(() => new Map(this.workspaces().map((workspace) => [workspace.id, workspace.timeZone])));

  private alertDaysFor(card: WireCardSummary): number {
    return this.alertDaysByWorkspace().get(card.workspaceId) ?? 0;
  }

  readonly unownedRows = computed(() => {
    const unowned = this.unowned();
    if (!unowned || unowned.total === 0) return null;
    const nowMs = this.clock.now();
    const rows = unowned.cards.slice(0, UNOWNED_LIMIT).map((card) => this.row(card, nowMs));
    return { rows, more: Math.max(0, unowned.total - rows.length) };
  });

  toggleStat(userId: string, stat: OverviewStat): void {
    this.selectedStats.update((current) => {
      const next = new Map(current);
      if (next.get(userId) === stat) next.delete(userId);
      else next.set(userId, stat);
      return next;
    });
  }

  private readonly boardsById = computed(() => new Map(this.boards().map((board) => [board.id, board])));
  private readonly listsById = computed(() => new Map(this.lists().map((list) => [list.id, list])));
  /** With no list marked in progress anywhere in scope, "In progress" explains how to turn it on. */
  readonly hasInProgressLists = computed(() => this.lists().some((list) => list.inProgress));

  /** Each person's open assigned cards, grouped in one pass instead of a scan of every card per person. */
  private readonly openCardsByPerson = computed(() => {
    const byPerson = new Map<string, OverviewCard[]>();
    for (const card of this.cards()) {
      if (card.completedAt || card.archivedAt) continue;
      for (const userId of card.assigneeIds) {
        const bucket = byPerson.get(userId);
        if (bucket) bucket.push(card);
        else byPerson.set(userId, [card]);
      }
    }
    return byPerson;
  });

  /**
   * One pass over the activity feed: each person's latest touch per card, their completions, and
   * when they were last active at all.
   */
  private readonly activity = computed(() => {
    const touches = new Map<string, Map<string, Touch & { card: WireCardSummary }>>();
    const completions = new Map<string, Map<string, { at: string; card: WireCardSummary }>>();
    const lastActive = new Map<string, string>();
    for (const event of this.events()) {
      const actorId = event.type === "checklistItemCompleted" ? event.completedByUserId : event.actorUserId;
      // Agent output is not the person's own effort (see WorkDoneCardEventBase.agentName).
      if (!actorId || ("agentName" in event && event.agentName)) continue;
      if (!lastActive.has(actorId) || lastActive.get(actorId)! < event.at) lastActive.set(actorId, event.at);
      if (event.type === "completed") {
        const done = completions.get(actorId) ?? new Map<string, { at: string; card: WireCardSummary }>();
        if (!done.has(event.card.id)) done.set(event.card.id, { at: event.at, card: event.card });
        completions.set(actorId, done);
        continue;
      }
      const byCard = touches.get(actorId) ?? new Map<string, Touch & { card: WireCardSummary }>();
      const previous = byCard.get(event.card.id);
      if (!previous || previous.at < event.at) {
        byCard.set(event.card.id, { at: event.at, verb: this.verbFor(event), card: event.card });
      }
      touches.set(actorId, byCard);
    }
    return { touches, completions, lastActive };
  });

  /**
   * Everything about each person that does not depend on the clock: who has what, and in which
   * order. The minute tick then only relabels the handful of rows on screen.
   */
  private readonly bases = computed(() => {
    const query = this.filters()?.q.trim().toLowerCase() ?? "";
    const queuesByUserId = new Map(this.queues().map((lane) => [lane.target.userId, lane.queue]));
    const cardsById = new Map<string, WireCardSummary>(this.cards().map((card) => [card.id, card]));
    const openByPerson = this.openCardsByPerson();
    const { touches, completions, lastActive } = this.activity();

    return this.people().map((person) => {
      const assigned = openByPerson.get(person.userId) ?? [];

      // Longest-running first: the card that has been "in progress" for two weeks is the one to
      // ask about, and it is also the one most likely to be stuck. Every card here is open, so the
      // earliest start is the longest-running at any moment and the order needs no clock.
      const inProgressAll = assigned
        .map((card) => ({ card, since: card.inProgressSince ? new Date(card.inProgressSince).getTime() : Number.NaN }))
        .filter(({ since }) => !Number.isNaN(since))
        .sort((a, b) => a.since - b.since)
        .map(({ card }) => card);
      const inProgressIds = new Set(inProgressAll.map((card) => card.id));

      // Live card over the event's copy: the feed is a point-in-time read and the card set is kept
      // current by realtime. Only open cards still theirs, and not already under "In progress".
      const recent = [...(touches.get(person.userId)?.values() ?? [])]
        .map((touch) => ({ touch, card: cardsById.get(touch.card.id) ?? touch.card }))
        .filter(({ card }) =>
          !card.completedAt && !card.archivedAt && card.assigneeIds.includes(person.userId) && !inProgressIds.has(card.id)
        )
        .sort((a, b) => b.touch.at.localeCompare(a.touch.at))
        .slice(0, RECENT_LIMIT);

      const queue = queuesByUserId.get(person.userId);
      const upNext = queue
        ? {
            entries: queue.items
              .flatMap((entry) => {
                if (!entry.card) return [];
                const card = expandCardSummary(entry.card);
                if (query && !card.title.toLowerCase().includes(query)) return [];
                return [{ card, rank: entry.rank }];
              })
              .slice(0, UP_NEXT_LIMIT),
            total: queue.totalCount,
            hidden: queue.hiddenCount,
          }
        : null;

      // Every open card, soonest due first and undated after (most recently updated first): the
      // order of both "Assigned" and the Open drill-down.
      const byAgenda = assigned
        .map((card) => ({ card, dueAt: dueDateTimestamp(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) }))
        .sort((a, b) =>
          (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY)
          || String(b.card.updatedAt).localeCompare(String(a.card.updatedAt))
        );

      // Completions count whoever the card was assigned to: closing it is this person's work.
      const doneAll = [...(completions.get(person.userId)?.values() ?? [])]
        .sort((a, b) => b.at.localeCompare(a.at));

      return {
        person,
        lastActiveAt: lastActive.get(person.userId) ?? null,
        inProgressAll,
        recent,
        upNext,
        byAgenda,
        doneAll,
      };
    });
  });

  readonly overviews = computed<PersonOverview[]>(() => {
    const now = new Date(this.clock.now());
    const nowMs = now.getTime();
    const selected = this.selectedStats();

    return this.bases().map((base) => {
      const inProgressRows = base.inProgressAll.slice(0, IN_PROGRESS_LIMIT).map((card) => this.row(card, nowMs));
      const recent = base.recent.map(({ touch, card }) =>
        this.row(card, nowMs, `${touch.verb} ${formatRelativeTime(touch.at, { now })}`)
      );
      const upNext = base.upNext
        ? { rows: base.upNext.entries.map(({ card, rank }) => ({ ...this.row(card, nowMs), rank })), total: base.upNext.total, hidden: base.upNext.hidden }
        : null;
      const doneRow = ({ at, card }: { at: string; card: WireCardSummary }) =>
        this.row(card, nowMs, `Done ${formatRelativeTime(at, { now })}`, { withDue: false });

      // What is already on screen above is not repeated: the panel is a summary, and every row
      // carries its own due chip, so nothing due disappears by being listed elsewhere.
      const shown = new Set([...inProgressRows, ...recent, ...(upNext?.rows ?? [])].map((row) => row.card.id));
      const assignedAll = base.byAgenda.filter(({ card }) => !shown.has(card.id));
      const overdueCards = base.byAgenda
        .filter(({ card }) => isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, now))
        .map(({ card }) => card);
      const inProgressTooLong = base.inProgressAll.filter((card) => isInProgressTooLong(card, nowMs, this.alertDaysFor(card))).length;

      const counts = {
        open: base.byAgenda.length,
        inProgress: base.inProgressAll.length,
        overdue: overdueCards.length,
        done: base.doneAll.length,
      };
      const stats: StatItem[] = [
        { key: "open", label: "Open", value: counts.open, tone: null, tooltip: "All their open cards" },
        {
          key: "inProgress",
          label: "In progress",
          value: counts.inProgress,
          tone: inProgressTooLong ? "aging" : counts.inProgress ? "active" : null,
          tooltip: inProgressTooLong
            ? `${inProgressTooLong} in progress longer than the workspace alert`
            : "Their open cards in In progress lists",
        },
        { key: "overdue", label: "Overdue", value: counts.overdue, tone: counts.overdue ? "alert" : null, tooltip: "Their open cards past due" },
        { key: "done", label: `Done ${OVERVIEW_ACTIVITY_DAYS}d`, value: counts.done, tone: null, tooltip: `Cards they completed in the last ${OVERVIEW_ACTIVITY_DAYS} days` },
      ];

      const stat = selected.get(base.person.userId) ?? null;
      let drillDown: PersonOverview["drillDown"] = null;
      if (stat) {
        const rows = stat === "open"
          ? base.byAgenda.map(({ card }) => this.row(card, nowMs))
          : stat === "inProgress"
            ? base.inProgressAll.map((card) => this.row(card, nowMs))
            : stat === "overdue"
              ? overdueCards.map((card) => this.row(card, nowMs))
              : base.doneAll.map(doneRow);
        const empty = {
          open: "No open cards",
          inProgress: this.hasInProgressLists() ? "Nothing in progress" : "No lists are marked In progress yet — mark them in workspace settings",
          overdue: "Nothing overdue",
          done: `Nothing completed in the last ${OVERVIEW_ACTIVITY_DAYS} days`,
        }[stat];
        // Each drill-down wears the icon and colour of the summary section it expands.
        const look = {
          open: { icon: "user-check", tone: "assigned" },
          inProgress: { icon: "progress", tone: "progress" },
          overdue: { icon: "alarm", tone: "overdue" },
          done: { icon: "circle-check", tone: "done" },
        }[stat];
        drillDown = {
          stat,
          label: stats.find((item) => item.key === stat)!.label,
          ...look,
          rows: rows.slice(0, DRILL_DOWN_LIMIT),
          more: Math.max(0, rows.length - DRILL_DOWN_LIMIT),
          empty,
        };
      }

      return {
        person: base.person,
        ...counts,
        inProgressTooLong,
        stats,
        lastActiveAt: base.lastActiveAt,
        inProgressRows,
        inProgressMore: Math.max(0, base.inProgressAll.length - IN_PROGRESS_LIMIT),
        recent,
        upNext,
        assigned: assignedAll.slice(0, ASSIGNED_LIMIT).map(({ card }) => this.row(card, nowMs)),
        assignedMore: Math.max(0, assignedAll.length - ASSIGNED_LIMIT),
        doneRows: base.doneAll.slice(0, DONE_LIMIT).map(doneRow),
        drillDown,
      };
    });
  });

  /**
   * Anyone with nothing open, nothing queued and no activity in the window. They collapse into one
   * line instead of a panel of empty sections, which on a large scope would push the people with
   * actual work below the fold.
   */
  readonly activePeople = computed(() => this.overviews().filter((item) => !this.isQuiet(item)));
  readonly quietPeople = computed(() => this.overviews().filter((item) => this.isQuiet(item)));

  private isQuiet(item: PersonOverview): boolean {
    return item.open === 0 && item.done === 0 && item.recent.length === 0 && !item.upNext?.total;
  }

  lastActiveLabel(item: PersonOverview): string {
    if (this.activityLoading() && this.events().length === 0) return "Loading activity…";
    return item.lastActiveAt
      ? `Active ${formatRelativeTime(item.lastActiveAt, { now: new Date(this.clock.now()) })}`
      : `No activity in ${OVERVIEW_ACTIVITY_DAYS} days`;
  }

  /** Just the verb: the row's context line already names the list the card is in now. */
  private verbFor(event: WorkDoneEvent): string {
    switch (event.type) {
      case "moved": return "Moved";
      case "created": return "Created";
      case "checklistItemCompleted": return "Ticked item";
      case "completed": return "Completed";
    }
  }

  /**
   * `note` is what the person did ("Moved 2h ago"). Every open card carries its time in progress
   * and due date when it has them; completed ones drop the due date, which no longer matters.
   */
  private row(card: WireCardSummary, nowMs: number, note: string | null = null, options: { withDue?: boolean } = {}): OverviewRow {
    const board = this.boardsById().get(card.boardId);
    const withDue = options.withDue ?? true;
    return {
      card,
      boardName: board?.name ?? "",
      boardIconClass: `ti ti-${board?.icon ?? "layout-kanban"}`,
      boardIconColor: board?.iconColor ? `var(--color-${board.iconColor})` : null,
      listName: this.listsById().get(card.listId)?.name ?? "",
      time: timeInProgressChip(card, nowMs, this.alertDaysFor(card), this.timeZoneByWorkspace().get(card.workspaceId)),
      due: withDue && card.dueDateLocalDate
        ? { text: formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) ?? "", tone: dueTone(card) }
        : null,
      note,
    };
  }

  private async loadUnowned(): Promise<void> {
    const seq = ++this.unownedSeq;
    if (!this.enabled()) return;
    const filters = this.filters();
    try {
      const response = await this.api.post<WorkQueryResponse>("/work/cards/query", {
        // The portfolio lens is the one that does not require an assignee; scope, search and the
        // page's other filters still apply, like the rest of the overview's card sections.
        lens: "portfolio",
        scope: this.scope() ?? undefined,
        filters: { ...(filters ?? {}), assigneeIds: [], unassignedOnly: true, inProgressOnly: true },
        sort: "inProgressAsc",
        limit: UNOWNED_LIMIT,
        includeMetadata: true,
      });
      if (seq !== this.unownedSeq) return;
      this.unowned.set({ cards: response.cards.map((card) => expandCardSummary(card)), total: response.totals.cards });
    } catch {
      // Best-effort: keep what is on screen; the person panels do not depend on it.
      if (seq === this.unownedSeq && this.unowned() === null) this.unowned.set({ cards: [], total: 0 });
    }
  }

  private async loadActivity(): Promise<void> {
    const seq = ++this.loadSeq;
    if (!this.enabled()) {
      this.activityLoading.set(false);
      return;
    }
    const today = startOfLocalDay(new Date());
    const body = {
      lens: "team" as const,
      scope: this.scope() ?? undefined,
      filters: this.filters() ?? undefined,
      from: addDays(today, -(OVERVIEW_ACTIVITY_DAYS - 1)).toISOString(),
      // Exclusive upper bound at the start of tomorrow, the same local-day window Work done sends.
      to: addDays(today, 1).toISOString(),
      timeZone: viewerTimeZone(),
    };
    const key = JSON.stringify({ ...body, from: undefined, to: undefined });
    // A realtime echo re-reads the same window; keep what is on screen instead of blanking it.
    const refreshing = this.loadedKey === key;
    if (!refreshing) this.events.set([]);
    this.activityLoading.set(true);
    this.activityError.set(null);
    try {
      const response = await this.api.post<WorkDoneResponse>("/work/work-done/query", body);
      if (seq !== this.loadSeq) return;
      this.events.set(response.events ?? []);
      this.loadedKey = key;
    } catch {
      if (seq === this.loadSeq && !refreshing) {
        this.activityError.set("Recent activity couldn’t be loaded, so “Recently active” and “Done” are empty.");
      }
    } finally {
      if (seq === this.loadSeq) this.activityLoading.set(false);
    }
  }
}

function dueTone(card: WireCardSummary): DueTone {
  if (isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone)) return "overdue";
  return isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) ? "soon" : "muted";
}
