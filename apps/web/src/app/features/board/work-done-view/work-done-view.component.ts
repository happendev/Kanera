import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import type {
  WorkDoneDaySummary,
  WorkDoneEvent,
  WorkDoneEventType,
  WorkDoneResponse,
  WorkDoneSummaryResponse,
  WorkFilters,
  WorkScope,
} from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import type { WorkViewLens } from "@kanera/shared/schema";
import { ApiClient } from "../../../core/api/api.client";
import { ActivityStripComponent, type ActivityStripSeries } from "../../../shared/activity-strip.component";
import { StatusToastComponent } from "../../../shared/status-toast.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { addDays, localDateKey, startOfLocalDay, viewerTimeZone } from "../../../shared/day-key.util";
import { mediaQuerySignal } from "../../../shared/media-query.signal";
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
import { readWorkDonePreferences, updateWorkDonePreferences } from "./work-done-preferences";
import type { CardDayDigest, WorkDoneDay, WorkDoneLayout, WorkDoneRangePreset } from "./work-done.types";

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

/** Days covered by each preset, counting the current day as one. */
const PRESET_DAYS: Record<Exclude<WorkDoneRangePreset, "custom">, number> = {
  today: 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

/** Labelled, not icon-only: "7d" is already as short as an icon and far clearer than one. */
const PRESET_OPTIONS: SegmentedOption<Exclude<WorkDoneRangePreset, "custom">>[] = [
  { id: "today", label: "Today", tooltip: "Today only" },
  { id: "7d", label: "7d", tooltip: "Last 7 days" },
  { id: "14d", label: "14d", tooltip: "Last 14 days" },
  { id: "30d", label: "30d", tooltip: "Last 30 days" },
];

const EVENT_TYPE_SERIES: Record<WorkDoneEventType, Omit<ActivityStripSeries, "counts">> = {
  created: { key: "created", label: "Created", noun: "created card", tone: "accent" },
  moved: { key: "moved", label: "Card movement", noun: "move", tone: "accent" },
  completed: { key: "completed", label: "Completed", noun: "completion", tone: "success" },
  checklistItemCompleted: {
    key: "checklistItemCompleted",
    label: "Checklist items",
    noun: "checklist completion",
    tone: "success",
  },
};

function toDateInputValue(date: Date): string {
  return localDateKey(date);
}

@Component({
  selector: "k-work-done-view",
  standalone: true,
  imports: [
    ActivityStripComponent,
    DateRangePickerPopover,
    SegmentedComponent,
    StatusToastComponent,
    TooltipDirective,
    WorkDoneDayComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./work-done-view.component.html",
  styleUrl: "./work-done-view.component.scss",
})
export class WorkDoneViewComponent {
  private readonly api = inject(ApiClient);
  // The board and global-work hosts provide BoardState in this view's DI scope, so
  // label/custom-field filters resolve against the same workspace catalogs the live board cards use.
  private readonly state = inject(BoardState, { optional: true });

  readonly scope = input.required<"board" | "global">();
  readonly boardId = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  readonly globalLens = input<Exclude<WorkViewLens, "portfolio"> | null>(null);
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
  readonly boardSummariesById = input<Map<string, WorkDoneBoardSummary> | null>(null);
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

  readonly cardOpened = output<string>();
  readonly cardSummaryOpened = output<WireCardSummary>();
  readonly hostCollapsedDayKeysChange = output<string[]>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly rangePickerOpen = signal(false);
  readonly copied = signal(false);
  private readonly events = signal<WorkDoneEvent[]>([]);
  private readonly stripDays = signal<WorkDoneDaySummary[]>([]);
  private readonly localCollapsedDayKeys = signal<ReadonlySet<string>>(new Set());
  private readonly collapsedDayKeys = computed(() => {
    const hosted = this.hostCollapsedDayKeys();
    return hosted === null ? this.localCollapsedDayKeys() : new Set(hosted);
  });
  private loadSeq = 0;
  private stripSeq = 0;

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
    // Restore remembered preferences once the scope input is available.
    effect(() => {
      const prefs = readWorkDonePreferences(this.scope());
      if (prefs.preset && prefs.preset !== "custom") this.applyPreset(prefs.preset, false);
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
    const parts = [`${this.eventCount()} ${this.eventCount() === 1 ? "event" : "events"}`];
    if (this.completedCount()) parts.push(`${this.completedCount()} completed`);
    if (this.peopleCount() > 1) parts.push(`${this.peopleCount()} people`);
    return parts.join(" · ");
  });

  readonly rangeLabel = computed(() => {
    const from = this.from();
    const to = this.to();
    if (from.getTime() === to.getTime()) {
      if (to.getTime() === this.today.getTime()) return "Today";
      if (to.getTime() === addDays(this.today, -1).getTime()) return "Yesterday";
      return to.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    }
    const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
    const fromLabel = from.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
    const toLabel = to.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return `${fromLabel} – ${toLabel}`;
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
    if (this.hasActiveFilters()) return "No matching work done";
    return this.from().getTime() === this.to().getTime()
      ? `No work done ${this.rangeLabel().toLowerCase()}`
      : "No work done in this period";
  });

  readonly emptyDescription = computed(() => {
    if (this.eventTypeFilter() !== null) return "Try another activity type, adjusting filters, or widening the period.";
    if (this.hasActiveFilters()) return "Try adjusting search or filters, or widening the period.";
    return "Cards created, moved, or marked complete, plus checklist items completed, will appear here.";
  });

  /**
   * Custom-field conditions are the one filter the aggregate cannot express, so when they are active
   * the strip is knowingly wider than the timeline. Say so in its heading rather than letting the
   * numbers quietly disagree.
   */
  readonly stripHeading = computed(() => {
    const selected = this.eventTypeFilter();
    const heading = selected === null ? "Activity" : `Activity · ${EVENT_TYPE_SERIES[selected].label}`;
    return this.filterCfConditions().length ? `${heading} · before field filters` : heading;
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
    this.from.set(addDays(today, -(PRESET_DAYS[preset] - 1)));
    if (persist) this.persistPrefs();
  }

  /** Shifts the whole period, clamped to the queryable window. */
  shiftRange(direction: -1 | 1) {
    const length = this.rangeLengthDays();
    let from = addDays(this.from(), direction * length);
    let to = addDays(this.to(), direction * length);
    if (from.getTime() < this.minDay.getTime()) {
      from = this.minDay;
      to = addDays(from, length - 1);
    }
    if (to.getTime() > this.today.getTime()) {
      to = this.today;
      from = addDays(to, -(length - 1));
    }
    this.preset.set("custom");
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
    updateWorkDonePreferences(this.scope(), { preset: this.preset() });
  }

  openDigest(digest: CardDayDigest) {
    this.cardSummaryOpened.emit(digest.card);
    this.cardOpened.emit(digest.cardId);
  }

  async copyDay(day: WorkDoneDay) {
    await this.copyText(buildStandupText(day, this.boardNames()));
  }

  async copyRange() {
    await this.copyText(buildRangeStandupText(this.days(), this.boardNames()));
  }

  private async copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      window.setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set("Could not copy to the clipboard.");
    }
  }

  private async load() {
    const request = this.request();
    if (!request) {
      this.events.set([]);
      this.error.set(null);
      this.loading.set(false);
      return;
    }
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = request.body
        ? await this.api.post<WorkDoneResponse>(request.url, request.body)
        : await this.api.get<WorkDoneResponse>(request.url);
      if (seq !== this.loadSeq) return;
      this.events.set(response.events ?? []);
    } catch {
      if (seq === this.loadSeq) this.error.set("Work history could not be loaded.");
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
      const response = request.body
        ? await this.api.post<WorkDoneSummaryResponse>(request.url, request.body)
        : await this.api.get<WorkDoneSummaryResponse>(request.url);
      if (seq !== this.stripSeq) return;
      this.stripDays.set(response.days ?? []);
    } catch {
      // The strip is a navigation aid, not the content: a failure leaves it on the range's own
      // counts rather than surfacing an error over the timeline.
      if (seq === this.stripSeq) this.stripDays.set([]);
    }
  }

  /**
   * Builds the events or summary request for the current scope.
   *
   * The summary variant always covers the fixed strip window rather than the visible range, and adds
   * `/summary` to the REST paths or `/summary/query` for the global POST.
   */
  private request(opts: { summary?: boolean } = {}): { url: string; body?: object } | null {
    const today = startOfLocalDay(new Date());
    const rangeFrom = opts.summary ? addDays(today, -(STRIP_WINDOW_DAYS - 1)) : this.from();
    const rangeTo = opts.summary ? today : this.to();
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
