import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal } from "@angular/core";
import type { Card, List } from "@kanera/shared/schema";
import type { WireCard, WireCardSummary, WireList } from "@kanera/shared/events";
import { APP_DOM_EVENTS } from "../../../core/browser/browser-contracts";
import { WorkspaceService } from "../../../core/workspace/workspace.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { CardKeyDisplayService } from "../../../shared/card-key-display.service";
import { DragScrollDirective, ScrollSyncGroup } from "../../../shared/drag-scroll.directive";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WEEKDAY_LABELS, startOfWeek, weekdayIndex } from "../../../shared/week-start";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { CardActionsMenuPopover } from "../card-actions-menu.popover";
import type { CardAssigneePresentation } from "../card.component";
import { CardLabelsComponent, type CardLabelPresentation } from "../card-labels.component";
import { openCardDetailInNewTab } from "../card-navigation.util";
import { DUE_DATE_SLOT_OPTIONS, dueDateSlotFor, isOverdue, type DueDateSlot } from "../due-date.util";

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
  imports: [NgTemplateOutlet, AvatarComponent, CardActionsMenuPopover, CardLabelsComponent, DragScrollDirective, SegmentedComponent, TooltipDirective],
  // One group per calendar instance, so the month panels of this calendar stay on the same weekday
  // columns without reaching into a calendar rendered elsewhere on the page.
  providers: [ScrollSyncGroup],
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
  private readonly injector = inject(Injector);
  private readonly scrollGroup = inject(ScrollSyncGroup);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  private centredOnToday = false;

  readonly cards = input.required<AnyCard[]>();
  readonly lists = input<AnyList[]>([]);
  readonly labelsByCard = input<Map<string, CardLabelPresentation[]>>(new Map());
  readonly assigneesByCard = input<Map<string, CardAssigneePresentation[]>>(new Map());
  readonly boardSummariesById = input<Map<string, BoardSummary> | null>(null);
  readonly filteredCardIds = input<Set<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly canEdit = input<boolean>(true);
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
  readonly skeletonDays = Array.from({ length: 35 }, (_, i) => i);
  readonly skeletonCards = [0, 1];

  constructor() {
    // A day column never compresses below a width that keeps its cards readable, so seven of them
    // are wider than almost any viewport and the month always scrolls sideways. Left alone it would
    // open on Monday; centre today's column instead, once, as soon as a real grid has been laid out.
    effect(() => {
      if (this.centredOnToday || this.loading() || !this.months().length) return;
      afterNextRender(() => this.centreTodayColumn(), { injector: this.injector });
    });
  }

  private centreTodayColumn(): void {
    if (this.centredOnToday) return;
    const host = this.element.nativeElement;
    // An unscrollable panel has not been laid out yet (or has nothing to centre within), so leave
    // the one attempt open for the next render rather than spending it on an empty grid.
    const panel = host.querySelector<HTMLElement>(".calendar-month-scroll");
    if (!panel || panel.scrollWidth <= panel.clientWidth) return;
    this.centredOnToday = true;

    const cell = host.querySelector<HTMLElement>(".calendar-month-scroll .is-today");
    const scroller = cell?.closest<HTMLElement>(".calendar-month-scroll");
    if (!cell || !scroller) return;
    // Both are laid out against the host, so the difference is the cell's offset inside the scroller.
    const withinScroller = cell.offsetLeft - scroller.offsetLeft;
    this.scrollGroup.scrollTo(Math.max(0, withinScroller - (scroller.clientWidth - cell.offsetWidth) / 2));
  }

  readonly title = computed(() => {
    const anchor = this.anchorDate();
    if (this.mode() === "month") {
      return monthLabel(anchor);
    }
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const sameYear = start.getFullYear() === end.getFullYear();
    const startFmt = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const endFmt = end.toLocaleDateString("en-US", sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
    const year = sameYear ? end.getFullYear() : `${start.getFullYear()} - ${end.getFullYear()}`;
    return `${startFmt} – ${endFmt}, ${year}`;
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
        days.push({ key, inMonth: true, isPadding: false, isToday: key === todayKey, cards });
      }
      while (days.length % 7 !== 0) {
        days.push(paddingDay(`pad:${monthKey}:trail:${days.length}`));
      }
      return { key: monthKey, label: monthLabel(new Date(year, month - 1, 1)), cardCount, days };
    });
  });

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

  slotLabel(card: AnyCard): string {
    const slot = dueDateSlotFor(card.dueDateSlot);
    if (slot === "anyTime") return "";
    return DUE_DATE_SLOT_OPTIONS.find((option) => option.value === slot)?.shortLabel ?? "";
  }

  slotTime(card: AnyCard): string {
    const slot = dueDateSlotFor(card.dueDateSlot);
    if (slot === "anyTime") return "";
    return DUE_DATE_SLOT_OPTIONS.find((option) => option.value === slot)?.timeLabel ?? "";
  }

  /**
   * Day-cell heading: "1 July". No weekday — the cell sits under a labelled weekday column, so
   * repeating it in all 35 cells is noise. The month is spelled out rather than abbreviated: a day
   * column is 233px at its narrowest, so there is room, and it stays at all because the padding weeks
   * of a month grid belong to the neighbouring month. The full date is the cell's tooltip.
   */
  dayLabel(key: string): string {
    return localDate(key).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  }

  dayTooltip(key: string): string {
    return localDate(key).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
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
  return { key, inMonth: false, isPadding: true, isToday: false, cards: [] };
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
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
