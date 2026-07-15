import { CdkDropListGroup } from "@angular/cdk/drag-drop";
import type { AfterViewInit, OnDestroy} from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, input, signal, untracked, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import type { GradientToken } from "@kanera/shared/colors";
import { GRADIENT_TOKENS } from "@kanera/shared/colors";
import type { CompactCardCustomFieldValue, ServerToClientEvents, WireAssignedWorkPayload, WireBoardMemberUser, WireCard, WireCardDetail, WireCardSummary, WireChecklistAssignment, WireWorkspaceMember } from "@kanera/shared/events";
import { expandCardCustomFieldValue } from "@kanera/shared/events";
import type { Card } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { APP_DOM_EVENTS, STORAGE_KEYS, assignedWorkTeamUserKey, viewPreferenceKey, type StorageKey } from "../../core/browser/browser-contracts";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardState, type BoardLaneItem, type LaneAnchor } from "../board/board-state";
import { cardIdsByBoard } from "../board/bulk-card-batches.util";
import { BulkCardActionsMenuPopover } from "../board/bulk-card-actions-menu.popover";
import { BulkCustomFieldsDialogComponent } from "../board/bulk-custom-fields.dialog";
import { BoardCalendarViewComponent } from "../board/calendar-view/board-calendar-view.component";
import { WorkDoneViewComponent } from "../board/work-done-view/work-done-view.component";
import { cardDragEdgeScrollStep } from "../board/card-drag-scroll";
import { CardDetailComponent } from "../board/card-detail.component";
import { formatDueDate, isOverdue } from "../board/due-date.util";
import { BoardListViewComponent } from "../board/list-view/board-list-view.component";
import { matchesCfConditions } from "../board/list-view/filter.util";
import type { CfFilterCondition, FilterValue } from "../board/list-view/filter.types";
import { FilterBarComponent } from "../board/list-view/filter-bar.component";
import { readCompletedFilter, readFilters, readViewBackground, readViewMode, writeCompletedFilter, writeFilters, writeViewBackground, writeViewMode, type StoredFilters, type ViewMode } from "../board/list-view/view-preference";
import type { BulkCardMenuPayload, BulkCardSelectionPayload, BulkListSelectionPayload, CardDropPayload, SeparatorDropPayload, StartAddPayload} from "../board/list.component";
import { ListComponent } from "../board/list.component";
import { CompletedCardsPanelComponent } from "../completed-cards/completed-cards-panel.component";
import { appendCompletedRangeParams, formatCompletedRangeDate } from "../completed-cards/completed-range.util";
import { AssignedWorkSocketBridge } from "./assigned-work-socket-bridge";
import { AssignedWorkState } from "./assigned-work-state";

type AnyCard = Card | WireCard | WireCardSummary;
type AssignedWorkMode = "me" | "team";

const ALL_TEAM_ASSIGNED_WORK_USER_ID = "all";
const MAX_VISIBLE_TABS = 7;
const TAB_WIDTH_ESTIMATE = 128;
const OVERFLOW_BUTTON_WIDTH = 58;
const SEARCH_DEBOUNCE_MS = 200;
const MOBILE_KANBAN_QUERY = "(max-width: 768px)";

@Component({
  selector: "k-assigned-work",
  standalone: true,
  imports: [CdkDropListGroup, ListComponent, CardDetailComponent, AvatarComponent, BoardListViewComponent, BoardCalendarViewComponent, WorkDoneViewComponent, CompletedCardsPanelComponent, FilterBarComponent, TooltipDirective, BulkCardActionsMenuPopover, BulkCustomFieldsDialogComponent],
  providers: [
    AssignedWorkState,
    AssignedWorkSocketBridge,
    // Card/List components inject BoardState — alias to our extended state so they
    // can be reused unchanged.
    { provide: BoardState, useExisting: AssignedWorkState },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./assigned-work.page.html",
  styleUrl: "./assigned-work.page.scss",
})
export class AssignedWorkPage implements AfterViewInit, OnDestroy {
  protected readonly state = inject(AssignedWorkState);
  private readonly bridge = inject(AssignedWorkSocketBridge);
  private readonly api = inject(ApiClient);
  private readonly appTitle = inject(AppTitleService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly notifications = inject(NotificationsService);
  private readonly workspaceService = inject(WorkspaceService);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>("searchInput");
  readonly listsEl = viewChild<ElementRef<HTMLElement>>("listsEl");

  readonly workspaceId = input.required<string>();
  readonly mode = input<AssignedWorkMode>("me");
  readonly userId = input<string | undefined>();
  readonly cardId = input<string | undefined>();
  readonly lightboxAttachmentId = input<string | undefined>();
  readonly view = input<ViewMode | undefined>();
  readonly currentUserId = computed(() => this.auth.user()?.id ?? null);
  readonly viewScope = computed(() => {
    const ws = this.workspaceId();
    const selected = this.selectedUserId();
    const user = this.isTeamView()
      ? selected === ALL_TEAM_ASSIGNED_WORK_USER_ID || !selected ? "team" : selected
      : "me";
    return `assignedWork:${ws}:${user}`;
  });
  readonly backgroundScope = computed(() => `assignedWork:${this.workspaceId()}:${this.isTeamView() ? "team" : "me"}`);
  // Scope for the sticky filter set. Derived from the stable route inputs (not selectedUserId,
  // which resolves asynchronously after load) so restore and persist always agree on the key.
  readonly filterPersistScope = computed(() => {
    const workspaceId = this.workspaceId();
    const requestedUserId = this.userId()
      ?? (this.mode() === "team" ? localStorage.getItem(assignedWorkTeamUserKey(workspaceId)) ?? undefined : undefined);
    const scopeUser = this.mode() === "team"
      ? (requestedUserId && requestedUserId !== ALL_TEAM_ASSIGNED_WORK_USER_ID ? requestedUserId : "team")
      : "me";
    return `assignedWork:${workspaceId}:${scopeUser}`;
  });
  readonly checklistSectionStorageKey = computed<StorageKey>(() =>
    `${STORAGE_KEYS.ASSIGNED_WORK_CHECKLIST_COLLAPSED_PREFIX}:${this.workspaceId()}:${this.isTeamView() ? "team" : "me"}`,
  );
  private readonly viewPreferenceVersion = signal(0);
  private readonly backgroundPreferenceVersion = signal(0);
  readonly effectiveView = computed<ViewMode>(() => {
    const fromUrl = this.view();
    if (fromUrl === "list" || fromUrl === "board" || fromUrl === "calendar" || fromUrl === "history") return fromUrl;
    this.workspaceId();
    this.mode();
    this.selectedUserId();
    this.viewPreferenceVersion();
    return this.readRememberedView();
  });

  readonly members = signal<WireBoardMemberUser[]>([]);
  readonly selectedUserId = signal<string | null>(null);
  readonly visibleTabLimit = signal(MAX_VISIBLE_TABS);
  readonly openCardId = signal<string | null>(null);
  readonly overflowOpen = signal(false);
  readonly overflowAlignRight = signal(false);
  readonly offlineAssignedCachedAt = signal<string | null>(null);
  readonly skeletonCards = [1, 2, 3];
  readonly skeletonTeamTabs = [1, 2, 3];
  readonly skeletonMeTabs = [1];

  readonly searchInputValue = signal('');
  readonly searchQuery = signal('');
  readonly boardFilterIds = signal<string[]>([]);
  readonly filterLabelIds = signal<string[]>([]);
  // Restrict to cards in the selected lists (empty = all lists).
  readonly filterListIds = signal<string[]>([]);
  // Operator-based custom-field conditions, shared with the board via matchesCfConditions.
  readonly filterCfConditions = signal<CfFilterCondition[]>([]);
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
  readonly completedHistoryCard = signal<WireCardSummary | null>(null);
  readonly workDoneRefreshVersion = signal(0);
  readonly completedPanelUserId = computed(() => this.isAllTeamSelected() ? null : this.selectedUserId());
  readonly compactOpen = signal(false);
  readonly showBackground = signal(false);
  readonly bulkSelectedCardIds = signal<Set<string>>(new Set());
  readonly lastBulkSelectedCardId = signal<string | null>(null);
  readonly bulkMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly bulkCustomFieldsOpen = signal(false);
  readonly addingToListId = signal<string | null>(null);
  readonly addingAtTop = signal(false);
  readonly gradientTokens = GRADIENT_TOKENS;
  readonly assignedBackground = computed(() => {
    this.backgroundPreferenceVersion();
    return readViewBackground(this.backgroundScope());
  });
  // Assemble the individual filter signals into the single shape the shared filter bar consumes.
  readonly filterValue = computed<FilterValue>(() => ({
    labelIds: this.filterLabelIds(),
    memberIds: [],
    listIds: this.filterListIds(),
    boardIds: this.boardFilterIds(),
    cfConditions: this.filterCfConditions(),
    showUnreadOnly: this.showUnreadOnly(),
    showOverdueOnly: this.showOverdueOnly(),
  }));
  readonly hasActiveFilter = computed(() =>
    !!this.searchQuery().trim() ||
    this.boardFilterIds().length > 0 ||
    this.filterLabelIds().length > 0 ||
    this.filterListIds().length > 0 ||
    this.filterCfConditions().length > 0 ||
    (this.effectiveView() !== "history" && this.showUnreadOnly()) ||
    this.showOverdueOnly() ||
    this.showArchived() ||
    this.showCompleted()
  );
  readonly toolbarFilterActive = computed(() => {
    if (this.effectiveView() === "history") {
      return !!this.searchQuery().trim() || this.boardFilterIds().length > 0 || this.filterLabelIds().length > 0 || this.filterListIds().length > 0 || this.filterCfConditions().length > 0;
    }
    return this.hasActiveFilter();
  });
  // Every non-archived custom field is filterable via the condition builder (all seven types).
  readonly filterableCustomFields = computed(() =>
    this.state.customFields().filter((field) => !field.archivedAt),
  );

  readonly skeletonLists = computed(() => Array.from({ length: 3 }, (_, i) => i));
  readonly isTeamView = computed(() => this.mode() === "team");
  readonly isAllTeamSelected = computed(() => this.isTeamView() && this.selectedUserId() === ALL_TEAM_ASSIGNED_WORK_USER_ID);
  readonly canCreateAssignedCards = computed(() => {
    const target = this.state.targetUser();
    return this.state.canEdit() && !this.showArchived() && target !== null && target.userId !== ALL_TEAM_ASSIGNED_WORK_USER_ID;
  });
  readonly assignedSeparatorCreateBaseUrl = computed(() => {
    const target = this.state.targetUser();
    if (!this.canCreateAssignedCards() || !target || target.userId === ALL_TEAM_ASSIGNED_WORK_USER_ID) return null;
    return `/workspaces/${this.workspaceId()}/assignees/${target.userId}`;
  });
  readonly addCardAssigneeIds = computed(() => {
    const userId = this.state.targetUser()?.userId ?? null;
    return userId && userId !== ALL_TEAM_ASSIGNED_WORK_USER_ID ? [userId] : [];
  });
  readonly defaultAddCardBoardId = computed(() => {
    const boards = this.state.boards();
    const filtered = this.boardFilterIds().find((id) => boards.some((board) => board.id === id));
    if (filtered) return filtered;
    return boards.length === 1 ? boards[0]!.id : boards[0]?.id ?? null;
  });

  /** Union of card IDs surviving the assigned-work filters — fed to list view. */
  readonly filteredCardIds = computed<Set<string>>(() => {
    const set = new Set<string>();
    for (const cards of this.filteredCardsByList().values()) {
      for (const card of cards) set.add(card.id);
    }
    return set;
  });

  readonly visibleMembers = computed(() => {
    const all = this.members();
    const limit = Math.max(1, Math.min(this.visibleTabLimit(), MAX_VISIBLE_TABS));
    if (all.length <= limit) return all;
    const active = this.selectedUserId();
    const activeIdx = all.findIndex((m) => m.userId === active);
    if (activeIdx >= limit) {
      return [all[activeIdx]!, ...all.slice(0, limit - 1)];
    }
    return all.slice(0, limit);
  });

  readonly overflowMembers = computed(() => {
    const all = this.members();
    const visibleIds = new Set(this.visibleMembers().map((m) => m.userId));
    return all.filter((m) => !visibleIds.has(m.userId));
  });
  readonly overflowHasSelectedUser = computed(() => this.overflowMembers().some((m) => m.userId === this.selectedUserId()));

  // Tab badges combine overdue cards and overdue checklist items into one figure so a member
  // with only overdue sub-tasks still flags attention.
  memberOverdueTotal(userId: string): number {
    return (this.state.memberOverdueCounts().get(userId) ?? 0) + (this.state.memberOverdueChecklistCounts().get(userId) ?? 0);
  }

  readonly checklistSectionTitle = computed(() =>
    this.isTeamView() ? (this.isAllTeamSelected() ? "Team checklist items" : "Checklist items") : "My checklist items",
  );
  // Collapsible so a long list (e.g. dozens of items) doesn't crowd out the board below; the
  // expanded list is height-capped and scrolls internally.
  readonly checklistSectionCollapsed = signal(true);
  readonly overdueChecklistItemCount = computed(() =>
    this.filteredChecklistItems().filter((item) => this.checklistItemOverdue(item)).length,
  );

  // Lists are workspace-scoped, so a single lookup resolves the list (icon/color/name) for any
  // checklist item across the accessible boards.
  private readonly listsById = computed(() => new Map(this.state.lists().map((list) => [list.id, list])));

  checklistItemList(item: WireChecklistAssignment) {
    return this.listsById().get(item.listId) ?? null;
  }

  checklistItemBoard(item: WireChecklistAssignment) {
    return this.state.boardsById().get(item.boardId) ?? null;
  }

  toggleChecklistSection() {
    this.checklistSectionCollapsed.update((collapsed) => {
      const next = !collapsed;
      this.writeChecklistSectionCollapsed(next);
      return next;
    });
  }

  readonly openCard = computed<AnyCard | null>(() => {
    const id = this.openCardId();
    return id ? (this.state.cards().find((c) => c.id === id) ?? this.state.detailForCard(id)?.card ?? (this.completedHistoryCard()?.id === id ? this.completedHistoryCard() : null)) : null;
  });

  readonly sortedLabels = computed(() =>
    [...this.state.cardLabels()].sort((a, b) => Number(a.position) - Number(b.position))
  );
  readonly overdueCardCount = computed(() =>
    this.state.cards().filter((card) => !card.archivedAt && !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone)).length
  );

  // The "My checklist items" section only appears in the kanban/list views; calendar and
  // history are card-oriented and a dedicated checklist surface there is deferred.
  readonly showChecklistSection = computed(() => {
    const view = this.effectiveView();
    return (view === "board" || view === "list") && this.filteredChecklistItems().length > 0;
  });

  // Assigned checklist items surviving the board + search + overdue-only filters. Mirrors the
  // card filter inputs so toggling a board or typing narrows both surfaces together. Overdue
  // items are sorted first, then by due date, with undated items last.
  readonly filteredChecklistItems = computed<WireChecklistAssignment[]>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const boardIds = new Set(this.boardFilterIds());
    const overdueOnly = this.showOverdueOnly();
    const unreadOnly = this.effectiveView() !== "history" && this.showUnreadOnly();
    const items = this.state.checklistItems().filter((item) => {
      if (boardIds.size && !boardIds.has(item.boardId)) return false;
      if (q && !item.text.toLowerCase().includes(q) && !item.cardTitle.toLowerCase().includes(q)) return false;
      if (overdueOnly && !this.checklistItemOverdue(item)) return false;
      // The unread filter is card-scoped, so checklist rows follow their parent card.
      if (unreadOnly && this.notifications.cardUnreadCount(item.cardId) === 0) return false;
      return true;
    });
    return items.sort((a, b) => {
      const aDate = a.dueDateLocalDate ?? "";
      const bDate = b.dueDateLocalDate ?? "";
      if (aDate && bDate) return aDate.localeCompare(bDate) || a.text.localeCompare(b.text);
      if (aDate) return -1;
      if (bDate) return 1;
      return a.text.localeCompare(b.text);
    });
  });
  // Render view-model for the (unvirtualized) checklist items list: resolve board/list/overdue/
  // due text once per filter change instead of calling those helpers for every row on every
  // change detection pass. Tracks state.lists()/boardsById() and the filtered item set.
  readonly checklistItemViews = computed(() =>
    this.filteredChecklistItems().map((item) => ({
      item,
      board: this.checklistItemBoard(item),
      list: this.checklistItemList(item),
      overdue: this.checklistItemOverdue(item),
      dueText: this.checklistItemDueDateText(item),
    })),
  );
  readonly filteredCardsByList = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const boardIds = this.boardFilterIds();
    const labelIds = this.filterLabelIds();
    const listIds = this.filterListIds();
    const conditions = this.filterCfConditions();
    const overdueOnly = this.showOverdueOnly();
    const unreadOnly = this.effectiveView() !== "history" && this.showUnreadOnly();
    const showArchived = this.showArchived();
    const labelFilterIds = new Set(labelIds);
    const listFilterIds = new Set(listIds);
    const labelIdsByCard = labelIds.length ? new Map<string, Set<string>>() : null;
    const fieldsById = conditions.length ? this.state.customFieldsById() : null;
    const cfValuesByCard = conditions.length ? this.state.customFieldValuesByCardAndField() : null;
    const boardFilterIds = new Set(boardIds);
    const hasFilters = !!q || boardIds.length > 0 || labelIds.length > 0 || listIds.length > 0 || conditions.length > 0 || unreadOnly || (!showArchived && overdueOnly);
    const visibleListIds = new Set(this.state.visibleLists().map((list) => list.id));
    const result = new Map<string, AnyCard[]>();
    for (const listId of visibleListIds) result.set(listId, []);

    // Build label lookup only when needed; most interactions should avoid
    // touching assignment rows while typing in the search box or changing views.
    if (labelIdsByCard) {
      for (const assignment of this.state.cardLabelAssignments()) {
        let labels = labelIdsByCard.get(assignment.cardId);
        if (!labels) {
          labels = new Set<string>();
          labelIdsByCard.set(assignment.cardId, labels);
        }
        labels.add(assignment.labelId);
      }
    }

    // Apply visibility and active filters in one pass, then sort each list.
    // Assigned work can span many boards, so avoiding per-list full-card scans
    // matters when team views get busy.
    for (const card of this.state.cards()) {
      if (!visibleListIds.has(card.listId)) continue;
      if (showArchived ? !card.archivedAt : card.archivedAt) continue;
      if (hasFilters) {
        if (q && !card.title.toLowerCase().includes(q)) continue;
        if (listFilterIds.size && !listFilterIds.has(card.listId)) continue;
        if (unreadOnly && this.notifications.cardUnreadCount(card.id) === 0) continue;
        if (boardFilterIds.size && !boardFilterIds.has(card.boardId)) continue;
        if (labelIdsByCard && !this.hasAny(labelIdsByCard.get(card.id), labelFilterIds)) continue;
        if (!showArchived && overdueOnly && (card.completedAt || !isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone))) continue;
        if (fieldsById && cfValuesByCard && !matchesCfConditions(card.id, conditions, fieldsById, cfValuesByCard)) continue;
      }
      result.get(card.listId)?.push(card);
    }

    for (const cards of result.values()) {
      cards.sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
    }

    return result;
  });

  readonly filteredItemsByList = computed(() => {
    // Assigned Work only ever shows cards assigned to the target user, so it is always a filtered
    // lane: keep separators only where they border one of those visible cards.
    const result = new Map<string, BoardLaneItem[]>();
    for (const [listId, cards] of this.filteredCardsByList()) {
      result.set(listId, this.state.itemsForList(listId, cards, true));
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
  readonly bulkSelectionBoardId = computed(() => this.bulkSelectedCards()[0]?.boardId ?? null);

  private detach: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollDrag: { startX: number; startScrollLeft: number } | null = null;
  private cleanupScrollDrag?: () => void;
  private cardDragPointer: { x: number; y: number } | null = null;
  private cardDropTargetListId: string | null = null;
  private cardDragSession = 0;
  private cardDragActive = false;
  private edgeScrollFrame: number | null = null;
  private skipNextDocumentClick = false;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === viewPreferenceKey("background", this.backgroundScope())) {
      this.backgroundPreferenceVersion.update((version) => version + 1);
    }
    if (event.key === this.checklistSectionStorageKey()) {
      this.checklistSectionCollapsed.set(event.newValue !== "0");
    }
  };

  constructor() {
    window.addEventListener("storage", this.onStorage);
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);

    effect((onCleanup) => {
      // Re-attach the scroll-drag handlers each time the kanban scroller mounts.
      const el = this.listsEl()?.nativeElement;
      if (!el) return;
      this.cleanupScrollDrag?.();
      this.setupListScrollDrag();
      onCleanup(() => this.cleanupScrollDrag?.());
    });

    effect(() => {
      const user = this.state.targetUser();
      const label = this.isTeamView() ? "Team Cards" : user ? "My Cards" : "Cards";
      this.appTitle.set(label);
    });

    effect(() => {
      this.checklistSectionCollapsed.set(this.readChecklistSectionCollapsed());
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
      const cardId = this.cardId() ?? null;
      this.openCardId.set(cardId);
      const needsDetail = cardId
        ? untracked(() => !this.state.cards().some((card) => card.id === cardId) && !this.state.detailForCard(cardId))
        : false;
      if (cardId && needsDetail) {
        void this.loadCardDetail(cardId);
      }
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
      const workspaceId = this.workspaceId();
      const mode = this.mode();
      const routeUserId = this.userId();
      // The sidebar returns to the canonical Team Cards URL, so remember its last tab outside the
      // route. An explicit query parameter still wins for shared links and browser history entries.
      const requestedUserId = mode === "team"
        ? routeUserId ?? localStorage.getItem(assignedWorkTeamUserKey(workspaceId)) ?? undefined
        : routeUserId;
      // Mirror viewScope() exactly (selectedUserId is not resolved yet at this point): the all-team
      // view — no user, or the "all" sentinel — persists under ":team" so the sticky range round-trips.
      const scopeUser = mode === "team"
        ? (requestedUserId && requestedUserId !== ALL_TEAM_ASSIGNED_WORK_USER_ID ? requestedUserId : "team")
        : "me";
      const preferenceScope = `assignedWork:${workspaceId}:${scopeUser}`;
      const completed = readCompletedFilter(preferenceScope);
      // Restore the sticky filter set for this scope (persisted by the effect below).
      const saved = readFilters(preferenceScope);
      this.boardFilterIds.set(saved?.boardIds ?? []);
      this.filterLabelIds.set(saved?.labelIds ?? []);
      this.filterListIds.set(saved?.listIds ?? []);
      this.filterCfConditions.set(saved?.cfConditions ?? []);
      this.showUnreadOnly.set(saved?.showUnreadOnly ?? false);
      this.showOverdueOnly.set(saved?.showOverdueOnly ?? false);
      this.completedFrom.set(completed?.from ?? "");
      this.completedTo.set(completed?.to ?? "");
      const initialCompletedFrom = completed?.from ?? "";
      const initialCompletedTo = completed?.to ?? "";
      const initialIncludeArchived = untracked(() => this.showArchived());
      let cancelled = false;
      let hydrated = false;
      let joinedOnce = false;
      let refreshInFlight = false;
      let refreshQueued = false;
      const keepCurrentView = untracked(() =>
        mode === "team" &&
        this.state.targetUser() !== null &&
        this.state.board()?.workspaceId === workspaceId
      );
      if (!keepCurrentView) {
        this.state.clear();
        this.members.set([]);
        this.selectedUserId.set(null);
        this.offlineAssignedCachedAt.set(null);
        // The value cache is keyed by card id; a cleared state drops those cards, so reset the
        // fetched-card tracker to force a reload for the new scope's card set.
        this.loadedCfValueCardIds.clear();
      } else if (mode === "team" && !requestedUserId) {
        this.selectedUserId.set(ALL_TEAM_ASSIGNED_WORK_USER_ID);
        this.offlineAssignedCachedAt.set(null);
      } else if (requestedUserId && untracked(() => this.members().some((m) => m.userId === requestedUserId))) {
        this.selectedUserId.set(requestedUserId);
        this.offlineAssignedCachedAt.set(null);
      }
      const socket = this.sockets.connect();

      const applyAssignedWork = (payload: WireAssignedWorkPayload, tabMembers: WireBoardMemberUser[], cachedAt: string | null) => {
        if (cancelled) return;
        this.selectedUserId.set(payload.targetUser.userId);
        if (mode === "team") this.rememberTeamUser(payload.targetUser.userId);
        this.members.set(tabMembers);
        this.state.hydrateAssignedWork(payload);
        // Register every accessible board with the WorkspaceService so card detail
        // and other utilities can map board → workspace consistently.
        this.workspaceService.registerBoards(workspaceId, payload.boards, payload.workspace.accentColor);
        this.workspaceService.cacheLists(workspaceId, payload.lists);
        this.offlineAssignedCachedAt.set(cachedAt);
        hydrated = true;
      };

      const refreshAssignedWork = () => {
        const userId = this.selectedUserId();
        if (cancelled || !hydrated || !userId) return;
        if (refreshInFlight) {
          refreshQueued = true;
          return;
        }
        refreshInFlight = true;
        const includeArchived = untracked(() => this.showArchived());
        // Same convergence guard as BoardPage.refreshBoard: a reconnect refresh whose GET predates a
        // card confirmed locally mid-flight would otherwise leave stale data until the next event.
        const seqBeforeFetch = this.state.cardMutationSeq();
        void this.load(
          workspaceId,
          userId,
          false,
          includeArchived,
          untracked(() => this.completedFrom()),
          untracked(() => this.completedTo()),
        )
          .then((fresh) => {
            const tabMembers = mode === "team" ? this.tabMembersFromPayload(fresh) : this.members();
            applyAssignedWork(fresh, tabMembers, null);
            this.saveAssignedWorkSnapshot(workspaceId, mode, userId, fresh, tabMembers);
            if (this.state.cardMutationSeq() !== seqBeforeFetch) refreshQueued = true;
          })
          .catch(() => undefined)
          .finally(() => {
            refreshInFlight = false;
            if (refreshQueued) {
              refreshQueued = false;
              refreshAssignedWork();
            }
          });
      };
      const refreshAfterBoardRejoin = () => {
        if (!joinedOnce) {
          joinedOnce = true;
          return;
        }
        refreshAssignedWork();
      };

      void this.resolveTargetUserId(workspaceId, mode, requestedUserId).then((userId) => {
        if (cancelled) return;
        if (!userId) {
          this.state.clear();
          return null;
        }
        this.selectedUserId.set(userId);
        if (mode === "team" && routeUserId && routeUserId !== userId) {
          void this.router.navigate(["/w", workspaceId, "team"], { queryParams: { userId }, replaceUrl: true });
        }
        return Promise.all([this.load(workspaceId, userId, false, initialIncludeArchived, initialCompletedFrom, initialCompletedTo), Promise.resolve(userId)] as const);
      }).then((result) => {
        if (!result) return;
        const [payload, userId] = result;
        const tabMembers = mode === "team" ? this.tabMembersFromPayload(payload) : this.members();
        applyAssignedWork(payload, tabMembers, null);
        this.saveAssignedWorkSnapshot(workspaceId, mode, userId, payload, tabMembers);

        this.detach?.();
        this.detach = this.bridge.attach(socket, workspaceId, {
          onJoined: refreshAfterBoardRejoin,
          onDesync: refreshAssignedWork,
          onWorkDoneChanged: () => this.workDoneRefreshVersion.update((version) => version + 1),
        });
      }).catch(async () => {
        const userId = this.selectedUserId() ?? (mode === "team" ? requestedUserId ?? ALL_TEAM_ASSIGNED_WORK_USER_ID : this.auth.user()?.id ?? null);
        const cached = userId
          ? await this.offlineCache.loadAssignedWork(this.assignedCacheKey(workspaceId, userId)).catch(() => null)
          : mode === "team"
            ? await this.offlineCache.loadAssignedWork(this.assignedCacheKey(workspaceId, "team:last")).catch(() => null)
            : null;
        if (cached) {
          applyAssignedWork(cached.payload, cached.tabMembers, cached.cachedAt);
          this.detach?.();
          this.detach = this.bridge.attach(socket, workspaceId, {
            onJoined: refreshAfterBoardRejoin,
            onDesync: refreshAssignedWork,
            onWorkDoneChanged: () => this.workDoneRefreshVersion.update((version) => version + 1),
          });
          return;
        }
        if (!cancelled) void this.router.navigateByUrl("/");
      });

      const onWorkspaceDeleted: ServerToClientEvents["workspace:deleted"] = ({ workspaceId: deletedId }) => {
        if (deletedId === workspaceId) void this.router.navigateByUrl("/");
      };
      const onWorkspaceMemberRemoved: ServerToClientEvents["workspace:member:removed"] = ({ workspaceId: wsId, userId: removedId }) => {
        if (wsId !== workspaceId) return;
        this.handleRemovedMemberTab(removedId);
      };
      const onWorkspaceMemberAdded: ServerToClientEvents["workspace:member:added"] = ({ workspaceId: wsId }) => {
        if (wsId !== workspaceId || mode !== "team") return;
        void this.loadMembers(workspaceId).then((members) => {
          if (!cancelled) {
            this.members.set(members);
            this.queueVisibleTabLimitUpdate();
          }
        }).catch(() => undefined);
      };
      socket.on("workspace:deleted", onWorkspaceDeleted);
      socket.on("workspace:member:removed", onWorkspaceMemberRemoved);
      socket.on("workspace:member:added", onWorkspaceMemberAdded);

      onCleanup(() => {
        cancelled = true;
        socket.off("workspace:deleted", onWorkspaceDeleted);
        socket.off("workspace:member:removed", onWorkspaceMemberRemoved);
        socket.off("workspace:member:added", onWorkspaceMemberAdded);
        this.detach?.();
        this.detach = null;
      });
    });

    // Persist the sticky filter set per scope. Keyed off filterPersistScope (stable route inputs)
    // so restore and persist agree; registered after the scope-change effect so a scope switch
    // restores the target scope's filters before this writes them back.
    effect(() => {
      const scope = this.filterPersistScope();
      const filters: StoredFilters = {
        boardIds: this.boardFilterIds(),
        labelIds: this.filterLabelIds(),
        memberIds: [], // assigned work has no member filter
        listIds: this.filterListIds(),
        cfConditions: this.filterCfConditions(),
        showUnreadOnly: this.showUnreadOnly(),
        showOverdueOnly: this.showOverdueOnly(),
      };
      writeFilters(scope, filters);
    });

    // The assigned-work payload only inlines `showOnCard` field values. Custom-field filtering,
    // List View CF columns, and the condition builder need every field's values across the many
    // boards the assigned cards span, so load them on demand (per board, only the assigned cards)
    // whenever a CF condition is active, the filter dropdown is open, or the List View is shown.
    effect(() => {
      const needed = this.effectiveView() === "list" || this.filterCfConditions().length > 0;
      // Track the card set so newly-arrived assigned cards get their values fetched too.
      const cards = this.state.cards();
      if (needed) untracked(() => this.ensureAssignedCustomFieldValuesLoaded(cards));
    });
  }

  // Card ids whose full custom-field values have been fetched (or are in flight). Unlike the board
  // page's single board-complete flag, Assigned Work spans boards and only ever holds the assigned
  // subset per board, so tracking per card keeps refetches minimal and handles realtime additions.
  private readonly loadedCfValueCardIds = new Set<string>();

  private ensureAssignedCustomFieldValuesLoaded(cards: readonly AnyCard[]) {
    if (!this.state.online()) return;
    const missing = cards.filter((card) => !this.loadedCfValueCardIds.has(card.id));
    if (missing.length === 0) return;
    // Optimistically mark before the request resolves so overlapping effect runs don't double-fetch;
    // failures un-mark the batch below so a later trigger retries.
    for (const card of missing) this.loadedCfValueCardIds.add(card.id);
    for (const [boardId, cardIds] of cardIdsByBoard(missing.map((c) => c.id), missing, "")) {
      if (!boardId) {
        for (const id of cardIds) this.loadedCfValueCardIds.delete(id);
        continue;
      }
      void this.api
        .post<{ customFieldValues: CompactCardCustomFieldValue[] }>(`/boards/${boardId}/custom-field-values/query`, { cardIds })
        .then((res) => {
          // Merge (not replace) so each board's values accumulate without clobbering siblings.
          this.state.mergeCustomFieldValues(res.customFieldValues.map(expandCardCustomFieldValue));
        })
        .catch(() => {
          for (const id of cardIds) this.loadedCfValueCardIds.delete(id);
        });
    }
  }

  ngOnDestroy() {
    window.removeEventListener("storage", this.onStorage);
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.clearSearchDebounce();
    this.detach?.();
    this.resizeObserver?.disconnect();
    this.cleanupScrollDrag?.();
  }

  ngAfterViewInit() {
    this.resizeObserver = new ResizeObserver(() => this.updateVisibleTabLimit());
    const tabs = this.host.nativeElement.querySelector<HTMLElement>('.tw-tabs');
    if (tabs) this.resizeObserver.observe(tabs);
    this.updateVisibleTabLimit();
  }

  private setupListScrollDrag() {
    const el = this.listsEl()?.nativeElement;
    if (!el) return;

    const scheduleDropTargetSnap = () => {
      if (!this.cardDropTargetListId || this.cardDragActive) return;
      const targetListId = this.cardDropTargetListId;
      const dragSession = this.cardDragSession;
      this.cardDropTargetListId = null;
      // CDK's touch path can emit dragEnded either before or after dropListDropped. Defer until
      // both have arrived, then center only if another drag has not taken ownership of the lane.
      queueMicrotask(() => {
        if (dragSession === this.cardDragSession && !this.cardDragActive) {
          this.centerListForMobile(targetListId, "smooth", el);
        }
      });
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest("k-list")) return;
      this.scrollDrag = { startX: e.clientX, startScrollLeft: el.scrollLeft };
      el.classList.add("is-dragging");
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.scrollDrag) return;
      e.preventDefault();
      el.scrollLeft = this.scrollDrag.startScrollLeft - (e.clientX - this.scrollDrag.startX);
    };

    const onMouseUp = () => {
      if (!this.scrollDrag) return;
      this.scrollDrag = null;
      el.classList.remove("is-dragging");
    };

    const onCardDragState = (event: Event) => {
      const active = event instanceof CustomEvent ? !!event.detail : false;
      this.cardDragActive = active;
      // Mobile scroll snapping otherwise pulls each small edge-scroll nudge back to the current
      // column, making lists beyond the viewport unreachable during a card drag.
      el.classList.toggle("is-card-dragging", active);
      if (active) {
        // A new drag owns its own destination. Clear any stale target and stop a previous smooth
        // snap animation before edge scrolling starts, otherwise consecutive drops can compete.
        this.cardDropTargetListId = null;
        this.cardDragSession += 1;
        if (typeof el.scrollTo === "function") {
          el.scrollTo({ left: el.scrollLeft, behavior: "auto" });
        }
        this.startEdgeScrollLoop();
      } else {
        this.stopEdgeScrollLoop();
        scheduleDropTargetSnap();
      }
    };

    const onCardDropTarget = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      this.cardDropTargetListId = event.detail;
      scheduleDropTargetSnap();
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
    document.addEventListener(APP_DOM_EVENTS.CARD_DROP_TARGET, onCardDropTarget);

    this.cleanupScrollDrag = () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onCardDragState);
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_MOVE, onCardDragMove);
      document.removeEventListener(APP_DOM_EVENTS.CARD_DROP_TARGET, onCardDropTarget);
      el.classList.remove("is-card-dragging");
      this.stopEdgeScrollLoop();
    };
  }

  private startEdgeScrollLoop() {
    if (this.edgeScrollFrame !== null) return;

    // Assigned Work reuses kanban cards across boards, so it mirrors BoardPage's
    // viewport-edge auto-scroll while a card drag is active.
    const tick = () => {
      this.edgeScrollFrame = window.requestAnimationFrame(tick);
      const pointer = this.cardDragPointer;
      const el = this.listsEl()?.nativeElement;
      if (!pointer || !el) return;

      const xStep = cardDragEdgeScrollStep(pointer.x, window.innerWidth);
      if (xStep !== 0) {
        el.scrollLeft += xStep;
      }

      const yStep = cardDragEdgeScrollStep(pointer.y, window.innerHeight);
      if (yStep !== 0) {
        window.scrollBy({ top: yStep, left: 0 });
      }
    };

    this.edgeScrollFrame = window.requestAnimationFrame(tick);
  }

  private stopEdgeScrollLoop() {
    this.cardDragPointer = null;
    if (this.edgeScrollFrame === null) return;
    window.cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }

  private load(workspaceId: string, userId: string, includeCompleted = false, includeArchived = this.showArchived(), completedFrom = this.completedFrom(), completedTo = this.completedTo()): Promise<WireAssignedWorkPayload> {
    const params = new URLSearchParams();
    if (includeCompleted) params.set("includeCompleted", "true");
    if (includeArchived) params.set("archived", "true");
    appendCompletedRangeParams(params, completedFrom, completedTo);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    if (userId === ALL_TEAM_ASSIGNED_WORK_USER_ID) {
      return this.api.get<WireAssignedWorkPayload>(`/workspaces/${workspaceId}/assignees/cards${suffix}`);
    }
    return this.api.get<WireAssignedWorkPayload>(`/workspaces/${workspaceId}/assignees/${userId}/cards${suffix}`);
  }

  private assignedCacheKey(workspaceId: string, userId: string): string {
    return userId === ALL_TEAM_ASSIGNED_WORK_USER_ID ? `${workspaceId}:team` : `${workspaceId}:${userId}`;
  }

  private saveAssignedWorkSnapshot(workspaceId: string, mode: AssignedWorkMode, userId: string, payload: WireAssignedWorkPayload, tabMembers: WireBoardMemberUser[]) {
    void this.offlineCache.saveAssignedWork(this.assignedCacheKey(workspaceId, userId), payload, tabMembers).catch(() => undefined);
    if (mode === "team") {
      void this.offlineCache.saveAssignedWork(this.assignedCacheKey(workspaceId, "team:last"), payload, tabMembers).catch(() => undefined);
    }
  }

  private async loadCardDetail(cardId: string) {
    try {
      const detail = await this.api.get<WireCardDetail>(`/cards/${cardId}/detail`);
      if (this.openCardId() === cardId) this.state.setCardDetail(detail);
    } catch {
      // The fetch can fail simply because we're offline. Don't tear down the open modal in that
      // case (that looked like the card detail "rebuilding" on connectivity changes) — fall back to
      // any cached detail and leave the modal open. The card-detail component re-fetches on its own
      // once connectivity returns.
      if (this.openCardId() !== cardId) return;
      const cached = await this.offlineCache.loadCardDetail(cardId).catch(() => null);
      if (cached && this.openCardId() === cardId) this.state.setCardDetail(cached.detail);
    }
  }

  private async resolveTargetUserId(workspaceId: string, mode: AssignedWorkMode, requestedUserId: string | undefined): Promise<string | null> {
    const meId = this.auth.user()?.id ?? null;
    if (mode !== "team") {
      if (!meId) return null;
      this.members.set([this.memberFromAuth(meId)]);
      this.queueVisibleTabLimitUpdate();
      return meId;
    }

    const existingMembers = untracked(() => this.members());
    const canUseExistingMembers = existingMembers.length > 0 && (!requestedUserId || existingMembers.some((m) => m.userId === requestedUserId));
    const members = canUseExistingMembers ? existingMembers : await this.loadMembers(workspaceId);
    if (!canUseExistingMembers) {
      this.members.set(members);
      this.queueVisibleTabLimitUpdate();
    }
    if (!requestedUserId || requestedUserId === ALL_TEAM_ASSIGNED_WORK_USER_ID) return ALL_TEAM_ASSIGNED_WORK_USER_ID;
    if (requestedUserId && requestedUserId !== meId && members.some((m) => m.userId === requestedUserId)) return requestedUserId;
    return members[0]?.userId ?? ALL_TEAM_ASSIGNED_WORK_USER_ID;
  }

  private rememberTeamUser(userId: string) {
    localStorage.setItem(assignedWorkTeamUserKey(this.workspaceId()), userId);
  }

  private async loadMembers(workspaceId: string): Promise<WireBoardMemberUser[]> {
    const meId = this.auth.user()?.id;
    const rows = await this.api.get<WireWorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
    return rows
      .filter((row) => row.userId !== meId)
      .map((row) => ({
        userId: row.userId,
        displayName: row.displayName ?? "",
        avatarUrl: row.avatarUrl ?? null,
        lastOnlineAt: row.lastOnlineAt ?? null,
        role: row.role,
        source: "workspace" as const,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private tabMembersFromPayload(payload: WireAssignedWorkPayload): WireBoardMemberUser[] {
    const meId = this.auth.user()?.id;
    return payload.members
      .filter((row) => row.userId !== meId)
      .map((row) => ({
        userId: row.userId,
        displayName: row.displayName ?? "",
        avatarUrl: row.avatarUrl ?? null,
        lastOnlineAt: row.lastOnlineAt ?? null,
        role: row.role,
        source: "workspace" as const,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private queueVisibleTabLimitUpdate() {
    queueMicrotask(() => untracked(() => this.updateVisibleTabLimit()));
  }

  private updateVisibleTabLimit() {
    const tabs = this.host.nativeElement.querySelector<HTMLElement>('.tw-tabs');
    if (!tabs) return;
    const memberCount = this.members().length;
    if (memberCount <= 1) {
      this.visibleTabLimit.set(MAX_VISIBLE_TABS);
      return;
    }

    // clientWidth includes left+right padding; subtract both to get the true
    // content area. The right padding reserves space for the fixed bell and
    // is responsive (60px desktop, 52px mobile) so we read it from the DOM.
    const cs = getComputedStyle(tabs);
    const paddingH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.gap) || 2;
    const available = Math.max(0, tabs.clientWidth - paddingH);

    // Use the widest currently-rendered tab as the per-tab estimate. This
    // intentionally errs conservative — it triggers the overflow button a bit
    // early rather than letting tabs spill into the notification bell's space.
    // TAB_WIDTH_ESTIMATE is the fallback before any tabs are in the DOM.
    const renderedTabs = Array.from(tabs.querySelectorAll<HTMLElement>(':scope > .tw-tab'));
    const tabWidth = renderedTabs.length > 0
      ? Math.max(...renderedTabs.map((t) => t.offsetWidth))
      : TAB_WIDTH_ESTIMATE;

    const allFitWidth = memberCount * tabWidth + (memberCount - 1) * gap;
    if (allFitWidth <= available) {
      this.visibleTabLimit.set(MAX_VISIBLE_TABS);
      return;
    }

    // Reserve space for the overflow button (measure it when rendered).
    const overflowWrapperEl = tabs.querySelector<HTMLElement>('.tw-overflow-wrapper');
    const overflowBtnWidth = (overflowWrapperEl?.offsetWidth ?? OVERFLOW_BUTTON_WIDTH) + gap;
    const availableWithOverflow = Math.max(0, available - overflowBtnWidth);
    this.visibleTabLimit.set(Math.max(1, Math.floor(availableWithOverflow / (tabWidth + gap))));
  }

  private memberFromAuth(userId: string): WireBoardMemberUser {
    const user = this.auth.user();
    return {
      userId,
      displayName: user?.displayName ?? "Me",
      avatarUrl: user?.avatarUrl ?? null,
      lastOnlineAt: null,
      role: "editor",
      source: "workspace",
    };
  }

  async clearFilters() {
    if (this.state.targetUser() === null) return;
    this.setSearchQuery('');
    this.boardFilterIds.set([]);
    this.filterLabelIds.set([]);
    this.filterListIds.set([]);
    this.filterCfConditions.set([]);
    this.showUnreadOnly.set(false);
    this.showOverdueOnly.set(false);
    const needsReload = this.showCompleted() || this.showArchived();
    this.showArchived.set(false);
    this.completedFrom.set("");
    this.completedTo.set("");
    writeCompletedFilter(this.viewScope(), null);
    this.compactOpen.set(false);
    if (needsReload) await this.reloadAssignedWork();
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

  toggleCompact(e: MouseEvent) {
    e.stopPropagation();
    if (this.state.targetUser() === null) return;
    this.compactOpen.update(v => !v);
  }

  openCompletedHistory() {
    if (this.state.targetUser() === null || this.isAllTeamSelected()) return;
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    this.completedPanelOpen.set(true);
    this.compactOpen.set(false);
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

  onStartAdd(payload: StartAddPayload) {
    if (!this.canCreateAssignedCards()) return;
    this.centerListForMobile(payload.listId);
    this.addingToListId.set(payload.listId);
    this.addingAtTop.set(payload.atTop);
    this.skipNextDocumentClick = true;
  }

  private centerListForMobile(listId: string, behavior: ScrollBehavior = "smooth", lists = this.listsEl()?.nativeElement) {
    if (!window.matchMedia?.(MOBILE_KANBAN_QUERY).matches) return;
    const list = lists?.querySelector<HTMLElement>(`k-list[data-list-id="${CSS.escape(listId)}"]`);
    // Mobile kanban columns snap to center; center the tapped column before showing the add-card
    // composer so adjacent peek columns don't leave the textarea half off-screen.
    list?.scrollIntoView({ behavior, block: "nearest", inline: "center" });
  }

  closeAddMode() {
    this.addingToListId.set(null);
    this.addingAtTop.set(false);
  }

  onAssignedCardCreated(card: AnyCard) {
    this.state.addCard(card);
    const targetUserId = this.addCardAssigneeIds()[0];
    if (targetUserId) this.state.setCardAssignees(card.id, [targetUserId]);
  }

  async toggleArchivedCards() {
    if (this.state.targetUser() === null) return;
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    const next = !this.showArchived();
    this.showArchived.set(next);
    if (next) this.showOverdueOnly.set(false);
    const userId = this.selectedUserId();
    if (!userId) return;
    const payload = await this.load(this.workspaceId(), userId, false, next);
    this.state.hydrateAssignedWork(payload);
    this.saveAssignedWorkSnapshot(this.workspaceId(), this.mode(), userId, payload, this.members());
  }

  async applyCompletedRange(range: { from: string; to: string }) {
    this.completedFrom.set(range.from);
    this.completedTo.set(range.to);
    writeCompletedFilter(this.viewScope(), range);
    await this.reloadAssignedWork();
  }

  async clearCompletedRange() {
    this.completedFrom.set("");
    this.completedTo.set("");
    writeCompletedFilter(this.viewScope(), null);
    await this.reloadAssignedWork();
  }

  /** The filter bar emits the desired archived state; `toggleArchivedCards` flips + reloads. */
  onArchivedChange(next: boolean) {
    if (next !== this.showArchived()) void this.toggleArchivedCards();
  }

  /** Fan the shared filter bar's value object back out to the individual sticky signals. */
  onFilterValueChange(v: FilterValue) {
    if (this.state.targetUser() === null) return;
    this.filterLabelIds.set(v.labelIds);
    this.filterListIds.set(v.listIds);
    this.boardFilterIds.set(v.boardIds);
    this.filterCfConditions.set(v.cfConditions);
    this.showUnreadOnly.set(v.showUnreadOnly);
    this.showOverdueOnly.set(v.showOverdueOnly);
  }

  private async reloadAssignedWork() {
    const userId = this.selectedUserId();
    if (!userId) return;
    const payload = await this.load(this.workspaceId(), userId, false, this.showArchived());
    this.state.hydrateAssignedWork(payload);
    this.saveAssignedWorkSnapshot(this.workspaceId(), this.mode(), userId, payload, this.members());
  }

  setAssignedBackground(token: GradientToken | null) {
    writeViewBackground(this.backgroundScope(), token);
    this.backgroundPreferenceVersion.update((version) => version + 1);
    this.showBackground.set(false);
  }

  private hasAny(values: Set<string> | undefined, filters: Set<string>): boolean {
    if (!values) return false;
    for (const id of filters) {
      if (values.has(id)) return true;
    }
    return false;
  }

  private addCardMouseDownStartedInside = false;

  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    const form = this.host.nativeElement.querySelector<HTMLElement>('.add-card-form, .lv-add-popover');
    this.addCardMouseDownStartedInside = !!(this.addingToListId() && form && target && form.contains(target));
  };

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const addCardMouseDownStartedInside = this.addCardMouseDownStartedInside;
    this.addCardMouseDownStartedInside = false;
    if (this.skipNextDocumentClick) {
      this.skipNextDocumentClick = false;
      return;
    }
    const target = event.target as Node | null;
    if (this.addingToListId()) {
      const form = this.host.nativeElement.querySelector<HTMLElement>('.add-card-form, .lv-add-popover');
      // Releasing outside after pressing in the textarea is text selection, not an outside-click intent.
      if (!addCardMouseDownStartedInside && (!form || !target || !form.contains(target))) this.closeAddMode();
    }
    if (this.checklistMenu()) {
      const menu = this.host.nativeElement.querySelector<HTMLElement>('.tw-checklist-context-menu');
      if (!menu || !target || !menu.contains(target)) this.closeChecklistMenu();
    }
    if (this.compactOpen()) {
      const controls = this.host.nativeElement.querySelector<HTMLElement>('.tw-controls');
      if (controls && target && !controls.contains(target)) this.compactOpen.set(false);
    }
    if (this.overflowOpen()) {
      const overflowWrapper = this.host.nativeElement.querySelector<HTMLElement>('.tw-overflow-wrapper');
      if (overflowWrapper && target && !overflowWrapper.contains(target)) this.overflowOpen.set(false);
    }
    if (this.showBackground()) {
      const backgroundWrapper = this.host.nativeElement.querySelector<HTMLElement>('.tw-background-wrap');
      if (backgroundWrapper && target && !backgroundWrapper.contains(target)) this.showBackground.set(false);
    }
  }

  @HostListener("document:keydown", ["$event"])
  onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.checklistMenu()) {
      this.closeChecklistMenu();
      return;
    }
    if (event.key === "Escape" && this.bulkSelectedCount() > 0 && !this.openCardId() && !this.bulkMenuOpen()) {
      event.preventDefault();
      this.clearBulkSelection();
      return;
    }
    if (event.key.toLowerCase() !== "f" || (!event.ctrlKey && !event.metaKey)) return;
    if (this.openCardId()) return;
    event.preventDefault();
    this.focusSearchInput();
  }

  selectUser(userId: string) {
    if (!this.isTeamView()) return;
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    this.overflowOpen.set(false);
    this.rememberTeamUser(userId);
    if (userId === ALL_TEAM_ASSIGNED_WORK_USER_ID) {
      void this.router.navigate(["/w", this.workspaceId(), "team"], {
        queryParams: { userId: null },
        queryParamsHandling: "merge",
      });
      return;
    }
    void this.router.navigate(["/w", this.workspaceId(), "team"], {
      queryParams: { userId },
    });
  }

  handleRemovedMemberTab(removedId: string) {
    if (removedId === this.auth.user()?.id) {
      void this.router.navigateByUrl("/");
      return;
    }
    const previousMembers = this.members();
    const removedIndex = previousMembers.findIndex((member) => member.userId === removedId);
    const remainingMembers = previousMembers.filter((member) => member.userId !== removedId);
    this.members.set(remainingMembers);
    this.queueVisibleTabLimitUpdate();
    if (removedId !== this.selectedUserId()) return;
    if (!this.isTeamView()) {
      void this.router.navigateByUrl("/");
      return;
    }
    // Stay in Assigned Work and move to the nearest surviving member tab. If no individual tabs
    // remain, All Team is the only valid fallback.
    const fallbackIndex = Math.max(0, Math.min(removedIndex, remainingMembers.length - 1));
    const fallbackUserId = remainingMembers[fallbackIndex]?.userId ?? ALL_TEAM_ASSIGNED_WORK_USER_ID;
    this.selectedUserId.set(fallbackUserId);
    this.rememberTeamUser(fallbackUserId);
    void this.router.navigate(["/w", this.workspaceId(), "team"], {
      queryParams: { userId: fallbackUserId === ALL_TEAM_ASSIGNED_WORK_USER_ID ? null : fallbackUserId },
      replaceUrl: true,
    });
  }

  toggleOverflow() {
    const nextOpen = !this.overflowOpen();
    this.overflowOpen.set(nextOpen);
    if (!nextOpen) return;

    const wrapper = this.host.nativeElement.querySelector<HTMLElement>('.tw-overflow-wrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const estimatedMenuWidth = 220;
    this.overflowAlignRight.set(rect.left + estimatedMenuWidth > window.innerWidth - 8);
  }

  private focusSearchInput() {
    this.searchInput()?.nativeElement.focus();
  }

  openCardDetail(cardId: string) {
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    void this.router.navigate(this.routeCommands(), {
      queryParams: { cardId, lightboxAttachmentId: null },
      queryParamsHandling: "merge",
    });
  }

  openBoard(boardId: string) {
    void this.router.navigate(["/b", boardId]);
  }

  // Checklist items deep-link to their parent card (they have no standalone route).
  openChecklistItem(item: WireChecklistAssignment) {
    this.openCardDetail(item.cardId);
  }

  // Right-click context menu for a checklist item (Open in new tab / Mark as resolved).
  readonly checklistMenu = signal<{ item: WireChecklistAssignment; x: number; y: number } | null>(null);

  openChecklistItemMenu(item: WireChecklistAssignment, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.checklistMenu.set({ item, x: event.clientX, y: event.clientY });
  }

  closeChecklistMenu() {
    this.checklistMenu.set(null);
  }

  private checklistItemUrl(item: WireChecklistAssignment): string {
    // Items have no standalone route, so the link targets the parent card on its board.
    return this.router.serializeUrl(
      this.router.createUrlTree(["/b", item.boardId], { queryParams: { cardId: item.cardId } }),
    );
  }

  openChecklistItemInNewTab(item: WireChecklistAssignment) {
    window.open(this.checklistItemUrl(item), "_blank", "noopener");
    this.closeChecklistMenu();
  }

  async resolveChecklistItem(item: WireChecklistAssignment) {
    this.closeChecklistMenu();
    // Optimistically drop it from the list; the realtime update confirms (completed → not
    // relevant). On failure, re-add so the list stays accurate.
    this.state.removeAssignedChecklistItem(item.itemId);
    try {
      await this.api.patch(`/cards/${item.cardId}/checklists/${item.checklistId}/items/${item.itemId}`, { completed: true });
    } catch (e) {
      this.state.upsertAssignedChecklistItem(item);
      throw e;
    }
  }

  checklistItemDueDateText(item: WireChecklistAssignment): string {
    if (!item.dueDateLocalDate) return "";
    return formatDueDate(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone);
  }

  checklistItemOverdue(item: WireChecklistAssignment): boolean {
    return isOverdue(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone);
  }

  closeCardDetail() {
    void this.router.navigate(this.routeCommands(), {
      queryParams: { cardId: null, lightboxAttachmentId: null },
      queryParamsHandling: "merge",
    });
  }

  setView(mode: ViewMode) {
    if (this.effectiveView() === mode) return;
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    writeViewMode(this.viewScope(), mode);
    if (this.isTeamView()) writeViewMode(this.teamViewScope(), mode);
    this.viewPreferenceVersion.update((version) => version + 1);
    void this.router.navigate(this.routeCommands(), {
      queryParams: { view: mode === "board" ? null : mode },
      queryParamsHandling: "merge",
    });
  }

  private routeCommands(): string[] {
    return this.isTeamView() ? ["/w", this.workspaceId(), "team"] : ["/w", this.workspaceId(), "u", this.selectedUserId() ?? this.auth.user()?.id ?? ""];
  }

  private readRememberedView(): ViewMode {
    const remembered = readViewMode(this.viewScope()) ?? (this.isTeamView() ? this.readTeamRememberedView() : null);
    return remembered === "list" || remembered === "calendar" || remembered === "history" ? remembered : "board";
  }

  private teamViewScope(): string {
    return `assignedWork:${this.workspaceId()}:team`;
  }

  private readTeamRememberedView(): ViewMode | null {
    const team = readViewMode(this.teamViewScope());
    if (team) return team;

    const prefix = `${STORAGE_KEYS.VIEW_PREFIX}.mode:assignedWork:${this.workspaceId()}:`;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix) || key.endsWith(":me") || key.endsWith(":team")) continue;
        const mode = localStorage.getItem(key);
        if (mode === "list" || mode === "calendar" || mode === "history") return mode;
      }
    } catch {
      return null;
    }
    return null;
  }

  private readChecklistSectionCollapsed(): boolean {
    try {
      return localStorage.getItem(this.checklistSectionStorageKey()) !== "0";
    } catch {
      return true;
    }
  }

  private writeChecklistSectionCollapsed(collapsed: boolean): void {
    try {
      const key = this.checklistSectionStorageKey();
      if (collapsed) localStorage.setItem(key, "1");
      else localStorage.setItem(key, "0");
    } catch {
      // Ignore unavailable storage; the in-memory signal still reflects the current click.
    }
  }

  async onCardDrop(p: CardDropPayload) {
    if (!this.state.canEdit()) return;
    const previous = this.state.snapshotCards();
    const card = this.state.cardById(p.cardId);
    if (!card) return;
    const beforeAnchor = p.beforeItem ?? (p.beforeCardId !== undefined && p.beforeCardId !== null ? { type: "card" as const, id: p.beforeCardId } : p.beforeCardId);
    const afterAnchor = p.afterItem ?? (p.afterCardId !== undefined && p.afterCardId !== null ? { type: "card" as const, id: p.afterCardId } : p.afterCardId);
    const beforeItem = beforeAnchor ? this.itemForAnchor(beforeAnchor) : beforeAnchor;
    const afterItem = afterAnchor ? this.itemForAnchor(afterAnchor) : afterAnchor;
    const optimistic = this.state.positionForItemDrop({ kind: "card", card }, p.toListId, beforeItem, afterItem);
    this.state.moveCard(p.cardId, p.toListId, optimistic);
    const cardAnchors = this.cardMoveAnchorsForDrop(p);
    try {
      const moved = await this.api.post<{ id: string; listId: string; position: string }>(`/cards/${p.cardId}/move`, {
        listId: p.toListId,
        ...cardAnchors,
      });
      // The server may interpolate against unassigned cards hidden between the
      // visible anchors. Its response settles the exact shared-list position
      // without changing the visible relative order.
      this.state.moveCard(moved.id, moved.listId, moved.position);
    } catch (error) {
      this.state.restoreCards(previous);
      throw error;
    }
  }

  async onSeparatorDrop(p: SeparatorDropPayload) {
    if (!this.state.canEdit()) return;
    const previous = this.state.snapshotSeparators();
    const separator = this.state.separatorsById().get(p.separatorId);
    if (!separator) return;
    const beforeItem = p.beforeItem ? this.itemForAnchor(p.beforeItem) : p.beforeItem;
    const afterItem = p.afterItem ? this.itemForAnchor(p.afterItem) : p.afterItem;
    const optimistic = this.state.positionForItemDrop({ kind: "separator", separator }, p.toListId, beforeItem, afterItem);
    this.state.moveSeparator(p.separatorId, p.toListId, optimistic);
    try {
      const moved = await this.api.post<{ id: string; listId: string; position: string }>(`/assigned-work-separators/${p.separatorId}/move`, {
        listId: p.toListId,
        ...(p.beforeItem !== undefined ? { beforeItem: p.beforeItem } : {}),
        ...(p.afterItem !== undefined ? { afterItem: p.afterItem } : {}),
      });
      this.state.moveSeparator(moved.id, moved.listId, moved.position);
    } catch (error) {
      this.state.restoreSeparators(previous);
      throw error;
    }
  }

  private cardMoveAnchorsForDrop(p: CardDropPayload): { beforeCardId?: string | null; afterCardId?: string | null } {
    if (p.beforeItem !== undefined) {
      if (p.beforeItem === null) return { beforeCardId: null };
      if (p.beforeItem.type === "card") return { beforeCardId: p.beforeItem.id };
      return this.cardAnchorNearSeparator(p.toListId, p.cardId, p.beforeItem.id, "before");
    }
    if (p.afterItem !== undefined) {
      if (p.afterItem === null) return { afterCardId: null };
      if (p.afterItem.type === "card") return { afterCardId: p.afterItem.id };
      return this.cardAnchorNearSeparator(p.toListId, p.cardId, p.afterItem.id, "after");
    }
    return {
      ...(p.beforeCardId !== undefined ? { beforeCardId: p.beforeCardId } : {}),
      ...(p.afterCardId !== undefined ? { afterCardId: p.afterCardId } : {}),
    };
  }

  private cardAnchorNearSeparator(listId: string, movingCardId: string, separatorId: string, side: "before" | "after"): { beforeCardId?: string | null; afterCardId?: string | null } {
    const items = this.state.itemsForList(listId, this.filteredCardsByList().get(listId) ?? [], true).filter((item) => item.kind !== "card" || item.card.id !== movingCardId);
    const separatorIndex = items.findIndex((item) => item.kind === "separator" && item.separator.id === separatorId);
    if (separatorIndex < 0) return {};
    const previousCard = [...items.slice(0, separatorIndex)].reverse().find((item): item is Extract<BoardLaneItem, { kind: "card" }> => item.kind === "card");
    const nextCard = items.slice(separatorIndex + 1).find((item): item is Extract<BoardLaneItem, { kind: "card" }> => item.kind === "card");

    // Assigned-work separators are personal rows, while card moves are real board moves.
    // Translate separator anchors to the nearest visible card anchor the card API can resolve.
    if (side === "before") return nextCard ? { beforeCardId: nextCard.card.id } : { afterCardId: previousCard?.card.id ?? null };
    return previousCard ? { afterCardId: previousCard.card.id } : { beforeCardId: nextCard?.card.id ?? null };
  }

  private itemForAnchor(anchor: LaneAnchor): BoardLaneItem | null {
    if (anchor.type === "card") {
      const card = this.state.cardById(anchor.id);
      return card ? { kind: "card", card } : null;
    }
    const separator = this.state.separatorsById().get(anchor.id);
    return separator ? { kind: "separator", separator } : null;
  }

  onListsBackgroundClick(e: MouseEvent) {
    if (e.target === e.currentTarget) this.clearBulkSelection();
  }

  onBulkSelectionRequested(payload: BulkCardSelectionPayload) {
    if (!this.state.canEdit() || this.showArchived()) return;
    const targetCard = this.state.cards().find((card) => card.id === payload.cardId);
    if (!targetCard) return;

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
    // can expand/contract a rendered range instead of collapsing to the last two rows.
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

  // Custom-field editing spans the selected cards' boards; the dialog fetches per-board values.
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
}
