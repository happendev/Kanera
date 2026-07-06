import { ChangeDetectionStrategy, Component, HostListener, computed, inject, input, output, signal } from "@angular/core";
import type { Card, CardLabel, List } from "@kanera/shared/schema";
import type { WireBoardMemberUser, WireCard, WireCardLabel, WireCardSummary, WireList } from "@kanera/shared/events";
import { APP_DOM_EVENTS } from "../../../core/browser/browser-contracts";
import { WorkspaceService } from "../../../core/workspace/workspace.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { CardActionsMenuPopover } from "../card-actions-menu.popover";
import { openCardDetailInNewTab } from "../card-navigation.util";
import { DUE_DATE_SLOT_OPTIONS, dueDateSlotFor, isOverdue, type DueDateSlot } from "../due-date.util";

type AnyCard = Card | WireCard | WireCardSummary;
type AnyList = List | WireList;
type AnyLabel = CardLabel | WireCardLabel;
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
  date: Date;
  key: string;
  dayNumber: number;
  inCurrentMonth: boolean;
  isToday: boolean;
  cards: AnyCard[];
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

@Component({
  selector: "k-board-calendar-view",
  standalone: true,
  imports: [AvatarComponent, CardActionsMenuPopover, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-calendar-view.component.html",
  styleUrl: "./board-calendar-view.component.scss",
})
export class BoardCalendarViewComponent {
  private readonly workspaces = inject(WorkspaceService);

  readonly cards = input.required<AnyCard[]>();
  readonly lists = input<AnyList[]>([]);
  readonly labelsByCard = input<Map<string, AnyLabel[]>>(new Map());
  readonly assigneesByCard = input<Map<string, WireBoardMemberUser[]>>(new Map());
  readonly boardSummariesById = input<Map<string, BoardSummary> | null>(null);
  readonly filteredCardIds = input<Set<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly canEdit = input<boolean>(true);
  readonly loading = input<boolean>(false);

  readonly cardOpened = output<string>();

  readonly mode = signal<"month" | "week">("month");
  readonly anchorDate = signal(startOfDay(new Date()));
  readonly activeActionsCardId = signal<string | null>(null);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly weekdayLabels = WEEKDAY_LABELS;
  readonly skeletonDays = Array.from({ length: 35 }, (_, i) => i);
  readonly skeletonCards = [0, 1];

  readonly title = computed(() => {
    const anchor = this.anchorDate();
    if (this.mode() === "month") {
      return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
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

  readonly days = computed(() => {
    const anchor = this.anchorDate();
    const rangeStart = this.mode() === "month"
      ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
      : startOfWeek(anchor);
    const rangeEnd = this.mode() === "month"
      ? endOfWeek(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
      : addDays(rangeStart, 6);
    const cardsByDate = new Map<string, AnyCard[]>();
    for (const card of this.visibleCards()) {
      const key = card.dueDateLocalDate;
      if (!key) continue;
      const list = cardsByDate.get(key);
      if (list) list.push(card);
      else cardsByDate.set(key, [card]);
    }

    const todayKey = toLocalDateKey(new Date());
    const days: CalendarDay[] = [];
    for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) {
      const key = toLocalDateKey(d);
      days.push({
        date: d,
        key,
        dayNumber: d.getDate(),
        inCurrentMonth: d.getMonth() === anchor.getMonth(),
        isToday: key === todayKey,
        cards: cardsByDate.get(key) ?? [],
      });
    }
    return days;
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
    openCardDetailInNewTab(card.boardId, card.id);
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

  labelsForCard(cardId: string): AnyLabel[] {
    return this.labelsByCard().get(cardId) ?? [];
  }

  assigneesForCard(cardId: string): WireBoardMemberUser[] {
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

  visibleLabels(cardId: string): AnyLabel[] {
    return this.labelsForCard(cardId).slice(0, 4);
  }

  hiddenLabelCount(cardId: string): number {
    return Math.max(0, this.labelsForCard(cardId).length - 4);
  }

  summary(card: AnyCard): CardSummaryFields {
    return card as CardSummaryFields;
  }

  visibleAssignees(cardId: string): WireBoardMemberUser[] {
    return this.assigneesForCard(cardId).slice(0, 2);
  }

  assigneeOverflow(cardId: string): number {
    return Math.max(0, this.assigneesForCard(cardId).length - 2);
  }

  hasSecondaryContent(card: AnyCard): boolean {
    return this.hasMetaContent(card) || this.assigneesForCard(card.id).length > 0;
  }

  hasMetaContent(card: AnyCard): boolean {
    const s = this.summary(card);
    return Boolean(
      s.hasDescription
      || (s.attachmentCount && s.attachmentCount > 0)
      || (s.checklistTotalCount && s.checklistTotalCount > 0),
    );
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent) {
    if (!this.activeActionsCardId()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("k-card-actions-menu, .cam-panel, .bp-panel, .dp-panel, .lp-panel, .qe-panel, .qe-popover")) return;
    this.closeActionsMenu();
  }

  @HostListener("document:kanera:card-actions-menu-open", ["$event"])
  onActionsMenuOpenElsewhere(event: Event) {
    const openedCardId = event instanceof CustomEvent ? (event as CustomEvent<string>).detail : null;
    if (openedCardId !== this.activeActionsCardId()) this.closeActionsMenu();
  }
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -date.getDay());
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
