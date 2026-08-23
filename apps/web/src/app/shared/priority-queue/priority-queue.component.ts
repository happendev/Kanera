import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal } from "@angular/core";
import { CdkDrag, type CdkDragDrop, type CdkDragMove, CdkDropList } from "@angular/cdk/drag-drop";
import type { WorkCatalog, WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { expandCardSummary, type WireCardSummary } from "@kanera/shared/events";
import type { BoardLaneItem } from "../../features/board/board-state";
import { CardActionsMenuPopover } from "../../features/board/card-actions-menu.popover";
import { CardDragCoordinator } from "../../features/board/card-drag-coordinator.service";
import { CardLabelsComponent, type CardLabelPresentation } from "../../features/board/card-labels.component";
import { suppressDropCommitTransitions } from "../../features/board/drop-commit-transition";
import { formatDueDate, isDueSoon, isOverdue } from "../../features/board/due-date.util";
import { AnchoredPickerPopover } from "../anchored-picker.popover";
import { CardKeyDisplayService } from "../card-key-display.service";
import type { PickerGroup } from "../picker-list.component";
import { priorityRankHeat } from "../priority-rank";
import { TooltipDirective } from "../tooltip.directive";
import { priorityAddGroups, type PriorityAddableCard } from "./priority-add-cards";
import { priorityAnchorAt, type PriorityAnchor } from "./priority-queue-math";

export type { PriorityAnchor, PriorityAddableCard };
export type PriorityReorder = PriorityAnchor & { priorityId: string };

/** A queue entry with everything a dense row renders, resolved once per queue change. */
type QueueRow = {
  entry: WorkPriorityItem;
  card: WireCardSummary | null;
  boardName: string;
  boardIconClass: string;
  boardIconColor: string | null;
  listName: string;
  /**
   * The list's own icon and colour, resolved the same way the board's are. A queued card's list *is*
   * its state, so the row states it in the list's own colour rather than as the grey tail of a
   * board·list trail — the same treatment the notifications drawer's breadcrumb gives it.
   */
  listIconClass: string;
  listColor: string | null;
  /**
   * Resolved server-side into `context`, never looked up client-side: Home never loads a work
   * catalog, and a guest board from another organisation is in the queue but absent from the
   * viewer's catalog. Empty on an optimistic row until the server's response lands.
   */
  labels: CardLabelPresentation[];
};

/** One open right-click menu. `token` identifies the *opening*, not the card — see `actionsMenu`. */
type QueueActionsMenu = {
  token: number;
  card: WireCardSummary;
  point: { x: number; y: number };
};

/**
 * One ordered priority queue, rendered as dense rows — the single implementation behind every
 * surface that shows "Up next": the shell drawer, the My Cards dock, and Home's top-of-queue block.
 *
 * Rows are dense two-liners rather than full card tiles because the one thing these surfaces exist
 * to communicate is the *order*, and a column of tiles lets barely five ranks into the viewport.
 * The card itself is one click away, and its rank pill on the tile already carries the tile-level
 * context.
 *
 * Deliberately chrome-free: no header, no title, no close button. Each host owns its own frame
 * (a drawer, a docked panel, a section on Home), and only the rows, their gestures and the add
 * affordance are shared. That is what lets two hosts be mounted at once without one's chrome
 * bleeding into the other's.
 */
@Component({
  selector: "k-priority-queue",
  standalone: true,
  imports: [AnchoredPickerPopover, CardActionsMenuPopover, CardLabelsComponent, CdkDrag, CdkDropList, TooltipDirective],
  templateUrl: "./priority-queue.component.html",
  styleUrl: "./priority-queue.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Compact hosts (Home's section) are laid out by the page, not by a scroller, so the host must
  // size to its content and must not clip the hover toolbar's lift.
  host: { "[class.is-compact-host]": "compact()" },
})
export class PriorityQueueComponent {
  private readonly cardDrag = inject(CardDragCoordinator);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;

  readonly priorities = input<WorkPrioritiesResponse | null>(null);
  /** For board/list names on optimistic rows, whose server-resolved `context` has not arrived. */
  readonly catalog = input<WorkCatalog | null>(null);
  readonly boardSummariesById = input<Map<string, { id: string; name: string; icon: string | null; iconColor: string | null }>>(new Map());
  /** False while the host is not interaction-ready, or when the viewer may not curate this queue. */
  readonly canDrag = input(false);
  readonly maxEntries = input(50);
  readonly selectedCardId = input<string | null>(null);
  /**
   * Cards the "Add card" picker offers — already filtered by the host to what the server would
   * accept. This picker is the always-visible way in; the tiles' hover "+" is a shortcut, and on
   * touch screens (no hover) this button is the primary affordance.
   */
  readonly addableCards = input<PriorityAddableCard[]>([]);
  /**
   * Cards whose board role lets this viewer act on them — gates the right-click actions menu the
   * same way the table view's canEdit does, so the menu never offers writes the server will refuse.
   *
   * `null` means the host has no role information to gate with, which is the honest answer for the
   * shell drawer and Home: their queue response carries no board role (see WorkPrioritiesResponse),
   * and only Global Work happens to hold a boards list it can derive one from. Those hosts show the
   * menu on every visible row, on the same terms as the quick-complete button they already offer
   * unconditionally. An empty set is therefore *not* the default — that would mean "roles are known,
   * and none of these are editable", which is what silently cost the drawer and Home their menu.
   */
  readonly editableCardIds = input<ReadonlySet<string> | null>(null);

  /**
   * The CDK drop-list id. Unique per mounted surface, because the drawer can be open over the My
   * Cards dock and CDK resolves connected lists by id — two surfaces sharing one id would let a
   * drag begun in either land in whichever the DOM happened to register first.
   */
  readonly dropListId = input("up-next-drop");
  /**
   * The lane name this surface registers its drags under. A stable id is what lets a state's
   * realtime handling hold a refresh until the gesture ends (see `whenCardDragIdle()`), so the
   * actor's own echo never reorders the queue under the pointer.
   */
  readonly dragLaneId = input("up-next-panel");
  /**
   * Whether board tiles dragged in from a lane may land here. Only the Global Work dock sits beside
   * a board whose lanes name it in `cdkDropListConnectedTo`; the drawer and Home are not drop
   * targets for anything but their own rows.
   */
  readonly acceptExternalCardDrops = input(false);
  /**
   * Render only the first N rows. Anchors are still computed over the full queue, so a truncated
   * surface (Home shows five) produces exactly the same drops as the full list would.
   */
  readonly visibleLimit = input<number | null>(null);
  readonly showAdd = input(true);
  readonly showDragHint = input(true);
  /** Empty-state suppression for hosts that render their own richer one (the drawer). */
  readonly showEmptyState = input(true);
  /** Tighter rows for embedded surfaces like Home's section, which is not a scroller. */
  readonly compact = input(false);
  /** Adds a one-click "mark complete" to each row — the drawer's and Home's quick action. */
  readonly allowQuickComplete = input(false);
  /**
   * Optional shared wall-clock reading for a host that renders an aggregate of these row states.
   * Null preserves the ordinary render-time behavior used by standalone queue surfaces.
   */
  readonly dueReferenceTime = input<number | null>(null);

  // Drives the rank pill's --rank-heat: the top of the queue wears a deeper accent tint.
  protected readonly rankHeat = priorityRankHeat;

  readonly reordered = output<PriorityReorder>();
  readonly removed = output<{ priorityId: string }>();
  /** A new card for the queue, with the anchor for where it was dropped (append when picked). */
  readonly added = output<PriorityAnchor & { cardId: string }>();
  readonly cardOpened = output<{ cardId: string; boardId: string; event: MouseEvent }>();
  readonly completed = output<{ cardId: string; completed: boolean }>();

  /**
   * Which of the two Add card affordances the picker is anchored to: a host-rendered "+" (via
   * `openAdd("head")`) or the inline button under the last row. One value rather than two booleans
   * so both can never be open at once.
   */
  readonly addOpenAt = signal<"head" | "list" | null>(null);
  readonly addOpen = computed(() => this.addOpenAt() !== null);

  private readonly addableCardIds = computed(() => new Set(this.addableCards().map((card) => card.id)));

  /**
   * Gate for board tiles dragged over this surface. Only a card the server would accept may enter;
   * everything else bounces back to its lane instead of landing and then erroring. Arrow property
   * because CDK calls the predicate unbound.
   */
  readonly canEnterFromBoard = (drag: CdkDrag<unknown>): boolean => {
    if (!this.acceptExternalCardDrops()) return false;
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
  private readonly allRows = computed<QueueRow[]>(() =>
    this.items().map((entry) => {
      const card = entry.card ? expandCardSummary(entry.card) : null;
      const board = card ? this.boardSummariesById().get(card.boardId) ?? null : null;
      const list = card ? this.listsById().get(card.listId) ?? null : null;
      const icon = entry.context?.boardIcon ?? board?.icon ?? "layout-kanban";
      const iconColor = entry.context?.boardIconColor ?? board?.iconColor ?? null;
      // "list" is the fallback every other list affordance uses (the board picker, the bulk actions
      // menu), so an unstyled list looks the same wherever it is named.
      const listIcon = entry.context?.listIcon ?? list?.icon ?? "list";
      const listColor = entry.context?.listColor ?? list?.color ?? null;
      return {
        entry,
        card,
        boardName: entry.context?.boardName ?? board?.name ?? "",
        boardIconClass: `ti ti-${icon}`,
        boardIconColor: iconColor ? `var(--color-${iconColor})` : null,
        listName: entry.context?.listName ?? list?.name ?? "",
        listIconClass: `ti ti-${listIcon}`,
        listColor: listColor ? `var(--color-${listColor})` : null,
        labels: entry.context?.labels ?? [],
      };
    }),
  );

  /**
   * A prefix slice, never a filtered subset: indices into the rendered list must stay valid indices
   * into `items()`, or a drop on a truncated surface would resolve against the wrong neighbours.
   */
  readonly rows = computed<QueueRow[]>(() => {
    const limit = this.visibleLimit();
    return limit === null ? this.allRows() : this.allRows().slice(0, limit);
  });

  /** How many ranked cards a truncated surface is not showing. */
  readonly hiddenByLimit = computed(() => Math.max(0, this.totalCount() - this.rows().length));

  readonly addGroups = computed<PickerGroup[]>(() =>
    priorityAddGroups(this.addableCards(), { showCardKeys: this.showCardKeys() })
  );

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

  /**
   * Completed and archived cards carry no due pressure, the same guard `k-card` applies. Without it a
   * card quick-completed from a row kept an angry red overdue chip for the moment before the server
   * dropped it out of the queue — and the drawer's due-pressure summary, which counts with exactly
   * these two predicates, would disagree with the chips beneath it.
   */
  dueOverdue(card: WireCardSummary): boolean {
    if (card.completedAt || card.archivedAt) return false;
    const reference = this.dueReferenceTime();
    return isOverdue(
      card.dueDateLocalDate,
      card.dueDateSlot,
      card.dueDateTimezone,
      reference === null ? new Date() : new Date(reference),
    );
  }

  dueSoon(card: WireCardSummary): boolean {
    if (card.completedAt || card.archivedAt) return false;
    const reference = this.dueReferenceTime();
    return isDueSoon(
      card.dueDateLocalDate,
      card.dueDateSlot,
      card.dueDateTimezone,
      reference === null ? new Date() : new Date(reference),
    );
  }

  /**
   * Bound to both `click` and `auxclick` so middle-click keeps its new-tab meaning, as on every
   * other card surface. Button 2 is filtered here rather than by the host: `auxclick` fires for the
   * right button too, and the row's own context menu already owns that gesture.
   */
  onCardOpened(card: WireCardSummary, event: MouseEvent): void {
    if (event.button === 2) return;
    this.cardOpened.emit({ cardId: card.id, boardId: card.boardId, event });
  }

  /**
   * The open right-click menu, as a 0-or-1 list so the template can key it by `token`.
   *
   * A plain nullable signal is what this was, and it could only ever open once: the panel stack
   * dismisses the previous menu from a capture-phase `contextmenu` listener, which runs *before* the
   * row handler that opens the next one, so the close and the re-open land in the same tick and
   * `@if` never observes the gap. The component instance then survives with its stack layer already
   * unregistered and its `is-positioned` class stripped — mounted, `visibility: hidden`, anchored
   * wherever it was last placed. See the template for the keyed rebuild.
   */
  readonly actionsMenu = signal<QueueActionsMenu[]>([]);
  private actionsToken = 0;

  onRowContextMenu(row: QueueRow, event: MouseEvent): void {
    // Redacted rows have nothing to act on. A host that knows its viewer's board roles narrows
    // further and keeps the browser's own menu on rows whose every action the server would refuse;
    // one that has no roles to narrow with passes null. That is not laxness — the queue response
    // carries no role at all, so the drawer and Home have nothing to filter by, and they already
    // offer quick complete on every row on exactly the same terms: attempt it, and surface the
    // server's refusal.
    const editable = this.editableCardIds();
    if (!row.card || (editable && !editable.has(row.card.id))) return;
    event.preventDefault();
    event.stopPropagation();
    this.actionsToken += 1;
    this.actionsMenu.set([{
      token: this.actionsToken,
      card: row.card,
      point: { x: event.clientX, y: event.clientY },
    }]);
  }

  closeActionsMenu(): void {
    this.actionsMenu.set([]);
  }

  onDragStarted(): void {
    this.cardDrag.start(this.dragLaneId());
  }

  onDragEnded(): void {
    this.cardDrag.end();
  }

  /**
   * Mirrors "is the pointer outside the rows scroller" onto the CDK preview clone as a class, so
   * the preview can dim into its "release removes" reading. Tracked against the same drop-list
   * element CDK measures for `isPointerOverContainer`, so the cue and the outcome always agree.
   * Queried from the document because CDK appends the preview to the body and exposes no handle to
   * it; the per-instance `dropListId` in the selector is what keeps two mounted surfaces (the
   * drawer over the dock) from grabbing each other's preview.
   */
  onDragMoved(event: CdkDragMove<unknown>): void {
    const rowsElement = this.host.nativeElement.querySelector(".panel-rows");
    const preview = document.querySelector<HTMLElement>(`.panel-row.cdk-drag-preview[data-queue="${this.dropListId()}"]`);
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
    const preview = document.querySelector<HTMLElement>(
      `.panel-row.cdk-drag-preview.drag-outside[data-queue="${this.dropListId()}"]`,
    );
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
    // Released outside the surface: the gesture reads "take it out of the queue", so it performs the
    // same removal the row's × does. Safe to key off the release point alone — CDK fires drops only
    // on an actual pointer release, so there is no cancelled-drag path that could land here, and
    // nothing else accepts these rows (this drop list is connected to no other).
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

  /**
   * True for the last row this surface *renders*, not the last in the queue: "move down" must stay
   * enabled on a truncated surface, where there are more rows below the fold to move past.
   */
  isLastInQueue(entry: WorkPriorityItem): boolean {
    return this.items().at(-1)?.id === entry.id;
  }

  onQuickComplete(card: WireCardSummary, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.completed.emit({ cardId: card.id, completed: !card.completedAt });
  }
}
