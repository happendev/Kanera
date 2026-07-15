import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import type { WorkDoneEvent, WorkDoneResponse } from "@kanera/shared/dto";
import type { WireList } from "@kanera/shared/events";
import { ApiClient } from "../../../core/api/api.client";
import { AvatarComponent } from "../../../shared/avatar.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardState } from "../board-state";
import { DatePickerPopover } from "../date-picker.popover";
import { matchesCfConditions } from "../list-view/filter.util";
import type { CfFilterCondition } from "../list-view/filter.types";

type BoardSummary = { id: string; name: string; icon: string | null; iconColor: string | null };

/** Furthest back the historical view may look — mirrors the server-side cap. */
const MAX_DAYS_BACK = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALL_ASSIGNED_WORK_USER_ID = "all";
/** Number of placeholder rows shown while the timeline loads. */
const SKELETON_ROW_COUNT = 6;
/** Max list names shown in a move path before the middle collapses to an ellipsis. */
const MOVE_PATH_MAX = 4;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

@Component({
  selector: "k-work-done-view",
  standalone: true,
  imports: [AvatarComponent, DatePickerPopover, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./work-done-view.component.html",
  styleUrl: "./work-done-view.component.scss",
})
export class WorkDoneViewComponent {
  private readonly api = inject(ApiClient);
  // The host pages (board / assigned-work) provide BoardState in this view's DI
  // scope, so label/custom-field filters resolve against the same workspace catalogs
  // the live board cards use.
  private readonly state = inject(BoardState);

  readonly scope = input.required<"board" | "assigned">();
  readonly boardId = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  readonly userId = input<string | null>(null);
  /** Assigned-work board filters; ignored in board scope. */
  readonly boardFilterIds = input<string[]>([]);
  readonly lists = input.required<WireList[]>();
  readonly selectedCardId = input<string | null>(null);
  /** Cross-board scope passes board summaries so rows show their board badge. */
  readonly boardSummariesById = input<Map<string, BoardSummary> | null>(null);
  readonly searchQuery = input("");
  readonly filterLabelIds = input<string[]>([]);
  readonly filterMemberIds = input<string[]>([]);
  readonly filterListIds = input<string[]>([]);
  readonly filterCfConditions = input<CfFilterCondition[]>([]);
  readonly refreshVersion = input(0);

  readonly cardOpened = output<string>();

  readonly day = signal(startOfDay(new Date()));
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly datePickerOpen = signal(false);
  private readonly events = signal<WorkDoneEvent[]>([]);
  private loadSeq = 0;

  readonly skeletonRows = Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => index);

  private readonly minDay = startOfDay(new Date(Date.now() - MAX_DAYS_BACK * DAY_MS));

  readonly canGoPrev = computed(() => this.day().getTime() > this.minDay.getTime());
  readonly canGoNext = computed(() => this.day().getTime() < startOfDay(new Date()).getTime());

  readonly dayLabel = computed(() => {
    const day = this.day();
    const todayKey = startOfDay(new Date()).getTime();
    if (day.getTime() === todayKey) return "Today";
    if (day.getTime() === todayKey - DAY_MS) return "Yesterday";
    return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  });

  /** Native date-input value (YYYY-MM-DD) and bounds for the picker. */
  readonly dayInputValue = computed(() => toDateInputValue(this.day()));
  readonly minInputValue = toDateInputValue(this.minDay);
  readonly maxInputValue = toDateInputValue(startOfDay(new Date()));

  private readonly listById = computed(() => {
    const map = new Map<string, { name: string; icon: string | null; color: string | null }>();
    for (const list of this.lists()) map.set(list.id, { name: list.name, icon: list.icon, color: list.color });
    return map;
  });

  readonly eventCount = computed(() => this.filteredEvents().length);
  readonly summaryText = computed(() => {
    const count = this.eventCount();
    return `${count} ${count === 1 ? "event" : "events"}`;
  });
  readonly hasActiveFilters = computed(() =>
    Boolean(this.searchQuery().trim()) ||
    this.boardFilterIds().length > 0 ||
    this.filterLabelIds().length > 0 ||
    this.filterMemberIds().length > 0 ||
    this.filterListIds().length > 0 ||
    this.filterCfConditions().length > 0
  );

  readonly daySentenceRef = computed(() => {
    const day = this.day();
    const todayKey = startOfDay(new Date()).getTime();
    if (day.getTime() === todayKey) return "today";
    if (day.getTime() === todayKey - DAY_MS) return "yesterday";
    return `on ${day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
  });

  readonly dayObjectRef = computed(() => {
    const day = this.day();
    const todayKey = startOfDay(new Date()).getTime();
    if (day.getTime() === todayKey) return "today";
    if (day.getTime() === todayKey - DAY_MS) return "yesterday";
    return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  });

  readonly emptyTitle = computed(() => {
    if (this.hasActiveFilters()) return "No matching work done";
    return this.daySentenceRef() === "today" ? "No work done today yet" : `No work done ${this.daySentenceRef()}`;
  });

  readonly emptyDescription = computed(() => {
    if (this.hasActiveFilters()) return `Try adjusting search or filters for ${this.dayObjectRef()}.`;
    return "Cards created, moved, or marked complete, plus checklist items completed that day, will appear here.";
  });

  constructor() {
    effect(() => {
      // Re-fetch whenever the selected day or the scope inputs change.
      this.day();
      this.boardId();
      this.workspaceId();
      this.userId();
      this.boardFilterIds();
      this.searchQuery();
      this.refreshVersion();
      void this.load();
    });
  }

  readonly customFields = this.state.customFields;

  // --- Row helpers ---------------------------------------------------------

  /** Event time-of-day in the viewer's locale, e.g. "9:05 AM". */
  timeFor(event: WorkDoneEvent): string {
    return new Date(event.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  /** Tabler icon name for each event type. */
  iconFor(event: WorkDoneEvent): string {
    switch (event.type) {
      case "created": return "plus";
      case "moved": return "arrow-right";
      case "completed": return "circle-check";
      case "checklistItemCompleted": return "checkbox";
    }
  }

  /** Short verb describing the event. */
  verbFor(event: WorkDoneEvent): string {
    switch (event.type) {
      case "created": return "Created";
      case "moved": return "Moved";
      case "completed": return "Completed";
      case "checklistItemCompleted": return "Checked off";
    }
  }

  /**
   * Move path as render segments, collapsing the middle of long journeys so the row
   * stays compact: a path of 5+ lists renders as "first → second → third → … → last".
   */
  movePathSegments(event: WorkDoneEvent): { text: string; icon: string | null; color: string | null; ellipsis: boolean }[] {
    if (event.type !== "moved") return [];
    const byId = this.listById();
    const resolved = event.listPath
      .map((id) => byId.get(id))
      .filter((l): l is { name: string; icon: string | null; color: string | null } => Boolean(l));
    const toSegment = (l: { name: string; icon: string | null; color: string | null }) =>
      ({ text: l.name, icon: l.icon, color: l.color, ellipsis: false });
    if (resolved.length <= MOVE_PATH_MAX) return resolved.map(toSegment);
    return [
      ...resolved.slice(0, MOVE_PATH_MAX - 1).map(toSegment),
      { text: "…", icon: null, color: null, ellipsis: true },
      toSegment(resolved[resolved.length - 1]!),
    ];
  }

  /** Actor display branches on type: checklist completions carry their own completedBy fields. */
  actorNameFor(event: WorkDoneEvent): string {
    return event.type === "checklistItemCompleted" ? event.completedByName : event.actorName;
  }

  actorAvatarFor(event: WorkDoneEvent): string | null {
    return event.type === "checklistItemCompleted" ? event.completedByAvatarUrl : event.actorAvatarUrl;
  }

  actorUserIdFor(event: WorkDoneEvent): string | null {
    return event.type === "checklistItemCompleted" ? event.completedByUserId : event.actorUserId;
  }

  boardSummaryFor(event: WorkDoneEvent): BoardSummary | null {
    return this.boardSummariesById()?.get(event.card.boardId) ?? null;
  }

  previousDay() {
    if (!this.canGoPrev()) return;
    this.day.set(startOfDay(new Date(this.day().getTime() - DAY_MS)));
  }

  nextDay() {
    if (!this.canGoNext()) return;
    this.day.set(startOfDay(new Date(this.day().getTime() + DAY_MS)));
  }

  today() {
    this.day.set(startOfDay(new Date()));
  }

  onPickerDate(value: string) {
    if (!value) return;
    const parts = value.split("-").map((part) => Number(part));
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return;
    const next = startOfDay(new Date(parts[0]!, parts[1]! - 1, parts[2]!));
    if (next.getTime() < this.minDay.getTime() || next.getTime() > startOfDay(new Date()).getTime()) return;
    this.day.set(next);
    this.datePickerOpen.set(false);
  }

  openCard(cardId: string) {
    this.cardOpened.emit(cardId);
  }

  isSelected(cardId: string): boolean {
    return this.selectedCardId() === cardId;
  }

  private async load() {
    const url = this.requestUrl();
    if (!url) {
      this.events.set([]);
      this.error.set(null);
      this.loading.set(false);
      return;
    }
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await this.api.get<WorkDoneResponse>(url);
      if (seq !== this.loadSeq) return;
      this.events.set(response.events ?? []);
    } catch {
      if (seq === this.loadSeq) this.error.set("Work history could not be loaded.");
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  private requestUrl(): string | null {
    const day = this.day();
    const from = day.toISOString();
    const to = new Date(day.getTime() + DAY_MS).toISOString();
    const params = new URLSearchParams({ from, to });
    const q = this.searchQuery().trim();
    if (q) params.set("q", q);
    if (this.scope() === "board") {
      const boardId = this.boardId();
      if (!boardId) return null;
      return `/boards/${boardId}/work-done?${params.toString()}`;
    }
    const workspaceId = this.workspaceId();
    const userId = this.userId();
    if (!workspaceId || !userId) return null;
    const boardFilters = this.boardFilterIds();
    // Keep the efficient server-side path for one board. For multiple boards the endpoint returns
    // the workspace day and filteredEvents narrows it client-side because the API accepts one id.
    if (boardFilters.length === 1) params.set("boardId", boardFilters[0]!);
    if (userId === ALL_ASSIGNED_WORK_USER_ID) return `/workspaces/${workspaceId}/assignees/work-done?${params.toString()}`;
    return `/workspaces/${workspaceId}/assignees/${userId}/work-done?${params.toString()}`;
  }

  // Label and custom-field filters apply to each event's card; the member filter
  // matches the event's actor (the card actor, or the checklist completer).
  readonly filteredEvents = computed(() => {
    const labelIds = this.filterLabelIds();
    const boardIds = this.boardFilterIds();
    const memberIds = this.filterMemberIds();
    const listIds = this.filterListIds();
    const conditions = this.filterCfConditions();
    if (!boardIds.length && !labelIds.length && !memberIds.length && !listIds.length && !conditions.length) return this.events();

    const boardFilterIds = new Set(boardIds);
    const labelFilterIds = new Set(labelIds);
    const memberFilterIds = new Set(memberIds);
    const listFilterIds = new Set(listIds);
    // Reuse the shared predicate so History-view CF filtering matches the board exactly.
    const fieldsById = conditions.length ? new Map(this.state.customFields().map((field) => [field.id, field])) : null;

    return this.events().filter((event) => {
      if (boardFilterIds.size && !boardFilterIds.has(event.boardId)) return false;
      if (labelIds.length && !event.card.labelIds.some((id) => labelFilterIds.has(id))) return false;
      if (listFilterIds.size && !listFilterIds.has(event.card.listId)) return false;
      if (memberIds.length) {
        const actorId = this.actorUserIdFor(event);
        if (!actorId || !memberFilterIds.has(actorId)) return false;
      }
      if (fieldsById) {
        const valuesByCard = new Map([[event.card.id, new Map(event.card.customFieldValues.map((v) => [v.fieldId, v]))]]);
        if (!matchesCfConditions(event.card.id, conditions, fieldsById, valuesByCard)) return false;
      }
      return true;
    });
  });
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
