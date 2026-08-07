import type { CdkDragDrop, CdkDragMove} from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDragPreview, CdkDropList } from "@angular/cdk/drag-drop";
import type { OnDestroy} from "@angular/core";
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Directive, ElementRef, HostBinding, computed, effect, inject, input, output, signal, untracked, viewChild } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import type { CardAttachmentRow, WireCard, WireCardSummary, WireList } from "@kanera/shared/events";
import type { Card, CardCustomFieldValue, List } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { vibrateCardDragEnd, vibrateCardDragStart } from "../../core/browser/haptics";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { AnchoredPanelPlacement } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AutofocusDirective } from "../../shared/autofocus.directive";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CARD_DRAG_START_DELAY, cardDragEdgeScrollStep } from "./card-drag-scroll";
import { CardDragCoordinator } from "./card-drag-coordinator.service";
import { CardComponent, type CardAssigneePresentation, type CardBulkMenuIntent, type CardLabelPresentation, type CardSelectionIntent } from "./card.component";
import { CardLabelsComponent } from "./card-labels.component";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";
import { BoardState, committedItemOrderForDrop, laneItemAnchor, laneItemKey, sameItemOrder, type AnyCustomField, type AnySeparator, type BoardLaneItem, type LaneAnchor } from "./board-state";
import { suppressDropCommitTransitions } from "./drop-commit-transition";
import { SeparatorComponent } from "./separator.component";
import { ViewportDropTargetDirective } from "./viewport-drop-target.directive";

// Catalog-backed consolidated boards intentionally carry only presentation fields. Keeping this
// shape here lets them use the same list/card renderer without inventing fake timestamps.
export interface BoardListPresentation {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  color: string | null;
  position: string;
}
type AnyList = List | WireList | BoardListPresentation;
type AnyCard = Card | WireCard | WireCardSummary;
const EMPTY_FIELD_VALUES = new Map<string, CardCustomFieldValue>();

// Large boards (3000+ cards across 30+ lists) choke if every card mounts on open, so each
// list renders only a leading slice and grows it as the user scrolls toward the bottom.
// The cap only ever grows, never shrinks, so cards already in the DOM —
// including one mid-drag — are never unmounted, keeping CDK drag-drop indices aligned.
const INITIAL_RENDER_CAP = 30;
const RENDER_CAP_PAGE = 60;
const GROW_NEAR_BOTTOM_PX = 600;
const LIST_DRAG_EDGE_SCROLL_MULTIPLIER = 2;
const COMMITTED_DROP_FALLBACK_MS = 2000;
interface DragListTargetCache {
  scrollLeft: number;
  rects: { left: number; right: number; top: number; bottom: number; element: HTMLElement }[];
}

export interface CardDropPayload {
  cardId: string;
  toListId: string;
  beforeCardId?: string | null;
  afterCardId?: string | null;
  beforeItem?: LaneAnchor | null;
  afterItem?: LaneAnchor | null;
}

export interface SeparatorDropPayload {
  separatorId: string;
  toListId: string;
  beforeItem?: LaneAnchor | null;
  afterItem?: LaneAnchor | null;
}

export interface StartAddPayload {
  listId: string;
  atTop: boolean;
}

export interface BulkCardSelectionPayload {
  cardId: string;
  orderedCardIds: string[];
  shiftKey: boolean;
  additive: boolean;
}

export interface BulkCardMenuPayload {
  cardId: string;
  point: { x: number; y: number };
}

export interface BulkListSelectionPayload {
  orderedCardIds: string[];
  /** Replace/add cover list-menu and table-header selection; remove lets a group checkbox toggle off. */
  mode: "replace" | "add" | "remove";
}

export interface AddCardBoardOption {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
}

@Directive({
  selector: "[kCloseCardChecklistsBeforeDrag]",
  standalone: true,
})
class CloseCardChecklistsBeforeDragDirective {
  private readonly drag = inject(CdkDrag);
  private readonly state = inject(BoardState);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  constructor() {
    this.drag._dragRef.beforeStarted.pipe(takeUntilDestroyed()).subscribe(() => {
      // CDK captures the source rectangle immediately after `beforeStarted`. Render the collapsed
      // card first so its preview and placeholder are measured from the compact tile geometry.
      this.state.closeCardChecklists();
      this.changeDetectorRef.detectChanges();
    });
  }
}

@Component({
  selector: "k-list",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragPreview, CloseCardChecklistsBeforeDragDirective, CardComponent, CardLabelsComponent, SeparatorComponent, AnchoredPanelDirective, AutofocusDirective, TooltipDirective, ViewportDropTargetDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./list.component.html",
  styleUrl: "./list.component.scss",
})
export class ListComponent implements OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly notifications = inject(NotificationsService);
  private readonly menuCoordinator = inject(BoardMenuCoordinator);
  private readonly dragCoordinator = inject(CardDragCoordinator);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly cardsEl = viewChild<ElementRef<HTMLElement>>("cardsEl");
  private readonly addCardTextarea = viewChild<ElementRef<HTMLTextAreaElement>>("addCardTextarea");
  // Touch requires a long-press before a drag starts so swipes scroll the list; mouse is immediate.
  protected readonly dragStartDelay = CARD_DRAG_START_DELAY;
  private activeCardDrag: CdkDrag<BoardLaneItem> | null = null;
  private cancelledCardDrag: CdkDrag<BoardLaneItem> | null = null;
  private lastDragPointer: { x: number; y: number } | null = null;
  private hoveredDragListEl: HTMLElement | null = null;
  private dragListTargetCache: DragListTargetCache | null = null;
  private anyCardDragging = false;
  private edgeScrollFrame: number | null = null;
  private cleanupDragCancel?: () => void;
  private clearCommittedDropTimeout: number | null = null;

  readonly list = input.required<AnyList>();
  readonly boardId = input.required<string>();
  readonly separatorCreateBaseUrl = input<string | null>(null);
  readonly separatorItemBaseUrl = input<string>("/separators");
  readonly allLists = input<AnyList[]>([]);
  readonly cards = input.required<AnyCard[]>();
  readonly items = input<BoardLaneItem[]>([]);
  readonly customFields = input<AnyCustomField[]>([]);
  readonly customFieldValuesByCardAndField = input<Map<string, Map<string, CardCustomFieldValue>>>(new Map());
  readonly labelsByCard = input<Map<string, CardLabelPresentation[]>>(new Map());
  readonly assigneesByCard = input<Map<string, CardAssigneePresentation[]>>(new Map());
  readonly attachmentCountByCard = input<Map<string, number>>(new Map());
  readonly coverAttachmentById = input<Map<string, CardAttachmentRow>>(new Map());
  readonly commentCounts = input<Map<string, number>>(new Map());
  readonly filteredCardIds = input<Set<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly bulkSelectedCardIds = input<Set<string>>(new Set());
  readonly canEdit = input<boolean>(true);
  // Role-only permission for STRUCTURAL gating (list menu, add-card affordances, separator
  // actions) so they stay mounted across offline/online transitions instead of churning the DOM.
  // Mutations and the disabled state still use the online-aware `canEdit`. See card-detail for the
  // same pattern.
  readonly canEditRole = input<boolean>(true);
  // A consolidated workspace can contain cards from editor and observer source boards. Keep the
  // list itself interactive for eligible cards while applying role and drag gates per source card.
  readonly editableCardIds = input<Set<string> | null>(null);
  readonly roleEditableCardIds = input<Set<string> | null>(null);
  readonly draggableCardIds = input<Set<string> | null>(null);
  readonly canCreateCards = input<boolean>(true);
  readonly addCardBoards = input<AddCardBoardOption[]>([]);
  readonly defaultAddCardBoardId = input<string | null>(null);
  readonly defaultAddCardAssigneeIds = input<string[]>([]);
  readonly showBulkListActions = input<boolean>(true);
  readonly showSelectAllCards = input<boolean>(true);
  readonly showCardActions = input<boolean>(true);
  readonly allowCardDuplicate = input<boolean>(true);
  readonly allowCardCopyToBoard = input<boolean>(true);
  readonly allowCardMoveToBoard = input<boolean>(true);
  readonly allowBoardNavigation = input<boolean>(false);
  readonly boardSummariesById = input<Map<string, { id: string; name: string; icon: string | null; iconColor: string | null }> | null>(null);
  // Up next queue presentation for consolidated work surfaces: the focused person's rank per card,
  // and the cards eligible for the tile's "+ Up next" affordance. Empty on ordinary boards.
  readonly priorityRanksByCard = input<Map<string, number>>(new Map());
  readonly priorityAddableCardIds = input<Set<string>>(new Set());
  /**
   * Extra drop-list ids this lane's cards may be dragged into, beyond the board's own
   * cdkDropListGroup — how Global Work lets a tile be dropped straight onto the Up next panel.
   * One-directional by construction: the panel does not list the lanes back, so its rows can
   * never be dragged out into a list.
   */
  readonly connectedDropLists = input<string[]>([]);
  readonly addingListId = input<string | null>(null);
  readonly addAtTop = input<boolean>(false);
  readonly cardDropped = output<CardDropPayload>();
  readonly separatorDropped = output<SeparatorDropPayload>();
  readonly cardOpened = output<string>();
  readonly boardOpened = output<string>();
  readonly cardAddedToPriority = output<string>();
  readonly bulkSelectionRequested = output<BulkCardSelectionPayload>();
  readonly bulkListSelectionRequested = output<BulkListSelectionPayload>();
  readonly bulkMenuRequested = output<BulkCardMenuPayload>();
  readonly cardCreated = output<AnyCard>();
  readonly separatorCreated = output<AnySeparator>();
  readonly separatorUpdated = output<AnySeparator>();
  readonly separatorDeleted = output<string>();
  readonly startAdd = output<StartAddPayload>();
  readonly cancelAdd = output<void>();

  readonly adding = computed(() => this.addingListId() === this.list().id);
  readonly otherLists = computed(() => this.allLists().filter(l => l.id !== this.list().id));
  readonly canManageSeparators = computed(() => Boolean(this.separatorCreateBaseUrl() ?? (this.boardId() ? `/boards/${this.boardId()}` : null)));
  private readonly committedDropItems = signal<BoardLaneItem[] | null>(null);
  // A cross-list target commits CDK's final order before the parent can propagate its optimistic
  // cards input back down. Keep that incoming item exempt from the large-list render slice during
  // the handoff, otherwise it briefly disappears on boards where change detection is expensive.
  private readonly committedDropItemKey = signal<string | null>(null);

  private readonly baseDisplayedCards = computed(() => {
    const all = this.cards();
    const ids = this.filteredCardIds();
    if (!ids) return all;
    return all.filter(c => ids.has(c.id));
  });

  readonly displayedCards = computed(() => this.baseDisplayedCards());
  readonly baseDisplayedItems = computed(() => this.items().length ? this.items() : this.baseDisplayedCards().map((card): BoardLaneItem => ({ kind: "card", card })));
  readonly displayedItems = computed(() => this.committedDropItems() ?? this.baseDisplayedItems());

  readonly cardCount = computed(() => this.displayedCards().length);
  readonly selectedAddCardBoard = computed(() => {
    const id = this.selectedAddCardBoardId() ?? this.defaultAddCardBoardId() ?? this.boardId();
    return this.addCardBoards().find((board) => board.id === id) ?? null;
  });
  readonly filteredAddCardBoards = computed(() => {
    const q = this.boardPickerQuery().trim().toLowerCase();
    const boards = [...this.addCardBoards()].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return boards;
    return boards.filter((board) => board.name.toLowerCase().includes(q));
  });

  // How many leading cards to actually render. Grows on scroll and drag edge-scroll.
  private readonly renderCap = signal(INITIAL_RENDER_CAP);
  // The slice handed to both the template and CDK's drop list, so drop indices line up with
  // the rendered DOM. Drop neighbour ids resolve against the full list in BoardState, so a
  // drop at the edge of the rendered slice still positions correctly relative to hidden cards.
  readonly renderedCards = computed(() => {
    const cards = this.displayedCards();
    // A filtered/search result set should be complete in the DOM so every match is visible and
    // browser find/selection behavior stays unsurprising. The cap is only for the unfiltered
    // large-board open path where mounting every card at once is the expensive bit.
    if (this.filteredCardIds()) return cards;
    const cap = this.renderCap();
    return cards.length > cap ? cards.slice(0, cap) : cards;
  });
  readonly renderedItems = computed(() => {
    const renderedCardIds = new Set(this.renderedCards().map((card) => card.id));
    const committedDropItemKey = this.committedDropItemKey();
    return this.displayedItems().filter((item) =>
      item.kind === "separator"
      || renderedCardIds.has(item.card.id)
      || laneItemKey(item) === committedDropItemKey,
    );
  });
  readonly hiddenCardCount = computed(() => Math.max(0, this.displayedCards().length - this.renderedCards().length));

  onCardsScroll(el: HTMLElement) {
    if (this.hiddenCardCount() === 0) return;
    if (this.anyCardDragging) return;
    if (this.shouldGrowCards(el)) this.growRenderedCards();
  }

  private growRenderedCards() {
    if (this.hiddenCardCount() === 0) return;
    this.renderCap.update((cap) => cap + RENDER_CAP_PAGE);
  }

  private shouldGrowCards(el: HTMLElement): boolean {
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Growth appends cards below the rendered ones, so existing rows (and a card mid-drag)
    // don't move. This also lets CDK's drag auto-scroll progressively reveal more of a long
    // list so a card can still be dropped past the initial window.
    return remaining <= GROW_NEAR_BOTTOM_PX;
  }

  labelsForCard(cardId: string): CardLabelPresentation[] {
    return this.labelsByCard().get(cardId) ?? [];
  }

  assigneesForCard(cardId: string): CardAssigneePresentation[] {
    return this.assigneesByCard().get(cardId) ?? [];
  }

  coverUrlForCard(card: AnyCard): string | null {
    const coverId = (card as Card).coverAttachmentId;
    const summaryCoverUrl = "coverUrl" in card ? card.coverUrl : null;
    const coverAttachment = coverId ? this.coverAttachmentById().get(coverId) : null;
    const resolved = coverId
      ? (coverAttachment?.thumbnailUrl ?? coverAttachment?.url ?? summaryCoverUrl)
      : summaryCoverUrl;
    // A restored offline snapshot can carry a signed cover URL (summary- or
    // attachment-sourced) whose token has expired. Rendering it only yields a
    // broken 404 until the live board load replaces this data; suppress it so
    // the card shows no cover meanwhile (and stays clean when truly offline,
    // since an expired token can never be served anyway).
    return visibleSignedMediaUrl(resolved);
  }

  coverColorForCard(card: AnyCard): string {
    const coverId = (card as Card).coverAttachmentId;
    const attachmentColor = coverId ? this.coverAttachmentById().get(coverId)?.coverImageColor : null;
    // The preview must stay cheap even when image analysis has not produced a primary colour.
    // An explicit theme token also avoids borrowing a label colour unrelated to the cover.
    return attachmentColor ?? ("coverImageColor" in card ? card.coverImageColor : null) ?? "var(--accent)";
  }

  attachmentCountForCard(cardId: string): number {
    return this.attachmentCountByCard().get(cardId) ?? 0;
  }

  commentCountForCard(cardId: string): number {
    return this.commentCounts().get(cardId) ?? 0;
  }

  isSelectedCard(cardId: string): boolean {
    return this.selectedCardId() === cardId;
  }

  isBulkSelectedCard(cardId: string): boolean {
    return this.bulkSelectedCardIds().has(cardId);
  }

  canEditCard(cardId: string): boolean {
    const editableIds = this.editableCardIds();
    return this.canEdit() && (editableIds === null || editableIds.has(cardId));
  }

  canEditCardRole(cardId: string): boolean {
    const editableIds = this.roleEditableCardIds();
    return this.canEditRole() && (editableIds === null || editableIds.has(cardId));
  }

  canDragCard(cardId: string): boolean {
    const draggableIds = this.draggableCardIds();
    return this.canEditCard(cardId) && (draggableIds === null || draggableIds.has(cardId));
  }

  onCardSelectionIntent(intent: CardSelectionIntent) {
    this.bulkSelectionRequested.emit({
      ...intent,
      orderedCardIds: this.displayedCards().map((card) => card.id),
    });
  }

  onCardBulkMenuIntent(intent: CardBulkMenuIntent) {
    this.bulkMenuRequested.emit(intent);
  }

  selectAllCards(event: MouseEvent) {
    if (!this.canEdit()) return;
    const orderedCardIds = this.displayedCards().map((card) => card.id);
    if (orderedCardIds.length === 0) return;
    // Selection uses the complete filtered card set rather than the rendered slice, so
    // long lanes include cards that have not yet been mounted by incremental scrolling.
    this.bulkListSelectionRequested.emit({ orderedCardIds, mode: event.shiftKey ? "add" : "replace" });
    this.closeMenu();
  }

  customFieldValuesForCard(cardId: string): Map<string, CardCustomFieldValue> {
    return this.customFieldValuesByCardAndField().get(cardId) ?? EMPTY_FIELD_VALUES;
  }

  boardSummaryForCard(card: AnyCard): { id: string; name: string; icon: string | null; iconColor: string | null } | null {
    const summaries = this.boardSummariesById();
    return summaries ? summaries.get(card.boardId) ?? null : null;
  }
  // True only when the list-options menu has at least one visible item.
  readonly anyBulkAction = computed(() =>
    this.canCreateCards()
    || this.canManageSeparators()
    || this.showBulkListActions()
    || this.showSelectAllCards()
  );
  readonly menuOpen = signal(false);
  /**
   * Reproduces the old `top: calc(100% + 4px); right: -25px`: `align: "end"` lines the panel's right
   * edge up with the trigger, `crossOffset` pushes it back out past the list's padding. `"measure"`
   * keeps the panel sized by its own `min-width` instead of a fixed width, and `minHeight` is the
   * menu's real height so it only ever flips above when it genuinely will not fit below.
   */
  readonly menuPlacement: AnchoredPanelPlacement = { align: "end", crossOffset: 25, gap: 4, width: "measure", minHeight: 240 };
  /**
   * The submenu now prefers the *right* of the menu and only flips left when there is no room. It used
   * to always open left (`right: calc(100% + 4px)`), which for the leftmost list sent it off the board
   * canvas and under the sidebar. Opening outward and letting placement flip is what keeps it on screen.
   */
  readonly moveListPlacement: AnchoredPanelPlacement = { side: "right", align: "start", gap: 4, width: "measure", maxHeight: 240 };
  readonly confirmClear = signal(false);
  readonly clearing = signal(false);
  readonly savingCompletion = signal(false);
  readonly showMoveListPicker = signal(false);
  readonly movingCards = signal(false);
  readonly newTitle = signal("");
  readonly boardPickerOpen = signal(false);
  readonly addBoardPlacement: AnchoredPanelPlacement = { width: 300, maxHeight: 280, minHeight: 180, gap: 4 };
  readonly boardPickerQuery = signal("");
  readonly selectedAddCardBoardId = signal<string | null>(null);
  readonly receiving = signal(false);
  readonly draggingOut = signal(false);
  readonly cardDragging = signal(false);
  readonly autoEditSeparatorId = signal<string | null>(null);

  @HostBinding("class.is-drop-target")
  get isDropTarget() {
    return this.receiving();
  }

  @HostBinding("class.is-drag-active")
  get isDragActive() {
    return this.dragCoordinator.active();
  }

  @HostBinding("attr.data-list-id")
  get hostListId() {
    return this.list().id;
  }

  constructor() {
    effect((onCleanup) => {
      if (!this.adding()) return;
      this.addAtTop();
      const timer = setTimeout(() => this.addCardTextarea()?.nativeElement.focus({ preventScroll: true }));
      onCleanup(() => clearTimeout(timer));
    });

    effect((onCleanup) => {
      this.renderedItems();
      if (this.hiddenCardCount() === 0) return;
      const el = this.cardsEl()?.nativeElement;
      if (!el) return;
      // After a render slice is mounted, grow again if the user is already near its end. This
      // covers tall screens and short cards where the first slice doesn't create much scroll.
      const frame = untracked(() => requestAnimationFrame(() => {
        if (this.hiddenCardCount() > 0 && this.shouldGrowCards(el)) this.growRenderedCards();
      }));
      onCleanup(() => cancelAnimationFrame(frame));
    });

    effect((onCleanup) => {
      if (this.hiddenCardCount() === 0) return;
      const el = this.cardsEl()?.nativeElement;
      if (!el) return;

      // A template scroll binding marks this component dirty on every scroll event, even after
      // onCardsScroll returns without growing the slice. Keep the hot path outside Angular's
      // event wrapper, coalesce threshold checks, and remove it once every card is mounted.
      let pendingFrame: number | null = null;
      const onScroll = () => {
        if (pendingFrame !== null) return;
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          this.onCardsScroll(el);
        });
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      onCleanup(() => {
        el.removeEventListener("scroll", onScroll);
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      });
    });

    // Outside-click and Escape dismissal for this menu come from `kAnchoredPanel` /
    // PanelStackService now. The hand-rolled listener that used to live here tested containment
    // against the whole list host, so clicking a card in the same list left the menu open; the stack
    // tests the panel itself, and also makes opening this menu close any other panel on the page.
    effect(() => {
      const openedListId = this.menuCoordinator.activeListMenuId();
      const openedCardId = this.menuCoordinator.activeCardMenuId();
      if (this.menuOpen() && (openedCardId !== null || openedListId !== this.list().id)) this.closeMenu();
    });

    effect(() => {
      const active = this.dragCoordinator.active();
      this.anyCardDragging = active;
      if (!active) {
        this.lastDragPointer = null;
        this.hoveredDragListEl = null;
        this.dragListTargetCache = null;
        this.cardDragging.set(false);
        this.stopEdgeScrollLoop();
      }
    });

    effect((onCleanup) => {
      const onTargetedDragMove = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const detail = event.detail as { x?: unknown; y?: unknown } | null;
        if (typeof detail?.x !== "number" || typeof detail.y !== "number") return;
        const el = this.cardsEl()?.nativeElement;
        if (!el) return;
        // The active drag dispatches this event only on the list under the pointer, avoiding
        // one layout read per rendered list on every pointer move on wide boards.
        const rect = el.getBoundingClientRect();
        if (detail.x < rect.left || detail.x > rect.right) {
          this.lastDragPointer = null;
          this.stopEdgeScrollLoop();
          return;
        }
        this.lastDragPointer = { x: detail.x, y: detail.y };
        this.startEdgeScrollLoop();
      };
      const onTargetedDragLeave = () => {
        this.lastDragPointer = null;
        this.stopEdgeScrollLoop();
      };
      const host = this.hostEl.nativeElement;
      host.addEventListener(APP_DOM_EVENTS.CARD_DRAG_OVER_LIST, onTargetedDragMove);
      host.addEventListener(APP_DOM_EVENTS.CARD_DRAG_LEAVE_LIST, onTargetedDragLeave);
      onCleanup(() => {
        host.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_OVER_LIST, onTargetedDragMove);
        host.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_LEAVE_LIST, onTargetedDragLeave);
      });
    });

    effect((onCleanup) => {
      const onDropSourceCommitted = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const detail = event.detail as { listId?: unknown; cardId?: unknown } | null;
        if (detail?.listId !== this.list().id || typeof detail.cardId !== "string") return;
        this.commitDropOrder(this.baseDisplayedItems().filter((item) => item.kind !== "card" || item.card.id !== detail.cardId));
      };
      document.addEventListener(APP_DOM_EVENTS.CARD_DROP_SOURCE_COMMITTED, onDropSourceCommitted);
      onCleanup(() => document.removeEventListener(APP_DOM_EVENTS.CARD_DROP_SOURCE_COMMITTED, onDropSourceCommitted));
    });

    effect(() => {
      const committed = this.committedDropItems();
      if (!committed) return;
      if (this.committedDropItemKey() === null) {
        // Source-list commitments intentionally omit the dragged card, so require the whole live
        // lane to match before releasing them; projecting would hide that still-present card.
        if (sameItemOrder(this.baseDisplayedItems(), committed)) this.clearCommittedDropOrder();
        return;
      }
      // A large list's committed order contains only its rendered slice, while baseDisplayedItems
      // contains the whole lane. Compare the same keys so live state can end the handoff without
      // waiting for the two-second safety timeout.
      const committedKeys = new Set(committed.map(laneItemKey));
      const comparableBaseItems = this.baseDisplayedItems().filter((item) => committedKeys.has(laneItemKey(item)));
      if (sameItemOrder(comparableBaseItems, committed)) this.clearCommittedDropOrder();
    });

    effect(() => {
      const boards = this.addCardBoards();
      const fallback = this.defaultAddCardBoardId() ?? boards[0]?.id ?? this.boardId();
      const selected = this.selectedAddCardBoardId();
      if (!selected || (boards.length > 0 && !boards.some((board) => board.id === selected))) {
        this.selectedAddCardBoardId.set(fallback || null);
      }
    });
  }

  // No `stopPropagation()`: the click has to reach the stack's document listener so opening this menu
  // dismisses any other open panel. The menu it opens survives because `AnchoredPanelDirective`
  // registers in `ngAfterViewInit`, after this click has finished propagating; and re-clicking still
  // closes, because this handler runs at the target first.
  toggleMenu() {
    this.confirmClear.set(false);
    this.showMoveListPicker.set(false);
    const next = !this.menuOpen();
    if (next) this.menuCoordinator.openListMenu(this.list().id);
    else this.menuCoordinator.closeListMenu(this.list().id);
    this.menuOpen.set(next);
  }

  /** Public because `kAnchoredPanel` calls it for every dismissal reason — outside click, Escape, and
   * being superseded by another panel opening. */
  closeMenu() {
    this.menuOpen.set(false);
    this.menuCoordinator.closeListMenu(this.list().id);
    this.confirmClear.set(false);
    this.showMoveListPicker.set(false);
  }

  // The submenu is a DOM descendant of the menu panel, so the stack derives it as a nested layer and
  // opening it leaves the menu underneath alone — no `stopPropagation()` needed to protect it.
  toggleMoveListPicker() {
    this.confirmClear.set(false);
    this.showMoveListPicker.update((v) => !v);
  }

  async moveAllCards(targetListId: string) {
    if (!this.canEdit() || this.movingCards()) return;
    this.movingCards.set(true);
    try {
      await this.api.post(`/lists/${this.list().id}/cards/move`, { targetListId, boardId: this.boardId() });
      this.menuOpen.set(false);
      this.showMoveListPicker.set(false);
    } finally {
      this.movingCards.set(false);
    }
  }

  async archiveCards() {
    if (!this.canEdit() || this.clearing()) return;
    this.clearing.set(true);
    try {
      await this.api.patch(`/lists/${this.list().id}/cards/archive`, { boardId: this.boardId() });
      this.menuOpen.set(false);
      this.confirmClear.set(false);
    } finally {
      this.clearing.set(false);
    }
  }

  async setAllCompleted(completed: boolean) {
    if (!this.canEdit() || this.savingCompletion()) return;
    this.savingCompletion.set(true);
    try {
      await this.api.post(`/boards/${this.boardId()}/lists/${this.list().id}/cards/completion`, { completed });
      this.menuOpen.set(false);
    } finally {
      this.savingCompletion.set(false);
    }
  }

  onAddCardFromMenu() {
    this.menuOpen.set(false);
    this.startAdd.emit({ listId: this.list().id, atTop: true });
  }

  async addSeparator(atTop = false) {
    if (!this.canEdit()) return;
    const baseUrl = this.separatorCreateBaseUrl() ?? (this.boardId() ? `/boards/${this.boardId()}` : null);
    if (!baseUrl) return;
    const separator = await this.api.post<AnySeparator>(`${baseUrl}/lists/${this.list().id}/separators`, {
      title: "",
      color: null,
      ...(atTop ? { atTop: true } : {}),
    });
    this.separatorCreated.emit(separator);
    this.autoEditSeparatorId.set(separator.id);
    this.closeMenu();
  }

  async updateSeparator(payload: { id: string; title: string; color: string | null }) {
    if (!this.canEdit()) return;
    const separator = await this.api.patch<AnySeparator>(`${this.separatorItemBaseUrl()}/${payload.id}`, {
      title: payload.title,
      color: payload.color,
    });
    this.separatorUpdated.emit(separator);
    if (this.autoEditSeparatorId() === separator.id) this.autoEditSeparatorId.set(null);
  }

  async deleteSeparator(separatorId: string) {
    if (!this.canEdit()) return;
    await this.api.delete(`${this.separatorItemBaseUrl()}/${separatorId}`);
    this.separatorDeleted.emit(separatorId);
    if (this.autoEditSeparatorId() === separatorId) this.autoEditSeparatorId.set(null);
  }

  onNewTitleInput(target: HTMLTextAreaElement) {
    this.newTitle.set(target.value);
    this.resizeNewTitleInput(target);
  }

  async addCard(e: Event) {
    e.preventDefault();
    if (!this.canEdit()) return;
    const title = this.newTitle().trim();
    if (!title) return;
    const boardId = this.selectedAddCardBoardId() ?? this.defaultAddCardBoardId() ?? this.boardId();
    if (!boardId) return;
    const assigneeIds = this.defaultAddCardAssigneeIds();
    const clientToken = crypto.randomUUID();
    const card = await this.api.createCard<AnyCard>(`/boards/${boardId}/lists/${this.list().id}/cards`, {
      title,
      clientToken,
      ...(this.addAtTop() ? { atTop: true } : {}),
      ...(assigneeIds.length ? { assigneeIds } : {}),
    });
    this.notifications.watchCreatedCardLocally(card.id);
    this.cardCreated.emit(card);
    this.newTitle.set("");
    this.boardPickerOpen.set(false);
    this.boardPickerQuery.set("");
    this.cancelAdd.emit();
  }

  toggleAddCardBoardPicker() {
    if (this.anyCardDragging) return;
    this.boardPickerOpen.update((open) => !open);
  }

  selectAddCardBoard(boardId: string) {
    this.selectedAddCardBoardId.set(boardId);
    this.boardPickerOpen.set(false);
    this.boardPickerQuery.set("");
  }

  private resizeNewTitleInput(input: HTMLTextAreaElement) {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  ngOnDestroy() {
    this.cleanupDragCancel?.();
    if (this.clearCommittedDropTimeout !== null) window.clearTimeout(this.clearCommittedDropTimeout);
    this.stopEdgeScrollLoop();
  }

  onDragStarted(drag: CdkDrag<BoardLaneItem>) {
    vibrateCardDragStart();
    this.cardDragging.set(true);
    this.anyCardDragging = true;
    this.activeCardDrag = drag;
    this.cancelledCardDrag = null;
    this.lastDragPointer = null;
    this.cleanupDragCancel?.();
    this.cleanupDragCancel = this.listenForDragCancel();
    this.startEdgeScrollLoop();
    this.dragCoordinator.start(this.list().id);
  }

  onDragEnded() {
    vibrateCardDragEnd();
    this.cleanupDragCancel?.();
    this.cleanupDragCancel = undefined;
    this.activeCardDrag = null;
    this.lastDragPointer = null;
    this.clearHoveredDragList();
    this.cardDragging.set(false);
    this.anyCardDragging = false;
    this.stopEdgeScrollLoop();
    this.dragCoordinator.end();
    this.draggingOut.set(false);
    this.receiving.set(false);
  }

  onDragMoved(event: CdkDragMove<BoardLaneItem>) {
    this.lastDragPointer = event.pointerPosition;
    this.dragCoordinator.move(event.pointerPosition);
    this.dispatchTargetedListDragMove(event.pointerPosition);
    document.dispatchEvent(new CustomEvent<{ x: number; y: number }>(APP_DOM_EVENTS.CARD_DRAG_MOVE, {
      detail: event.pointerPosition,
    }));
  }

  private dispatchTargetedListDragMove(pointer: { x: number; y: number }) {
    const targetList = this.targetListForPointer(pointer);
    this.dragCoordinator.target(targetList?.dataset["listId"] ?? null);
    if (targetList !== this.hoveredDragListEl) {
      this.clearHoveredDragList();
      this.hoveredDragListEl = targetList;
    }
    targetList?.dispatchEvent(new CustomEvent<{ x: number; y: number }>(APP_DOM_EVENTS.CARD_DRAG_OVER_LIST, {
      detail: pointer,
    }));
  }

  private clearHoveredDragList() {
    this.hoveredDragListEl?.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_LEAVE_LIST));
    this.hoveredDragListEl = null;
  }

  private targetListForPointer(pointer: { x: number; y: number }): HTMLElement | null {
    // More than one board canvas can be mounted on consolidated pages. Restrict hit testing to
    // this list's nearest canvas so a drag never targets a list in another workspace section.
    const lane = this.hostEl.nativeElement.closest<HTMLElement>(".lists");
    const scrollLeft = lane?.scrollLeft ?? 0;
    if (!this.dragListTargetCache || this.dragListTargetCache.scrollLeft !== scrollLeft) {
      // Avoid elementFromPoint() on every drag move. On large boards that hit-test was the largest
      // remaining native JS sample; list columns only need refreshing when horizontal scroll moves.
      const laneBottom = lane?.getBoundingClientRect().bottom ?? window.innerHeight;
      this.dragListTargetCache = {
        scrollLeft,
        rects: Array.from(lane?.querySelectorAll<HTMLElement>("k-list") ?? []).map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: Math.max(rect.bottom, laneBottom), element };
        }),
      };
    }
    return this.dragListTargetCache.rects.find((rect) =>
      pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom
    )?.element ?? null;
  }

  onDropListEntered() {
    this.receiving.set(true);
    this.draggingOut.set(false);
  }

  private startEdgeScrollLoop() {
    if (this.edgeScrollFrame !== null) return;

    const tick = () => {
      this.edgeScrollFrame = window.requestAnimationFrame(tick);
      const pointer = this.lastDragPointer;
      const el = this.cardsEl()?.nativeElement;
      if (!pointer || !el) return;
      const rect = el.getBoundingClientRect();
      if (pointer.x < rect.left || pointer.x > rect.right) return;
      const yStep = cardDragEdgeScrollStep(pointer.y - rect.top, rect.height);
      if (yStep === 0) return;
      // Keep the common case cheap: a drag over the visible top of a large list should not mount
      // dozens of extra cards. Only grow the rendered slice when the pointer is actually trying
      // to edge-scroll through hidden rows.
      if (yStep > 0 && this.hiddenCardCount() > 0 && this.shouldGrowCards(el)) this.growRenderedCards();
      el.scrollTop += yStep * LIST_DRAG_EDGE_SCROLL_MULTIPLIER;
    };

    this.edgeScrollFrame = window.requestAnimationFrame(tick);
  }

  private stopEdgeScrollLoop() {
    if (this.edgeScrollFrame !== null) {
      window.cancelAnimationFrame(this.edgeScrollFrame);
      this.edgeScrollFrame = null;
    }
  }

  private listenForDragCancel(): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !this.activeCardDrag) return;
      event.preventDefault();
      event.stopPropagation();
      this.cancelledCardDrag = this.activeCardDrag;
      const pointer = this.lastDragPointer ?? { x: 0, y: 0 };
      this.restoreDragToOriginalPosition(this.activeCardDrag, pointer);
      // `reset()` only snaps the transform back; it does not end CDK's active
      // drag session. Trigger CDK's pointer-up path so previews/placeholders
      // are cleaned up, while `cancelledCardDrag` prevents the move emit.
      const dragRef = this.activeCardDrag._dragRef as unknown as { _pointerUp(event: MouseEvent): void };
      dragRef._pointerUp(new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: pointer.x,
        clientY: pointer.y,
      }));
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }

  private restoreDragToOriginalPosition(drag: CdkDrag<BoardLaneItem>, pointer: { x: number; y: number }) {
    const dragRef = drag._dragRef as unknown as {
      _dropContainer?: {
        enter(item: unknown, pointerX: number, pointerY: number, index?: number): void;
        exit(item: unknown): void;
      };
      _initialContainer?: {
        enter(item: unknown, pointerX: number, pointerY: number, index?: number): void;
        exit(item: unknown): void;
      };
      _initialIndex?: number;
    };

    if (!dragRef._initialContainer || dragRef._initialIndex === undefined) return;

    // CDK cancellation is private API territory. Move the live placeholder back
    // before ending the drag so Escape visually cancels instead of dropping in place.
    if (dragRef._dropContainer && dragRef._dropContainer !== dragRef._initialContainer) {
      dragRef._dropContainer.exit(drag._dragRef);
    }
    dragRef._dropContainer = dragRef._initialContainer;
    dragRef._initialContainer.enter(drag._dragRef, pointer.x, pointer.y, dragRef._initialIndex);
  }

  onDrop(event: CdkDragDrop<BoardLaneItem[]>) {
    if (event.item === this.cancelledCardDrag) {
      this.cancelledCardDrag = null;
      return;
    }

    this.receiving.set(false);
    const item = event.item.data as BoardLaneItem | undefined;
    const fallbackItem = event.previousContainer.data[event.previousIndex];
    const droppedItem = item ?? fallbackItem;
    if (!droppedItem) return;
    if (droppedItem.kind === "card" && !this.canDragCard(droppedItem.card.id)) return;
    const itemKey = laneItemKey(droppedItem);
    const targetItems = event.container.data;
    const targetListId = this.list().id;

    // The page owns the horizontal scroller. Preserve the actual receiving column so mobile can
    // settle onto it after drag cleanup re-enables scroll snapping.
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: targetListId }));

    const committedTargetItems = committedItemOrderForDrop(targetItems, droppedItem, event.currentIndex);
    if (event.previousContainer === event.container && sameItemOrder(targetItems, committedTargetItems)) return;
    suppressDropCommitTransitions(
      event.previousContainer.element?.nativeElement,
      event.container.element?.nativeElement,
    );
    const committedCardCount = committedTargetItems.reduce((count, item) => count + (item.kind === "card" ? 1 : 0), 0);
    // Cross-list drops can add one card just beyond the old cap. Grow only enough to keep the
    // newly committed visible slice mounted after parent state replaces the temporary order.
    this.renderCap.update((cap) => Math.max(cap, committedCardCount));
    this.commitDropOrder(committedTargetItems, itemKey);
    if (event.previousContainer !== event.container) {
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_SOURCE_COMMITTED, {
        detail: {
          listId: String(event.previousContainer.id).replace(/^dl-/, ""),
          cardId: droppedItem.kind === "card" ? droppedItem.card.id : undefined,
        },
      }));
    }

    const droppedIndex = committedTargetItems.findIndex((targetItem) => laneItemKey(targetItem) === itemKey);
    const beforeItem = droppedIndex >= 0 ? committedTargetItems[droppedIndex + 1] ?? null : null;
    const afterItem = beforeItem === null ? committedTargetItems[droppedIndex - 1] ?? null : undefined;
    const anchorPayload = beforeItem !== null
      ? { beforeItem: beforeItem ? laneItemAnchor(beforeItem) : null }
      : { afterItem: afterItem ? laneItemAnchor(afterItem) : null };

    if (droppedItem.kind === "card") {
      this.cardDropped.emit({ cardId: droppedItem.card.id, toListId: targetListId, ...anchorPayload });
    } else {
      this.separatorDropped.emit({ separatorId: droppedItem.separator.id, toListId: targetListId, ...anchorPayload });
    }
  }

  private commitDropOrder(items: BoardLaneItem[], droppedItemKey: string | null = null) {
    this.committedDropItems.set(items);
    this.committedDropItemKey.set(droppedItemKey);
    if (this.clearCommittedDropTimeout !== null) window.clearTimeout(this.clearCommittedDropTimeout);
    // The parent pages may be waiting on real or artificial latency before their optimistic
    // move runs. Keep the final CDK placeholder order painted until parent state catches up.
    this.clearCommittedDropTimeout = window.setTimeout(() => this.clearCommittedDropOrder(), COMMITTED_DROP_FALLBACK_MS);
  }

  private clearCommittedDropOrder() {
    if (this.clearCommittedDropTimeout !== null) {
      window.clearTimeout(this.clearCommittedDropTimeout);
      this.clearCommittedDropTimeout = null;
    }
    this.committedDropItems.set(null);
    this.committedDropItemKey.set(null);
  }
}
