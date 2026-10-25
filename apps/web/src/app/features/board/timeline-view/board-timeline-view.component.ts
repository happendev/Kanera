import { GettingStartedService } from "../../../core/getting-started/getting-started.service";
import type { OnInit } from "@angular/core";
import { ApplicationRef, ChangeDetectionStrategy, Component, DestroyRef, Injector, ElementRef, afterNextRender, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild } from "@angular/core";
import type { CardRelationSummary, DependencyGraphEdge, ScheduleResponse } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { barDurationDays, computeSchedule, dateKeyOf, dayNumber, endForMovedStart, plannedBar, type Schedule, type ScheduledCard } from "@kanera/shared/schedule";
import { CachedViewService } from "../../../core/offline/cached-view.service";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { APP_DOM_EVENTS } from "../../../core/browser/browser-contracts";
import { hasCoarsePointer } from "../../../core/browser/input-modality";
import { icu } from "../../../core/i18n/icu";
import { SocketService } from "../../../core/realtime/socket.service";
import { DensityService } from "../../../core/theme/density.service";
import { WorkspaceService } from "../../../core/workspace/workspace.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { CardKeyDisplayService } from "../../../shared/card-key-display.service";
import { formatDate, formatDateRange, formatRelativeTime } from "../../../shared/date-format";
import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { FitLabelsDirective } from "../../../shared/fit-labels.directive";
import { ToastService } from "../../../shared/toast.service";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardState } from "../board-state";
import { CardActionsMenuPopover } from "../card-actions-menu.popover";
import type { CardAssigneePresentation } from "../card.component";
import { CardLabelsComponent, type CardLabelPresentation } from "../card-labels.component";
import { openCardDetailInNewTab } from "../card-navigation.util";
import { dueDateSlotFor, isOverdue } from "../due-date.util";
import { boardStateCardStore, TABLE_CARD_STORE, type TableCardStore } from "../table-view/table-card-store";
import type { AnyCard, AnyList } from "../table-view/table-view.types";
import {
  buildTimelineRows,
  clampPxPerDay,
  dayAt,
  DEFAULT_PX_PER_DAY,
  dependencyPath,
  GROUP_ROW_HEIGHT,
  NAME_PANE_WIDTH,
  NAME_PANE_WIDTH_MAX,
  NAME_PANE_WIDTH_MIN,
  NAME_PANE_WIDTH_NARROW,
  MAX_PX_PER_DAY,
  MIN_PX_PER_DAY,
  plannedBars,
  rangeWidth,
  ROW_HEIGHT,
  ROW_HEIGHT_COMPACT,
  ROW_HEIGHT_LABELLED,
  ROW_HEIGHT_LABELLED_COMPACT,
  timelineHeader,
  timelineRange,
  todayKey,
  UNSCHEDULED_GROUP_KEY,
  weekendBands,
  xOf,
  type TimelineBar,
  type TimelineBoardSummary,
  type TimelineCardRow,
  type TimelineGroupByKind,
  type TimelineRow,
} from "./timeline-layout";
import { readTimelinePreference, writeTimelinePreference, type TimelinePreference } from "./timeline-preferences";

/** Below this host width the name pane narrows and bars show no inline text. */
const NARROW_MAX_WIDTH = 640;
/** Pointer travel before a press on a bar counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** One zoom button press, as a factor of pixels per day. */
const ZOOM_STEP = 1.6;
/**
 * Wheel distance to zoom factor: exp(-delta * k). A mouse notch (~100px) zooms by about a fifth;
 * a trackpad pinch, which Chrome and Firefox report as ctrl+wheel with small deltas, follows the
 * fingers.
 */
const WHEEL_ZOOM_RATE = 0.0022;
/** Share of the remaining distance to the zoom target covered each frame: eases in without lag. */
const ZOOM_EASE = 0.3;
/** Space Fit leaves either side of the planned work. */
const FIT_MARGIN_PX = 40;

type DragMode = "move" | "start" | "end";

interface BarDrag {
  cardId: string;
  mode: DragMode;
  originX: number;
  bar: TimelineBar;
  /** Snapped whole-day delta of the pointer from where the press started. */
  dayDelta: number;
  moved: boolean;
}

interface LinkDraft {
  sourceCardId: string;
  /** Chart-relative start of the wire, at the blocker's bar end. */
  x: number;
  y: number;
  /** Chart-relative pointer position. */
  pointerX: number;
  pointerY: number;
  targetCardId: string | null;
}

interface Wire {
  id: string;
  edge: DependencyGraphEdge;
  path: string;
  midX: number;
  midY: number;
  tone: "plain" | "critical" | "risk" | "lit" | "offpath";
}

/**
 * The Timeline (Gantt) view of a board: one row per card, a bar from its start date to its due date,
 * and finish-to-start wires for `blocks` relations. Bars move and resize by dragging, wires are drawn
 * by dragging from a bar's end onto another bar, and the critical path toggle runs the shared
 * scheduling engine (`@kanera/shared/schedule`) over all accessible connected cards; filters only select rendered rows.
 *
 * Cards come from the host's state, so bars follow every realtime card event for free; only the
 * off-board inputs are read here through the schedule endpoint and refreshed from board events.
 *
 * Phones and other coarse pointers do not drag here: a horizontal drag is also how the chart scrolls,
 * and a long-press would fight that for the same gesture. They reschedule from card detail instead,
 * as the calendar's phone layout does.
 */
const EMPTY_LABELS: CardLabelPresentation[] = [];

/**
 * Where the chart's off-host schedule comes from. A board reads its own schedule; a chart over many
 * boards (My Cards, Team Cards) reads each workspace its cards sit in, since dependencies never
 * cross a workspace, so one read per workspace is the complete graph for every card on the chart.
 */
export type TimelineScheduleScope = { boardId: string } | { workspaceIds: readonly string[] };

function scopeKey(scope: TimelineScheduleScope): string {
  return "boardId" in scope ? `board:${scope.boardId}` : `workspaces:${[...scope.workspaceIds].sort().join(",")}`;
}

@Component({
  selector: "k-board-timeline-view",
  standalone: true,
  imports: [AvatarComponent, CardActionsMenuPopover, CardLabelsComponent, EmptyStateComponent, FitLabelsDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-timeline-view.component.html",
  styleUrl: "./board-timeline-view.component.scss",
  host: { "[class.is-narrow]": "narrow()", "[class.is-dragging]": "drag() !== null || linkDraft() !== null", "[class.is-panning]": "panning()" },
})
export class BoardTimelineViewComponent implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly gettingStarted = inject(GettingStartedService);
  private readonly sockets = inject(SocketService);
  private readonly toasts = inject(ToastService);
  private readonly workspaces = inject(WorkspaceService);
  private readonly density = inject(DensityService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  /** Same optimistic seam as the calendar: a board falls back to `BoardState`, tests may provide neither. */
  private readonly cardStore: TableCardStore | null = inject(TABLE_CARD_STORE, { optional: true })
    ?? (() => { const state = inject(BoardState, { optional: true }); return state ? boardStateCardStore(state, this.api) : null; })();

  readonly scope = input.required<TimelineScheduleScope>();
  readonly cards = input.required<AnyCard[]>();
  readonly lists = input<AnyList[]>([]);
  /** Board names for the `board` grouping's headings; a single-board host leaves it unset. */
  readonly boardSummariesById = input<ReadonlyMap<string, TimelineBoardSummary> | null>(null);
  readonly labelsByCard = input<Map<string, CardLabelPresentation[]>>(new Map());
  readonly assigneesByCard = input<Map<string, CardAssigneePresentation[]>>(new Map());
  readonly filteredCardIds = input<Set<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly canEdit = input(true);
  private readonly queries = inject(CachedViewService);
  readonly cachedAt = signal<string | null>(null);
  readonly editingEnabled = computed(() => this.canEdit() && this.sockets.online() && !this.cachedAt());
  readonly offlineCopyLabel = computed(() => {
    const time = this.cachedAt();
    return time ? $localize`:Dependencies view note; a relative time such as "5 minutes ago" follows:Offline copy from ${formatRelativeTime(time)}:time:` : "";
  });
  /**
   * Over many boards the viewer's role differs per board, so the host names the cards they may
   * reschedule and link; null (a board) means `canEdit` decides for every card.
   */
  readonly editableCardIds = input<ReadonlySet<string> | null>(null);
  /**
   * Off when the workspace has dependencies switched off: the server then sends no edges, so the
   * chart has no wires or critical path to toggle and nothing new can be linked.
   */
  readonly dependenciesEnabled = input(true);
  readonly loading = input(false);
  /** Key for the remembered zoom and toggles; the host keeps the grouping under the same key. */
  readonly preferenceScope = input.required<string>();
  /** How rows are grouped. The host owns the switch (see `timelineGroupByState`). */
  readonly groupBy = input<TimelineGroupByKind>("list");

  readonly cardOpened = output<string>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>("scroller");

  /** The zoom: pixels per calendar day, continuous between MIN_PX_PER_DAY and MAX_PX_PER_DAY. */
  readonly pxPerDay = signal(DEFAULT_PX_PER_DAY);
  readonly minPxPerDay = MIN_PX_PER_DAY;
  readonly maxPxPerDay = MAX_PX_PER_DAY;
  readonly panning = signal(false);
  readonly critical = signal(false);
  readonly showDependencies = signal(true);
  readonly collapsedGroupKeys = signal<ReadonlySet<string>>(new Set());
  readonly drag = signal<BarDrag | null>(null);
  readonly linkDraft = signal<LinkDraft | null>(null);
  readonly selectedEdgeId = signal<string | null>(null);
  readonly hoveredCardId = signal<string | null>(null);
  /** The day under the pointer in an unscheduled card's lane, where a click would place it. */
  readonly placementGhost = signal<{ cardId: string; day: number } | null>(null);
  readonly reschedulingCardIds = signal<ReadonlySet<string>>(new Set());
  readonly activeActionsCardId = signal<string | null>(null);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  private readonly hostWidth = signal(0);
  readonly narrow = computed(() => this.hostWidth() > 0 && this.hostWidth() < NARROW_MAX_WIDTH);
  readonly coarsePointer = hasCoarsePointer();
  readonly skeletonRows = Array.from({ length: 8 }, (_, index) => index);

  private readonly edgesResponse = signal<DependencyGraphEdge[]>([]);
  private readonly scheduleResponse = signal<ScheduleResponse | null>(null);
  private readonly graphRooms = new Map<string, () => void>();
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(600);
  private readonly focusedRowId = signal<string | null>(null);
  private suppressedClickCardId: string | null = null;
  readonly edgesLoading = signal(false);
  private loadSeq = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedScopeKey: string | null = null;
  private preferenceLoaded = false;
  private scrolledScopeKey: string | null = null;

  readonly today = todayKey();
  readonly rowHeight = computed(() => {
    const compact = this.density.compact();
    const height = this.hasLabelChips() ? (compact ? ROW_HEIGHT_LABELLED_COMPACT : ROW_HEIGHT_LABELLED)
      : compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;
    return this.coarsePointer ? Math.max(44, height) : height;
  });
  readonly barHeight = computed(() => (this.density.compact() ? ROW_HEIGHT_COMPACT : ROW_HEIGHT) - 10);
  readonly groupRowHeight = this.coarsePointer ? Math.max(44, GROUP_ROW_HEIGHT) : GROUP_ROW_HEIGHT;
  // Grouped by label, the group heading already names each row's label, so the chips would only
  // repeat it (and cost every row a second line).
  readonly showLabelChips = computed(() => !this.narrow() && this.groupBy() !== "label");
  /** Whether any row shows label chips; only then do card rows grow a second line for them. */
  private readonly hasLabelChips = computed(() => {
    if (!this.showLabelChips()) return false;
    const labels = this.labelsByCard();
    return this.visibleCards().some((card) => (labels.get(card.id)?.length ?? 0) > 0);
  });
  /**
   * The pane width at which the widest row's label chips show whole, measured from the DOM because
   * chip widths depend on the font, the label display mode and density. Label names are never cut
   * off, so this is a floor for both the automatic and the dragged width.
   */
  private readonly labelsFitWidth = signal(0);
  private readonly labelObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.measureLabels());
  /** The width the viewer dragged the pane's edge to; null follows the automatic width. */
  readonly customNamePaneWidth = signal<number | null>(null);
  // Long titles never fit a fixed pane, so the viewer can widen it. Phones keep the fixed narrow
  // pane (and hide the labels): the chart is the point there and the handle would fight the scroll.
  readonly namePaneWidth = computed(() => this.narrow() ? NAME_PANE_WIDTH_NARROW : this.clampNamePaneWidth(this.customNamePaneWidth() ?? NAME_PANE_WIDTH));
  private paneResize: { pointerId: number; startX: number; startWidth: number } | null = null;

  private readonly appRef = inject(ApplicationRef);
  /** Where an animated zoom is heading, and the viewport x it keeps still; null when at rest. */
  /**
   * Where an animated zoom is heading and the viewport x it holds. With `focusDay` (Fit), that day
   * glides to the anchor as the scale changes; without it, the day already under the anchor stays.
   */
  private zoomTarget: { px: number; anchorX: number; focusDay?: number } | null = null;
  private zoomFrames = 0;
  /**
   * Whether the viewer picked this zoom (buttons, slider, wheel, pinch). Until they do, and again
   * after Fit all, the chart has no remembered zoom: each visit opens fitted to the plan as it is then.
   */
  private zoomChosen = false;
  private readonly injector = inject(Injector);
  private zoomFrame: number | null = null;
  private pan: { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number; moved: boolean } | null = null;
  private suppressPanClick = false;

  readonly visibleCards = computed(() => {
    const filter = this.filteredCardIds();
    const cards = this.cards();
    return filter ? cards.filter((card) => filter.has(card.id)) : cards;
  });
  private readonly visibleCardIds = computed(() => new Set(this.visibleCards().map((card) => card.id)));
  readonly cardsById = computed(() => new Map(this.cards().map((card) => [card.id, card])));
  private readonly blockerKeys = computed(() => new Map([
    ...(this.scheduleResponse()?.cards ?? []).map((card) => [card.id, card.key] as const),
    ...this.cards().map((card) => [card.id, card.key] as const),
  ]));
  private readonly dateTextCache = new Map<string, string>();
  readonly scheduledCount = computed(() => plannedBars(this.visibleCards()).length);

  /** Only `blocks` edges between two visible cards: a wire needs both ends on the chart. */
  readonly edges = computed(() => {
    const ids = this.visibleCardIds();
    return this.edgesResponse().filter((edge) => edge.kind === "blocks" && ids.has(edge.sourceCardId) && ids.has(edge.targetCardId));
  });

  readonly schedule = computed<Schedule>(() => {
    // The host owns current rows (including optimistic writes). Off-host inputs come from the same
    // complete, access-filtered graph the API uses. Search and folding change no dates.
    const hosted = this.cardsById();
    const external = (this.scheduleResponse()?.cards ?? []).filter((card) => !hosted.has(card.id));
    return computeSchedule([
      ...external.map((card) => ({ id: card.id, startDateLocalDate: card.plannedStart, dueDateLocalDate: card.plannedEnd, done: false })),
      ...this.cards().filter((card) => !card.archivedAt).map((card) => ({ id: card.id, startDateLocalDate: card.startDateLocalDate, dueDateLocalDate: card.dueDateLocalDate, done: Boolean(card.completedAt) })),
    ], this.edgesResponse());
  });

  // Zoomed out, the planned work can span less than the window; the scale stretches to fill it (plus
  // a week, so the far edge is never a hard stop while panning).
  private readonly minimumDays = computed(() => Math.ceil(Math.max(0, this.hostWidth() - this.namePaneWidth()) / this.pxPerDay()) + 7);
  readonly range = computed(() => timelineRange(plannedBars(this.visibleCards()), this.today, this.minimumDays()));
  readonly chartWidth = computed(() => rangeWidth(this.range(), this.pxPerDay()));
  readonly header = computed(() => timelineHeader(this.range(), this.pxPerDay(), this.today));
  readonly weekends = computed(() => weekendBands(this.range(), this.pxPerDay()));
  readonly todayX = computed(() => xOf(dayNumber(this.today), this.range(), this.pxPerDay()) + this.pxPerDay() / 2);
  /** The zoom slider runs on a log scale, so each stretch of its track zooms by the same factor. */
  readonly zoomLevel = computed(() => Math.log(this.pxPerDay()));
  readonly minZoomLevel = Math.log(MIN_PX_PER_DAY);
  readonly maxZoomLevel = Math.log(MAX_PX_PER_DAY);

  readonly rows = computed<TimelineRow[]>(() => buildTimelineRows(this.visibleCards(), this.groupBy(), this.range(), this.pxPerDay(), {
    lists: this.lists(),
    boards: this.boardSummariesById() ?? undefined,
    labelsByCard: this.labelsByCard(),
    assigneesByCard: this.assigneesByCard(),
    collapsedGroupKeys: this.collapsedGroupKeys(),
    labels: {
      unassigned: $localize`:Timeline view group for cards nobody is assigned to:Unassigned`,
      noLabel: $localize`:Timeline view group for cards with no label:No label`,
      allCards: $localize`:Timeline view group heading when cards are not grouped:All cards`,
      unscheduled: $localize`:Timeline view group for cards with neither a start nor a due date:Unscheduled`,
    },
  }));

  /** Top offset of each row, so wires can be drawn between bars without measuring the DOM. */
  readonly rowTops = computed(() => {
    const tops = new Map<string, number>();
    let y = 0;
    for (const row of this.rows()) {
      tops.set(row.id, y);
      y += row.kind === "group" ? this.groupRowHeight : this.rowHeight();
    }
    return { tops, height: y };
  });
  readonly bodyHeight = computed(() => this.rowTops().height);

  /** Window the DOM, never the schedule. Binary search handles mixed heading/card heights.
   * Keep focused/dragged rows mounted so scrolling cannot steal a keyboard focus or pointer capture.
   */
  readonly windowRows = computed(() => {
    const rows = this.rows();
    const { tops } = this.rowTops();
    const top = Math.max(0, this.scrollTop() - 200);
    const bottom = this.scrollTop() + this.viewportHeight() + 200;
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((tops.get(rows[mid]!.id) ?? 0) < top) low = mid + 1;
      else high = mid;
    }
    const visible: TimelineRow[] = [];
    for (let index = Math.max(0, low - 1); index < rows.length; index++) {
      const row = rows[index]!;
      if ((tops.get(row.id) ?? 0) > bottom) break;
      visible.push(row);
    }
    const pinned = new Set([this.drag()?.cardId, this.activeActionsCardId()]);
    const focused = this.focusedRowId();
    for (const row of rows) {
      if ((row.id === focused || (row.kind === "card" && pinned.has(row.card.id))) && !visible.includes(row)) visible.push(row);
    }
    return visible;
  });

  onScroll(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) return;
    // Quantize within the overscan so pixel-by-pixel scrolling doesn't re-render the rows.
    this.scrollTop.set(Math.floor(scroller.scrollTop / 100) * 100);
    this.viewportHeight.set(scroller.clientHeight);
  }

  onRowFocus(event: FocusEvent): void {
    this.focusedRowId.set((event.target as HTMLElement).closest<HTMLElement>("[data-row-id]")?.dataset["rowId"] ?? null);
  }


  /** The first row of each card: where its wires attach when a card sits in several groups. */
  private readonly firstRowByCard = computed(() => {
    const rows = new Map<string, TimelineCardRow>();
    for (const row of this.rows()) if (row.kind === "card" && !rows.has(row.card.id)) rows.set(row.card.id, row);
    return rows;
  });

  /** Bars with the in-flight drag applied, so the chart previews the drop before it is committed. */
  readonly previewBar = computed<{ cardId: string; bar: TimelineBar } | null>(() => {
    const drag = this.drag();
    if (!drag || !drag.moved) return null;
    return { cardId: drag.cardId, bar: this.draggedBar(drag) };
  });

  readonly wires = computed<Wire[]>(() => {
    if (!this.showDependencies()) return [];
    const rows = this.firstRowByCard();
    const { tops } = this.rowTops();
    const schedule = this.schedule();
    const critical = this.critical();
    const selected = this.selectedEdgeId();
    const preview = this.previewBar();
    const wires: Wire[] = [];
    for (const edge of this.edges()) {
      const source = rows.get(edge.sourceCardId);
      const target = rows.get(edge.targetCardId);
      if (!source?.bar || !target?.bar || source.x === null || target.x === null) continue;
      const sourceGeometry = this.geometryFor(source, preview);
      const targetGeometry = this.geometryFor(target, preview);
      const from = { x: sourceGeometry.x + sourceGeometry.width, y: (tops.get(source.id) ?? 0) + this.rowHeight() / 2 };
      const to = { x: targetGeometry.x, y: (tops.get(target.id) ?? 0) + this.rowHeight() / 2 };
      if (Math.max(from.y, to.y) < this.scrollTop() - 200 || Math.min(from.y, to.y) > this.scrollTop() + this.viewportHeight() + 200) continue;
      const conflict = schedule.cards.get(edge.targetCardId)?.conflicts.some((candidate) => candidate.edgeId === edge.id) ?? false;
      const tone: Wire["tone"] = selected === edge.id ? "lit"
        : critical ? (schedule.criticalEdgeIds.has(edge.id) ? "critical" : "offpath")
        : conflict ? "risk" : "plain";
      wires.push({ id: edge.id, edge, path: dependencyPath(from, to, this.rowHeight()), midX: (from.x + to.x) / 2, midY: (from.y + to.y) / 2, tone });
    }
    return wires;
  });

  readonly selectedWire = computed(() => this.wires().find((wire) => wire.id === this.selectedEdgeId()) ?? null);

  readonly summary = computed(() => {
    const schedule = this.schedule();
    let critical = 0;
    let conflicts = 0;
    for (const id of this.visibleCardIds()) {
      const card = schedule.cards.get(id);
      if (!card) continue;
      if (card.critical) critical += 1;
      if (card.conflicts.length) conflicts += 1;
    }
    return { scheduled: this.scheduledCount(), total: this.visibleCards().length, critical, conflicts };
  });
  readonly scheduledLabel = computed(() => icu($localize`:Timeline view toolbar count - how many of the board's cards have a date:{scheduled, plural, one {1 of {total} cards scheduled} other {# of {total} cards scheduled}}`, { scheduled: this.summary().scheduled, total: this.summary().total }));
  readonly conflictsLabel = computed(() => icu($localize`:Timeline view toolbar count - cards whose blocker finishes after they start:{count, plural, one {1 scheduling conflict} other {# scheduling conflicts}}`, { count: this.summary().conflicts }));

  constructor() {
    effect(() => {
      if (!this.editingEnabled()) untracked(() => {
        this.drag.set(null);
        this.linkDraft.set(null);
        this.selectedEdgeId.set(null);
        this.closeActionsMenu();
      });
    });
    // The view only renders where the workspace has the Timeline on, so opening it ticks the step.
    this.gettingStarted.noteUsed("viewTimeline");
    afterNextRender(() => {
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => { this.hostWidth.set(this.host.nativeElement.clientWidth); this.onScroll(); });
      observer.observe(this.host.nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
    // Rows come and go with filters, grouping and folding, so the chips being measured are
    // re-collected after each render that changes them; the observer reports their sizes, including
    // when the label display mode or density changes a chip's width without changing the rows.
    afterRenderEffect(() => {
      this.windowRows();
      const observer = this.labelObserver;
      if (!observer) return;
      observer.disconnect();
      for (const labels of this.host.nativeElement.querySelectorAll<HTMLElement>(".tl-labels")) observer.observe(labels);
      if (!this.host.nativeElement.querySelector(".tl-labels")) this.labelsFitWidth.set(0);
    });
    this.destroyRef.onDestroy(() => this.labelObserver?.disconnect());
    // The scroller only exists once the board has loaded, so the first scroll waits for it; a new
    // board gets its own first scroll, later data changes leave the viewer where they were.
    // Wheel must be a non-passive listener to stop the page zooming, and the click guard must run
    // in the capture phase, ahead of the lane and bar handlers; template bindings can do neither.
    effect((onCleanup) => {
      const element = this.scroller()?.nativeElement;
      if (!element) return;
      const wheel = (event: WheelEvent) => this.onWheel(event);
      const down = (event: PointerEvent) => this.onPanPointerDown(event);
      const move = (event: PointerEvent) => this.onPanPointerMove(event);
      const up = (event: PointerEvent) => this.onPanPointerUp(event);
      const click = (event: MouseEvent) => this.onPanClick(event);
      element.addEventListener("wheel", wheel, { passive: false });
      element.addEventListener("pointerdown", down);
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", up);
      element.addEventListener("click", click, true);
      onCleanup(() => {
        element.removeEventListener("wheel", wheel);
        element.removeEventListener("pointerdown", down);
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", up);
        element.removeEventListener("click", click, true);
      });
    });
    effect(() => {
      const scroller = this.scroller();
      const key = scopeKey(this.scope());
      if (!scroller || this.scrolledScopeKey === key) return;
      this.scrolledScopeKey = key;
      untracked(() => this.openAtStart());
    });
    // Preferences follow the scope: a different board, a different memory.
    effect(() => {
      const scope = this.preferenceScope();
      untracked(() => {
        const stored = readTimelinePreference(scope);
        // No remembered zoom means fit: the first view of the board sets the scale (openAtStart).
        this.zoomChosen = stored.pxPerDay !== null;
        if (stored.pxPerDay !== null) this.pxPerDay.set(stored.pxPerDay);
        this.zoomTarget = null;
        this.critical.set(stored.critical);
        this.showDependencies.set(stored.dependencies);
        this.collapsedGroupKeys.set(new Set(stored.collapsed));
        this.customNamePaneWidth.set(stored.nameWidth);
        this.preferenceLoaded = true;
      });
    });
    effect(() => {
      // Keyed on the scope's identity, not the object: a host that rebuilds the same scope must not
      // throw the schedule away and re-read it.
      const key = scopeKey(this.scope());
      untracked(() => {
        if (this.loadedScopeKey === key) return;
        this.loadedScopeKey = key;
        for (const leave of this.graphRooms.values()) leave();
        this.graphRooms.clear();
        this.scheduleResponse.set(null);
        this.edgesResponse.set([]);
        void this.loadEdges(this.scope());
      });
    });
  }

  ngOnInit(): void {
    const socket = this.sockets.connect();
    // Relations live on the card, so a change on this board says which card; the whole edge set is
    // re-read because an edge can join or leave the chart from either end.
    const linksChanged = ({ boardId }: { boardId: string }) => {
      if (this.chartsBoard(boardId)) this.scheduleRefresh();
    };
    const reconnected = () => this.scheduleRefresh();
    const accessChanged = ({ boardId }: { boardId: string }) => {
      if (!this.chartsBoard(boardId)) return;
      // Discard off-board identities immediately; reauthorization may now exclude this branch.
      this.scheduleResponse.set(null);
      this.edgesResponse.set([]);
      this.scheduleRefresh();
    };
    const accessEvents = [SERVER_EVENTS.BOARD_MEMBER_UPDATED, SERVER_EVENTS.BOARD_MEMBER_REMOVED, SERVER_EVENTS.BOARD_DELETED] as const;
    for (const event of accessEvents) socket.on(event, accessChanged);
    const events = [SERVER_EVENTS.CARD_LINKS_CHANGED, SERVER_EVENTS.CARD_UPDATED, SERVER_EVENTS.CARD_CREATED, SERVER_EVENTS.CARD_MOVED, SERVER_EVENTS.CARD_DELETED] as const;
    for (const event of events) socket.on(event, linksChanged);
    socket.on("connect", reconnected);
    this.destroyRef.onDestroy(() => {
      for (const event of events) socket.off(event, linksChanged);
      for (const leave of this.graphRooms.values()) leave();
      this.graphRooms.clear();
      socket.off("connect", reconnected);
      for (const event of accessEvents) socket.off(event, accessChanged);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      if (this.zoomFrame !== null) cancelAnimationFrame(this.zoomFrame);
      // Leaving mid-zoom still remembers where it was heading.
      if (this.zoomTarget) {
        this.pxPerDay.set(this.zoomTarget.px);
        this.persist();
      }
      this.loadSeq++;
    });
  }

  /**
   * Whether a board's card events concern this chart: the host's own board, any board a hosted card
   * sits on (a cross-board host already listens in those rooms) or a board the schedule pulled an
   * off-host blocker from.
   */
  private chartsBoard(boardId: string): boolean {
    const scope = this.scope();
    if ("boardId" in scope && scope.boardId === boardId) return true;
    return this.graphRooms.has(boardId) || this.cards().some((card) => card.boardId === boardId);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.loadEdges(this.scope());
    }, 300);
  }

  private async loadEdges(scope: TimelineScheduleScope): Promise<void> {
    const seq = ++this.loadSeq;
    this.edgesLoading.set(true);
    try {
      const { response, cachedAt } = await this.queries.read({ url: "/cards/schedule", body: scope }, () => this.readSchedule(scope));
      if (seq !== this.loadSeq) return;
      this.scheduleResponse.set(response);
      this.cachedAt.set(cachedAt);
      this.edgesResponse.set(response.edges.map((edge) => ({ ...edge, kind: "blocks" })));
      // Room leases are ref-counted by SocketService. Retain known boards until leaving this chart:
      // a completed external blocker can reopen and must rejoin the schedule without a page reload.
      const hostedBoardIds = new Set(this.cards().map((card) => card.boardId));
      if ("boardId" in scope) hostedBoardIds.add(scope.boardId);
      for (const board of response.boards) {
        if (!hostedBoardIds.has(board.id) && !this.graphRooms.has(board.id)) this.graphRooms.set(board.id, this.sockets.joinBoard(board.id));
      }
    } catch {
      // Without a saved schedule the host's cached cards still provide the chart's bars.
    } finally {
      if (seq === this.loadSeq) this.edgesLoading.set(false);
    }
  }

  /** One schedule per workspace, merged: a card or edge reached from two workspaces is the same row. */
  private async readSchedule(scope: TimelineScheduleScope): Promise<ScheduleResponse> {
    if ("boardId" in scope) return this.api.post<ScheduleResponse>("/cards/schedule", { boardId: scope.boardId });
    const responses = await Promise.all(scope.workspaceIds.map((workspaceId) => this.api.post<ScheduleResponse>("/cards/schedule", { workspaceId })));
    const cards = new Map<string, ScheduleResponse["cards"][number]>();
    const edges = new Map<string, ScheduleResponse["edges"][number]>();
    const boards = new Map<string, ScheduleResponse["boards"][number]>();
    const criticalEdgeIds = new Set<string>();
    for (const response of responses) {
      for (const card of response.cards) cards.set(card.id, card);
      for (const edge of response.edges) edges.set(edge.id, edge);
      for (const board of response.boards) boards.set(board.id, board);
      for (const id of response.criticalEdgeIds) criticalEdgeIds.add(id);
    }
    // The chart recomputes slack and the critical path itself over the merged graph, so the
    // per-workspace summaries are not combined; the first stands in for the response shape.
    const emptySummary: ScheduleResponse["summary"] = { scheduledCount: 0, unscheduledCount: 0, conflictCount: 0, criticalCount: 0, range: null, projectedFinish: null, latestDue: null, slipDays: 0 };
    return {
      cards: [...cards.values()],
      edges: [...edges.values()],
      criticalEdgeIds: [...criticalEdgeIds],
      summary: responses[0]?.summary ?? emptySummary,
      boards: [...boards.values()],
      lists: responses.flatMap((response) => response.lists),
      labels: responses.flatMap((response) => response.labels),
      people: responses.flatMap((response) => response.people),
      truncated: responses.some((response) => response.truncated),
    };
  }

  private persist(): void {
    if (!this.preferenceLoaded) return;
    const value: TimelinePreference = {
      pxPerDay: this.zoomChosen ? this.pxPerDay() : null,
      groupBy: this.groupBy(),
      critical: this.critical(),
      dependencies: this.showDependencies(),
      collapsed: [...this.collapsedGroupKeys()],
      nameWidth: this.customNamePaneWidth(),
    };
    writeTimelinePreference(this.preferenceScope(), value);
  }

  // ---- Zoom ----
  //
  // Every zoom input (buttons, slider, ctrl+wheel, trackpad pinch) only moves a target; one frame
  // loop eases the scale towards it, so a notchy mouse wheel and a button press glide like a pinch.
  // Each frame keeps the day under the anchor (the pointer, or the chart's middle) at the same
  // screen x, so zooming reads as a lens over the plan and never as a jump.

  zoomIn(): void {
    this.zoomTowards((this.zoomTarget?.px ?? this.pxPerDay()) * ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomTowards((this.zoomTarget?.px ?? this.pxPerDay()) / ZOOM_STEP);
  }

  /** Whether there is anything to fit: at least one visible card with a date. */
  readonly canFit = computed(() => this.scheduledCount() > 0);

  /**
   * Zoom and scroll so every visible dated card is on screen at once, centred, with a little room
   * either side. A plan longer than the furthest zoom allows is centred at that zoom instead.
   */
  fitAll(): void {
    const fit = this.fitTarget();
    if (!fit) return;
    this.zoomChosen = false;
    this.zoomTarget = fit;
    this.zoomFrames = 0;
    if (this.zoomFrame === null) this.zoomFrame = requestAnimationFrame(() => this.zoomStep());
  }

  /** The scale and centre that show every visible dated card; null when there is nothing to fit. */
  private fitTarget(): { px: number; anchorX: number; focusDay: number } | null {
    const scroller = this.scroller()?.nativeElement;
    const bars = plannedBars(this.visibleCards());
    if (!scroller || !bars.length) return null;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const bar of bars) {
      first = Math.min(first, dayNumber(bar.start));
      last = Math.max(last, dayNumber(bar.end));
    }
    const pane = this.namePaneWidth();
    const chart = scroller.clientWidth - pane;
    // Room for the first bar's edge and the last bar's caption, which sits to its right.
    const available = Math.max(80, chart - FIT_MARGIN_PX * 2);
    return { px: clampPxPerDay(available / (last - first + 1)), anchorX: pane + chart / 2, focusDay: (first + last + 1) / 2 };
  }

  /**
   * The first view of a board: fitted to the plan unless the viewer has a zoom of their own, in which
   * case it keeps that zoom and opens on today. No animation; this is where the chart starts.
   */
  private openAtStart(): void {
    const fit = this.zoomChosen ? null : this.fitTarget();
    if (fit) this.pxPerDay.set(fit.px);
    // The scale just changed, so place the scroll once the sheet has been drawn at it.
    afterNextRender(() => {
      const scroller = this.scroller()?.nativeElement;
      if (!scroller) return;
      if (fit) scroller.scrollLeft = (fit.focusDay - this.range().startDay) * fit.px + this.namePaneWidth() - fit.anchorX;
      else this.scrollToToday();
    }, { injector: this.injector });
  }

  onZoomSlider(value: string): void {
    // exp(log(max)) comes back a hair under max; snap the ends so the limits (and the disabled
    // buttons that mark them) are actually reached.
    const px = Math.exp(Number(value));
    this.zoomTowards(px > MAX_PX_PER_DAY * 0.999 ? MAX_PX_PER_DAY : px < MIN_PX_PER_DAY * 1.001 ? MIN_PX_PER_DAY : px);
  }

  /** Ctrl (or ⌘) + wheel, which is also how browsers report a trackpad pinch, zooms at the pointer. */
  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    // Otherwise the browser zooms the whole page.
    event.preventDefault();
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
    const anchorX = event.clientX - scroller.getBoundingClientRect().left;
    this.zoomTowards((this.zoomTarget?.px ?? this.pxPerDay()) * Math.exp(-delta * WHEEL_ZOOM_RATE), anchorX);
  }

  private zoomTowards(px: number, anchorX?: number): void {
    const scroller = this.scroller()?.nativeElement;
    const target = clampPxPerDay(px);
    this.zoomChosen = true;
    if (!scroller) {
      this.pxPerDay.set(target);
      this.persist();
      return;
    }
    const pane = this.namePaneWidth();
    // Over the name pane there is no day under the pointer, so the chart's middle stays put instead.
    const anchor = anchorX !== undefined && anchorX > pane ? anchorX : pane + (scroller.clientWidth - pane) / 2;
    this.zoomTarget = { px: target, anchorX: anchor };
    this.zoomFrames = 0;
    if (this.zoomFrame === null) this.zoomFrame = requestAnimationFrame(() => this.zoomStep());
  }

  private zoomStep(): void {
    this.zoomFrame = null;
    const target = this.zoomTarget;
    const scroller = this.scroller()?.nativeElement;
    if (!target || !scroller) return;
    const current = this.pxPerDay();
    // Ease in log space: zooming from 4px to 8px feels like 40px to 80px.
    const ratio = Math.log(target.px / current);
    const pane = this.namePaneWidth();
    const range = this.range();
    const anchorDay = range.startDay + (scroller.scrollLeft + target.anchorX - pane) / current;
    const gap = target.focusDay === undefined ? 0 : target.focusDay - anchorDay;
    // The frame cap ends a glide the scroll can't finish, such as a focus day the edge of the
    // scale keeps from reaching the anchor.
    const done = (Math.abs(ratio) < 0.004 && Math.abs(gap) * current < 1) || ++this.zoomFrames > 90;
    const next = done ? target.px : current * Math.exp(ratio * ZOOM_EASE);
    const placeDay = done ? anchorDay + gap : anchorDay + gap * ZOOM_EASE;
    this.pxPerDay.set(next);
    // Render now rather than on the next scheduled pass, so the wider sheet exists before the scroll
    // is set (otherwise the browser clamps it) and scale and scroll land in the same frame.
    this.appRef.tick();
    scroller.scrollLeft = (placeDay - this.range().startDay) * next + pane - target.anchorX;
    if (done) {
      this.zoomTarget = null;
      // Once per settled zoom, never per frame; saved at once so a reload right after keeps it.
      this.persist();
    } else {
      this.zoomFrame = requestAnimationFrame(() => this.zoomStep());
    }
  }


  // ---- Panning ----
  //
  // A mouse or pen press on the chart's background grabs it: dragging scrolls both ways, like a map.
  // Touch already pans natively. Bars, handles, names, wires and menus keep their own gestures, and
  // an undated card's lane still takes a plain click to place the card; only a drag past the
  // threshold becomes a pan, and the click that ends it is swallowed.

  private onPanPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.pointerType === "touch" || this.drag() || this.linkDraft()) return;
    const target = event.target as Element | null;
    if (!target?.closest(".tl-lane, .tl-header-lane, .tl-bands, .tl-body") || target.closest("button, a, input, .tl-name, .tl-link-handle, .tl-wire-hit, .tl-wire-remove, .tl-pane-resizer, k-card-actions-menu")) return;
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) return;
    this.pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, moved: false };
  }

  private onPanPointerMove(event: PointerEvent): void {
    const pan = this.pan;
    const scroller = this.scroller()?.nativeElement;
    if (!pan || pan.pointerId !== event.pointerId || !scroller) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      pan.moved = true;
      scroller.setPointerCapture(event.pointerId);
      this.placementGhost.set(null);
      this.panning.set(true);
    }
    event.preventDefault();
    scroller.scrollLeft = pan.scrollLeft - dx;
    scroller.scrollTop = pan.scrollTop - dy;
  }

  private onPanPointerUp(event: PointerEvent): void {
    const pan = this.pan;
    if (!pan || pan.pointerId !== event.pointerId) return;
    this.pan = null;
    if (!pan.moved) return;
    this.panning.set(false);
    this.suppressPanClick = event.type === "pointerup";
    // A click only follows a pointerup when it lands where the press began; reset in case none does.
    setTimeout(() => { this.suppressPanClick = false; });
  }

  private onPanClick(event: MouseEvent): void {
    if (!this.suppressPanClick) return;
    this.suppressPanClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  toggleCritical(): void {
    this.critical.update((value) => !value);
    this.persist();
  }

  toggleDependencies(): void {
    this.showDependencies.update((value) => !value);
    this.selectedEdgeId.set(null);
    this.persist();
  }

  /**
   * Keeps at least a third of the host for the chart, so a wide pane can't push the bars off-screen,
   * unless whole label names need more: those are never cut off, so their width wins.
   */
  private clampNamePaneWidth(width: number): number {
    const host = this.hostWidth();
    const max = host > 0 ? Math.min(NAME_PANE_WIDTH_MAX, Math.round(host * 2 / 3)) : NAME_PANE_WIDTH_MAX;
    const min = Math.max(NAME_PANE_WIDTH_MIN, this.labelsFitWidth());
    return Math.round(Math.max(min, Math.min(max, width)));
  }

  /** The pane's own chrome (icon, padding, avatars) plus each row's natural chip width; the widest wins. */
  private measureLabels(): void {
    let widest = 0;
    for (const labels of this.host.nativeElement.querySelectorAll<HTMLElement>(".tl-card-name .tl-labels")) {
      const name = labels.closest<HTMLElement>(".tl-card-name");
      const text = labels.closest<HTMLElement>(".tl-name-text");
      if (!name || !text) continue;
      widest = Math.max(widest, labels.offsetWidth + name.offsetWidth - text.offsetWidth);
    }
    this.labelsFitWidth.set(Math.ceil(widest));
  }

  onPaneResizeStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.paneResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: this.namePaneWidth() };
  }

  onPaneResizeMove(event: PointerEvent): void {
    const resize = this.paneResize;
    if (!resize || resize.pointerId !== event.pointerId) return;
    this.customNamePaneWidth.set(this.clampNamePaneWidth(resize.startWidth + event.clientX - resize.startX));
  }

  onPaneResizeEnd(event: PointerEvent): void {
    if (!this.paneResize || this.paneResize.pointerId !== event.pointerId) return;
    this.paneResize = null;
    this.persist();
  }

  onPaneResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      this.customNamePaneWidth.set(this.clampNamePaneWidth(this.namePaneWidth() + (event.key === "ArrowRight" ? step : -step)));
    } else if (event.key === "Home" || event.key === "Enter") {
      this.customNamePaneWidth.set(null);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.persist();
  }

  resetNamePaneWidth(): void {
    this.customNamePaneWidth.set(null);
    this.persist();
  }

  toggleGroup(key: string): void {
    this.collapsedGroupKeys.update((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    this.persist();
  }

  scrollToToday(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) return;
    const visible = scroller.clientWidth - this.namePaneWidth();
    scroller.scrollLeft = Math.max(0, this.todayX() - visible * 0.3);
  }

  isUnscheduledGroup(key: string): boolean {
    return key === UNSCHEDULED_GROUP_KEY;
  }

  // ---- Presentation ----

  scheduled(cardId: string): ScheduledCard | undefined {
    return this.schedule().cards.get(cardId);
  }

  /** The row's geometry, with the dragged preview applied when this is the card being dragged. */
  geometryFor(row: TimelineCardRow, preview = this.previewBar()): { x: number; width: number; point: boolean } {
    if (preview && preview.cardId === row.card.id) {
      const start = dayNumber(preview.bar.start);
      const end = dayNumber(preview.bar.end);
      const px = this.pxPerDay();
      return { x: xOf(start, this.range(), this.pxPerDay()), width: (end - start + 1) * px, point: (end - start + 1) * px <= 12 };
    }
    return { x: row.x ?? 0, width: row.width ?? 0, point: row.point };
  }

  barFor(row: TimelineCardRow): TimelineBar | null {
    const preview = this.previewBar();
    return preview && preview.cardId === row.card.id ? preview.bar : row.bar;
  }

  /** Where a non-critical card's finish could slip to, drawn as a tail when the critical path is on. */
  slackWidth(row: TimelineCardRow): number {
    if (!this.critical()) return 0;
    const card = this.scheduled(row.card.id);
    if (!card?.latestFinish || !card.earliestFinish || card.slackDays === null || card.slackDays === 0) return 0;
    const geometry = this.geometryFor(row);
    const latestX = xOf(dayNumber(card.latestFinish), this.range(), this.pxPerDay()) + this.pxPerDay();
    return Math.max(0, latestX - (geometry.x + geometry.width));
  }

  isCritical(cardId: string): boolean {
    return this.critical() && (this.scheduled(cardId)?.critical ?? false);
  }

  /** Faded while the critical path is on: dated, chained, and not on it. */
  isOffPath(cardId: string): boolean {
    if (!this.critical()) return false;
    const card = this.scheduled(cardId);
    return Boolean(card && !card.critical && (card.blockerIds.length || card.dependentIds.length));
  }

  hasConflict(cardId: string): boolean {
    return (this.scheduled(cardId)?.conflicts.length ?? 0) > 0;
  }

  isOverdueCard(card: AnyCard): boolean {
    return !card.completedAt && !card.archivedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  listFor(card: AnyCard): AnyList | null {
    return this.lists().find((list) => list.id === card.listId) ?? null;
  }

  listColor(card: AnyCard): string | null {
    const list = this.listFor(card);
    return list?.color ? `var(--color-${list.color})` : null;
  }

  tokenColor(token: string | null): string | null {
    return token ? `var(--color-${token})` : null;
  }

  assigneesFor(cardId: string): CardAssigneePresentation[] {
    return this.assigneesByCard().get(cardId) ?? [];
  }

  workspaceIdFor(card: AnyCard): string | null {
    return this.workspaces.workspaceIdForBoard(card.boardId);
  }

  /** "12 Oct – 16 Oct · 5 working days", or the single day for a point. */
  datesText(bar: TimelineBar | null): string {
    if (!bar) return $localize`:Timeline view row text for a card with no dates:No dates`;
    const key = `${bar.start}/${bar.end}`;
    const cached = this.dateTextCache.get(key);
    if (cached) return cached;
    const span = bar.start === bar.end ? formatDate(bar.start, "short") : formatDateRange(bar.start, bar.end);
    const days = barDurationDays(bar);
    const text = `${span} · ${icu($localize`:Timeline view bar length in working days:{count, plural, one {1 working day} other {# working days}}`, { count: days })}`;
    // A small per-view cache avoids repeating Intl/plural work on hover, toggles and drag frames.
    if (this.dateTextCache.size >= 256) this.dateTextCache.clear();
    this.dateTextCache.set(key, text);
    return text;
  }

  conflictText(cardId: string): string {
    const card = this.scheduled(cardId);
    const conflict = card?.conflicts[0];
    if (!conflict) return "";
    const key = this.blockerKeys().get(conflict.blockerId) ?? "";
    return icu($localize`:Timeline view warning on a bar - a card it waits on is planned to finish after this one starts:{count, plural, one {{key} finishes 1 working day after this card starts} other {{key} finishes # working days after this card starts}}`, { count: conflict.days, key });
  }

  slackText(cardId: string): string {
    const card = this.scheduled(cardId);
    if (!card || card.slackDays === null) return "";
    if (card.critical) return $localize`:Timeline view tooltip text - the card is on the critical path:On the critical path`;
    return icu($localize`:Timeline view tooltip text - how many working days a card could slip without delaying its chain:{count, plural, =0 {No slack} one {1 working day of slack} other {# working days of slack}}`, { count: card.slackDays });
  }

  labelsFor(cardId: string): CardLabelPresentation[] {
    return this.labelsByCard().get(cardId) ?? EMPTY_LABELS;
  }

  /** Hover text on a bar too short for its inline title: title, labels and dates on one line. */
  barTooltip(row: TimelineCardRow): string {
    const labels = this.labelsFor(row.card.id).map((label) => label.name).join(", ");
    return [row.card.title, labels, this.datesText(this.barFor(row))].filter(Boolean).join(" · ");
  }

  barLabel(row: TimelineCardRow): string {
    // Labels follow the title: the chips are hidden on narrow hosts and when the name pane runs out
    // of room, so the accessible name and the bar tooltip are where they stay readable.
    const labels = this.labelsFor(row.card.id).map((label) => label.name).join(", ");
    const parts = [row.card.title, labels, this.datesText(this.barFor(row))];
    const list = this.listFor(row.card);
    if (list) parts.push(list.name);
    if (this.hasConflict(row.card.id)) parts.push(this.conflictText(row.card.id));
    if (this.critical()) parts.push(this.slackText(row.card.id));
    return parts.filter(Boolean).join(". ");
  }

  wireLabel(wire: Wire): string {
    const source = this.cardsById().get(wire.edge.sourceCardId);
    const target = this.cardsById().get(wire.edge.targetCardId);
    return $localize`:Timeline view accessible name of a dependency wire:${target?.key ?? ""}:dependent: waits on ${source?.key ?? ""}:blocker:`;
  }

  groupCountLabel(count: number): string {
    return icu($localize`:Timeline view group heading count:{count, plural, one {1 card} other {# cards}}`, { count });
  }

  canEditCard(card: AnyCard): boolean {
    return this.editingEnabled() && (this.editableCardIds()?.has(card.id) ?? true) && !this.reschedulingCardIds().has(card.id);
  }

  canDrag(card: AnyCard): boolean {
    return this.canEditCard(card) && !this.coarsePointer;
  }

  // ---- Opening and menus ----

  openCard(cardId: string): void {
    this.cardOpened.emit(cardId);
  }

  openCardInNewTab(card: AnyCard, event: MouseEvent): void {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openCardDetailInNewTab(card.organisationKey, card.key);
  }

  onCardContextMenu(card: AnyCard, event: MouseEvent): void {
    if (!this.canEditCard(card)) return;
    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, { detail: card.id }));
    this.actionsMenuPoint.set({ x: event.clientX, y: event.clientY });
    this.activeActionsCardId.set(card.id);
  }

  closeActionsMenu(): void {
    this.actionsMenuPoint.set(null);
    this.activeActionsCardId.set(null);
  }

  // ---- Dragging bars ----

  onBarPointerDown(event: PointerEvent, row: TimelineCardRow, mode: DragMode): void {
    this.suppressedClickCardId = null;
    if (event.button !== 0 || !row.bar || !this.canDrag(row.card)) return;
    if (mode !== "move") event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    this.selectedEdgeId.set(null);
    this.drag.set({ cardId: row.card.id, mode, originX: event.clientX, bar: row.bar, dayDelta: 0, moved: false });
  }

  onBarPointerMove(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    const moved = drag.moved || Math.abs(dx) >= DRAG_THRESHOLD_PX;
    const dayDelta = Math.round(dx / this.pxPerDay());
    if (moved !== drag.moved || dayDelta !== drag.dayDelta) this.drag.set({ ...drag, moved, dayDelta });
  }

  async onBarPointerUp(event: PointerEvent, row: TimelineCardRow): Promise<void> {
    const drag = this.drag();
    if (!drag || drag.cardId !== row.card.id) return;
    this.drag.set(null);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.suppressedClickCardId = drag.moved || drag.mode !== "move" ? row.card.id : null;
    if (!drag.moved || drag.dayDelta === 0) return;
    const next = this.draggedBar(drag);
    await this.commitBar(row.card, next, drag.mode);
  }

  onBarClick(event: MouseEvent, row: TimelineCardRow): void {
    event.stopPropagation();
    const suppressed = this.suppressedClickCardId === row.card.id && event.detail !== 0;
    this.suppressedClickCardId = null;
    if (!suppressed) this.openCard(row.card.id);
  }

  onBarPointerCancel(): void {
    this.drag.set(null);
  }

  /** The bar a drag would leave behind: moved keeping its working-day length, or with one end pulled. */
  private draggedBar(drag: BarDrag): TimelineBar {
    const start = dayNumber(drag.bar.start);
    const end = dayNumber(drag.bar.end);
    switch (drag.mode) {
      case "move": {
        const newStart = dateKeyOf(start + drag.dayDelta);
        return { start: newStart, end: endForMovedStart(drag.bar, newStart) };
      }
      case "start": {
        const newStart = Math.min(end, start + drag.dayDelta);
        return { start: dateKeyOf(newStart), end: drag.bar.end };
      }
      case "end": {
        const newEnd = Math.max(start, end + drag.dayDelta);
        return { start: drag.bar.start, end: dateKeyOf(newEnd) };
      }
    }
  }

  /**
   * Writes a bar back to the card. A point keeps its single date: moving a due-only card moves its
   * due date, not an invented start. Pulling an end of a point gives the card both dates, since that
   * is exactly what the gesture asked for.
   */
  private async commitBar(card: AnyCard, bar: TimelineBar, mode: DragMode): Promise<void> {
    const hadStart = Boolean(card.startDateLocalDate);
    const hadDue = Boolean(card.dueDateLocalDate);
    const body: { startDateLocalDate?: string | null; dueDateLocalDate?: string | null; dueDateSlot?: string | null } = {};
    const giveBoth = mode !== "move";
    if (hadStart || giveBoth) body.startDateLocalDate = bar.start;
    if (hadDue || giveBoth) {
      body.dueDateLocalDate = bar.end;
      body.dueDateSlot = dueDateSlotFor(card.dueDateSlot);
    }
    if (body.startDateLocalDate === card.startDateLocalDate && body.dueDateLocalDate === card.dueDateLocalDate) return;
    const optimistic: AnyCard = {
      ...card,
      ...(body.startDateLocalDate !== undefined && { startDateLocalDate: body.startDateLocalDate }),
      ...(body.dueDateLocalDate !== undefined && { dueDateLocalDate: body.dueDateLocalDate, dueDateSlot: dueDateSlotFor(card.dueDateSlot) }),
    };
    await this.write(card, optimistic, body, $localize`:Toast when dragging a bar on the Timeline view fails:Couldn't reschedule the card`);
  }

  private async write(card: AnyCard, optimistic: AnyCard, body: Record<string, unknown>, fallback: string): Promise<void> {
    if (!this.canEditCard(card)) return;
    this.cardStore?.updateCard(optimistic);
    this.markRescheduling(card.id, true);
    try {
      const updated = await this.api.patch<AnyCard>(`/cards/${card.id}`, body);
      this.cardStore?.updateCard(updated);
    } catch (error) {
      this.cardStore?.updateCard(card);
      this.toasts.error(apiMessage(error, fallback));
    } finally {
      this.markRescheduling(card.id, false);
    }
  }

  private markRescheduling(cardId: string, active: boolean): void {
    this.reschedulingCardIds.update((ids) => {
      const next = new Set(ids);
      if (active) next.add(cardId);
      else next.delete(cardId);
      return next;
    });
  }

  // ---- Placing unscheduled cards ----

  onLanePointerMove(event: PointerEvent, row: TimelineCardRow): void {
    if (row.bar || !this.canEditCard(row.card)) return;
    const lane = event.currentTarget as HTMLElement;
    const x = event.clientX - lane.getBoundingClientRect().left;
    this.placementGhost.set({ cardId: row.card.id, day: dayAt(x, this.range(), this.pxPerDay()) });
  }

  onLanePointerLeave(row: TimelineCardRow): void {
    if (this.placementGhost()?.cardId === row.card.id) this.placementGhost.set(null);
  }

  ghostX(row: TimelineCardRow): number | null {
    const ghost = this.placementGhost();
    if (!ghost || ghost.cardId !== row.card.id) return null;
    return xOf(ghost.day, this.range(), this.pxPerDay());
  }

  ghostLabel(row: TimelineCardRow): string {
    const ghost = this.placementGhost();
    if (!ghost || ghost.cardId !== row.card.id) return "";
    return $localize`:Timeline view hint while hovering an unscheduled card's lane - the day it would be placed on:Place on ${formatDate(dateKeyOf(ghost.day), "weekday")}:date:`;
  }

  /** A click in an undated card's lane plans it for that one day; the bar can then be stretched. */
  async placeCard(event: MouseEvent, row: TimelineCardRow): Promise<void> {
    if (row.bar || !this.canEditCard(row.card)) return;
    const lane = event.currentTarget as HTMLElement;
    const x = event.clientX - lane.getBoundingClientRect().left;
    const day = dateKeyOf(dayAt(x, this.range(), this.pxPerDay()));
    this.placementGhost.set(null);
    const body = { startDateLocalDate: day, dueDateLocalDate: day, dueDateSlot: "anyTime" };
    await this.write(row.card, { ...row.card, startDateLocalDate: day, dueDateLocalDate: day, dueDateSlot: "anyTime" }, body, $localize`:Toast when placing a card on the Timeline view fails:Couldn't schedule the card`);
  }

  // ---- Drawing dependencies ----

  onLinkHandlePointerDown(event: PointerEvent, row: TimelineCardRow): void {
    if (event.button !== 0 || !this.canDrag(row.card)) return;
    event.stopPropagation();
    event.preventDefault();
    const geometry = this.geometryFor(row);
    const y = (this.rowTops().tops.get(row.id) ?? 0) + this.rowHeight() / 2;
    const chart = this.chartOrigin();
    this.linkDraft.set({
      sourceCardId: row.card.id,
      x: geometry.x + geometry.width,
      y,
      pointerX: event.clientX - chart.x,
      pointerY: event.clientY - chart.y,
      targetCardId: null,
    });
    const move = (moveEvent: PointerEvent) => {
      const draft = this.linkDraft();
      if (!draft) return;
      const origin = this.chartOrigin();
      const over = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-card-id]");
      const targetCardId = over?.dataset["cardId"] ?? null;
      this.linkDraft.set({ ...draft, pointerX: moveEvent.clientX - origin.x, pointerY: moveEvent.clientY - origin.y, targetCardId: targetCardId !== draft.sourceCardId ? targetCardId : null });
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      const draft = this.linkDraft();
      this.linkDraft.set(null);
      if (draft?.targetCardId) void this.addDependency(draft.sourceCardId, draft.targetCardId);
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      this.linkDraft.set(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  /** The chart body's page position, so pointer coordinates can be mapped into wire space. */
  private chartOrigin(): { x: number; y: number } {
    const body = this.host.nativeElement.querySelector<HTMLElement>(".tl-wires");
    const rect = body?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 };
  }

  draftPath(): string {
    const draft = this.linkDraft();
    if (!draft) return "";
    const target = draft.targetCardId ? this.firstRowByCard().get(draft.targetCardId) : null;
    if (target?.bar) {
      const geometry = this.geometryFor(target);
      return dependencyPath({ x: draft.x, y: draft.y }, { x: geometry.x, y: (this.rowTops().tops.get(target.id) ?? 0) + this.rowHeight() / 2 }, this.rowHeight());
    }
    return `M ${draft.x} ${draft.y} L ${draft.pointerX} ${draft.pointerY}`;
  }

  private async addDependency(blockerId: string, dependentId: string): Promise<void> {
    const blocker = this.cardsById().get(blockerId);
    const dependent = this.cardsById().get(dependentId);
    if (!blocker || !dependent || !this.canEditCard(dependent)) return;
    if (this.edges().some((edge) => edge.sourceCardId === blockerId && edge.targetCardId === dependentId)) return;
    try {
      const created = await this.api.post<CardRelationSummary>(`/cards/${dependentId}/relations`, { targetCardId: blockerId, direction: "blocked_by" });
      this.edgesResponse.update((edges) => [...edges, { id: created.id, sourceCardId: blockerId, targetCardId: dependentId, kind: "blocks" }]);
      this.toasts.success($localize`:Toast after drawing a dependency on the Timeline view:${dependent.key}:dependent: now waits on ${blocker.key}:blocker:`);
    } catch (error) {
      this.toasts.error(apiMessage(error, $localize`:Error toast when drawing a dependency on the Timeline view fails:Couldn't add the dependency. Try again.`));
    }
  }

  selectWire(wire: Wire, event: Event): void {
    event.stopPropagation();
    this.selectedEdgeId.update((current) => current === wire.id ? null : wire.id);
  }

  clearSelection(): void {
    this.selectedEdgeId.set(null);
  }

  async removeSelectedWire(): Promise<void> {
    const wire = this.selectedWire();
    if (!wire || !this.editingEnabled()) return;
    this.selectedEdgeId.set(null);
    const previous = this.edgesResponse();
    this.edgesResponse.set(previous.filter((edge) => edge.id !== wire.id));
    try {
      await this.api.delete(`/cards/${wire.edge.targetCardId}/relations/${wire.id}`);
    } catch (error) {
      this.edgesResponse.set(previous);
      this.toasts.error(apiMessage(error, $localize`:Error toast when removing a dependency on the Timeline view fails:Couldn't remove the dependency. Try again.`));
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if ((event.key === "Delete" || event.key === "Backspace") && this.selectedEdgeId()) {
      event.preventDefault();
      void this.removeSelectedWire();
    } else if (event.key === "Escape") {
      this.selectedEdgeId.set(null);
      this.linkDraft.set(null);
    }
  }

  wireClass(wire: Wire): string {
    return `tl-wire is-${wire.tone}`;
  }

  /** Visible rows of a card, for its tooltip when the bar is too short to hold its title. */
  showsInlineTitle(row: TimelineCardRow): boolean {
    return !this.narrow() && this.geometryFor(row).width >= 96;
  }

  plannedBarOf(card: AnyCard): TimelineBar | null {
    return plannedBar(card);
  }
}

/** The API's own message (already in the viewer's language, e.g. a loop rejection), else a fallback. */
function apiMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
