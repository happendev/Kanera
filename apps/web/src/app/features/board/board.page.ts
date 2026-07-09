import { CdkDropListGroup } from "@angular/cdk/drag-drop";
import type { OnDestroy} from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import type { CompactCardCustomFieldValue, CompactCardSummary, ServerToClientEvents, WireBoardMemberUser, WireCard, WireCardSummary, WireChecklistTemplate, WireSeparator } from "@kanera/shared/events";
import { expandCardCustomFieldValue, expandCardSummary, SERVER_EVENTS } from "@kanera/shared/events";
import type { BoardExportArchive } from "@kanera/shared/dto";
import type { Board, BoardRole, BoardSeparator, Card, CardLabel, CustomField, List } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { downloadTextFile } from "../../core/browser/download";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService, type OfflineBoardSnapshot } from "../../core/offline/offline-cache.service";
import { RecentBoardsService } from "../../core/recent-boards/recent-boards.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { StatusToastComponent } from "../../shared/status-toast.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardBackgroundPopover } from "./board-background.popover";
import { BoardMembersMenu } from "../shared/board-members-menu.popover";
import { BoardSocketBridge } from "./board-socket-bridge";
import { BoardState, type BoardLaneItem, type LaneAnchor } from "./board-state";
import { BulkCardActionsMenuPopover } from "./bulk-card-actions-menu.popover";
import { BulkCustomFieldsDialogComponent } from "./bulk-custom-fields.dialog";
import { BoardCalendarViewComponent } from "./calendar-view/board-calendar-view.component";
import { WorkDoneViewComponent } from "./work-done-view/work-done-view.component";
import { WatcherPopoverComponent } from "./watcher-popover.component";
import { cardDragEdgeScrollStep } from "./card-drag-scroll";
import { CardDetailComponent } from "./card-detail.component";
import { isOverdue } from "./due-date.util";
import { BoardListViewComponent } from "./list-view/board-list-view.component";
import { matchesCfConditions } from "./list-view/filter.util";
import type { CfFilterCondition, FilterValue } from "./list-view/filter.types";
import { FilterBarComponent } from "./list-view/filter-bar.component";
import { readCompletedFilter, readFilters, readViewMode, writeCompletedFilter, writeFilters, writeViewMode, type StoredFilters, type ViewMode } from "./list-view/view-preference";
import { NotesViewComponent } from "../notes/notes-view.component";
import { CompletedCardsPanelComponent } from "../completed-cards/completed-cards-panel.component";
import { appendCompletedRangeParams, formatCompletedRangeDate } from "../completed-cards/completed-range.util";
import type { BulkCardMenuPayload, BulkCardSelectionPayload, BulkListSelectionPayload, CardDropPayload, SeparatorDropPayload, StartAddPayload } from "./list.component";
import { ListComponent } from "./list.component";
import { boardArchiveFileName, boardArchiveToReportRows, boardReportColumnWidths, styledBoardReportRows } from "./board-export.util";

type AnyCard = Card | WireCard | WireCardSummary;
const OFFLINE_COPY_PROMPT_DELAY_MS = 3000; // 3 seconds
const SEARCH_DEBOUNCE_MS = 200;

// Wide boards (30+ lists) only render a leading run of list columns and grow it as the user
// scrolls right, mirroring the per-list card cap. The cap only ever grows, so a list (and any
// card mid-drag) is never unmounted, keeping CDK's cross-list drop targets valid; edge-scroll
// during a drag grows the cap and reveals the next list before the pointer reaches it.
const INITIAL_LISTS_CAP = 8;
const GROW_NEAR_RIGHT_EDGE_PX = 800;
const PRELOAD_NEAR_RIGHT_EDGE_PX = 1600;
const LIST_GROWTH_IDLE_TIMEOUT_MS = 200;

@Component({
  selector: "k-board",
  standalone: true,
  imports: [CdkDropListGroup, ListComponent, CardDetailComponent, BoardBackgroundPopover, BoardMembersMenu, AvatarComponent, BoardListViewComponent, BoardCalendarViewComponent, WorkDoneViewComponent, NotesViewComponent, CompletedCardsPanelComponent, FilterBarComponent, StatusToastComponent, TooltipDirective, WatcherPopoverComponent, BulkCardActionsMenuPopover, BulkCustomFieldsDialogComponent],
  providers: [BoardState, BoardSocketBridge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board.page.html",
  styleUrl: "./board.page.scss",
})
export class BoardPage implements OnDestroy {
  protected readonly state = inject(BoardState);
  private readonly socketBridge = inject(BoardSocketBridge);
  private readonly api = inject(ApiClient);
  private readonly appTitle = inject(AppTitleService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly notifications = inject(NotificationsService);
  private readonly recentBoards = inject(RecentBoardsService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly listsEl = viewChild<ElementRef<HTMLElement>>('listsEl');

  readonly boardId = input.required<string>();
  readonly cardId = input<string | undefined>();
  readonly lightboxAttachmentId = input<string | undefined>();
  readonly noteId = input<string | undefined>();
  readonly view = input<ViewMode | undefined>();
  readonly rememberedView = signal<ViewMode>("board");
  /** Resolved view mode: URL query param > localStorage > default board. */
  readonly effectiveView = computed<ViewMode>(() => {
    const fromUrl = this.view();
    if (fromUrl === "list" || fromUrl === "board" || fromUrl === "notes" || fromUrl === "calendar" || fromUrl === "history") return fromUrl;
    return this.rememberedView();
  });
  readonly openCardId = signal<string | null>(null);
  readonly showBackground = signal(false);
  readonly membersPopoverOpen = signal(false);
  readonly watcherPopoverOpen = signal(false);
  readonly skeletonCards = [1, 2, 3];

  // How many list columns to actually render; grows on horizontal scroll toward the right edge.
  private readonly listRenderCap = signal(INITIAL_LISTS_CAP);
  readonly renderedLists = computed(() => {
    const lists = this.state.visibleLists();
    const cap = this.listRenderCap();
    return lists.length > cap ? lists.slice(0, cap) : lists;
  });
  readonly hiddenListCount = computed(() => Math.max(0, this.state.visibleLists().length - this.listRenderCap()));

  onListsScroll(el: HTMLElement) {
    // New columns append to the right of existing ones, so the dragged card's context doesn't
    // shift. Growing during a drag's horizontal edge-scroll lets a card reach a list column
    // beyond the initial window (preserving cross-list drag on wide boards).
    const remaining = el.scrollWidth - el.scrollLeft - el.clientWidth;
    this.scheduleListGrowthNearRightEdge(el, remaining <= GROW_NEAR_RIGHT_EDGE_PX);
  }

  private growListCap() {
    if (this.hiddenListCount() === 0) return;
    this.listRenderCap.update((cap) => cap + 1);
  }

  readonly searchInputValue = signal('');
  readonly searchQuery = signal('');
  readonly filterLabelIds = signal<string[]>([]);
  readonly filterMemberIds = signal<string[]>([]);
  // Restrict to cards in the selected lists (empty = all lists).
  readonly filterListIds = signal<string[]>([]);
  // Operator-based custom-field conditions covering all seven field types (see filter.util.ts).
  // Conditions AND together; multiple conditions on the same field are allowed.
  readonly filterCfConditions = signal<CfFilterCondition[]>([]);
  readonly compactOpen = signal(false);
  readonly showUnreadOnly = signal(false);
  readonly showOverdueOnly = signal(false);
  readonly showArchived = signal(false);
  readonly completedFrom = signal("");
  readonly completedTo = signal("");
  readonly showCompleted = computed(() => !!this.completedFrom() || !!this.completedTo());
  readonly completedRangeLabel = computed(() => {
    const from = this.completedFrom();
    const to = this.completedTo();
    if (from && to) return `${formatCompletedRangeDate(from)} – ${formatCompletedRangeDate(to)}`;
    if (from) return `From ${formatCompletedRangeDate(from)}`;
    if (to) return `Until ${formatCompletedRangeDate(to)}`;
    return "Choose date range";
  });
  readonly completedPanelOpen = signal(false);
  readonly bulkSelectedCardIds = signal<Set<string>>(new Set());
  readonly lastBulkSelectedCardId = signal<string | null>(null);
  readonly bulkMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly bulkCustomFieldsOpen = signal(false);
  readonly completedHistoryCard = signal<WireCardSummary | null>(null);
  readonly workDoneRefreshVersion = signal(0);
  readonly exportMenuOpen = signal(false);
  readonly exportLoading = signal<"json" | "xlsx" | null>(null);
  readonly currentUserId = computed(() => this.auth.user()?.id ?? null);
  readonly workspaceAccentColor = computed(() => this.workspaceService.accentColorForBoard(this.boardId()));
  readonly offlineTooltip = computed(() => this.state.canEdit() || this.state.online() ? null : "You're offline - changes are paused");
  readonly offlineCopyLabel = computed(() => {
    const cachedAt = this.offlineBoardCachedAt();
    return cachedAt ? `Offline copy from ${this.formatRelativeTime(cachedAt)}` : "";
  });
  readonly offlineCopyPromptDelayMs = OFFLINE_COPY_PROMPT_DELAY_MS;

  // Assemble the individual filter signals into the single shape the shared filter bar consumes.
  // Board is single-board, so `boardIds` is always empty here.
  readonly filterValue = computed<FilterValue>(() => ({
    labelIds: this.filterLabelIds(),
    memberIds: this.filterMemberIds(),
    listIds: this.filterListIds(),
    boardIds: [],
    cfConditions: this.filterCfConditions(),
    showUnreadOnly: this.showUnreadOnly(),
    showOverdueOnly: this.showOverdueOnly(),
  }));

  // Every non-archived custom field is filterable via the condition builder (all seven types).
  readonly filterableCustomFields = computed(() =>
    this.state.customFields().filter((field) => !field.archivedAt),
  );

  readonly sortedLabels = computed(() =>
    [...this.state.cardLabels()].sort((a, b) => Number(a.position) - Number(b.position))
  );

  readonly sortedFilterMembers = computed(() => {
    const meId = this.currentUserId();
    return [...this.state.members()].sort((a, b) => {
      if (a.userId === meId) return -1;
      if (b.userId === meId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  });

  // Board membership is the access and assignment boundary. Do not merge in the workspace roster:
  // users who belong to the workspace but not this board must remain invisible here.
  readonly sortedBoardMembers = computed(() => this.sortMembersByRole(this.state.members()));
  readonly headerMembers = computed(() => this.sortedBoardMembers().slice(0, 5));
  readonly headerMemberOverflow = computed(() => Math.max(0, this.sortedBoardMembers().length - this.headerMembers().length));
  readonly assignableMembers = computed(() => this.sortedBoardMembers());
  readonly membersButtonLabel = computed(() => {
    const count = this.sortedBoardMembers().length;
    return count === 1 ? "1 board member" : `${count} board members`;
  });

  readonly filteredCardIds = computed<Set<string> | null>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const labelIds = this.filterLabelIds();
    const memberIds = this.filterMemberIds();
    const listIds = this.filterListIds();
    const conditions = this.filterCfConditions();
    const unreadOnly = this.effectiveView() !== "history" && this.showUnreadOnly();
    const overdueOnly = this.showOverdueOnly();
    const showArchived = this.showArchived();
    if (!q && !labelIds.length && !memberIds.length && !listIds.length && !conditions.length && !unreadOnly && (!overdueOnly || showArchived)) return null;
    const fieldsById = conditions.length ? this.state.customFieldsById() : null;
    const cfValuesByCard = conditions.length ? this.state.customFieldValuesByCardAndField() : null;
    const listSet = new Set(listIds);
    const labelFilterIds = new Set(labelIds);
    const memberFilterIds = new Set(memberIds);
    const labelIdsByCard = labelIds.length ? this.state.labelIdSetsByCard() : null;
    const assigneeIdsByCard = memberIds.length ? this.state.assigneeIdSetsByCard() : null;

    const matching = this.state.cards()
      .filter(c => showArchived ? !!c.archivedAt : !c.archivedAt)
      .filter(card => {
        if (q && !card.title.toLowerCase().includes(q)) return false;
        if (listSet.size && !listSet.has(card.listId)) return false;
        if (unreadOnly && this.notifications.cardUnreadCount(card.id) === 0) return false;
        if (labelIdsByCard && !this.hasAny(labelIdsByCard.get(card.id), labelFilterIds)) return false;
        if (assigneeIdsByCard && !this.hasAny(assigneeIdsByCard.get(card.id), memberFilterIds)) return false;
        if (!showArchived && overdueOnly && (card.completedAt || !isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone))) return false;
        if (fieldsById && cfValuesByCard && !matchesCfConditions(card.id, conditions, fieldsById, cfValuesByCard)) return false;
        return true;
      });
    return new Set(matching.map(c => c.id));
  });

  readonly cardsByList = computed(() => {
    const showArchived = this.showArchived();
    const visibleListIds = new Set(this.state.visibleLists().map((list) => list.id));
    const result = new Map<string, AnyCard[]>();
    for (const listId of visibleListIds) result.set(listId, []);

    // Walk the card set once, then sort each populated list. This keeps board
    // view rendering linear in card count instead of filtering all cards per list.
    for (const card of this.state.cards()) {
      if (!visibleListIds.has(card.listId)) continue;
      if (showArchived ? !card.archivedAt : card.archivedAt) continue;
      result.get(card.listId)?.push(card);
    }

    for (const cards of result.values()) {
      cards.sort((a, b) => Number(a.position) - Number(b.position));
    }
    return result;
  });

  readonly itemsByList = computed(() => {
    const filtered = !!this.filteredCardIds();
    const result = new Map<string, BoardLaneItem[]>();
    for (const [listId, cards] of this.cardsByList()) {
      result.set(listId, this.state.itemsForList(listId, cards, filtered));
    }
    return result;
  });

  readonly activeCards = computed(() =>
    this.state.cards().filter((card) => this.showArchived() ? !!card.archivedAt : !card.archivedAt),
  );
  readonly bulkSelectedCards = computed(() => {
    const selected = this.bulkSelectedCardIds();
    return this.state.cards().filter((card) => selected.has(card.id));
  });
  readonly bulkSelectedCardIdList = computed(() => Array.from(this.bulkSelectedCardIds()));
  readonly bulkSelectedCount = computed(() => this.bulkSelectedCardIds().size);
  readonly bulkMenuOpen = computed(() => Boolean(this.bulkMenuPoint()) && this.bulkSelectedCount() > 0);

  readonly isFiltered = computed(() =>
    Boolean(this.searchQuery().trim()) ||
    this.filterLabelIds().length > 0 ||
    this.filterMemberIds().length > 0 ||
    this.filterListIds().length > 0 ||
    this.filterCfConditions().length > 0 ||
    (this.effectiveView() !== "history" && this.showUnreadOnly()) ||
    this.showOverdueOnly() ||
    this.showArchived() ||
    this.showCompleted()
  );
  readonly toolbarFilterActive = computed(() => {
    if (this.effectiveView() === "history") {
      return Boolean(this.searchQuery().trim()) || this.filterLabelIds().length > 0 || this.filterMemberIds().length > 0 || this.filterListIds().length > 0 || this.filterCfConditions().length > 0;
    }
    return this.isFiltered();
  });
  readonly isWatchingBoard = computed(() => this.notifications.isWatchingBoard(this.boardId()));
  readonly offlineBoardCachedAt = signal<string | null>(null);
  private filterLoadSeq = 0;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private hasAny(values: Set<string> | undefined, filters: Set<string>): boolean {
    if (!values) return false;
    for (const id of filters) {
      if (values.has(id)) return true;
    }
    return false;
  }

  private sortMembersByRole(members: WireBoardMemberUser[]): WireBoardMemberUser[] {
    const roleRank: Record<WireBoardMemberUser["role"], number> = {
      admin: 0,
      editor: 1,
      member: 2,
      observer: 3,
    };
    return [...members].sort((a, b) => {
      const roleDelta = roleRank[a.role] - roleRank[b.role];
      if (roleDelta !== 0) return roleDelta;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  private saveCurrentBoardSnapshot() {
    const snapshot = this.state.snapshot();
    if (snapshot) this.saveBoardSnapshot(snapshot);
  }

  private saveBoardSnapshot(snapshot: Omit<OfflineBoardSnapshot, "boardId" | "cachedAt">) {
    void this.offlineCache.saveBoard(snapshot.board.id, snapshot).catch(() => undefined);
  }

  readonly skeletonLists = computed(() => {
    const lists = this.workspaceService.listsForBoard(this.boardId());
    const n = lists.length || 3;
    return Array.from({ length: n }, (_, i) => i);
  });
  readonly addingToListId = signal<string | null>(null);
  readonly addingAtTop = signal(false);

  // Live-collection resolution: the open card as it exists in state.cards(), with the
  // completed-history summary as a fallback for cards outside the active filter window.
  readonly openCardInCollection = computed<AnyCard | null>(() => {
    const id = this.openCardId();
    return id ? (this.state.cards().find((c) => c.id === id) ?? (this.completedHistoryCard()?.id === id ? this.completedHistoryCard() : null)) : null;
  });
  // Last-known summary of the open card, held so the modal stays mounted with data when a
  // background board refresh, filter change, or archive drops the card from the live collection.
  readonly openCardHeld = signal<AnyCard | null>(null);
  // Sticky modal: prefer the live-collection card; otherwise fall back to the held summary, but
  // only while the open card id is unchanged so we never render a stale different card. The modal
  // therefore never vanishes on a background refresh — it closes only on close() or a real
  // CARD_DELETED (see the socket handler below), matching the confirmed product decision.
  readonly openCard = computed<AnyCard | null>(() => {
    const fromCollection = this.openCardInCollection();
    if (fromCollection) return fromCollection;
    const held = this.openCardHeld();
    return held?.id === this.openCardId() ? held : null;
  });

  // Tracks the id the held summary belongs to, so the capture effect can drop a held card the moment
  // the open id changes — preventing a previous visit's summary from resurfacing when returning to an
  // id that is currently outside the live collection.
  private heldCardId: string | null = null;
  private scrollDrag: { startX: number; startScrollLeft: number } | null = null;
  private cleanupScrollDrag?: () => void;
  private cardDragPointer: { x: number; y: number } | null = null;
  private edgeScrollFrame: number | null = null;
  private listGrowthIdle: number | null = null;
  private listGrowthFrame: number | null = null;
  private listTitleResizeObserver: ResizeObserver | null = null;
  private listTitleMutationObserver: MutationObserver | null = null;
  private listTitleHeightFrame: number | null = null;
  private cardDragActive = false;
  private largeBoardClassApplied = false;

  private attachScrollDragHandlers(el: HTMLElement) {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest('k-list') || target.closest('.add-list')) return;
      this.scrollDrag = { startX: e.clientX, startScrollLeft: el.scrollLeft };
      el.classList.add('is-dragging');
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.scrollDrag) return;
      e.preventDefault();
      el.scrollLeft = this.scrollDrag.startScrollLeft - (e.clientX - this.scrollDrag.startX);
    };

    const onMouseUp = () => {
      if (!this.scrollDrag) return;
      this.scrollDrag = null;
      el.classList.remove('is-dragging');
    };

    const onCardDragState = (event: Event) => {
      const active = event instanceof CustomEvent ? !!event.detail : false;
      this.cardDragActive = active;
      if (active) {
        // CDK snapshots available drop containers during drag. Reveal all list columns at drag
        // start so far-right lists are registered as targets before horizontal edge-scroll reaches
        // them; per-list card caps still keep the DOM bounded.
        this.cancelScheduledListGrowth();
        this.listRenderCap.set(this.state.visibleLists().length);
        if (this.listTitleHeightFrame !== null) {
          window.cancelAnimationFrame(this.listTitleHeightFrame);
          this.listTitleHeightFrame = null;
        }
        this.startEdgeScrollLoop();
      } else {
        this.stopEdgeScrollLoop();
        this.scheduleListTitleHeightSync(el);
      }
    };

    const onCardDragMove = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { x?: unknown; y?: unknown } | null;
      if (typeof detail?.x !== "number" || typeof detail.y !== "number") return;
      this.cardDragPointer = { x: detail.x, y: detail.y };
    };

    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.addEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onCardDragState);
    document.addEventListener(APP_DOM_EVENTS.CARD_DRAG_MOVE, onCardDragMove);

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onCardDragState);
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_MOVE, onCardDragMove);
      this.stopEdgeScrollLoop();
    };
  }

  ngOnDestroy() {
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.clearSearchDebounce();
    this.cleanupScrollDrag?.();
    this.cancelScheduledListGrowth();
    this.stopListTitleHeightSync();
    this.setLargeBoardClass(false);
    this.workspaceService.setActiveAccentColor(null);
  }

  private setLargeBoardClass(active: boolean) {
    if (this.largeBoardClassApplied === active) return;
    this.largeBoardClassApplied = active;
    document.body.classList.toggle("is-large-board", active);
  }

  private startListTitleHeightSync(el: HTMLElement) {
    this.stopListTitleHeightSync();
    this.listTitleResizeObserver = new ResizeObserver(() => this.scheduleListTitleHeightSync(el));
    this.listTitleMutationObserver = new MutationObserver(() => {
      this.observeListTitles(el);
      this.scheduleListTitleHeightSync(el);
    });
    this.observeListTitles(el);
    this.listTitleMutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
    this.scheduleListTitleHeightSync(el);
  }

  private observeListTitles(el: HTMLElement) {
    this.listTitleResizeObserver?.disconnect();
    for (const title of this.listTitleEls(el)) {
      this.listTitleResizeObserver?.observe(title);
    }
  }

  private scheduleListTitleHeightSync(el: HTMLElement) {
    // CDK mutates classes/placeholders continuously while dragging. Re-measuring every list title
    // in response to those mutations creates long layout tasks on large boards; title heights do
    // not need to change until the drag settles.
    if (this.cardDragActive) return;
    if (this.listTitleHeightFrame !== null) return;
    this.listTitleHeightFrame = window.requestAnimationFrame(() => {
      this.listTitleHeightFrame = null;
      this.syncListTitleHeight(el);
    });
  }

  private syncListTitleHeight(el: HTMLElement) {
    const titles = this.listTitleEls(el);
    const maxHeight = titles.reduce((height, title) => Math.max(height, this.measureNaturalListTitleHeight(title)), 0);
    if (maxHeight > 0) el.style.setProperty("--list-title-height", `${Math.ceil(maxHeight)}px`);
  }

  private measureNaturalListTitleHeight(title: HTMLElement): number {
    const width = title.getBoundingClientRect().width;
    if (width === 0) return 0;
    const clone = title.cloneNode(true) as HTMLElement;
    // Measure outside the observed board subtree so the observer does not react to its own probe.
    clone.style.position = "absolute";
    clone.style.visibility = "hidden";
    clone.style.pointerEvents = "none";
    clone.style.minHeight = "0";
    clone.style.height = "auto";
    clone.style.width = `${width}px`;
    clone.style.inset = "0 auto auto 0";
    document.body.appendChild(clone);
    const height = clone.getBoundingClientRect().height;
    clone.remove();
    return height;
  }

  private listTitleEls(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>("k-list .list-header h3"));
  }

  private stopListTitleHeightSync() {
    if (this.listTitleHeightFrame !== null) {
      window.cancelAnimationFrame(this.listTitleHeightFrame);
      this.listTitleHeightFrame = null;
    }
    this.listTitleResizeObserver?.disconnect();
    this.listTitleResizeObserver = null;
    this.listTitleMutationObserver?.disconnect();
    this.listTitleMutationObserver = null;
    this.listsEl()?.nativeElement.style.removeProperty("--list-title-height");
  }

  private startEdgeScrollLoop() {
    if (this.edgeScrollFrame !== null) return;

    // During CDK card dragging, nudge the horizontal board scroller and the page
    // scroll when the pointer sits near a viewport edge.
    const tick = () => {
      this.edgeScrollFrame = window.requestAnimationFrame(tick);
      const pointer = this.cardDragPointer;
      if (!pointer) return;

      const xStep = cardDragEdgeScrollStep(pointer.x, window.innerWidth);
      const el = this.listsEl()?.nativeElement;
      if (xStep !== 0 && el) {
        el.scrollLeft += xStep;
        if (xStep > 0) this.scheduleListGrowthNearRightEdge(el, true);
      }

      const yStep = cardDragEdgeScrollStep(pointer.y, window.innerHeight);
      if (yStep !== 0) {
        window.scrollBy({ top: yStep, left: 0 });
      }
    };

    this.edgeScrollFrame = window.requestAnimationFrame(tick);
  }

  private scheduleListGrowthNearRightEdge(el: HTMLElement, urgent = false) {
    if (this.hiddenListCount() === 0) return;
    // Upgrade an idle preload to the next animation frame if fast scrolling reaches the urgent zone.
    if (urgent && this.listGrowthIdle !== null) {
      window.cancelIdleCallback(this.listGrowthIdle);
      this.listGrowthIdle = null;
    }
    if (this.listGrowthIdle !== null || this.listGrowthFrame !== null) return;
    const remaining = el.scrollWidth - el.scrollLeft - el.clientWidth;
    if (remaining > PRELOAD_NEAR_RIGHT_EDGE_PX) return;

    const grow = () => {
      if (this.hiddenListCount() === 0) return;
      const currentRemaining = el.scrollWidth - el.scrollLeft - el.clientWidth;
      if (currentRemaining > PRELOAD_NEAR_RIGHT_EDGE_PX) return;
      this.growListCap();

      // Angular renders the new column after the signal update. Recheck layout on the next frame
      // and keep staging columns only while the user remains close to the rendered edge.
      this.listGrowthFrame = window.requestAnimationFrame(() => {
        this.listGrowthFrame = null;
        this.scheduleListGrowthNearRightEdge(el);
      });
    };

    if (urgent || typeof window.requestIdleCallback !== "function") {
      this.listGrowthFrame = window.requestAnimationFrame(() => {
        this.listGrowthFrame = null;
        grow();
      });
      return;
    }

    this.listGrowthIdle = window.requestIdleCallback(() => {
      this.listGrowthIdle = null;
      grow();
    }, { timeout: LIST_GROWTH_IDLE_TIMEOUT_MS });
  }

  private cancelScheduledListGrowth() {
    if (this.listGrowthIdle !== null) {
      window.cancelIdleCallback(this.listGrowthIdle);
      this.listGrowthIdle = null;
    }
    if (this.listGrowthFrame !== null) {
      window.cancelAnimationFrame(this.listGrowthFrame);
      this.listGrowthFrame = null;
    }
  }

  private stopEdgeScrollLoop() {
    this.cardDragPointer = null;
    if (this.edgeScrollFrame === null) return;
    window.cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }

  constructor() {
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    effect((onCleanup) => {
      // Re-attach scroll-drag handlers whenever the kanban scroller mounts.
      const el = this.listsEl()?.nativeElement;
      if (!el) return;
      const detach = this.attachScrollDragHandlers(el);
      this.startListTitleHeightSync(el);
      this.cleanupScrollDrag = detach;
      onCleanup(() => {
        detach();
        this.stopListTitleHeightSync();
        this.cleanupScrollDrag = undefined;
      });
    });

    effect(() => {
      // Large seeded/imported boards have hundreds of mounted cards; hover shadows/transitions and
      // broad selector invalidation are noticeable when sweeping across cards. The body class lets
      // global CSS choose cheaper hover/drag affordances only for those boards.
      this.setLargeBoardClass(this.state.visibleLists().length > 20 || this.activeCards().length > 300);
    });

    effect(() => {
      const boardTitle = this.state.board()?.name ?? "Board";
      const cardTitle = this.openCard()?.title;
      if (cardTitle) this.appTitle.set(cardTitle, boardTitle);
      else this.appTitle.set(boardTitle);
    });

    effect(() => {
      this.openCardId.set(this.cardId() ?? null);
    });

    // Capture the last-known summary of the open card while it still resolves from the live
    // collection. Reads only openCardInCollection (never openCardHeld), so there is no feedback loop.
    effect(() => {
      const id = this.openCardId();
      const resolved = this.openCardInCollection();
      // Drop any held summary when the open id changes, before capturing the new one. Without this,
      // navigating A → (unavailable) B → A while A stays outside the collection would resurrect A's
      // stale summary from the first visit. A same-id background refresh keeps the held card (sticky).
      if (id !== this.heldCardId) {
        this.heldCardId = id;
        this.openCardHeld.set(null);
      }
      if (resolved) this.openCardHeld.set(resolved);
    });

    effect(() => {
      this.state.assignableMembers.set(this.assignableMembers());
    });

    effect(() => {
      const visibleIds = new Set(this.activeCards().map((card) => card.id));
      const selected = this.bulkSelectedCardIds();
      if (selected.size === 0) return;
      const next = new Set([...selected].filter((id) => visibleIds.has(id)));
      if (next.size !== selected.size) {
        this.bulkSelectedCardIds.set(next);
        if (this.lastBulkSelectedCardId() && !next.has(this.lastBulkSelectedCardId()!)) {
          this.lastBulkSelectedCardId.set(null);
        }
        if (next.size === 0) this.closeBulkMenu();
      }
    });

    effect((onCleanup) => {
      const value = this.searchInputValue();
      const timer = setTimeout(() => this.searchQuery.set(value), SEARCH_DEBOUNCE_MS);
      this.searchDebounceTimer = timer;
      onCleanup(() => {
        clearTimeout(timer);
        if (this.searchDebounceTimer === timer) this.searchDebounceTimer = null;
      });
    });

    effect(() => {
      const board = this.state.board();
      if (!board) {
        this.membersPopoverOpen.set(false);
      }
    });

    effect(() => {
      const remembered = readViewMode(`board:${this.boardId()}`);
      this.rememberedView.set(remembered === "list" || remembered === "notes" || remembered === "calendar" || remembered === "history" ? remembered : "board");
    });

    effect(() => {
      const board = this.state.board();
      const color = board
        ? (board.iconColor ?? this.workspaceService.accentColorForBoard(board.id))
        : null;
      const style = this.el.nativeElement.style;
      if (color) {
        style.setProperty("--accent", `var(--color-${color})`);
        style.setProperty("--accent-hover", `color-mix(in srgb, var(--color-${color}), black 15%)`);
        style.setProperty("--ring", `color-mix(in srgb, var(--color-${color}) 40%, transparent)`);
      } else {
        style.removeProperty("--accent");
        style.removeProperty("--accent-hover");
        style.removeProperty("--ring");
      }
      this.workspaceService.setActiveAccentColor(color);
    });

    effect(() => {
      const snapshot = this.state.snapshot();
      if (!snapshot || this.offlineBoardCachedAt()) return;
      untracked(() => this.saveBoardSnapshot(snapshot));
    });

    // Filters, List View columns, and export need every field's values, not just the
    // showOnCard ones inlined at board open, so load the full set the moment one is engaged.
    effect(() => {
      // Hidden (showOnCard=false) fields aren't inlined at board open, so load the full value set
      // whenever the List View is active or a CF condition is active — otherwise a condition on a
      // hidden field would wrongly hide cards while its values are absent. Adding a condition in the
      // filter bar seeds it with an operand-less (inactive) operator, so this fires in time before it
      // can affect matching.
      const needed = this.effectiveView() === "list" || this.filterCfConditions().length > 0;
      if (needed) this.ensureCustomFieldValuesLoaded();
    });

    // If the rendered list columns don't overflow the viewport there's no horizontal scroll to
    // trigger growth, so on a very wide screen keep revealing lists until they fill the strip or
    // all are shown. rAF reads layout after paint; growing re-runs this effect until settled.
    effect(() => {
      this.renderedLists();
      if (this.hiddenListCount() === 0) return;
      const el = this.listsEl()?.nativeElement;
      if (!el) return;
      untracked(() => requestAnimationFrame(() => {
        if (this.hiddenListCount() > 0 && el.scrollWidth <= el.clientWidth) this.scheduleListGrowthNearRightEdge(el, true);
      }));
    });

    effect((onCleanup) => {
      const boardId = this.boardId();
      let cancelled = false;
      let hydrated = false;
      let joinedOnce = false;
      let refreshInFlight = false;
      let refreshQueued = false;
      const completed = readCompletedFilter(`board:${boardId}`);
      // Search stays session-local; label/member/list/CF/unread/overdue filters are sticky per board
      // (restored here, persisted by the effect below), and the completed range keeps its own key.
      const saved = readFilters(`board:${boardId}`);
      this.setSearchQuery("");
      this.filterLabelIds.set(saved?.labelIds ?? []);
      this.filterMemberIds.set(saved?.memberIds ?? []);
      this.filterListIds.set(saved?.listIds ?? []);
      this.filterCfConditions.set(saved?.cfConditions ?? []);
      this.showUnreadOnly.set(saved?.showUnreadOnly ?? false);
      this.showOverdueOnly.set(saved?.showOverdueOnly ?? false);
      this.showArchived.set(false);
      this.compactOpen.set(false);
      this.membersPopoverOpen.set(false);
      this.completedFrom.set(completed?.from ?? "");
      this.completedTo.set(completed?.to ?? "");
      const completedFrom = completed?.from ?? "";
      const completedTo = completed?.to ?? "";
      const includeArchived = untracked(() => this.showArchived());
      this.cancelScheduledListGrowth();
      this.listRenderCap.set(INITIAL_LISTS_CAP);
      this.state.clear();
      const socket = this.sockets.connect();

      const applyBoard = (data: Awaited<ReturnType<typeof this.loadBoard>>) => {
        if (cancelled) return;
        this.state.hydrate(data);
        this.offlineBoardCachedAt.set(null);
        hydrated = true;
        this.saveCurrentBoardSnapshot();
      };
      const applyCachedBoard = (snapshot: OfflineBoardSnapshot) => {
        if (cancelled) return;
        this.state.restoreSnapshot(snapshot);
        this.offlineBoardCachedAt.set(snapshot.cachedAt);
        hydrated = true;
      };
      const handleRevokedAccess = (error: unknown) => {
        if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return false;
        // Cached content is an offline fallback, never an authorization fallback. A definitive
        // access denial invalidates every local copy before leaving the route.
        this.state.clear();
        this.workspaceService.removeBoard(boardId);
        void this.offlineCache.revokeBoardAccess(boardId).catch(() => undefined);
        if (!cancelled) void this.router.navigateByUrl("/");
        return true;
      };
      const refreshBoard = () => {
        if (cancelled || !hydrated) return;
        if (refreshInFlight) {
          refreshQueued = true;
          return;
        }
        refreshInFlight = true;
        // A refresh's GET snapshot can predate a card mutation confirmed locally while it was in
        // flight (the create/move/rename race a reconnect-triggered refresh). Capture the local
        // revision now; if it advances before the response applies, queue one more serialized
        // refresh so we converge on server truth instead of leaving stale data on screen.
        const seqBeforeFetch = this.state.cardMutationSeq();
        void this.loadBoard(
          boardId,
          false,
          untracked(() => this.showArchived()),
          false,
          untracked(() => this.completedFrom()),
          untracked(() => this.completedTo()),
        )
          .then((data) => {
            applyBoard(data);
            if (this.state.cardMutationSeq() !== seqBeforeFetch) refreshQueued = true;
          })
          .catch((error: unknown) => {
            handleRevokedAccess(error);
          })
          .finally(() => {
            refreshInFlight = false;
            if (refreshQueued) {
              refreshQueued = false;
              refreshBoard();
            }
          });
      };

      this.closeAddMode();
      this.clearBulkSelection();
      void this.offlineCache.loadBoard(boardId)
        .then((cached) => {
          if (cached && !hydrated) applyCachedBoard(cached);
        })
        .catch(() => undefined);

      void this.loadBoard(boardId, false, includeArchived, true, completedFrom, completedTo).then(applyBoard).catch(async (error: unknown) => {
        if (handleRevokedAccess(error)) return;
        if (hydrated) return;
        const cached = await this.offlineCache.loadBoard(boardId).catch(() => null);
        if (cached) {
          applyCachedBoard(cached);
          return;
        }
        if (!cancelled) void this.router.navigateByUrl("/");
      });

      const detach = this.socketBridge.attach(socket, boardId, {
        viewerUserId: this.auth.user()?.id ?? null,
        onJoined: () => {
          if (!joinedOnce) {
            joinedOnce = true;
            return;
          }
          refreshBoard();
        },
        onDesync: refreshBoard,
        onWorkDoneChanged: () => this.workDoneRefreshVersion.update((version) => version + 1),
      });
      const onDeleted: ServerToClientEvents["board:deleted"] = ({ boardId: deletedId }) => {
        if (deletedId === boardId) void this.router.navigateByUrl("/");
      };
      const onWorkspaceDeleted: ServerToClientEvents["workspace:deleted"] = ({ workspaceId }) => {
        if (workspaceId === this.state.board()?.workspaceId) void this.router.navigateByUrl("/");
      };
      const onWorkspaceMemberUpdated: ServerToClientEvents["workspace:member:updated"] = ({ workspaceId, member }) => {
        if (workspaceId !== this.state.board()?.workspaceId || member.userId !== this.auth.user()?.id) return;
        // Workspace admin changes alter effective access to every board. Re-open this board against
        // the server so promotion gains admin controls and demotion either restores explicit access
        // or follows the normal revoked-access redirect without a full page reload.
        refreshBoard();
      };
      const onClientUserRoleChanged: ServerToClientEvents["client:user:role-changed"] = () => refreshBoard();
      const onUserProfileUpdated: ServerToClientEvents["user:profile:updated"] = ({ userId, displayName, avatarUrl }) => {
        const applyProfile = (member: WireBoardMemberUser) =>
          member.userId === userId ? { ...member, displayName, avatarUrl } : member;
        this.state.members.update((members) => members.map(applyProfile));
      };
      const onBoardMemberRemoved: ServerToClientEvents["board:member:removed"] = ({ boardId: eventBoardId, userId }) => {
        // BoardSocketBridge owns the roster update. This page-level listener only handles the
        // additional route/cache cleanup required when the current viewer loses access.
        if (eventBoardId !== boardId || userId !== this.auth.user()?.id) return;
        this.state.clear();
        this.workspaceService.removeBoard(boardId);
        void this.offlineCache.revokeBoardAccess(boardId).catch(() => undefined);
        void this.router.navigateByUrl("/");
      };
      // The board socket bridge removes a deleted card from state.cards(), which would otherwise
      // leave the sticky-modal fallback holding the open card. A real delete is the one case where
      // the modal must close: drop the held summary and navigate the card out of the URL. Archive
      // arrives as CARD_UPDATED (not a delete), so archived cards stay open — matching the decision.
      const onCardDeleted: ServerToClientEvents[typeof SERVER_EVENTS.CARD_DELETED] = ({ boardId: eventBoardId, cardId }) => {
        if (eventBoardId !== boardId || cardId !== this.openCardId()) return;
        this.openCardHeld.set(null);
        this.closeCardDetail();
      };
      socket.on(SERVER_EVENTS.CARD_DELETED, onCardDeleted);
      socket.on("board:deleted", onDeleted);
      socket.on("workspace:deleted", onWorkspaceDeleted);
      socket.on("workspace:member:updated", onWorkspaceMemberUpdated);
      socket.on("client:user:role-changed", onClientUserRoleChanged);
      socket.on("user:profile:updated", onUserProfileUpdated);
      socket.on("board:member:removed", onBoardMemberRemoved);
      onCleanup(() => {
        cancelled = true;
        socket.off(SERVER_EVENTS.CARD_DELETED, onCardDeleted);
        socket.off("board:deleted", onDeleted);
        socket.off("workspace:deleted", onWorkspaceDeleted);
        socket.off("workspace:member:updated", onWorkspaceMemberUpdated);
        socket.off("client:user:role-changed", onClientUserRoleChanged);
        socket.off("user:profile:updated", onUserProfileUpdated);
        socket.off("board:member:removed", onBoardMemberRemoved);
        detach();
      });
    });

    // Persist the sticky filter set per board. Registered after the board-open effect so a board
    // switch restores the new board's filters before this writes them back under the new scope.
    effect(() => {
      const scope = `board:${this.boardId()}`;
      const filters: StoredFilters = {
        labelIds: this.filterLabelIds(),
        memberIds: this.filterMemberIds(),
        listIds: this.filterListIds(),
        cfConditions: this.filterCfConditions(),
        showUnreadOnly: this.showUnreadOnly(),
        showOverdueOnly: this.showOverdueOnly(),
      };
      writeFilters(scope, filters);
    });
  }

  private async loadBoard(boardId: string, includeCompleted = false, includeArchived = this.showArchived(), recordVisit = true, completedFrom = this.completedFrom(), completedTo = this.completedTo()) {
    const params = new URLSearchParams();
    if (includeCompleted) params.set("includeCompleted", "true");
    if (includeArchived) params.set("archived", "true");
    appendCompletedRangeParams(params, completedFrom, completedTo);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const payload = await this.api.post<{
      board: Board;
      lists: List[];
      cards: CompactCardSummary[];
      separators: (BoardSeparator | WireSeparator)[];
      customFields: CustomField[];
      cardLabels: CardLabel[];
      checklistTemplates: WireChecklistTemplate[];
      members: WireBoardMemberUser[];
      viewerRole: BoardRole;
      viewerSource?: "board" | "workspace";
      viewerCanAccessWorkspace?: boolean;
      viewerAssignedItemsOnly?: boolean;
      customFieldValuesComplete?: boolean;
    }>(`/boards/${boardId}/open${suffix}`, {});
    if (recordVisit) this.recentBoards.record(boardId);
    // The server strips default/null fields to shrink the payload; re-expand to full summaries
    // here so every downstream consumer (and the `x in card` discriminators) sees complete objects.
    return { ...payload, cards: payload.cards.map(expandCardSummary) };
  }

  // Guards against overlapping fetches for the current board. Keep the board id with the guard
  // so quick navigation cannot let an old board's request suppress the new board's lazy load.
  private cfValuesInFlightForBoard: string | null = null;

  /**
   * The board-open payload only inlines values for `showOnCard` fields. Filters, List View
   * columns, and export need every field's values, so load them on demand the first time a
   * consumer needs them. No-op when the payload was already complete or offline.
   */
  private ensureCustomFieldValuesLoaded() {
    const boardId = this.boardId();
    if (this.state.customFieldValuesComplete()) return;
    if (!this.state.online()) return;
    if (this.cfValuesInFlightForBoard === boardId) return;
    this.cfValuesInFlightForBoard = boardId;
    void this.api
      .get<{ customFieldValues: CompactCardCustomFieldValue[] }>(`/boards/${boardId}/custom-field-values`)
      .then((res) => {
        // Ignore a late response after navigating to another board.
        if (this.boardId() !== boardId) return;
        this.state.setAllCustomFieldValues(res.customFieldValues.map(expandCardCustomFieldValue));
        // Register so the bulk custom-fields dialog does not refetch this board's values.
        this.state.markCfValuesLoadedForBoard(boardId);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.cfValuesInFlightForBoard === boardId) this.cfValuesInFlightForBoard = null;
      });
  }

  private formatRelativeTime(value: string): string {
    const diffMs = Date.now() - new Date(value).getTime();
    const mins = Math.max(0, Math.floor(diffMs / 60_000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  private skipNextDocumentClick = false;
  private addCardMouseDownStartedInside = false;

  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    const form = this.el.nativeElement.querySelector<HTMLElement>('.add-card-form, .lv-add-popover');
    this.addCardMouseDownStartedInside = !!(this.addingToListId() && form && target && form.contains(target));
  };

  @HostListener("document:click", ["$event"])
  onDocumentClick(e: MouseEvent) {
    const target = e.target;
    const addCardMouseDownStartedInside = this.addCardMouseDownStartedInside;
    this.addCardMouseDownStartedInside = false;
    if (this.skipNextDocumentClick) {
      this.skipNextDocumentClick = false;
      return;
    }
    if (this.addingToListId()) {
      const form = this.el.nativeElement.querySelector<HTMLElement>('.add-card-form, .lv-add-popover');
      // Releasing outside after pressing in the textarea is text selection, not an outside-click intent.
      if (!addCardMouseDownStartedInside && (!form || !(target instanceof Node) || !form.contains(target))) this.closeAddMode();
    }
    if (this.compactOpen()) {
      const filters = this.el.nativeElement.querySelector<HTMLElement>('.board-filters');
      if (filters && target instanceof Node && !filters.contains(target)) this.compactOpen.set(false);
    }
    if (this.exportMenuOpen()) {
      const wrapper = this.el.nativeElement.querySelector<HTMLElement>(".board-export-wrap");
      if (wrapper && target instanceof Node && !wrapper.contains(target)) this.exportMenuOpen.set(false);
    }
  }

  @HostListener("document:keydown", ["$event"])
  onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.bulkSelectedCount() > 0 && !this.openCardId() && !this.bulkMenuOpen()) {
      event.preventDefault();
      this.clearBulkSelection();
      return;
    }
    if (event.key.toLowerCase() !== "f" || (!event.ctrlKey && !event.metaKey)) return;
    if (this.openCardId()) return;
    event.preventDefault();
    // Focus the always-visible search input
    const input = this.el.nativeElement.querySelector<HTMLInputElement>('.bf-search-input');
    input?.focus();
  }

  onStartAdd(p: StartAddPayload) {
    this.addingToListId.set(p.listId);
    this.addingAtTop.set(p.atTop);
    this.skipNextDocumentClick = true;
  }

  closeAddMode() {
    this.addingToListId.set(null);
    this.addingAtTop.set(false);
  }

  toggleBackground(e: MouseEvent) {
    e.stopPropagation();
    if (this.state.board() === null) return;
    this.membersPopoverOpen.set(false);
    this.showBackground.update((v) => !v);
    this.exportMenuOpen.set(false);
  }

  toggleMembersPopover(e: MouseEvent) {
    e.stopPropagation();
    if (this.state.board() === null || this.sortedBoardMembers().length === 0) return;
    this.showBackground.set(false);
    this.compactOpen.set(false);
    this.exportMenuOpen.set(false);
    this.membersPopoverOpen.update((value) => !value);
  }

  removeBoardMemberFromView(userId: string) {
    // The mutation originates inside the popover, so update its parent header immediately instead
    // of relying on the durable realtime event making a round trip back to this same browser.
    this.state.removeBoardMember(userId);
  }

  upsertBoardMemberInView(member: WireBoardMemberUser) {
    // Membership drives both card and checklist assignment eligibility, so make the new grant
    // available to every picker immediately on the initiating page and on realtime peers.
    this.state.upsertBoardMember(member);
  }

  toggleExportMenu(e: MouseEvent) {
    e.stopPropagation();
    if (!this.state.canEditRole() || this.state.board() === null || this.exportLoading()) return;
    this.showBackground.set(false);
    this.compactOpen.set(false);
    this.membersPopoverOpen.set(false);
    this.exportMenuOpen.update((value) => !value);
  }

  async exportBoardJson() {
    if (!this.state.canEditRole() || this.exportLoading()) return;
    this.exportLoading.set("json");
    try {
      const archive = await this.loadBoardExportArchive();
      downloadTextFile(JSON.stringify(archive, null, 2), "application/json", boardArchiveFileName(archive, "json"));
      this.exportMenuOpen.set(false);
    } finally {
      this.exportLoading.set(null);
    }
  }

  async exportBoardExcel() {
    if (!this.state.canEditRole() || this.exportLoading()) return;
    this.exportLoading.set("xlsx");
    try {
      const archive = await this.loadBoardExportArchive();
      const rows = boardArchiveToReportRows(archive);
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      await writeXlsxFile(styledBoardReportRows(rows), {
        sheet: "Cards",
        columns: boardReportColumnWidths(rows),
        stickyRowsCount: 4,
      }).toFile(boardArchiveFileName(archive, "xlsx"));
      this.exportMenuOpen.set(false);
    } finally {
      this.exportLoading.set(null);
    }
  }

  private loadBoardExportArchive() {
    return this.api.get<BoardExportArchive>(`/boards/${this.boardId()}/export`);
  }

  async toggleBoardWatch() {
    if (this.state.board() === null) return;
    await this.notifications.toggleBoardWatch(this.boardId());
  }

  toggleBoardWatcherPopover(event: MouseEvent) {
    event.stopPropagation();
    this.watcherPopoverOpen.update((open) => !open);
  }

  openCompletedHistory() {
    if (this.state.board() === null) return;
    this.completedPanelOpen.set(true);
    this.compactOpen.set(false);
    this.membersPopoverOpen.set(false);
    this.exportMenuOpen.set(false);
  }

  onCompletedCardOpened(card: WireCardSummary) {
    this.completedPanelOpen.set(false);
    this.completedHistoryCard.set(card);
    this.state.setCardLabels(card.id, card.labelIds);
    this.state.setCardAssignees(card.id, card.assigneeIds);
    this.state.customFieldValues.update((values) => [...values.filter((value) => value.cardId !== card.id), ...card.customFieldValues]);
    this.state.commentCounts.update((counts) => new Map(counts).set(card.id, card.commentCount));
    this.openCardDetail(card.id);
  }

  async toggleArchivedCards() {
    if (this.state.board() === null) return;
    const next = !this.showArchived();
    const seq = ++this.filterLoadSeq;
    this.showArchived.set(next);
    if (next) this.showOverdueOnly.set(false);
    const data = await this.loadBoard(this.boardId(), false, next);
    if (seq !== this.filterLoadSeq || this.showArchived() !== next) return;
    this.state.hydrate(data);
    const snapshot = this.state.snapshot();
    if (snapshot) void this.offlineCache.saveBoard(this.boardId(), snapshot).catch(() => undefined);
  }

  async applyCompletedRange(range: { from: string; to: string }) {
    const seq = ++this.filterLoadSeq;
    this.completedFrom.set(range.from);
    this.completedTo.set(range.to);
    writeCompletedFilter(`board:${this.boardId()}`, range);
    const data = await this.loadBoard(this.boardId(), false, this.showArchived());
    if (seq !== this.filterLoadSeq) return;
    this.state.hydrate(data);
    this.persistOfflineSnapshot();
  }

  async clearCompletedRange() {
    const seq = ++this.filterLoadSeq;
    this.completedFrom.set("");
    this.completedTo.set("");
    writeCompletedFilter(`board:${this.boardId()}`, null);
    const data = await this.loadBoard(this.boardId(), false, this.showArchived());
    if (seq !== this.filterLoadSeq) return;
    this.state.hydrate(data);
    this.persistOfflineSnapshot();
  }

  // The completed range is sticky per board, so the next load re-applies it; keep the offline copy
  // in sync with what is shown, matching the archived-toggle behaviour.
  private persistOfflineSnapshot() {
    const snapshot = this.state.snapshot();
    if (snapshot) void this.offlineCache.saveBoard(this.boardId(), snapshot).catch(() => undefined);
  }

  toggleCompact(e: MouseEvent) {
    e.stopPropagation();
    if (this.state.board() === null) return;
    this.membersPopoverOpen.set(false);
    this.exportMenuOpen.set(false);
    this.compactOpen.update(v => !v);
  }

  /** Fan the shared filter bar's single value object back out to the individual sticky signals. */
  onFilterValueChange(v: FilterValue) {
    if (this.state.board() === null) return;
    this.filterLabelIds.set(v.labelIds);
    this.filterMemberIds.set(v.memberIds);
    this.filterListIds.set(v.listIds);
    this.filterCfConditions.set(v.cfConditions);
    this.showUnreadOnly.set(v.showUnreadOnly);
    this.showOverdueOnly.set(v.showOverdueOnly);
  }

  /** The filter bar emits the desired archived state; `toggleArchivedCards` flips + reloads. */
  onArchivedChange(next: boolean) {
    if (next !== this.showArchived()) void this.toggleArchivedCards();
  }

  async clearFilters() {
    if (this.state.board() === null) return;
    const needsActiveCardsReload = this.showArchived() || this.showCompleted();
    const seq = ++this.filterLoadSeq;
    this.setSearchQuery('');
    this.filterLabelIds.set([]);
    this.filterMemberIds.set([]);
    this.filterListIds.set([]);
    this.filterCfConditions.set([]);
    this.showUnreadOnly.set(false);
    this.showOverdueOnly.set(false);
    this.showArchived.set(false);
    this.completedFrom.set("");
    this.completedTo.set("");
    writeCompletedFilter(`board:${this.boardId()}`, null);
    this.compactOpen.set(false);
    this.membersPopoverOpen.set(false);
    if (!needsActiveCardsReload) return;
    const data = await this.loadBoard(this.boardId(), false, false);
    if (seq !== this.filterLoadSeq || this.showArchived()) return;
    this.state.hydrate(data);
    const snapshot = this.state.snapshot();
    if (snapshot) void this.offlineCache.saveBoard(this.boardId(), snapshot).catch(() => undefined);
  }

  setSearchQuery(value: string) {
    this.searchInputValue.set(value);
    if (value === "") {
      this.clearSearchDebounce();
      this.searchQuery.set("");
    }
  }

  private clearSearchDebounce() {
    if (this.searchDebounceTimer === null) return;
    clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = null;
  }

  onListsBackgroundClick(e: MouseEvent) {
    // A selection drag can synthesize a click on the board background when the pointer is
    // released outside the textarea. Only treat it as a background click when it also began there.
    if (e.target === e.currentTarget && !this.addCardMouseDownStartedInside) {
      this.closeAddMode();
      this.clearBulkSelection();
    }
  }

  onBulkSelectionRequested(payload: BulkCardSelectionPayload) {
    if (!this.state.canEdit() || this.showArchived()) return;
    this.closeBulkMenu();
    const current = this.bulkSelectedCardIds();
    let next: Set<string>;
    if (payload.shiftKey && this.lastBulkSelectedCardId()) {
      const from = payload.orderedCardIds.indexOf(this.lastBulkSelectedCardId()!);
      const to = payload.orderedCardIds.indexOf(payload.cardId);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        next = payload.additive ? new Set(current) : new Set();
        for (const id of payload.orderedCardIds.slice(start, end + 1)) next.add(id);
      } else {
        next = this.toggleBulkCard(current, payload.cardId);
      }
    } else {
      next = this.toggleBulkCard(current, payload.cardId);
    }
    this.bulkSelectedCardIds.set(next);
    // Keep the original anchor during range selection so repeated Shift-clicks
    // can expand/contract a range instead of collapsing to the last two rows.
    if (!payload.shiftKey || !this.lastBulkSelectedCardId()) {
      this.lastBulkSelectedCardId.set(payload.cardId);
    }
  }

  onBulkListSelectionRequested(payload: BulkListSelectionPayload) {
    if (!this.state.canEdit() || this.showArchived()) return;
    this.closeBulkMenu();
    const next = payload.additive ? new Set(this.bulkSelectedCardIds()) : new Set<string>();
    for (const cardId of payload.orderedCardIds) next.add(cardId);
    this.bulkSelectedCardIds.set(next);
    this.lastBulkSelectedCardId.set(payload.orderedCardIds.at(-1) ?? null);
  }

  onBulkMenuRequested(payload: BulkCardMenuPayload) {
    if (!this.bulkSelectedCardIds().has(payload.cardId)) return;
    this.bulkMenuPoint.set(payload.point);
  }

  openBulkMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (this.bulkSelectedCount() === 0) return;
    this.bulkMenuPoint.set({ x: event.clientX, y: event.clientY });
  }

  closeBulkMenu() {
    this.bulkMenuPoint.set(null);
  }

  // The bulk menu hands custom-field editing off to a dedicated dialog while keeping selection.
  openBulkCustomFields() {
    if (this.bulkSelectedCount() === 0) return;
    this.closeBulkMenu();
    this.bulkCustomFieldsOpen.set(true);
  }

  clearBulkSelection() {
    this.bulkSelectedCardIds.set(new Set());
    this.lastBulkSelectedCardId.set(null);
    this.bulkCustomFieldsOpen.set(false);
    this.closeBulkMenu();
  }

  private toggleBulkCard(current: Set<string>, cardId: string): Set<string> {
    const next = new Set(current);
    if (next.has(cardId)) next.delete(cardId);
    else next.add(cardId);
    return next;
  }

  openCardDetail(cardId: string) {
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    void this.router.navigate(["/b", this.boardId()], {
      queryParams: { cardId, lightboxAttachmentId: null },
      queryParamsHandling: "merge",
    });
  }

  setView(mode: ViewMode) {
    if (this.state.board() === null) return;
    if (this.effectiveView() === mode) return;
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    this.membersPopoverOpen.set(false);
    writeViewMode(`board:${this.boardId()}`, mode);
    this.rememberedView.set(mode);
    void this.router.navigate(["/b", this.boardId()], {
      queryParams: { view: mode === "board" ? null : mode },
      queryParamsHandling: "merge",
    });
  }

  closeCardDetail() {
    // Drop the held summary so the sticky-modal fallback can't re-resolve a just-closed card.
    this.openCardHeld.set(null);
    void this.router.navigate(["/b", this.boardId()], {
      queryParams: { cardId: null, lightboxAttachmentId: null },
      queryParamsHandling: "merge",
    });
  }

  async onCardDrop(p: CardDropPayload) {
    if (!this.state.canEdit()) return;
    const previousCards = this.state.snapshotCards();
    const card = this.state.cardById(p.cardId);
    if (!card) return;
    const beforeAnchor = p.beforeItem ?? (p.beforeCardId !== undefined && p.beforeCardId !== null ? { type: "card" as const, id: p.beforeCardId } : p.beforeCardId);
    const afterAnchor = p.afterItem ?? (p.afterCardId !== undefined && p.afterCardId !== null ? { type: "card" as const, id: p.afterCardId } : p.afterCardId);
    const beforeItem = beforeAnchor ? this.itemForAnchor(beforeAnchor) : beforeAnchor;
    const afterItem = afterAnchor ? this.itemForAnchor(afterAnchor) : afterAnchor;
    const optimisticPosition = this.state.positionForItemDrop({ kind: "card", card }, p.toListId, beforeItem, afterItem);

    this.state.moveCard(p.cardId, p.toListId, optimisticPosition);

    try {
      const moved = await this.api.post<{ id: string; listId: string; position: string }>(`/cards/${p.cardId}/move`, {
        listId: p.toListId,
        ...(p.beforeItem !== undefined ? { beforeItem: p.beforeItem } : p.beforeCardId !== undefined ? { beforeCardId: p.beforeCardId } : {}),
        ...(p.afterItem !== undefined ? { afterItem: p.afterItem } : p.afterCardId !== undefined ? { afterCardId: p.afterCardId } : {}),
      });
      this.state.moveCard(moved.id, moved.listId, moved.position);
    } catch (error) {
      this.state.restoreCards(previousCards);
      throw error;
    }
  }

  async onSeparatorDrop(p: SeparatorDropPayload) {
    if (!this.state.canEdit()) return;
    const previousSeparators = this.state.separators();
    const separator = this.state.separatorsById().get(p.separatorId);
    if (!separator) return;
    const beforeItem = p.beforeItem ? this.itemForAnchor(p.beforeItem) : p.beforeItem;
    const afterItem = p.afterItem ? this.itemForAnchor(p.afterItem) : p.afterItem;
    const optimisticPosition = this.state.positionForItemDrop({ kind: "separator", separator }, p.toListId, beforeItem, afterItem);
    this.state.moveSeparator(p.separatorId, p.toListId, optimisticPosition);
    try {
      const moved = await this.api.post<{ id: string; listId: string; position: string }>(`/separators/${p.separatorId}/move`, {
        listId: p.toListId,
        ...(p.beforeItem !== undefined ? { beforeItem: p.beforeItem } : {}),
        ...(p.afterItem !== undefined ? { afterItem: p.afterItem } : {}),
      });
      this.state.moveSeparator(moved.id, moved.listId, moved.position);
    } catch (error) {
      this.state.separators.set(previousSeparators);
      throw error;
    }
  }

  private itemForAnchor(anchor: LaneAnchor): BoardLaneItem | null {
    if (anchor.type === "card") {
      const card = this.state.cardById(anchor.id);
      return card ? { kind: "card", card } : null;
    }
    const separator = this.state.separatorsById().get(anchor.id);
    return separator ? { kind: "separator", separator } : null;
  }

}
