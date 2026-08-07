import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal } from "@angular/core";
import { CdkDrag, type CdkDragDrop, type CdkDragMove, CdkDropList } from "@angular/cdk/drag-drop";
import type { BoardLaneItem } from "../board/board-state";
import type { WorkCatalog, WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { expandCardSummary, type WireCardSummary } from "@kanera/shared/events";
import { AnchoredPickerPopover } from "../../shared/anchored-picker.popover";
import type { PickerGroup } from "../../shared/picker-list.component";
import { priorityRankHeat } from "../../shared/priority-rank";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CardActionsMenuPopover } from "../board/card-actions-menu.popover";
import { CardDragCoordinator } from "../board/card-drag-coordinator.service";
import { suppressDropCommitTransitions } from "../board/drop-commit-transition";
import { formatDueDate, isDueSoon, isOverdue } from "../board/due-date.util";
import { priorityAnchorAt, type PriorityAnchor } from "./priority-anchor";

export type { PriorityAnchor };
export type PriorityReorder = PriorityAnchor & { priorityId: string };

/** A card the viewer may queue, with enough context to pick it out of a cross-board list. */
export type UpNextAddableCard = {
  id: string;
  title: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardIconColor: string | null;
  listName: string;
};

/** A queue entry with everything a dense row renders, resolved once per queue change. */
type PanelRow = {
  entry: WorkPriorityItem;
  card: WireCardSummary | null;
  boardName: string;
  boardIconClass: string;
  boardIconColor: string | null;
  listName: string;
};

/**
 * Registering drags under a stable lane id is what lets the state's realtime handling hold a
 * refresh until the gesture ends (see `whenCardDragIdle()`), so the actor's own invalidation echo
 * never reorders the queue under the pointer.
 */
const PANEL_LANE = "up-next-panel";

/**
 * The Up next panel: one person's ordered queue, docked beside whichever display the page is
 * showing.
 *
 * Rows are dense two-liners rather than full card tiles because the one thing this surface exists
 * to communicate is the *order*, and a column of tiles lets barely five ranks into the viewport.
 * The card itself is one click away, and its rank pill on the tile already carries the tile-level
 * context. Adding to the queue happens on the tiles ("+ Up next"), not here — the display the
 * reader already uses is the candidate pool, with all its filters and grouping intact.
 *
 * The queue is deliberately filter-independent. Docked beside the filtered display rather than
 * rendered as a lane inside it, that stops needing an explanatory chip: a separate panel is
 * visibly a separate scope.
 */
@Component({
  selector: "k-up-next-panel",
  standalone: true,
  imports: [AnchoredPickerPopover, CardActionsMenuPopover, CdkDrag, CdkDropList, TooltipDirective],
  templateUrl: "./up-next-panel.component.html",
  styleUrl: "./up-next-panel.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpNextPanelComponent {
  private readonly cardDrag = inject(CardDragCoordinator);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly priorities = input<WorkPrioritiesResponse | null>(null);
  /** For board/list names on optimistic rows, whose server-resolved `context` has not arrived. */
  readonly catalog = input<WorkCatalog | null>(null);
  readonly boardSummariesById = input<Map<string, { id: string; name: string; icon: string | null; iconColor: string | null }>>(new Map());
  /** False while the page is not interaction-ready, or when the viewer may not curate this queue. */
  readonly canDrag = input(false);
  /** The queue owner's name when curating somebody else; null reads as "your own". */
  readonly targetName = input<string | null>(null);
  readonly maxEntries = input(50);
  readonly error = input<string | null>(null);
  readonly selectedCardId = input<string | null>(null);
  /**
   * Cards the "Add card" picker offers — already filtered by the host to what the server would
   * accept. This picker is the always-visible way in; the tiles' hover "+" is a shortcut, and on
   * touch screens (no hover) this button is the primary affordance.
   */
  readonly addableCards = input<UpNextAddableCard[]>([]);
  /**
   * Cards whose board role lets this viewer act on them — gates the right-click actions menu the
   * same way the table view's canEdit does, so the menu never offers writes the server will refuse.
   */
  readonly editableCardIds = input<ReadonlySet<string>>(new Set());

  // Drives the rank pill's --rank-heat: the top of the queue wears a deeper accent tint.
  protected readonly rankHeat = priorityRankHeat;

  readonly reordered = output<PriorityReorder>();
  readonly removed = output<{ priorityId: string }>();
  /** A new card for the queue, with the anchor for where it was dropped (append when picked). */
  readonly added = output<PriorityAnchor & { cardId: string }>();
  readonly cardOpened = output<string>();
  readonly closed = output<void>();

  /**
   * Which of the two Add card affordances the picker is anchored to: the header's "+" or the
   * inline button under the last row. One value rather than two booleans so both can never be
   * open at once.
   */
  readonly addOpenAt = signal<"head" | "list" | null>(null);
  readonly addOpen = computed(() => this.addOpenAt() !== null);

  private readonly addableCardIds = computed(() => new Set(this.addableCards().map((card) => card.id)));

  /**
   * Gate for board tiles dragged over the panel (the lanes name this drop list in their
   * `cdkDropListConnectedTo`). Only a card the server would accept may enter; everything else
   * bounces back to its lane instead of landing and then erroring. Arrow property because CDK
   * calls the predicate unbound.
   */
  readonly canEnterFromBoard = (drag: CdkDrag<unknown>): boolean => {
    const data = drag.data as BoardLaneItem | undefined;
    return data?.kind === "card"
      && this.canReorder()
      && !this.atCapacity()
      && this.addableCardIds().has(data.card.id);
  };

  readonly items = computed<WorkPriorityItem[]>(() => this.priorities()?.items ?? []);
  readonly totalCount = computed(() => this.priorities()?.totalCount ?? 0);
  readonly hiddenCount = computed(() => this.priorities()?.hiddenCount ?? 0);
  readonly atCapacity = computed(() => this.totalCount() >= this.maxEntries());
  readonly canReorder = computed(() => this.canDrag() && (this.priorities()?.canReorder ?? false));

  private readonly reorderableWorkspaceIds = computed(
    () => new Set(this.priorities()?.reorderableWorkspaceIds ?? []),
  );
  private readonly listsById = computed(
    () => new Map((this.catalog()?.lists ?? []).map((list) => [list.id, list])),
  );

  /**
   * Server-resolved `context` wins because it covers boards the catalog cannot see (a guest board
   * from another organisation is in the queue but not necessarily in this viewer's work catalog).
   * The catalog and board summaries only backfill optimistic rows, whose context is still null.
   */
  readonly rows = computed<PanelRow[]>(() =>
    this.items().map((entry) => {
      const card = entry.card ? expandCardSummary(entry.card) : null;
      const board = card ? this.boardSummariesById().get(card.boardId) ?? null : null;
      const list = card ? this.listsById().get(card.listId) ?? null : null;
      const icon = entry.context?.boardIcon ?? board?.icon ?? "layout-kanban";
      const iconColor = entry.context?.boardIconColor ?? board?.iconColor ?? null;
      return {
        entry,
        card,
        boardName: entry.context?.boardName ?? board?.name ?? "",
        boardIconClass: `ti ti-${icon}`,
        boardIconColor: iconColor ? `var(--color-${iconColor})` : null,
        listName: entry.context?.listName ?? list?.name ?? "",
      };
    }),
  );

  /**
   * The picker's rows, grouped per board the way the create-card and scope pickers group theirs, so
   * a cross-board pool of similar titles ("Fix login") stays tellable-apart.
   */
  readonly addGroups = computed<PickerGroup[]>(() => {
    const groups = new Map<string, PickerGroup>();
    for (const card of this.addableCards()) {
      const group = groups.get(card.boardId) ?? {
        id: card.boardId,
        label: card.boardName,
        icon: card.boardIcon ?? "layout-kanban",
        color: card.boardIconColor,
        options: [],
      };
      group.options.push({ id: card.id, label: card.title, hint: card.listName || null });
      groups.set(card.boardId, group);
    }
    return [...groups.values()];
  });

  toggleAdd(at: "head" | "list" = "list"): void {
    this.addOpenAt.update((current) => (current === at ? null : at));
  }

  onAddPicked(cardId: string): void {
    this.addOpenAt.set(null);
    this.added.emit({ cardId, beforeId: null });
  }

  isDraggable(entry: WorkPriorityItem): boolean {
    // A redacted entry is a locked placeholder: allowing the drag would send an anchor the server
    // rejects, and the viewer has no rights over that card's workspace anyway.
    return this.canReorder() && entry.card !== null && this.reorderableWorkspaceIds().has(entry.card.workspaceId);
  }

  dueText(card: WireCardSummary): string | null {
    if (!card.dueDateLocalDate) return null;
    return formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  dueOverdue(card: WireCardSummary): boolean {
    return isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  dueSoon(card: WireCardSummary): boolean {
    return isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  /** The right-clicked row's card, holding the same actions menu a table row or tile offers. */
  readonly actionsCard = signal<WireCardSummary | null>(null);
  readonly actionsPoint = signal<{ x: number; y: number } | null>(null);

  onRowContextMenu(row: PanelRow, event: MouseEvent): void {
    // Redacted rows have nothing to act on; rows the viewer cannot edit keep the browser's own
    // menu rather than opening one whose every action the server would refuse.
    if (!row.card || !this.editableCardIds().has(row.card.id)) return;
    event.preventDefault();
    event.stopPropagation();
    this.actionsPoint.set({ x: event.clientX, y: event.clientY });
    this.actionsCard.set(row.card);
  }

  closeActionsMenu(): void {
    this.actionsCard.set(null);
    this.actionsPoint.set(null);
  }

  onDragStarted(): void {
    this.cardDrag.start(PANEL_LANE);
  }

  onDragEnded(): void {
    this.cardDrag.end();
  }

  /**
   * Mirrors "is the pointer outside the rows scroller" onto the CDK preview clone as a class, so
   * the preview can dim into its "release removes" reading. Tracked against the same drop-list
   * element CDK measures for `isPointerOverContainer`, so the cue and the outcome always agree.
   * Queried from the document because CDK appends the preview to the body and exposes no handle to
   * it; the `.panel-row` scoping keeps this away from other drags' previews.
   */
  onDragMoved(event: CdkDragMove<unknown>): void {
    const rowsElement = this.host.nativeElement.querySelector(".panel-rows");
    const preview = document.querySelector<HTMLElement>(".panel-row.cdk-drag-preview");
    if (!rowsElement || !preview) return;
    const rect = rowsElement.getBoundingClientRect();
    const { x, y } = event.pointerPosition;
    const outside = x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
    preview.classList.toggle("drag-outside", outside);
  }

  /**
   * An outside release removes the row (see onDrop), but CDK first animates the preview back into
   * the list and only fires the drop — and with it the removal — after that snap-back completes,
   * which reads as "it came back, then vanished". Zeroing the preview's transition here, at the
   * release moment, makes CDK resolve the animation immediately so the removal is instant.
   */
  onDragReleased(): void {
    const preview = document.querySelector<HTMLElement>(".panel-row.cdk-drag-preview.drag-outside");
    if (preview) preview.style.transition = "none";
  }

  onDrop(event: CdkDragDrop<unknown[]>): void {
    suppressDropCommitTransitions(
      event.previousContainer.element.nativeElement,
      event.container.element.nativeElement,
    );
    if (event.previousContainer.id !== event.container.id) {
      // A board tile dropped in: join at the slot the pointer released it, in the same anchor
      // frame a reorder uses — the full queue is the "rest", since nothing was lifted out of it.
      const data = event.item.data as BoardLaneItem | undefined;
      if (data?.kind !== "card" || !this.canEnterFromBoard(event.item)) return;
      this.added.emit({ cardId: data.card.id, ...priorityAnchorAt(this.items(), event.currentIndex) });
      return;
    }
    const moved = this.items()[event.previousIndex];
    if (!moved) return;
    // Released outside the panel: the gesture reads "take it out of the queue", so it performs the
    // same removal the row's × does. Safe to key off the release point alone — CDK fires drops only
    // on an actual pointer release, so there is no cancelled-drag path that could land here, and
    // nothing else accepts these rows (the panel's list is connected to no other drop list).
    if (!event.isPointerOverContainer) {
      this.removed.emit({ priorityId: moved.id });
      return;
    }
    if (event.previousIndex === event.currentIndex) return;
    const rest = this.items().filter((item) => item.id !== moved.id);
    this.reordered.emit({ priorityId: moved.id, ...priorityAnchorAt(rest, event.currentIndex) });
  }

  /**
   * One step up or down, for keyboard and coarse pointers, where a precise drag is the worst verb.
   * Anchors are computed in "rest" coordinates (the queue without the moved row), the same frame
   * `onDrop` uses, so a step over a redacted neighbour resolves exactly like a drop next to it.
   */
  moveBy(entry: WorkPriorityItem, delta: number): void {
    const index = this.items().findIndex((item) => item.id === entry.id);
    if (index < 0) return;
    const target = Math.max(0, Math.min(this.items().length - 1, index + delta));
    if (target === index) return;
    const rest = this.items().filter((item) => item.id !== entry.id);
    this.reordered.emit({ priorityId: entry.id, ...priorityAnchorAt(rest, target) });
  }

}
