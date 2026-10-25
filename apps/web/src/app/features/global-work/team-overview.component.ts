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
import { CachedViewService } from "../../core/offline/cached-view.service";
import { viewPreferenceKey } from "../../core/browser/browser-contracts";
import { AvatarComponent } from "../../shared/avatar.component";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import { icu } from "../../core/i18n/icu";
import { formatRelativeTime } from "../../shared/date-format";
import { addDays, startOfLocalDay, viewerTimeZone } from "../../shared/day-key.util";
import { MinuteClockService } from "../../shared/minute-clock.service";
import { priorityRankHeat } from "../../shared/priority-rank";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { dueDateTimestamp, formatDueDate, isDueSoon, isOverdue } from "../board/due-date.util";
import { isInProgressTooLong, timeInProgressChip, type TimeInProgressChip } from "../board/time-in-progress.util";
import { blockedChipLabel } from "../board/card-relations.util";

/** The per-person sections a viewer can fold. Folding one folds it in every panel at once. */
type OverviewSection = "inProgress" | "recent" | "upNext" | "assigned" | "done";
const OVERVIEW_SECTIONS: readonly OverviewSection[] = ["inProgress", "recent", "upNext", "assigned", "done"];
const COLLAPSED_SECTIONS_KEY = viewPreferenceKey("collapsedSections", "teamOverview");
const HIDE_GUESTS_KEY = viewPreferenceKey("hideGuests", "teamOverview");

function storedHideGuests(): boolean {
  try {
    return localStorage.getItem(HIDE_GUESTS_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * A guest on every board they share with this scope: someone from a client or partner organisation
 * rather than the team. A member of any in-scope board's organisation is never one.
 */
function isGuest(person: WorkCatalogPerson): boolean {
  return person.boardIds.length > 0 && person.boardIds.every((boardId) => person.guestBoardIds.includes(boardId));
}

/** Viewer-local and best-effort: private windows and blocked storage simply start expanded. */
function storedCollapsedSections(): ReadonlySet<OverviewSection> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? OVERVIEW_SECTIONS.filter((section) => value.includes(section)) : []);
  } catch {
    return new Set();
  }
}

/** How far back "recently active" and "done" look. Matches Work done's default 7-day preset. */
const OVERVIEW_ACTIVITY_DAYS = 7;
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
  /** Tooltip for the Blocked chip while the card waits on an open card; null otherwise. */
  blocked: string | null;
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

type TouchVerb = "moved" | "created" | "ticked";
/** A person's own action on a card, reduced to what the overview needs. */
type Touch = { at: string; verb: TouchVerb };

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
  private readonly queries = inject(CachedViewService);
  private readonly clock = inject(MinuteClockService);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  protected readonly rankHeat = priorityRankHeat;
  protected readonly recentTooltip = $localize`:Team overview section tooltip:Other open cards they moved, created or ticked items on in the last ${OVERVIEW_ACTIVITY_DAYS}:days: days`;

  readonly people = input<WorkCatalogPerson[]>([]);
  readonly cards = input<WireCardSummary[]>([]);
  readonly queues = input<WorkPriorityQueue[]>([]);
  readonly lists = input<WorkCatalogList[]>([]);
  readonly boards = input<WorkCatalogBoard[]>([]);
  /** Each workspace's time-in-progress alert; a card's clock turns amber past its own workspace's. */
  readonly workspaces = input<WorkCatalogWorkspace[]>([]);
  readonly scope = input<WorkScope | null>(null);
  readonly filters = input<WorkFilters | null>(null);
  /** Opening a new filtered board needs a live query; local panel browsing stays available. */
  readonly canNavigate = input(true);
  private readonly activityCachedAt = signal<string | null>(null);
  private readonly unownedCachedAt = signal<string | null>(null);
  readonly unownedError = signal(false);
  readonly offlineMessage = computed(() => {
    const time = [this.activityCachedAt(), this.unownedCachedAt()].filter((value): value is string => !!value).sort()[0];
    return time ? $localize`:Dependencies view note; a relative time such as "5 minutes ago" follows:Offline copy from ${formatRelativeTime(time)}:time:` : "";
  });
  /** Bumped by the host on reconciles and realtime echoes, like the Work done display's. */
  readonly refreshVersion = input(0);
  readonly selectedCardId = input<string | null>(null);

  readonly cardOpened = output<WireCardSummary>();
  /** Opens the person's own cards (board display, focused on them). */
  readonly personFocused = output<string>();
  /**
   * The one teammate to show, with their Up next docked beside the overview by the page; null shows
   * everyone. A focus on someone this overview has no panel for (scope changed under it) shows
   * everyone rather than an empty page.
   */
  readonly focusedUserId = input<string | null>(null);
  /** Whether the page's dock is showing the focused person's queue, so their Edit button says so. */
  readonly upNextOpen = input(false);
  /** The person strip and avatars: focus this person, or null for everyone. The page owns focus. */
  readonly focusChanged = output<string | null>();
  /** Edit on a teammate's Up next: focus them with their queue docked, or close the open dock. */
  readonly upNextToggled = output<string>();

  readonly events = signal<WorkDoneEvent[]>([]);
  readonly activityError = signal<string | null>(null);
  readonly activityLoading = signal(false);
  readonly showQuiet = signal(false);

  /** Viewer-local, like the folds: whether to leave guests out of the strip and the panels. */
  readonly hideGuests = signal(storedHideGuests());
  readonly guestCount = computed(() => this.people().filter(isGuest).length);
  private readonly shownPeople = computed(() =>
    this.hideGuests() ? this.people().filter((person) => !isGuest(person)) : this.people()
  );

  toggleHideGuests(): void {
    const next = !this.hideGuests();
    this.hideGuests.set(next);
    try {
      localStorage.setItem(HIDE_GUESTS_KEY, String(next));
    } catch {
      // Storage can be unavailable in privacy mode; the choice still applies for this visit.
    }
    // A focused guest would otherwise leave their Up next docked beside a panel that is gone.
    const focused = this.people().find((person) => person.userId === this.focusedUserId());
    if (next && focused && isGuest(focused)) this.focusChanged.emit(null);
  }

  /** Says what a press does and to whom, since "guest" alone does not say which side of the line they are. */
  readonly hideGuestsTooltip = computed(() => {
    const count = this.guestCount();
    return this.hideGuests()
      ? icu($localize`:Tooltip on the pressed Team overview toggle; pressing shows guests again:{count, plural, one {Show # guest from another organisation} other {Show # guests from other organisations}}`, { count })
      : icu($localize`:Tooltip on the Team overview toggle hiding guests:{count, plural, one {Hide # guest from another organisation} other {Hide # guests from other organisations}}`, { count });
  });

  /**
   * Folded sections, shared by every panel: comparing one kind of work across the team ("what is
   * everyone working on") means hiding the same other sections everywhere, not panel by panel.
   */
  readonly collapsedSections = signal<ReadonlySet<OverviewSection>>(storedCollapsedSections());

  isCollapsed(section: OverviewSection): boolean {
    return this.collapsedSections().has(section);
  }

  /** Every section folded; the panel header's fold-all button then unfolds them instead. */
  readonly allSectionsCollapsed = computed(() => OVERVIEW_SECTIONS.every((section) => this.collapsedSections().has(section)));

  toggleSection(section: OverviewSection): void {
    const next = new Set(this.collapsedSections());
    if (!next.delete(section)) next.add(section);
    this.storeCollapsedSections(next);
  }

  toggleAllSections(): void {
    this.storeCollapsedSections(new Set(this.allSectionsCollapsed() ? [] : OVERVIEW_SECTIONS));
  }

  private storeCollapsedSections(next: ReadonlySet<OverviewSection>): void {
    this.collapsedSections.set(next);
    try {
      localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next]));
    } catch {
      // Storage can be unavailable in privacy mode; the fold still applies for this visit.
    }
  }
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
      this.queries.online();
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
    if (!this.inProgressEnabled() || !unowned || unowned.total === 0) return null;
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
  readonly inProgressEnabled = computed(() => this.boards().some((board) => board.inProgressEnabled !== false));
  readonly hasInProgressLists = computed(() => this.lists().some((list) => list.inProgress));

  /** Each person's open assigned cards, grouped in one pass instead of a scan of every card per person. */
  private readonly openCardsByPerson = computed(() => {
    const byPerson = new Map<string, WireCardSummary[]>();
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

    return this.shownPeople().map((person) => {
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
        this.row(card, nowMs, touchNote(touch.verb, formatRelativeTime(touch.at, { now })))
      );
      const upNext = base.upNext
        ? { rows: base.upNext.entries.map(({ card, rank }) => ({ ...this.row(card, nowMs), rank })), total: base.upNext.total, hidden: base.upNext.hidden }
        : null;
      const doneRow = ({ at, card }: { at: string; card: WireCardSummary }) =>
        this.row(card, nowMs, $localize`:Overview row note, e.g. "Done 2h ago":Done ${formatRelativeTime(at, { now })}:time:`, { withDue: false });

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
        {
          key: "open",
          label: $localize`:card state|Team overview stat, count of their open cards:Open`,
          value: counts.open,
          tone: null,
          tooltip: $localize`:Team overview stat tooltip:All their open cards`,
        },
        {
          key: "inProgress",
          label: $localize`:Team overview stat:In progress`,
          value: counts.inProgress,
          tone: inProgressTooLong ? "aging" : counts.inProgress ? "active" : null,
          tooltip: inProgressTooLong
            ? icu($localize`:Team overview stat tooltip:{count, plural, one {# in progress longer than the workspace alert} other {# in progress longer than the workspace alert}}`, { count: inProgressTooLong })
            : $localize`:Team overview stat tooltip:Their open cards in In progress lists`,
        },
        {
          key: "overdue",
          label: $localize`:Team overview stat:Overdue`,
          value: counts.overdue,
          tone: counts.overdue ? "alert" : null,
          tooltip: $localize`:Team overview stat tooltip:Their open cards past due`,
        },
        {
          key: "done",
          label: $localize`:Team overview stat, cards completed in the last N days:Done ${OVERVIEW_ACTIVITY_DAYS}:days:d`,
          value: counts.done,
          tone: null,
          tooltip: $localize`:Team overview stat tooltip:Cards they completed in the last ${OVERVIEW_ACTIVITY_DAYS}:days: days`,
        },
      ];

      const selection = selected.get(base.person.userId) ?? null;
      const stat = selection === "inProgress" && !this.inProgressEnabled() ? null : selection;
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
          open: $localize`:Team overview drill-down empty state:No open cards`,
          inProgress: this.hasInProgressLists()
            ? $localize`:Team overview empty state:Nothing in progress`
            : $localize`:Team overview empty state:No lists are marked In progress yet — mark them in workspace settings`,
          overdue: $localize`:Team overview drill-down empty state:Nothing overdue`,
          done: $localize`:Team overview drill-down empty state:Nothing completed in the last ${OVERVIEW_ACTIVITY_DAYS}:days: days`,
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
        stats: stats.filter((stat) => this.inProgressEnabled() || stat.key !== "inProgress"),
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
  readonly activePeople = computed(() => {
    const focused = this.focusedOverview();
    return focused ? [focused] : this.overviews().filter((item) => !this.isQuiet(item));
  });
  readonly quietPeople = computed(() => this.focusedOverview() ? [] : this.overviews().filter((item) => this.isQuiet(item)));

  /** The focused person's panel, shown even when they are quiet: they were picked on purpose. */
  readonly focusedOverview = computed(() => {
    const userId = this.focusedUserId();
    return userId ? this.overviews().find((item) => item.person.userId === userId) ?? null : null;
  });

  /** Everyone with a panel or a quiet row, in panel order, for the person strip. */
  readonly stripPeople = computed(() => this.overviews().map((item) => item.person));

  personChipLabel(name: string, focused: boolean): string {
    return focused
      ? $localize`:Button on the Team overview person strip; shows every teammate again:Show everyone instead of ${name}:person:`
      : $localize`:Button on the Team overview person strip; shows only this teammate and their Up next:Show only ${name}:person:`;
  }

  private isQuiet(item: PersonOverview): boolean {
    return item.open === 0 && item.done === 0 && item.recent.length === 0 && !item.upNext?.total;
  }

  readonly collapseAllLabel = $localize`:Team overview panel button folding every section in every panel:Collapse all sections`;
  readonly expandAllLabel = $localize`:Team overview panel button unfolding every section in every panel:Expand all sections`;

  openCardsLabel(name: string): string {
    return $localize`:Button opening one teammate's cards:Open ${name}:person:’s cards`;
  }

  isDocked(userId: string): boolean {
    return this.upNextOpen() && this.focusedUserId() === userId;
  }

  upNextActionLabel(name: string, open: boolean): string {
    if (!open && !this.canNavigate()) return $localize`:Tooltip, open the Up next panel:Open Up next`;
    return open
      ? $localize`:Button closing the Up next panel for one teammate:Close Up next for ${name}:person:`
      : $localize`:Button opening the Up next panel to change one teammate's queue:Edit Up next for ${name}:person:`;
  }

  cardsGroupLabel(name: string): string {
    return $localize`:Group of one teammate's card counts:${name}:person:’s cards`;
  }

  lastActiveLabel(item: PersonOverview): string {
    if (this.activityLoading() && this.events().length === 0) return $localize`:Team overview person header:Loading activity…`;
    return item.lastActiveAt
      ? $localize`:Team overview person header, e.g. "Active 2h ago":Active ${formatRelativeTime(item.lastActiveAt, { now: new Date(this.clock.now()) })}:time:`
      : $localize`:Team overview person header:No activity in ${OVERVIEW_ACTIVITY_DAYS}:days: days`;
  }

  /** Just the verb: the row's context line already names the list the card is in now. */
  private verbFor(event: Exclude<WorkDoneEvent, { type: "completed" }>): TouchVerb {
    return event.type === "checklistItemCompleted" ? "ticked" : event.type;
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
      time: this.boardsById().get(card.boardId)?.inProgressEnabled === false ? null : timeInProgressChip(card, nowMs, this.alertDaysFor(card), this.timeZoneByWorkspace().get(card.workspaceId)),
      due: withDue && card.dueDateLocalDate
        ? { text: formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) ?? "", tone: dueTone(card) }
        : null,
      blocked: blockedChipLabel(card),
      note,
    };
  }

  private async loadUnowned(): Promise<void> {
    const seq = ++this.unownedSeq;
    const filters = this.filters();
    try {
      const { response, cachedAt } = await this.queries.read<WorkQueryResponse>({ url: "/work/cards/query", body: {
        // The portfolio lens is the one that does not require an assignee; scope, search and the
        // page's other filters still apply, like the rest of the overview's card sections.
        lens: "portfolio",
        scope: this.scope() ?? undefined,
        filters: { ...(filters ?? {}), assigneeIds: [], unassignedOnly: true, inProgressOnly: true },
        sort: "inProgressAsc",
        limit: UNOWNED_LIMIT,
        includeMetadata: true,
      } });
      if (seq !== this.unownedSeq) return;
      this.unownedCachedAt.set(cachedAt);
      this.unownedError.set(false);
      this.unowned.set({ cards: response.cards.map((card) => expandCardSummary(card)), total: response.totals.cards });
    } catch {
      if (seq === this.unownedSeq) {
        this.unowned.set(null);
        this.unownedCachedAt.set(null);
        this.unownedError.set(true);
      }
    }
  }

  private async loadActivity(): Promise<void> {
    const seq = ++this.loadSeq;
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
      // Overview is a rolling window: offline, show its last update even after midnight.
      // Explicit date ranges in Work done keep their own exact-query snapshots.
      const { response, cachedAt } = await this.queries.read<WorkDoneResponse>({
        url: "/work/work-done/query",
        body: { ...body, from: undefined, to: undefined, windowDays: OVERVIEW_ACTIVITY_DAYS },
      }, () => this.api.post<WorkDoneResponse>("/work/work-done/query", body));
      if (seq !== this.loadSeq) return;
      this.events.set(response.events ?? []);
      this.activityCachedAt.set(cachedAt);
      this.loadedKey = key;
    } catch {
      if (seq === this.loadSeq && !refreshing) {
        this.activityError.set($localize`:Team overview error:Recent activity couldn’t be loaded, so “Recently active” and “Recently done” are empty.`);
      }
    } finally {
      if (seq === this.loadSeq) this.activityLoading.set(false);
    }
  }
}

/** Each verb is a whole message, so word order can change with the language. */
function touchNote(verb: TouchVerb, time: string): string {
  switch (verb) {
    case "moved": return $localize`:Overview row note, e.g. "Moved 2h ago":Moved ${time}:time:`;
    case "created": return $localize`:Overview row note, e.g. "Created 2h ago":Created ${time}:time:`;
    case "ticked": return $localize`:Overview row note, a checklist item was ticked, e.g. "Ticked item 2h ago":Ticked item ${time}:time:`;
  }
}

function dueTone(card: WireCardSummary): DueTone {
  if (isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone)) return "overdue";
  return isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) ? "soon" : "muted";
}
