import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { CdkDrag, type CdkDragDrop, CdkDropList } from "@angular/cdk/drag-drop";
import type { WorkCatalogPerson, WorkPriorityItem, WorkPriorityQueue } from "@kanera/shared/dto";
import { expandCardSummary, type WireCardSummary } from "@kanera/shared/events";
import { AvatarComponent } from "../../shared/avatar.component";
import { AnchoredPickerPopover } from "../../shared/anchored-picker.popover";
import type { PickerGroup } from "../../shared/picker-list.component";
import { priorityRankHeat } from "../../shared/priority-rank";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CARD_DRAG_START_DELAY } from "../board/card-drag-scroll";
import { CardActionsMenuPopover } from "../board/card-actions-menu.popover";
import { CardDragCoordinator } from "../board/card-drag-coordinator.service";
import { suppressDropCommitTransitions } from "../board/drop-commit-transition";
import { formatDueDate, isDueSoon, isOverdue } from "../board/due-date.util";
import { priorityAnchorAt, type PriorityAnchor } from "./priority-anchor";
import type { UpNextAddableCard } from "./up-next-panel.component";

export type TeamPriorityReorder = PriorityAnchor & { targetUserId: string; priorityId: string };

/** A queue entry with everything a dense row renders, resolved once per queue change. */
type LaneRow = {
  entry: WorkPriorityItem;
  card: WireCardSummary | null;
  boardName: string;
  boardIconClass: string;
  boardIconColor: string | null;
  listName: string;
};

type Lane = {
  target: WorkPriorityQueue["target"];
  queue: WorkPriorityQueue["queue"];
  rows: LaneRow[];
  avatarUrl: string | null;
  canReorder: boolean;
  reorderableWorkspaceIds: Set<string>;
  addableCards: UpNextAddableCard[];
  addGroups: PickerGroup[];
  atCapacity: boolean;
};

/** Same purpose as the panel's lane id: lets the state hold reconciles until the gesture ends. */
const LANES_DRAG = "team-priorities-lane";

/**
 * The Team Cards priorities display: one "Up next" lane per person whose queue this viewer may
 * read, side by side, so a manager reads the whole team's order without focusing each person in
 * turn.
 *
 * Rows are the Up next panel's dense two-liners — this display exists to communicate *order*, and
 * the numbers must read the same here as in the panel and on the tiles. Adding, reordering and
 * removing all work in place per lane while this display remains the whole readable team.
 *
 * Lanes are intentionally not connected to each other as drop lists: dragging a row from one
 * person's lane to another's would mean re-assigning the card, which is a card edit, not a
 * sequencing gesture. For the same reason a release outside the lane snaps back instead of
 * removing (unlike the single docked panel, the neighbouring lanes make "outside" one misdrop
 * away from someone else's queue) — removal is the row tool's ×.
 */
@Component({
  selector: "k-team-priorities-view",
  standalone: true,
  imports: [AnchoredPickerPopover, AvatarComponent, CardActionsMenuPopover, CdkDrag, CdkDropList, TooltipDirective],
  templateUrl: "./team-priorities-view.component.html",
  styleUrl: "./team-priorities-view.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeamPrioritiesViewComponent {
  private readonly cardDrag = inject(CardDragCoordinator);

  readonly queues = input<WorkPriorityQueue[]>([]);
  /** For lane-header avatars; targets outside the viewer's catalog just fall back to initials. */
  readonly people = input<WorkCatalogPerson[]>([]);
  /** False while the page is not interaction-ready. Per-lane curation rights still apply on top. */
  readonly canDrag = input(false);
  readonly error = input<string | null>(null);
  readonly maxEntries = input(50);
  readonly addableCardsByUserId = input<ReadonlyMap<string, UpNextAddableCard[]>>(new Map());
  readonly editableCardIds = input<ReadonlySet<string>>(new Set());
  /** Title-only search, matching Global Work's card query semantics without changing true ranks. */
  readonly searchQuery = input("");
  readonly selectedCardId = input<string | null>(null);

  // Drives the rank pill's --rank-heat: the top of each queue wears a deeper accent tint.
  protected readonly rankHeat = priorityRankHeat;

  readonly reordered = output<TeamPriorityReorder>();
  readonly removed = output<{ targetUserId: string; priorityId: string }>();
  readonly added = output<{ targetUserId: string; cardId: string }>();
  /** The page owns lane visibility so its profile toggles remain the way to restore a hidden lane. */
  readonly laneHidden = output<string>();
  readonly cardOpened = output<string>();
  // Touch uses the board's hold-to-drag gate so an ordinary vertical swipe keeps scrolling.
  protected readonly dragStartDelay = CARD_DRAG_START_DELAY;
  readonly addOpenAt = signal<{ targetUserId: string; at: "head" | "list" } | null>(null);
  readonly actionsCard = signal<WireCardSummary | null>(null);
  readonly actionsPoint = signal<{ x: number; y: number } | null>(null);

  private readonly avatarsByUserId = computed(
    () => new Map(this.people().map((person) => [person.userId, person.avatarUrl])),
  );

  readonly lanes = computed<Lane[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    return this.queues().map((lane) => {
      const addableCards = this.addableCardsByUserId().get(lane.target.userId) ?? [];
      return {
        target: lane.target,
        queue: lane.queue,
        avatarUrl: this.avatarsByUserId().get(lane.target.userId) ?? null,
        canReorder: this.canDrag() && lane.queue.canReorder,
        reorderableWorkspaceIds: new Set(lane.queue.reorderableWorkspaceIds),
        addableCards,
        addGroups: this.addGroups(addableCards),
        atCapacity: lane.queue.totalCount >= this.maxEntries(),
        // Server-resolved context only: every row here came from the batch response, and redacted
        // entries carry no context by design (the placeholder must not disclose where the card lives).
        rows: lane.queue.items.flatMap((entry) => {
          const card = entry.card ? expandCardSummary(entry.card) : null;
          if (query && !card?.title.toLowerCase().includes(query)) return [];
          const icon = entry.context?.boardIcon ?? "layout-kanban";
          const iconColor = entry.context?.boardIconColor ?? null;
          return [{
            entry,
            card,
            boardName: entry.context?.boardName ?? "",
            boardIconClass: `ti ti-${icon}`,
            boardIconColor: iconColor ? `var(--color-${iconColor})` : null,
            listName: entry.context?.listName ?? "",
          }];
        }),
      };
    });
  });

  toggleAdd(targetUserId: string, at: "head" | "list"): void {
    this.addOpenAt.update((current) =>
      current?.targetUserId === targetUserId && current.at === at ? null : { targetUserId, at }
    );
  }

  isAddOpen(targetUserId: string, at: "head" | "list"): boolean {
    const open = this.addOpenAt();
    return open?.targetUserId === targetUserId && open.at === at;
  }

  onAddPicked(targetUserId: string, cardId: string): void {
    this.addOpenAt.set(null);
    this.added.emit({ targetUserId, cardId });
  }

  private addGroups(cards: UpNextAddableCard[]): PickerGroup[] {
    const groups = new Map<string, PickerGroup>();
    for (const card of cards) {
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
  }

  onRowContextMenu(row: LaneRow, event: MouseEvent): void {
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

  isDraggable(lane: Lane, entry: WorkPriorityItem): boolean {
    // A redacted entry is a locked placeholder: allowing the drag would send an anchor the server
    // rejects, and the viewer has no rights over that card's workspace anyway.
    return lane.canReorder && entry.card !== null && lane.reorderableWorkspaceIds.has(entry.card.workspaceId);
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

  onDragStarted(): void {
    this.cardDrag.start(LANES_DRAG);
  }

  onDragEnded(): void {
    this.cardDrag.end();
  }

  onDrop(event: CdkDragDrop<unknown[]>, lane: Lane): void {
    suppressDropCommitTransitions(
      event.previousContainer.element.nativeElement,
      event.container.element.nativeElement,
    );
    const moved = lane.rows[event.previousIndex]?.entry;
    if (!moved) return;
    // Released outside the lane: snap back, on purpose. With lanes side by side, "outside" is one
    // misdrop from a neighbour's queue, so the drag-out-removes gesture the docked panel offers
    // would delete entries people meant to hand across. The row's × is the removal here.
    if (!event.isPointerOverContainer) return;
    if (event.previousIndex === event.currentIndex) return;
    const rest = lane.queue.items.filter((item) => item.id !== moved.id);
    const anchor = this.searchQuery().trim()
      ? this.filteredAnchor(lane, moved.id, event.currentIndex)
      : priorityAnchorAt(rest, event.currentIndex);
    if (!anchor) return;
    this.reordered.emit({
      targetUserId: lane.target.userId,
      priorityId: moved.id,
      ...anchor,
    });
  }

  /**
   * One step up or down, for keyboard and coarse pointers. Anchors are computed in "rest"
   * coordinates (the queue without the moved row), the same frame `onDrop` uses, so a step over a
   * redacted neighbour resolves exactly like a drop next to it.
   */
  moveBy(lane: Lane, entry: WorkPriorityItem, delta: number): void {
    const index = lane.rows.findIndex((row) => row.entry.id === entry.id);
    if (index < 0) return;
    const target = Math.max(0, Math.min(lane.rows.length - 1, index + delta));
    if (target === index) return;
    const rest = lane.queue.items.filter((item) => item.id !== entry.id);
    const anchor = this.searchQuery().trim()
      ? this.filteredAnchor(lane, entry.id, target)
      : priorityAnchorAt(rest, target);
    if (!anchor) return;
    this.reordered.emit({
      targetUserId: lane.target.userId,
      priorityId: entry.id,
      ...anchor,
    });
  }

  /**
   * A filtered drop stays relative to the nearest matching card instead of jumping to the absolute
   * head/tail of the full queue, whose non-matching rows are intentionally still in place.
   */
  private filteredAnchor(lane: Lane, movedId: string, index: number): PriorityAnchor | null {
    const visibleRest = lane.rows.map((row) => row.entry).filter((item) => item.id !== movedId);
    if (visibleRest.length === 0) return null;
    const below = visibleRest[index];
    return below ? { beforeId: below.id } : { afterId: visibleRest.at(-1)!.id };
  }
}
