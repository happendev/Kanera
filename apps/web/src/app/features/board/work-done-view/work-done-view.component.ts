import { GettingStartedService } from "../../../core/getting-started/getting-started.service";
import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import type {
  WorkDoneDaySummary,
  WorkDoneEvent,
  WorkDoneEventType,
  WorkDoneResponse,
  WorkDoneSummaryResponse,
  WorkFilters,
  WorkScope,
} from "@kanera/shared/dto";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import type { WorkViewLens } from "@kanera/shared/schema";
import { DEFAULT_IN_PROGRESS_ALERT_DAYS, DEFAULT_INACTIVE_CARDS_DAYS } from "@kanera/shared/workspace-defaults";
import { CachedViewService } from "../../../core/offline/cached-view.service";
import { ActivityStripComponent, type ActivityStripSeries } from "../../../shared/activity-strip.component";
import { ToastService } from "../../../shared/toast.service";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { addDays, localDateKey, startOfLocalDay, viewerTimeZone } from "../../../shared/day-key.util";
import { mediaQuerySignal } from "../../../shared/media-query.signal";
import { MinuteClockService } from "../../../shared/minute-clock.service";
import { startOfWeek, weekdayIndex } from "../../../shared/week-start";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { DateRangePickerPopover } from "../../completed-cards/date-range-picker.popover";
import type { CardLabelPresentation } from "../card-labels.component";
import { BoardState } from "../board-state";
import { matchesCfConditions } from "../table-view/filter.util";
import type { CfFilterCondition } from "../table-view/filter.types";
import type { AnyCustomField } from "../table-view/table-view.types";
import {
  actorUserIdFor,
  buildRangeStandupText,
  buildStandupText,
  countsByDay,
  groupIntoDays,
} from "./work-done-grouping";
import { WorkDoneDayComponent, type WorkDoneBoardSummary } from "./work-done-day.component";
import { buildReportText, buildWorkDoneReport, type WorkDoneReportField, type WorkDoneReportSource } from "./work-done-report";
import { WorkDoneReportComponent } from "./work-done-report.component";
import { readWorkDonePreferences, updateWorkDonePreferences } from "./work-done-preferences";
import type { CardDayDigest, WorkDoneDay, WorkDoneLayout, WorkDoneRangePreset } from "./work-done.types";
import { formatDate, formatDateRange, formatRelativeTime } from "../../../shared/date-format";
import { icu } from "../../../core/i18n/icu";

type WorkDoneList = {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
};

/** Furthest back the historical view may look — mirrors the server-side cap. */
const MAX_DAYS_BACK = 60;
/** Number of placeholder rows shown while the timeline loads. */
const SKELETON_ROW_COUNT = 6;

/**
 * Length of the activity strip window. Wider than any range preset on purpose — the strip's job is to
 * show where the busy days are so you can navigate to them, which needs more history than you are
 * currently reading. Kept under MAX_DAYS_BACK so the request is always inside the server's cap.
 */
const STRIP_WINDOW_DAYS = 56;

/**
 * Rendered strip window on narrow viewports. 56 halves cleanly to 28, so both are whole weeks and the
 * Monday markers stay put. The request always fetches the full window (see `request`), so widening the
 * viewport fills the extra columns in without a refetch.
 */
const STRIP_WINDOW_DAYS_NARROW = 28;

/** Where the strip stacks its rows — see the matching breakpoint in activity-strip.component.scss. */
const NARROW_STRIP_QUERY = "(max-width: 640px)";

/** Days covered by each fixed-length preset, counting the current day as one. `week` is calendar-based. */
const PRESET_DAYS: Record<Exclude<WorkDoneRangePreset, "custom" | "week">, number> = {
  today: 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

/** First day of a preset's range, given today. */
function presetStart(preset: Exclude<WorkDoneRangePreset, "custom">, today: Date): Date {
  // The working week as every calendar grid in the app draws it: Monday through today.
  if (preset === "week") return startOfWeek(today);
  return addDays(today, -(PRESET_DAYS[preset] - 1));
}

/** Labelled, not icon-only: "7d" is already as short as an icon and far clearer than one. */
const PRESET_OPTIONS: SegmentedOption<Exclude<WorkDoneRangePreset, "custom">>[] = [
  { id: "today", label: $localize`:Work done period preset - today:Today`, tooltip: $localize`:Work done period preset tooltip:Today only` },
  { id: "week", label: $localize`:Work done period preset - the current working week:Week`, tooltip: $localize`:Work done period preset tooltip:This week, Monday to today` },
  { id: "7d", label: $localize`:Work done period preset - abbreviation for 7 days:7d`, tooltip: $localize`:Work done period preset tooltip:Last 7 days` },
  { id: "14d", label: $localize`:Work done period preset - abbreviation for 14 days:14d`, tooltip: $localize`:Work done period preset tooltip:Last 14 days` },
  { id: "30d", label: $localize`:Work done period preset - abbreviation for 30 days:30d`, tooltip: $localize`:Work done period preset tooltip:Last 30 days` },
];

const EVENT_TYPE_SERIES: Record<WorkDoneEventType, Omit<ActivityStripSeries, "counts">> = {
  // `noun` is the strip's English fallback only; `countLabel` is what renders.
  created: {
    key: "created",
    label: $localize`:Activity strip series - cards created:Created`,
    noun: "created card",
    countLabel: (count) => icu($localize`:Activity strip day tooltip:{count, plural, one {# created card} other {# created cards}}`, { count }),
    tone: "accent",
  },
  moved: {
    key: "moved",
    label: $localize`:Activity strip series - cards moved between lists:Card movement`,
    noun: "move",
    countLabel: (count) => icu($localize`:Activity strip day tooltip - card moves:{count, plural, one {# move} other {# moves}}`, { count }),
    tone: "accent",
  },
  completed: {
    key: "completed",
    label: $localize`:Activity strip series - cards completed:Completed`,
    noun: "completion",
    countLabel: (count) => icu($localize`:Activity strip day tooltip:{count, plural, one {# completion} other {# completions}}`, { count }),
    tone: "success",
  },
  checklistItemCompleted: {
    key: "checklistItemCompleted",
    label: $localize`:Activity strip series - checklist items ticked:Checklist items`,
    noun: "checklist completion",
    countLabel: (count) => icu($localize`:Activity strip day tooltip:{count, plural, one {# checklist completion} other {# checklist completions}}`, { count }),
    tone: "success",
  },
};

function toDateInputValue(date: Date): string {
  return localDateKey(date);
}

@Component({
  selector: "k-work-done-view",
  standalone: true,
  imports: [EmptyStateComponent,
    ActivityStripComponent,
    DateRangePickerPopover,
    SegmentedComponent,
    TooltipDirective,
    WorkDoneDayComponent,
    WorkDoneReportComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./work-done-view.component.html",
  styleUrl: "./work-done-view.component.scss",
})
export class WorkDoneViewComponent {
  private readonly queries = inject(CachedViewService);
  readonly cachedAt = signal<string | null>(null);
  readonly offlineCopyLabel = computed(() => {
    const time = this.cachedAt();
    return time ? $localize`:Dependencies view note; a relative time such as "5 minutes ago" follows:Offline copy from ${formatRelativeTime(time)}:time:` : "";
  });
  private readonly toasts = inject(ToastService);
  // The board and global-work hosts provide BoardState in this view's DI scope, so
  // label/custom-field filters resolve against the same workspace catalogs the live board cards use.
  private readonly state = inject(BoardState, { optional: true });
  private readonly gettingStarted = inject(GettingStartedService);
  private readonly clock = inject(MinuteClockService);

  readonly scope = input.required<"board" | "global">();
  readonly boardId = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  readonly globalLens = input<WorkViewLens | null>(null);
  readonly globalScope = input<WorkScope | null>(null);
  readonly globalFilters = input<WorkFilters | null>(null);
  readonly catalogCustomFields = input<AnyCustomField[]>([]);
  /** Cross-board filters supplied by Global Work; ignored in board scope. */
  readonly boardFilterIds = input<string[]>([]);
  readonly lists = input.required<WorkDoneList[]>();
  /**
   * Label catalog for hosts that do not hydrate BoardState — the global page provides a bare
   * BoardState for its shared child components but loads its own cross-workspace catalog, so without
   * this its rows would silently drop every label chip.
   */
  readonly catalogLabels = input<CardLabelPresentation[]>([]);
  readonly selectedCardId = input<string | null>(null);
  /** Cross-board scope passes board summaries so rows show their board badge. */
  readonly inProgressEnabled = computed(() => this.scope() !== "board" || this.state?.inProgressEnabled() !== false);
  readonly boardSummariesById = input<Map<string, WorkDoneBoardSummary> | null>(null);
  /** Each workspace's time zone, whose working hours a card's tracked time counts. */
  readonly timeZonesByWorkspace = input<ReadonlyMap<string, string> | null>(null);
  readonly searchQuery = input("");
  readonly filterLabelIds = input<string[]>([]);
  readonly filterMemberIds = input<string[]>([]);
  readonly filterListIds = input<string[]>([]);
  readonly filterCfConditions = input<CfFilterCondition[]>([]);
  /** Host-owned activity-type filter from the page's shared Filter panel; null means all activity. */
  readonly eventTypeFilter = input<WorkDoneEventType | null>(null);
  /** Host-owned presentation toggle beside the page search field. */
  readonly layout = input<WorkDoneLayout>("list");
  readonly refreshVersion = input(0);
  /** Optional host-owned day folds; board History keeps its existing transient local state. */
  readonly hostCollapsedDayKeys = input<readonly string[] | null>(null);
  /**
   * The report's "right now" inputs from a host that has no hydrated BoardState: Global Work passes
   * its cross-board cards, lists, boards, people and per-workspace thresholds here. Board scope leaves
   * it null and reads BoardState. Without either, the Report layout has nothing to draw and falls
   * back to the list.
   */
  readonly reportSource = input<WorkDoneReportSource | null>(null);

  readonly cardOpened = output<string>();
  readonly cardSummaryOpened = output<WireCardSummary>();
  readonly hostCollapsedDayKeysChange = output<string[]>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly rangePickerOpen = signal(false);
  private readonly events = signal<WorkDoneEvent[]>([]);
  private readonly stripDays = signal<WorkDoneDaySummary[]>([]);
  /**
   * Per-day counts for the period of the same length just before the visible one; the report's
   * deltas. Null until loaded, when the layout is not Report, or when that period reaches back past
   * the server's window, in which case the report simply shows no comparison.
   */
  private readonly previousDays = signal<WorkDoneDaySummary[] | null>(null);
  /** The first timeline response has landed, so an empty report means "quiet", not "still loading". */
  private readonly loadedOnce = signal(false);
  private readonly localCollapsedDayKeys = signal<ReadonlySet<string>>(new Set());
  private readonly collapsedDayKeys = computed(() => {
    const hosted = this.hostCollapsedDayKeys();
    return hosted === null ? this.localCollapsedDayKeys() : new Set(hosted);
  });
  private loadSeq = 0;
  private loadedRequestKey: string | null = null;
  private stripSeq = 0;
  private previousSeq = 0;

  readonly skeletonRows = Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => index);
  readonly presetOptions = PRESET_OPTIONS;
  // Narrow viewports show half the window: 56 columns inside a phone-width panel are a couple of
  // pixels each, which is neither readable nor tappable.
  private readonly narrowStrip = mediaQuerySignal(NARROW_STRIP_QUERY);
  readonly stripWindowDays = computed(() => (this.narrowStrip() ? STRIP_WINDOW_DAYS_NARROW : STRIP_WINDOW_DAYS));

  private readonly today = startOfLocalDay(new Date());
  private readonly minDay = addDays(this.today, -(MAX_DAYS_BACK - 1));
  readonly minInputValue = toDateInputValue(this.minDay);
  readonly maxInputValue = toDateInputValue(this.today);

  // Inclusive local-day range. `preset` is remembered per scope; a custom range comes from the picker.
  readonly preset = signal<WorkDoneRangePreset>("7d");
  readonly from = signal<Date>(addDays(startOfLocalDay(new Date()), -(PRESET_DAYS["7d"] - 1)));
  readonly to = signal<Date>(startOfLocalDay(new Date()));

  constructor() {
    // Boards and My Cards both render this view, so it ticks the "View Work done" step for either.
    this.gettingStarted.noteUsed("viewWorkDone");
    // Restore the remembered period for the active layout. The report defaults to the working week
    // (what a coordinator reports on), the timeline to the last 7 days; each remembers its own choice.
    effect(() => {
      const prefs = readWorkDonePreferences(this.scope());
      const preset = this.layout() === "report" ? (prefs.reportPreset ?? "week") : (prefs.preset ?? "7d");
      if (preset !== "custom") untracked(() => this.applyPreset(preset, false));
    });

    effect(() => {
      // The comparison period moves with the visible range, but only the report reads it.
      this.layout();
      this.from();
      this.to();
      this.boardId();
      this.globalLens();
      this.globalScope();
      this.globalFilters();
      this.searchQuery();
      this.filterListIds();
      this.filterLabelIds();
      this.filterMemberIds();
      this.refreshVersion();
      this.queries.online();
      void this.loadPreviousPeriod();
    });

    effect(() => {
      // Re-fetch whenever the range or the scope inputs change.
      this.from();
      this.to();
      this.scope();
      this.boardId();
      this.globalLens();
      this.globalScope();
      this.globalFilters();
      this.boardFilterIds();
      this.searchQuery();
      this.refreshVersion();
      this.queries.online();
      void this.load();
    });

    effect(() => {
      // The strip's window is fixed, so it only reloads when the scope or filters change — not when
      // the visible range moves within it.
      this.scope();
      this.boardId();
      this.globalLens();
      this.globalScope();
      this.globalFilters();
      this.boardFilterIds();
      this.searchQuery();
      this.refreshVersion();
      this.queries.online();
      void this.loadStrip();
    });
  }

  readonly customFields = computed(() => this.state?.customFields() ?? this.catalogCustomFields());

  private readonly listById = computed(() => {
    const map = new Map<string, { name: string; icon: string | null; color: string | null }>();
    for (const list of this.lists()) map.set(list.id, { name: list.name, icon: list.icon, color: list.color });
    return map;
  });

  /** Label catalog for row chips, from whichever host provided one. */
  readonly labelsById = computed(() => {
    const catalog = this.catalogLabels();
    const labels: CardLabelPresentation[] = catalog.length
      ? catalog
      : (this.state?.cardLabels() ?? []).map((label) => ({ id: label.id, name: label.name, color: label.color }));
    return new Map<string, CardLabelPresentation>(labels.map((label) => [label.id, label]));
  });

  private readonly boardNames = computed(() => {
    const summaries = this.boardSummariesById();
    return summaries ? new Map([...summaries].map(([id, board]) => [id, board.name])) : new Map<string, string>();
  });

  // Label and custom-field filters apply to each event's card; the member filter matches the event's
  // actor (the card actor, or the checklist completer). Activity type is deliberately local: the
  // bounded timeline is already loaded, so switching it should be instant and require no refetch.
  readonly filteredEvents = computed(() => {
    const eventType = this.eventTypeFilter();
    const labelIds = this.filterLabelIds();
    const boardIds = this.boardFilterIds();
    const memberIds = this.filterMemberIds();
    const listIds = this.filterListIds();
    const conditions = this.filterCfConditions();
    if (eventType === null && !boardIds.length && !labelIds.length && !memberIds.length && !listIds.length && !conditions.length) return this.events();

    const boardFilterIds = new Set(boardIds);
    const labelFilterIds = new Set(labelIds);
    const memberFilterIds = new Set(memberIds);
    const listFilterIds = new Set(listIds);
    // Reuse the shared predicate so History-view CF filtering matches the board exactly.
    const fieldsById = conditions.length ? new Map(this.customFields().map((field) => [field.id, field])) : null;

    return this.events().filter((event) => {
      if (eventType !== null && event.type !== eventType) return false;
      if (boardFilterIds.size && !boardFilterIds.has(event.boardId)) return false;
      if (labelIds.length && !event.card.labelIds.some((id) => labelFilterIds.has(id))) return false;
      if (listFilterIds.size && !listFilterIds.has(event.card.listId)) return false;
      if (memberIds.length) {
        const actorId = actorUserIdFor(event);
        if (!actorId || !memberFilterIds.has(actorId)) return false;
      }
      if (fieldsById) {
        const valuesByCard = new Map([[event.card.id, new Map(event.card.customFieldValues.map((v) => [v.fieldId, v]))]]);
        if (!matchesCfConditions(event.card.id, conditions, fieldsById, valuesByCard)) return false;
      }
      return true;
    });
  });

  readonly days = computed(() => groupIntoDays(this.filteredEvents(), this.listById(), this.today));

  readonly eventCount = computed(() => this.filteredEvents().length);
  // Distinct cards across the range: rows are per card *and* person, so summing digests would
  // double-count a card several people worked on.
  readonly cardCount = computed(() => {
    const seen = new Set<string>();
    for (const day of this.days()) for (const digest of day.digests) seen.add(digest.cardId);
    return seen.size;
  });
  readonly completedCount = computed(() => this.days().reduce((sum, day) => sum + day.counts.completed, 0));
  readonly peopleCount = computed(() => {
    const seen = new Set<string>();
    for (const day of this.days()) for (const actor of day.actors) seen.add(actor.userId ?? `name:${actor.name}`);
    return seen.size;
  });

  readonly summaryParts = computed(() => {
    const parts = [icu($localize`:Work done summary - number of events:{count, plural, one {# event} other {# events}}`, { count: this.eventCount() })];
    if (this.completedCount()) {
      parts.push(icu($localize`:Work done summary - number of cards completed:{count, plural, one {# completed} other {# completed}}`, { count: this.completedCount() }));
    }
    if (this.peopleCount() > 1) {
      parts.push(icu($localize`:Work done summary - number of people:{count, plural, one {# person} other {# people}}`, { count: this.peopleCount() }));
    }
    return parts.join(" · ");
  });

  readonly rangeLabel = computed(() => {
    const from = this.from();
    const to = this.to();
    if (from.getTime() === to.getTime()) {
      if (to.getTime() === this.today.getTime()) return $localize`:Work done period label:Today`;
      if (to.getTime() === addDays(this.today, -1).getTime()) return $localize`:Work done period label:Yesterday`;
      return formatDate(to, "long");
    }
    return formatDateRange(from, to);
  });

  readonly fromInputValue = computed(() => toDateInputValue(this.from()));
  readonly toInputValue = computed(() => toDateInputValue(this.to()));

  /** Whole-period paging: shifting keeps the range length, so the comparison stays like-for-like. */
  private readonly rangeLengthDays = computed(() =>
    Math.round((this.to().getTime() - this.from().getTime()) / (24 * 60 * 60 * 1000)) + 1
  );

  readonly canGoPrev = computed(() => addDays(this.from(), -1).getTime() >= this.minDay.getTime());
  readonly canGoNext = computed(() => this.to().getTime() < this.today.getTime());

  readonly hasActiveFilters = computed(() =>
    this.eventTypeFilter() !== null
    || Boolean(this.searchQuery().trim())
    || this.boardFilterIds().length > 0
    || this.filterLabelIds().length > 0
    || this.filterMemberIds().length > 0
    || this.filterListIds().length > 0
    || this.filterCfConditions().length > 0
  );

  readonly emptyTitle = computed(() => {
    if (this.hasActiveFilters()) return $localize`:Work done empty state title:No matching work done`;
    if (this.from().getTime() !== this.to().getTime()) return $localize`:Work done empty state title:No work done in this period`;
    // One message per case rather than lower-casing the period label into a sentence: "today" is a
    // word in the sentence, while a date keeps its own capitalisation in every language.
    const day = this.to().getTime();
    if (day === this.today.getTime()) return $localize`:Work done empty state title:No work done today`;
    if (day === addDays(this.today, -1).getTime()) return $localize`:Work done empty state title:No work done yesterday`;
    return $localize`:Work done empty state title for a past day:No work done ${formatDate(this.to(), "long")}:date:`;
  });

  readonly emptyDescription = computed(() => {
    if (this.eventTypeFilter() !== null) return $localize`:Work done empty state hint:Try another activity type, adjusting filters, or widening the period.`;
    if (this.hasActiveFilters()) return $localize`:Work done empty state hint:Try adjusting search or filters, or widening the period.`;
    return $localize`:Work done empty state hint:Cards created, moved, or marked complete, plus checklist items completed, will appear here.`;
  });

  /**
   * Custom-field conditions are the one filter the aggregate cannot express, so when they are active
   * the strip is knowingly wider than the timeline. Say so in its heading rather than letting the
   * numbers quietly disagree.
   */
  readonly stripHeading = computed(() => {
    const selected = this.eventTypeFilter();
    const heading = selected === null
      ? $localize`:Activity strip heading:Activity`
      : $localize`:Activity strip heading for one activity type:Activity · ${EVENT_TYPE_SERIES[selected].label}:activityType:`;
    return this.filterCfConditions().length
      ? $localize`:Activity strip heading - the counts ignore custom-field filters:${heading}:heading: · before field filters`
      : heading;
  });

  /** Movement and completion series for the strip, over the fixed strip window. */
  readonly activitySeries = computed<ActivityStripSeries[]>(() => {
    const days = this.stripDays();
    // Fall back to the loaded range's own counts until the strip request lands, so the panel is never
    // an empty grey block on first paint.
    const fallback = this.days();
    const counts = (metric: WorkDoneEventType) =>
      days.length
        ? new Map(days.map((day) => [day.date, day[metric]]))
        : countsByDay(fallback, metric);
    const selected = this.eventTypeFilter();
    // The unfiltered strip keeps its established movement/completion comparison. Once a type is
    // selected, the same control becomes a focused history navigator for that exact event type.
    const types: WorkDoneEventType[] = selected === null ? ["moved", "completed"] : [selected];
    return types.map((type) => ({ ...EVENT_TYPE_SERIES[type], counts: counts(type) }));
  });

  /**
   * Select fields with their options, for the report's per-option breakdowns. Only wire fields carry
   * options; a bare schema row (never the board page's case) contributes nothing.
   */
  private readonly reportSelectFields = computed<WorkDoneReportField[]>(() =>
    this.customFields()
      .filter((field) => field.type === "select" && !field.archivedAt && "options" in field)
      .map((field) => ({
        id: field.id,
        name: field.name,
        icon: field.icon,
        options: ("options" in field ? field.options : []).map((option) => ({ id: option.id, name: option.label, color: option.color })),
      })),
  );

  /** Whether this host can draw the report at all: the board's own state, or a supplied source. */
  readonly reportAvailable = computed(() => (this.scope() === "board" ? !!this.state : this.reportSource() !== null));

  /**
   * The management report over the loaded period plus the live cards, only while the Report layout
   * is showing, so the timeline never pays for it. Null until the first timeline response, so the
   * report cannot open on "nothing happened" while the events are still in flight.
   *
   * On a board, the page's list, label and member filters narrow the "right now" half too, so a report
   * filtered to one person shows that person's overdue work, not the whole board's. Search text is the
   * one filter applied to events alone: it matches server-side and has no client predicate for live
   * cards. In global scope the host's cards already match its filters server-side, so they pass as is.
   */
  readonly report = computed(() => {
    if (this.layout() !== "report" || !this.loadedOnce()) return null;
    const source = this.scope() === "global" ? this.reportSource() : null;
    if (source) {
      return buildWorkDoneReport({
        from: this.from(),
        to: this.to(),
        today: this.today,
        now: this.clock.now(),
        events: this.filteredEvents(),
        previousDays: this.previousDays(),
        cards: source.cards,
        lists: source.lists,
        boards: source.boards,
        workspaces: source.workspaces,
        viewerUserId: source.viewerUserId,
        members: source.members,
        assigneeIdsByCard: source.assigneeIdsByCard,
        labelIdsByCard: source.labelIdsByCard,
        labelsById: this.labelsById(),
        selectFields: this.reportSelectFields(),
        fieldValuesByCard: source.fieldValuesByCard,
        inProgressEnabled: true,
        inProgressAlertDays: DEFAULT_IN_PROGRESS_ALERT_DAYS,
        inactiveCardsDays: DEFAULT_INACTIVE_CARDS_DAYS,
        timeZone: viewerTimeZone(),
        workspaceSettings: source.workspaceSettings,
      });
    }
    const state = this.state;
    if (!state || this.scope() !== "board") return null;
    const listIds = new Set(this.filterListIds());
    const labelIds = new Set(this.filterLabelIds());
    const memberIds = new Set(this.filterMemberIds());
    const conditions = this.filterCfConditions();
    const labelIdsByCard = state.labelIdsByCard();
    const assigneeIdsByCard = state.assigneeIdsByCard();
    const fieldsById = conditions.length ? new Map(this.customFields().map((field) => [field.id, field])) : null;
    const valuesByCard = fieldsById ? state.customFieldValuesByCardAndField() : null;
    const cards = state.cards().filter((card) => {
      if (listIds.size && !listIds.has(card.listId)) return false;
      if (labelIds.size && !(labelIdsByCard.get(card.id) ?? []).some((id) => labelIds.has(id))) return false;
      if (memberIds.size && !(assigneeIdsByCard.get(card.id) ?? []).some((id) => memberIds.has(id))) return false;
      if (fieldsById && valuesByCard && !matchesCfConditions(card.id, conditions, fieldsById, valuesByCard)) return false;
      return true;
    });
    return buildWorkDoneReport({
      from: this.from(),
      to: this.to(),
      today: this.today,
      now: this.clock.now(),
      events: this.filteredEvents(),
      previousDays: this.previousDays(),
      cards,
      lists: state.visibleLists().map((list) => ({ id: list.id, name: list.name, icon: list.icon, color: list.color, inProgress: list.inProgress })),
      members: state.members(),
      assigneeIdsByCard,
      labelIdsByCard,
      labelsById: this.labelsById(),
      selectFields: this.reportSelectFields(),
      fieldValuesByCard: state.customFieldValuesByCardAndField(),
      inProgressEnabled: this.inProgressEnabled(),
      inProgressAlertDays: state.inProgressAlertDays(),
      inactiveCardsDays: state.inactiveCardsDays(),
      timeZone: state.workspaceTimeZone(),
    });
  });

  readonly reportMembersById = computed<ReadonlyMap<string, WireBoardMemberUser>>(() => {
    const source = this.scope() === "global" ? this.reportSource() : null;
    if (source) return new Map(source.members.map((member) => [member.userId, member]));
    return this.state?.membersById() ?? new Map();
  });

  isDayCollapsed(dateKey: string): boolean {
    return this.collapsedDayKeys().has(dateKey);
  }

  toggleDay(dateKey: string) {
    const next = new Set(this.collapsedDayKeys());
    if (next.has(dateKey)) next.delete(dateKey);
    else next.add(dateKey);
    if (this.hostCollapsedDayKeys() !== null) {
      this.hostCollapsedDayKeysChange.emit([...next]);
      return;
    }
    this.localCollapsedDayKeys.set(next);
  }

  applyPreset(preset: Exclude<WorkDoneRangePreset, "custom">, persist = true) {
    const today = startOfLocalDay(new Date());
    this.preset.set(preset);
    this.to.set(today);
    this.from.set(presetStart(preset, today));
    if (persist) this.persistPrefs();
  }

  /**
   * Shifts the whole period, clamped to the queryable window. A week (the Week preset, or any
   * Monday-to-Sunday range) pages by calendar weeks rather than by its own length, so stepping back
   * from "this week so far" on a Monday lands on all of last week, not on Sunday alone.
   */
  shiftRange(direction: -1 | 1) {
    const weekly = this.preset() === "week" || (weekdayIndex(this.from()) === 0 && this.rangeLengthDays() === 7);
    const length = weekly ? 7 : this.rangeLengthDays();
    let from = addDays(this.from(), direction * length);
    let to = weekly ? addDays(from, 6) : addDays(this.to(), direction * length);
    if (from.getTime() < this.minDay.getTime()) {
      from = this.minDay;
      to = addDays(from, length - 1);
    }
    if (to.getTime() > this.today.getTime()) {
      to = this.today;
      // A week keeps its Monday: forward onto the current week is "this week so far", not the
      // trailing seven days.
      if (!weekly) from = addDays(to, -(length - 1));
    }
    const thisWeek = weekly && from.getTime() === startOfWeek(this.today).getTime();
    this.preset.set(thisWeek ? "week" : "custom");
    this.from.set(from);
    this.to.set(to);
  }

  onRangeApplied(range: { from: string | null; to: string | null }) {
    const from = range.from ? this.parseDayInput(range.from) : null;
    const to = range.to ? this.parseDayInput(range.to) : null;
    if (!from && !to) return;
    // A one-ended selection reads as "that day onwards" / "up to that day" within the window.
    const start = from ?? this.minDay;
    const end = to ?? this.today;
    if (end.getTime() < start.getTime()) return;
    this.preset.set("custom");
    this.from.set(start);
    this.to.set(end);
    this.rangePickerOpen.set(false);
    this.persistPrefs();
  }

  /** Jumping from a strip column narrows the view to that single day. */
  onStripDaySelected(dateKey: string) {
    const day = this.parseDayInput(dateKey);
    if (!day || day.getTime() < this.minDay.getTime() || day.getTime() > this.today.getTime()) return;
    this.preset.set("custom");
    this.from.set(day);
    this.to.set(day);
  }

  private parseDayInput(value: string): Date | null {
    const parts = value.split("-").map((part) => Number(part));
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return null;
    return startOfLocalDay(new Date(parts[0]!, parts[1]! - 1, parts[2]!));
  }

  private persistPrefs(): void {
    updateWorkDonePreferences(this.scope(), this.layout() === "report" ? { reportPreset: this.preset() } : { preset: this.preset() });
  }

  openDigest(digest: CardDayDigest) {
    this.cardSummaryOpened.emit(digest.card);
    this.cardOpened.emit(digest.cardId);
  }

  async copyDay(day: WorkDoneDay) {
    await this.copyText(buildStandupText(day, this.boardNames()));
  }

  async copyRange() {
    const report = this.report();
    if (report) {
      const subject = (this.scope() === "global" ? this.reportSource()?.title : this.state?.board()?.name) ?? "";
      await this.copyText(buildReportText(report, $localize`:Title line of the copied report text, e.g. "Report for Platform Delivery · 14–18 Oct":Report for ${subject}:board: · ${this.rangeLabel()}:range:`));
      return;
    }
    await this.copyText(buildRangeStandupText(this.days(), this.boardNames()));
  }

  private async copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toasts.success($localize`:Toast after copying work done as text:Copied to clipboard.`, "clipboard-check");
    } catch {
      this.error.set($localize`:Error when copying to the clipboard fails:Could not copy to the clipboard.`);
    }
  }

  private async load() {
    const request = this.request();
    const seq = ++this.loadSeq;
    if (!request) {
      this.loadedRequestKey = null;
      this.events.set([]);
      this.error.set(null);
      this.loading.set(false);
      return;
    }
    const requestKey = JSON.stringify(request);
    // Reconnects and realtime echoes refresh the same history query. Keep even an empty result
    // mounted; only a new scope or filter needs a skeleton while its first response is pending.
    const refreshing = this.loadedRequestKey === requestKey;
    this.loading.set(!refreshing);
    if (!refreshing) {
      this.loadedRequestKey = null;
      this.events.set([]);
      this.loadedOnce.set(false);
      this.cachedAt.set(null);
    }
    this.error.set(null);
    try {
      const { response, cachedAt } = await this.queries.read<WorkDoneResponse>(request);
      if (seq !== this.loadSeq) return;
      this.events.set(response.events ?? []);
      this.cachedAt.set(cachedAt);
      this.loadedRequestKey = requestKey;
      this.loadedOnce.set(true);
    } catch {
      // A transient reconnect failure must not replace already-loaded history with an error page.
      if (seq === this.loadSeq && !refreshing) this.error.set($localize`:Error when the work done history fails to load:Work history could not be loaded.`);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  private async loadStrip() {
    const request = this.request({ summary: true });
    if (!request) {
      this.stripDays.set([]);
      return;
    }
    const seq = ++this.stripSeq;
    try {
      const { response } = await this.queries.read<WorkDoneSummaryResponse>(request);
      if (seq !== this.stripSeq) return;
      this.stripDays.set(response.days ?? []);
    } catch {
      // The strip is a navigation aid, not the content: a failure leaves it on the range's own
      // counts rather than surfacing an error over the timeline.
      if (seq === this.stripSeq) this.stripDays.set([]);
    }
  }

  /**
   * The report's comparison: the same-length period ending the day before the visible one. Skipped
   * (and cleared) outside the Report layout, and when the period would start before the server's
   * window — a partial comparison would understate the previous period and overstate every delta.
   */
  private async loadPreviousPeriod() {
    if (this.layout() !== "report" || !this.reportAvailable()) {
      this.previousDays.set(null);
      return;
    }
    const length = this.rangeLengthDays();
    const to = addDays(this.from(), -1);
    const from = addDays(to, -(length - 1));
    const request = from.getTime() >= this.minDay.getTime() ? this.request({ summary: true, range: { from, to } }) : null;
    const seq = ++this.previousSeq;
    if (!request) {
      this.previousDays.set(null);
      return;
    }
    try {
      const { response } = await this.queries.read<WorkDoneSummaryResponse>(request);
      if (seq !== this.previousSeq) return;
      this.previousDays.set(response.days ?? []);
    } catch {
      // No comparison beats a wrong one: the report drops its deltas until the next refresh.
      if (seq === this.previousSeq) this.previousDays.set(null);
    }
  }

  /**
   * Builds the events or summary request for the current scope.
   *
   * The summary variant covers the fixed strip window rather than the visible range (or an explicit
   * `range`, for the report's previous-period comparison), and adds `/summary` to the REST paths or
   * `/summary/query` for the global POST.
   */
  private request(opts: { summary?: boolean; range?: { from: Date; to: Date } } = {}): { url: string; body?: object } | null {
    const today = startOfLocalDay(new Date());
    const rangeFrom = opts.range?.from ?? (opts.summary ? addDays(today, -(STRIP_WINDOW_DAYS - 1)) : this.from());
    const rangeTo = opts.range?.to ?? (opts.summary ? today : this.to());
    const from = rangeFrom.toISOString();
    // Exclusive upper bound: start of the day after the last day in the range.
    const to = addDays(rangeTo, 1).toISOString();
    const timeZone = viewerTimeZone();

    if (this.scope() === "global") {
      const lens = this.globalLens();
      if (!lens) return null;
      return {
        url: opts.summary ? "/work/work-done/summary/query" : "/work/work-done/query",
        body: {
          lens,
          scope: this.globalScope() ?? undefined,
          filters: {
            ...(this.globalFilters() ?? {}),
            q: this.searchQuery().trim() || this.globalFilters()?.q || "",
          },
          from,
          to,
          timeZone,
        },
      };
    }

    const params = new URLSearchParams({ from, to, timeZone });
    const q = this.searchQuery().trim();
    if (q) params.set("q", q);
    // List/label/member filters must go to the server for the summary: an aggregate cannot be narrowed
    // in JS the way the loaded timeline can, so without these the strip would report more work than
    // the rows below it. Sent for the timeline too, which just makes filteredEvents' pass redundant.
    for (const listId of this.filterListIds()) params.append("listIds", listId);
    for (const labelId of this.filterLabelIds()) params.append("labelIds", labelId);
    for (const memberId of this.filterMemberIds()) params.append("actorIds", memberId);
    const suffix = opts.summary ? "/summary" : "";

    const boardId = this.boardId();
    if (!boardId) return null;
    return { url: `/boards/${boardId}/work-done${suffix}?${params.toString()}` };
  }
}
