import { CdkDrag, type CdkDragDrop, CdkDropList, CdkDropListGroup } from "@angular/cdk/drag-drop";
import { CdkScrollable } from "@angular/cdk/scrolling";
import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, output, signal } from "@angular/core";
import type { Card, List } from "@kanera/shared/schema";
import type { WireCard, WireCardSummary, WireList } from "@kanera/shared/events";
import { ApiClient } from "../../../core/api/api.client";
import { APP_DOM_EVENTS } from "../../../core/browser/browser-contracts";
import { ToastService } from "../../../shared/toast.service";
import { WorkspaceService } from "../../../core/workspace/workspace.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { CardKeyDisplayService } from "../../../shared/card-key-display.service";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WEEKDAY_LABELS, startOfWeek, weekdayIndex } from "../../../shared/week-start";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { BoardState } from "../board-state";
import { CardActionsMenuPopover } from "../card-actions-menu.popover";
import { CARD_DRAG_START_DELAY } from "../card-drag-scroll";
import type { CardAssigneePresentation } from "../card.component";
import { CardLabelsComponent, type CardLabelPresentation } from "../card-labels.component";
import { openCardDetailInNewTab } from "../card-navigation.util";
import { DUE_DATE_SLOT_OPTIONS, dueDateSlotFor, isOverdue, type DueDateSlot } from "../due-date.util";
import { formatDate, formatDateRange } from "../../../shared/date-format";
import { boardStateCardStore, TABLE_CARD_STORE, type TableCardStore } from "../table-view/table-card-store";

type AnyCard = Card | WireCard | WireCardSummary;
type AnyList = List | WireList;
type BoardSummary = { id: string; name: string; icon: string | null; iconColor: string | null };

interface CardSummaryFields {
  hasDescription?: boolean;
  commentCount?: number;
  attachmentCount?: number;
  checklistDoneCount?: number;
  checklistTotalCount?: number;
  coverUrl?: string | null;
}

interface CalendarDay {
  key: string;
  /** Day of the month, for the compact and phone cells that show the number alone. */
  dayNumber: number;
  /** false dims the cell: the day belongs to a neighbouring month (paged month view only). */
  inMonth: boolean;
  /** Renders nothing. The cell only exists to shift its week into the right weekday columns. */
  isPadding: boolean;
  isToday: boolean;
  cards: AnyCard[];
}

interface CalendarMonth {
  key: string;
  label: string;
  cardCount: number;
  /** Whole weeks only, so the cells tile a 7-column grid exactly. */
  days: CalendarDay[];
}

/**
 * How the calendar spends its width, measured on the component itself (not the viewport) because the
 * same calendar sits beside an open sidebar, a card-detail panel, or nothing at all.
 *
 * - `full` — seven roomy columns, every tile shows its whole context row.
 * - `compact` — still seven columns (dates must stay under their real weekday), but each column is
 *   only ~80–140px, so cells show the bare day number and a month cell caps its tiles behind
 *   "+N more" instead of growing into a column of slivers.
 * - `phone` — seven columns of tiles is unreadable, so the month becomes a grid of day numbers with
 *   due-card dots and the chosen day's cards listed underneath; a week becomes a vertical day list.
 */
export type CalendarLayout = "full" | "compact" | "phone";

/** Below this the seven tile columns are too narrow to read. Same value as `$bp-sheet`. */
const PHONE_MAX_WIDTH = 560;
/** Below this a column is under ~140px, where the full day heading and an uncapped stack stop fitting. */
const COMPACT_MAX_WIDTH = 1000;
/** Tiles a compact month cell shows before the rest fold behind "+N more". */
const COMPACT_MONTH_CARD_LIMIT = 3;

export function calendarLayoutForWidth(width: number): CalendarLayout {
  // 0 means "not laid out" (and every width in a DOM-less test): keep the full grid rather than
  // guessing a phone layout for a component that has not been measured.
  if (width <= 0) return "full";
  if (width < PHONE_MAX_WIDTH) return "phone";
  if (width < COMPACT_MAX_WIDTH) return "compact";
  return "full";
}

/**
 * The calendar for board and Global Work views. One component keeps day cards, tiles, and label
 * chips aligned between them.
 *
 * Two navigation models over the same grid:
 * - `paged` (default) — the toolbar walks one month or week at a time. Cards from the neighbouring
 *   month stay visible but dimmed, since no other grid on screen would show them.
 * - `stacked` — every month that holds a card is rendered in date order with no toolbar, for views
 *   that span many boards and are read by scrolling. Neighbouring-month cells stay blank there: the
 *   month itself is rendered further down, and repeating its cards would show a card twice.
 */
@Component({
  selector: "k-board-calendar-view",
  standalone: true,
  imports: [CdkDrag, CdkDropList, CdkDropListGroup, CdkScrollable, NgTemplateOutlet, AvatarComponent, CardActionsMenuPopover, CardLabelsComponent, SegmentedComponent, TooltipDirective],
  // The stacked view is a block in a page that scrolls itself, so the host must stop claiming the
  // pane height and clipping its own overflow. Bound here because :host styles cannot be switched by
  // a class on a child element.
  host: { "[class.is-stacked]": "navigation() === 'stacked'" },
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-calendar-view.component.html",
  styleUrl: "./board-calendar-view.component.scss",
})
export class BoardCalendarViewComponent {
  private readonly workspaces = inject(WorkspaceService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);
  private readonly toasts = inject(ToastService);
  /**
   * Where a rescheduled card lands before its realtime echo, so the tile jumps to the new day on
   * release rather than a round trip later. Same seam the table uses: Global Work provides its
   * query projection, a board falls back to `BoardState`, and a bare test harness has neither.
   */
  private readonly cardStore: TableCardStore | null = inject(TABLE_CARD_STORE, { optional: true })
    ?? (() => { const state = inject(BoardState, { optional: true }); return state ? boardStateCardStore(state, this.api) : null; })();
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;

  readonly cards = input.required<AnyCard[]>();
  readonly lists = input<AnyList[]>([]);
  readonly labelsByCard = input<Map<string, CardLabelPresentation[]>>(new Map());
  readonly assigneesByCard = input<Map<string, CardAssigneePresentation[]>>(new Map());
  readonly boardSummariesById = input<Map<string, BoardSummary> | null>(null);
  readonly filteredCardIds = input<Set<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly canEdit = input<boolean>(true);
  /**
   * Cards the viewer may reschedule when `canEdit` is on; `null` means all of them. Global Work
   * spans boards with different roles, so a read-only board's cards must not lift off the grid.
   */
  readonly editableCardIds = input<Set<string> | null>(null);
  readonly loading = input<boolean>(false);
  readonly navigation = input<"paged" | "stacked">("paged");

  readonly cardOpened = output<string>();

  readonly mode = signal<"month" | "week">("month");
  /** Labelled: "Month" and "Week" are short, and the two calendar glyphs are near-identical. */
  readonly modeOptions: SegmentedOption<"month" | "week">[] = [
    { id: "month", icon: "calendar-month", label: "Month" },
    { id: "week", icon: "calendar-week", label: "Week" },
  ];
  readonly anchorDate = signal(startOfDay(new Date()));
  readonly activeActionsCardId = signal<string | null>(null);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly weekdayLabels = WEEKDAY_LABELS;
  /** Touch waits, so a finger can still scroll the grid; the mouse has drag-scroll on the cell background. */
  readonly dragStartDelay = CARD_DRAG_START_DELAY;
  /** The day the lifted tile is over, for the drop highlight. */
  readonly dropTargetDayKey = signal<string | null>(null);
  /** Ids mid-flight to the API; the tile shows its new day already and must not be dragged again until settled. */
  readonly reschedulingCardIds = signal<Set<string>>(new Set());
  readonly skeletonDays = Array.from({ length: 35 }, (_, i) => i);
  readonly skeletonCards = [0, 1];

  /**
   * Seeded from the viewport so a phone does not paint a frame of the seven-column grid before the
   * first measurement; the host is never wider than the window, so this only ever errs towards the
   * roomier layout and the observer corrects it on the first frame.
   */
  readonly layout = signal<CalendarLayout>(
    calendarLayoutForWidth(typeof window === "undefined" ? 0 : window.innerWidth),
  );
  /** Month cells the user has opened past the compact cap with "+N more". */
  readonly expandedDayKeys = signal<ReadonlySet<string>>(new Set());
  /** The day picked in the phone month grid; `null` falls back to `phoneSelectedDayKey`'s default. */
  readonly pickedDayKey = signal<string | null>(null);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === "undefined") return;
      const host = this.element.nativeElement;
      const observer = new ResizeObserver(() => this.layout.set(calendarLayoutForWidth(host.clientWidth)));
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  readonly title = computed(() => {
    const anchor = this.anchorDate();
    if (this.mode() === "month") {
      return monthLabel(anchor);
    }
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    // Always spell the year in the header: the week is the page's only date anchor.
    return formatDateRange(start, end, { now: new Date(0) });
  });

  readonly visibleCards = computed(() => {
    const filter = this.filteredCardIds();
    return this.cards()
      .filter((card) => Boolean(card.dueDateLocalDate))
      .filter((card) => !filter || filter.has(card.id))
      .sort((a, b) => {
        const slotA = slotOrder(a.dueDateSlot);
        const slotB = slotOrder(b.dueDateSlot);
        if (slotA !== slotB) return slotA - slotB;
        return Number(a.position) - Number(b.position);
      });
  });

  private readonly cardsByDate = computed(() => {
    const byDate = new Map<string, AnyCard[]>();
    for (const card of this.visibleCards()) {
      const key = card.dueDateLocalDate;
      if (!key) continue;
      const day = byDate.get(key);
      if (day) day.push(card);
      else byDate.set(key, [card]);
    }
    return byDate;
  });

  /** The cells of the paged view: the anchor month padded to whole weeks, or the anchor week. */
  readonly days = computed<CalendarDay[]>(() => {
    const anchor = this.anchorDate();
    const monthMode = this.mode() === "month";
    const rangeStart = monthMode
      ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
      : startOfWeek(anchor);
    const rangeEnd = monthMode
      ? endOfWeek(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
      : addDays(rangeStart, 6);
    const cardsByDate = this.cardsByDate();
    const todayKey = toLocalDateKey(new Date());

    const days: CalendarDay[] = [];
    for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) {
      const key = toLocalDateKey(d);
      days.push({
        key,
        dayNumber: d.getDate(),
        // A week strip is not bounded by a month, so nothing in it is out of month.
        inMonth: !monthMode || d.getMonth() === anchor.getMonth(),
        isPadding: false,
        isToday: key === todayKey,
        cards: cardsByDate.get(key) ?? [],
      });
    }
    return days;
  });

  readonly months = computed<CalendarMonth[]>(() => {
    if (this.navigation() === "paged") {
      const days = this.days();
      return [{
        key: `${this.anchorDate().getFullYear()}-${this.anchorDate().getMonth() + 1}`,
        label: this.title(),
        cardCount: days.reduce((total, day) => total + day.cards.length, 0),
        days,
      }];
    }

    const cardsByDate = this.cardsByDate();
    const todayKey = toLocalDateKey(new Date());
    const monthKeys = [...new Set([...cardsByDate.keys()].map((key) => key.slice(0, 7)))].sort();
    return monthKeys.map((monthKey) => {
      const year = Number(monthKey.slice(0, 4));
      const month = Number(monthKey.slice(5, 7));
      // Day 0 of the next month is the last day of this one.
      const daysInMonth = new Date(year, month, 0).getDate();
      const leadingBlanks = weekdayIndex(new Date(year, month - 1, 1));
      const days: CalendarDay[] = [];
      for (let index = 0; index < leadingBlanks; index += 1) {
        days.push(paddingDay(`pad:${monthKey}:lead:${index}`));
      }
      let cardCount = 0;
      for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
        const key = `${monthKey}-${`${dayNumber}`.padStart(2, "0")}`;
        const cards = cardsByDate.get(key) ?? [];
        cardCount += cards.length;
        days.push({ key, dayNumber, inMonth: true, isPadding: false, isToday: key === todayKey, cards });
      }
      while (days.length % 7 !== 0) {
        days.push(paddingDay(`pad:${monthKey}:trail:${days.length}`));
      }
      return { key: monthKey, label: monthLabel(new Date(year, month - 1, 1)), cardCount, days };
    });
  });

  /**
   * The phone month's chosen day. An explicit pick wins while it is still on screen; otherwise
   * today when it is in this month, else the month's first day with something due, else the 1st —
   * so paging to another month always lands on a day worth looking at.
   */
  readonly phoneSelectedDay = computed<CalendarDay | null>(() => {
    const days = this.days();
    const picked = this.pickedDayKey();
    return days.find((day) => day.key === picked)
      ?? days.find((day) => day.isToday && day.inMonth)
      ?? days.find((day) => day.inMonth && day.cards.length)
      ?? days.find((day) => day.inMonth)
      ?? null;
  });

  pickDay(key: string) {
    this.pickedDayKey.set(key);
  }

  /** Cards a cell renders: everything, except a compact month cell that has not been expanded. */
  cellCards(day: CalendarDay): AnyCard[] {
    if (!this.isCapped(day)) return day.cards;
    return day.cards.slice(0, COMPACT_MONTH_CARD_LIMIT - 1);
  }

  /** How many tiles sit behind the cell's "+N more"; 0 when the cell shows them all. */
  hiddenCardCount(day: CalendarDay): number {
    return day.cards.length - this.cellCards(day).length;
  }

  /**
   * Only a compact month caps: a week is a single row with the whole pane's height to grow into, and
   * a full-width cell is wide enough that a tall day still reads as a column of cards. The cap hides
   * one more than the limit so "+N more" takes the last slot instead of a lone "+1" replacing one tile.
   */
  private isCapped(day: CalendarDay): boolean {
    // The stacked view is always a month grid, whatever the (hidden) paged mode says.
    const monthGrid = this.navigation() === "stacked" || this.mode() === "month";
    return this.layout() === "compact"
      && monthGrid
      && day.cards.length > COMPACT_MONTH_CARD_LIMIT
      && !this.expandedDayKeys().has(day.key);
  }

  toggleDayExpanded(key: string) {
    this.expandedDayKeys.update((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  isDayExpanded(key: string): boolean {
    return this.expandedDayKeys().has(key);
  }

  setMode(mode: "month" | "week") {
    this.mode.set(mode);
  }

  previous() {
    const anchor = this.anchorDate();
    this.anchorDate.set(this.mode() === "month"
      ? new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
      : addDays(anchor, -7));
  }

  next() {
    const anchor = this.anchorDate();
    this.anchorDate.set(this.mode() === "month"
      ? new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)
      : addDays(anchor, 7));
  }

  today() {
    this.anchorDate.set(startOfDay(new Date()));
  }

  openCard(cardId: string) {
    this.cardOpened.emit(cardId);
  }

  openCardInNewTab(card: AnyCard, event: MouseEvent) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openCardDetailInNewTab(card.organisationKey, card.key);
  }

  onCardContextMenu(card: AnyCard, event: MouseEvent) {
    if (!this.canEdit()) return;
    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, { detail: card.id }));
    this.actionsMenuPoint.set({ x: event.clientX, y: event.clientY });
    this.activeActionsCardId.set(card.id);
  }

  closeActionsMenu() {
    this.actionsMenuPoint.set(null);
    this.activeActionsCardId.set(null);
  }

  canEditCard(card: AnyCard): boolean {
    if (!this.canEdit()) return false;
    const editable = this.editableCardIds();
    return editable === null || editable.has(card.id);
  }

  canDragCard(card: AnyCard): boolean {
    return this.canEditCard(card) && !this.reschedulingCardIds().has(card.id);
  }

  /**
   * A tile released on another day keeps its time slot and moves its due date to that day. The drop
   * list data is the day key, so an empty slot and a populated cell are the same target.
   */
  async onCardDropped(event: CdkDragDrop<string, string, AnyCard>) {
    const card = event.item.data;
    const dueDateLocalDate = event.container.data;
    if (!card || !dueDateLocalDate || dueDateLocalDate === card.dueDateLocalDate) return;
    if (!this.canDragCard(card)) return;

    // The store re-renders the tile in its new cell immediately; the PATCH echo then converges on
    // the same value. On failure the card goes back where it was so the grid never lies.
    this.cardStore?.updateCard({ ...card, dueDateLocalDate });
    this.markRescheduling(card.id, true);
    try {
      const updated = await this.api.patch<AnyCard>(`/cards/${card.id}`, {
        dueDateLocalDate,
        // Preserve the slot: only the day changed. A card that never had a slot stays "any time".
        dueDateSlot: dueDateSlotFor(card.dueDateSlot),
      });
      this.cardStore?.updateCard(updated);
    } catch (error) {
      this.cardStore?.updateCard(card);
      this.toasts.error("Could not change the due date");
      throw error;
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

  workspaceIdFor(card: AnyCard): string | null {
    return this.workspaces.workspaceIdForBoard(card.boardId);
  }

  labelsForCard(cardId: string): CardLabelPresentation[] {
    return this.labelsByCard().get(cardId) ?? [];
  }

  assigneesForCard(cardId: string): CardAssigneePresentation[] {
    return this.assigneesByCard().get(cardId) ?? [];
  }

  boardSummaryFor(card: AnyCard): BoardSummary | null {
    return this.boardSummariesById()?.get(card.boardId) ?? null;
  }

  isSelected(cardId: string): boolean {
    return this.selectedCardId() === cardId;
  }

  isOverdue(card: AnyCard): boolean {
    return !card.archivedAt && !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  slotTime(card: AnyCard): string {
    const slot = dueDateSlotFor(card.dueDateSlot);
    if (slot === "anyTime") return "";
    return DUE_DATE_SLOT_OPTIONS.find((option) => option.value === slot)?.timeLabel ?? "";
  }

  /**
   * Day-cell heading: "1 Jul". No weekday — the cell sits under a labelled weekday column, so
   * repeating it in all 35 cells is noise. The month stays because the padding weeks of a month grid
   * belong to the neighbouring month.
   */
  dayLabel(key: string): string {
    return formatDate(localDate(key), "short", { now: localDate(key) });
  }

  /**
   * A compact column has room for the number alone. The 1st keeps its month so the rollover from
   * the dimmed neighbouring month into this one (and back) still reads without the full labels.
   */
  compactDayLabel(day: CalendarDay): string {
    return day.dayNumber === 1 ? this.dayLabel(day.key) : String(day.dayNumber);
  }

  /** Phone list heading: "Tue 6 Oct". The weekday is spelled because no column header names it. */
  agendaDayLabel(key: string): string {
    return formatDate(localDate(key), "weekday", { now: localDate(key) });
  }

  /** The full date for a phone month cell's accessible name, which otherwise reads as a bare number. */
  dayAccessibleLabel(day: CalendarDay): string {
    const date = formatDate(localDate(day.key), "long");
    if (!day.cards.length) return date;
    return `${date}, ${day.cards.length} ${day.cards.length === 1 ? "card" : "cards"} due`;
  }

  /**
   * Up to three dots under a phone month day, one per card, coloured by the card's state so an
   * overdue or finished day is visible before it is tapped. Past three, the count replaces the dots.
   */
  dayDots(day: CalendarDay): ("overdue" | "done" | "due")[] {
    return day.cards.slice(0, 3).map((card) => card.completedAt ? "done" : this.isOverdue(card) ? "overdue" : "due");
  }

  /** Stacked phone agenda: only days holding cards, so a year of months does not become a year of empty rows. */
  agendaDays(month: CalendarMonth): CalendarDay[] {
    return month.days.filter((day) => !day.isPadding && day.cards.length);
  }

  summary(card: AnyCard): CardSummaryFields {
    return card as CardSummaryFields;
  }

  visibleAssignees(cardId: string): CardAssigneePresentation[] {
    return this.assigneesForCard(cardId).slice(0, 2);
  }

  assigneeOverflow(cardId: string): number {
    return Math.max(0, this.assigneesForCard(cardId).length - 2);
  }

  hasMetaContent(card: AnyCard): boolean {
    const s = this.summary(card);
    return Boolean(
      s.hasDescription
      || (s.attachmentCount && s.attachmentCount > 0)
      || (s.checklistTotalCount && s.checklistTotalCount > 0),
    );
  }

}

function paddingDay(key: string): CalendarDay {
  return { key, dayNumber: 0, inMonth: false, isPadding: true, isToday: false, cards: [] };
}

function monthLabel(date: Date): string {
  return formatDate(date, "monthYear");
}

/** Noon, so a local date key can never land on the previous day through a timezone offset. */
function localDate(key: string): Date {
  return new Date(`${key}T12:00:00`);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfWeek(date: Date): Date {
  return addDays(startOfWeek(date), 6);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function slotOrder(slot: DueDateSlot | null | undefined): number {
  switch (dueDateSlotFor(slot)) {
    case "morning": return 1;
    case "afternoon": return 2;
    case "endOfWorkDay": return 3;
    case "anyTime": return 4;
  }
}
