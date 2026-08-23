import type { OnDestroy} from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
import type { CompactCardCustomFieldValue, CompactCardSummary, ServerToClientEvents, WireBoardMemberUser, WireCard, WireCardSummary, WireChecklistTemplate, WireSeparator } from "@kanera/shared/events";
import { expandCardCustomFieldValue, expandCardSummary, SERVER_EVENTS } from "@kanera/shared/events";
import type { BoardExportArchive, WorkDoneEventType, WorkPrioritiesResponse } from "@kanera/shared/dto";
import type { Board, BoardRole, BoardSeparator, Card, CardCustomFieldValue, CardLabel, CustomField, List } from "@kanera/shared/schema";
import { AnalyticsService } from "../../core/analytics/analytics.service";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { downloadTextFile } from "../../core/browser/download";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService, type OfflineBoardSnapshot } from "../../core/offline/offline-cache.service";
import { RecentBoardsService } from "../../core/recent-boards/recent-boards.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import type { AnchoredPanelPlacement } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { PanelStackService } from "../../shared/panel-stack.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { PageToolbarComponent } from "../../shared/page-toolbar.component";
import { mediaQuerySignal } from "../../shared/media-query.signal";
import { SearchFieldComponent } from "../../shared/search-field.component";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { StatusToastComponent } from "../../shared/status-toast.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardBackgroundPopover } from "./board-background.popover";
import { BoardCanvasComponent } from "./board-canvas.component";
import { BoardMembersMenu } from "../shared/board-members-menu.popover";
import { BoardSocketBridge } from "./board-socket-bridge";
import { BoardState, type BoardLaneItem, type LaneAnchor } from "./board-state";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";
import { boardWorkRisk, isCardInactive } from "@kanera/shared/card-health";
import { BulkCardActionsMenuPopover } from "./bulk-card-actions-menu.popover";
import { BulkCustomFieldsDialogComponent } from "./bulk-custom-fields.dialog";
import { BoardCalendarViewComponent } from "./calendar-view/board-calendar-view.component";
import { WorkDoneViewComponent } from "./work-done-view/work-done-view.component";
import { readWorkDoneLayout, writeWorkDoneLayout } from "./work-done-view/work-done-preferences";
import { NARROW_WORK_DONE_LAYOUT_QUERY, type WorkDoneLayout } from "./work-done-view/work-done.types";
import { WatcherPopoverComponent } from "./watcher-popover.component";
import { CardDetailComponent } from "./card-detail.component";
import { isOverdue } from "./due-date.util";
import { BoardGroupColumnComponent, type GroupCardDropPayload } from "./board-group-column.component";
import { CardComposerDialogComponent, type CardComposerSeed } from "./card-composer.dialog";
import { BoardTableViewComponent } from "./table-view/board-table-view.component";
import { matchesCfConditions } from "./table-view/filter.util";
import type { CfFilterCondition, FilterValue } from "./table-view/filter.types";
import { FilterBarComponent } from "./table-view/filter-bar.component";
import { groupCards } from "./table-view/group-by.util";
import { GROUP_BY_OPTIONS, NULL_GROUP_KEY, type CardGroup, type GroupBy } from "./table-view/table-view.types";
import { readCompletedFilter, readFilters, readGroupBy, readViewMode, writeCompletedFilter, writeFilters, writeGroupBy, writeViewMode, type StoredFilters, type ViewMode } from "./table-view/view-preference";
import { NotesViewComponent } from "../notes/notes-view.component";
import { CompletedCardsPanelComponent } from "../completed-cards/completed-cards-panel.component";
import { appendCompletedRangeParams, formatCompletedRangeDate } from "../completed-cards/completed-range.util";
import type { BulkCardMenuPayload, BulkCardSelectionPayload, BulkListSelectionPayload, CardDropPayload, SeparatorDropPayload, StartAddPayload } from "./list.component";
import { ListComponent } from "./list.component";
import { boardArchiveFileName, boardArchiveToReportRows, boardReportColumnWidths, styledBoardReportRows } from "./board-export.util";
import { MirrorCreateDialogComponent } from "../board-mirrors/mirror-create.dialog";
import { BoardMirrorsDialogComponent } from "../board-mirrors/board-mirrors.dialog";
import { BoardMirrorsService } from "../board-mirrors/board-mirrors.service";

type AnyCard = Card | WireCard | WireCardSummary;
type BoardRiskFilter = "overdue" | "unassigned" | "inactive";
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

/** The "no value" bucket of any grouping — Unassigned, No label, No <field>. */
function isNullGroup(group: CardGroup): boolean {
  return group.key.endsWith(`:${NULL_GROUP_KEY}`);
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** `YYYY-MM-DD` for today plus `offsetDays`, in the viewer's own timezone (due dates are local). */
function localDateKey(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

@Component({
  selector: "k-board-page",
  standalone: true,
  imports: [AnchoredPanelDirective, BoardCanvasComponent, BoardGroupColumnComponent, CardComposerDialogComponent, ListComponent, CardDetailComponent, BoardBackgroundPopover, BoardMembersMenu, AvatarComponent, BoardTableViewComponent, BoardCalendarViewComponent, WorkDoneViewComponent, NotesViewComponent, CompletedCardsPanelComponent, FilterBarComponent, PageHeaderComponent, PageToolbarComponent, SearchFieldComponent, SegmentedComponent, StatusToastComponent, TooltipDirective, WatcherPopoverComponent, BulkCardActionsMenuPopover, BulkCustomFieldsDialogComponent, MirrorCreateDialogComponent, BoardMirrorsDialogComponent],
  providers: [BoardState, BoardSocketBridge, BoardMenuCoordinator],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board.page.html",
  styleUrl: "./board.page.scss",
})
export class BoardPage implements OnDestroy {
  protected readonly state = inject(BoardState);
  private readonly socketBridge = inject(BoardSocketBridge);
  private readonly analytics = inject(AnalyticsService);
  private readonly api = inject(ApiClient);
  private readonly appTitle = inject(AppTitleService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly notifications = inject(NotificationsService);
  private readonly recentBoards = inject(RecentBoardsService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly boardMirrors = inject(BoardMirrorsService);
  private readonly panelStack = inject(PanelStackService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly listsEl = viewChild<BoardCanvasComponent>('listsEl');

  readonly boardId = input.required<string>();
  readonly cardId = input<string | undefined>();
  readonly lightboxAttachmentId = input<string | undefined>();
  readonly noteId = input<string | undefined>();
  /** Bound from the `view` query param, so it is whatever string the URL carried. */
  readonly view = input<string | undefined>();
  readonly rememberedView = signal<ViewMode>("board");
  /** Resolved view mode: URL query param > localStorage > default board. */
  readonly effectiveView = computed<ViewMode>(() => {
    const fromUrl = this.view();
    // A `?view=list` link from before the List view was retired resolves to the Table, which is the
    // view that replaced it — the alternative is silently dropping the reader onto the kanban.
    if (fromUrl === "list") return "table";
    if (fromUrl === "table" || fromUrl === "board" || fromUrl === "notes" || fromUrl === "calendar" || fromUrl === "history") return fromUrl;
    return this.rememberedView();
  });
  /**
   * Table renders its own export menu, so the board-level export button stands down rather than
   * offering the same action twice on one screen. Search and filtering do *not* branch on this any
   * more: the page toolbar owns both for every view, and the table is told to suppress its own.
   */
  readonly viewOwnsChrome = computed(() => this.effectiveView() === "table");

  /**
   * Notes is the one view that holds no cards, so the query bar has nothing to query: "Search cards",
   * a card Filter and Completed all applied to a collection that is not on screen. Notes brings its
   * own tree, tabs and New note control instead.
   */
  readonly viewHasQueryBar = computed(() => this.effectiveView() !== "notes");

  /**
   * The 5-way view switch. Disabled as a set while the board loads — the switch stays mounted (it is
   * navigation) but has nothing to navigate within yet.
   */
  readonly viewOptions = computed<SegmentedOption<ViewMode>[]>(() => {
    const disabled = this.state.board() === null;
    return [
      { id: "board", icon: "layout-kanban", label: "Board view", disabled },
      { id: "table", icon: "table", label: "Table view", disabled },
      { id: "calendar", icon: "calendar-week", label: "Calendar view", disabled },
      { id: "history", icon: "history", label: "Work done", disabled },
      { id: "notes", icon: "notebook", label: "Board Notes", disabled },
    ];
  });

  /** Board colour, falling back to the workspace accent, for the header's lead icon. */
  readonly boardIconColor = computed(() => {
    const board = this.state.board();
    const color = board?.iconColor ?? this.workspaceAccentColor();
    return color ? `var(--color-${color})` : null;
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
  /** History-only event dimension, surfaced through the page's shared Filter panel. */
  readonly workDoneEventType = signal<WorkDoneEventType | null>(null);
  private readonly preferredWorkDoneLayout = signal<WorkDoneLayout>(readWorkDoneLayout("board"));
  private readonly narrowWorkDoneLayout = mediaQuerySignal(NARROW_WORK_DONE_LAYOUT_QUERY);
  /** Grid is a wide-screen preference; a one-column "grid" is just a less readable list. */
  readonly workDoneLayout = computed<WorkDoneLayout>(() =>
    this.narrowWorkDoneLayout() ? "list" : this.preferredWorkDoneLayout()
  );
  readonly workDoneLayoutOptions = computed<readonly SegmentedOption<WorkDoneLayout>[]>(() => [
    { id: "list", icon: "list-details", label: "List layout" },
    { id: "grid", icon: "layout-grid", label: "Grid layout", disabled: this.narrowWorkDoneLayout() },
  ]);

  setWorkDoneLayout(layout: WorkDoneLayout): void {
    if (layout === "grid" && this.narrowWorkDoneLayout()) return;
    this.preferredWorkDoneLayout.set(layout);
    writeWorkDoneLayout("board", layout);
  }
  readonly showUnreadOnly = signal(false);
  readonly showOverdueOnly = signal(false);
  readonly showInactiveOnly = signal(false);
  /** Session-local drill-down selected from Board overview; composed with the normal filter bar. */
  readonly boardRiskFilter = signal<BoardRiskFilter | null>(null);
  /** Only cards in the viewer's own "Up next" queue (`viewerPriorityRanks`). */
  readonly showPrioritySetOnly = signal(false);
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
  /**
   * The viewer's own "Up next" queue positions, worn as rank pills on this board's tiles. The queue
   * is user-scoped and spans boards; this page only ever looks up its own card ids in the map, so
   * entries for other boards are simply never read. Cleared on fetch failure rather than left
   * stale — a stale sequence reads as an instruction.
   */
  readonly viewerPriorityRanks = signal<Map<string, number>>(new Map());
  readonly workDoneRefreshVersion = signal(0);
  readonly exportMenuOpen = signal(false);
  /**
   * The two header menus share their chrome but not their width — the mirror menu's labels are longer.
   * Width lives here rather than in CSS so placement clamps against the box that is actually rendered;
   * a CSS-only override would leave the panel wider than the position it was aligned for.
   * `minHeight` is the real height of a two-item menu, so a header low on a short viewport does not
   * flip it above the trigger for no reason.
   */
  readonly exportMenuPlacement: AnchoredPanelPlacement = { align: "end", width: 160, gap: 4, minHeight: 90, maxHeight: 240 };
  readonly mirrorMenuPlacement: AnchoredPanelPlacement = { ...this.exportMenuPlacement, width: 240 };
  readonly exportLoading = signal<"json" | "xlsx" | null>(null);
  readonly mirrorMenuOpen = signal(false);
  readonly mirrorCreateOpen = signal(false);
  readonly mirrorsDialogOpen = signal(false);
  readonly mirrorCount = signal(0);
  readonly mirrorInboundCount = signal(0);
  readonly mirrorCanManage = signal(false);
  readonly mirrorRefreshVersion = signal(0);
  readonly mirrorConfigured = computed(() => this.mirrorCount() > 0);
  readonly boardSyncAvailable = computed(() => {
    if (!this.state.boardSyncAllowed()) return false;
    // The board-open value describes the board owner and is essential for guest boards. When the
    // current organisation owns the board, also consume live auth entitlements so a trial-expiry
    // event blocks creation without waiting for the route to reload.
    return this.state.workspaceClientId() !== this.auth.user()?.clientId || this.auth.boardSyncAllowed();
  });
  readonly mirrorCreateMode = computed<"outbound" | "inbound">(() => this.mirrorInboundCount() > 0 ? "inbound" : "outbound");
  readonly mirrorCreateBlocked = computed(() => !this.boardSyncAvailable() || (this.mirrorCreateMode() === "inbound" && !this.state.viewerIsWorkspaceAdmin()));
  readonly mirrorCreateLabel = computed(() => !this.boardSyncAvailable()
    ? "Board syncing requires Pro"
    : this.mirrorCreateMode() === "inbound"
      ? this.mirrorCreateBlocked() ? "Only target administrators can add another source" : "Mirror another board into this board…"
      : "Mirror this board…");
  readonly boardLinkingEnabled = this.state.boardLinkingEnabled;
  readonly manageMirrorsLabel = computed(() => {
    const count = this.mirrorCount();
    if (count === 0) return "No board mirrors yet";
    return `Manage ${count} board mirror${count === 1 ? "" : "s"}`;
  });
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
    showInactiveOnly: this.showInactiveOnly(),
    showPrioritySetOnly: this.showPrioritySetOnly(),
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
  /**
   * Whether the avatar stack renders at all. An admin always gets the trigger (it is how members are
   * added); everyone else only when there is somebody to show. Folded into one computed because the
   * header slot must be a single projectable root — see the NG8011 note in the template.
   */
  readonly headerMembersVisible = computed(
    () => this.state.board() !== null && (this.sortedBoardMembers().length > 0 || this.state.viewerIsWorkspaceAdmin()),
  );
  readonly headerMembers = computed(() => this.sortedBoardMembers().slice(0, 5));
  readonly headerMemberOverflow = computed(() => Math.max(0, this.sortedBoardMembers().length - this.headerMembers().length));
  readonly assignableMembers = computed(() => this.sortedBoardMembers());
  readonly membersButtonLabel = computed(() => {
    const count = this.sortedBoardMembers().length;
    return count === 1 ? "1 board member" : `${count} board members`;
  });

  readonly filteredCardIds = computed<Set<string> | null>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const keyMatch = /^([a-z][a-z0-9]{1,9})-([1-9][0-9]*)$/.exec(q);
    const historicalKeyNumber = keyMatch && this.state.workspaceCardKeyPrefixes().some((prefix) => prefix.toLowerCase() === keyMatch[1])
      ? Number(keyMatch[2])
      : null;
    const labelIds = this.filterLabelIds();
    const memberIds = this.filterMemberIds();
    const listIds = this.filterListIds();
    const conditions = this.filterCfConditions();
    const unreadOnly = this.effectiveView() !== "history" && this.showUnreadOnly();
    const overdueOnly = this.showOverdueOnly();
    const inactiveOnly = this.showInactiveOnly();
    const riskFilter = this.boardRiskFilter();
    // Like overdue, ignored while viewing archived: archived cards are never in the live queue,
    // so applying it there would blank the archive rather than filter it.
    const prioritySetOnly = this.showPrioritySetOnly();
    const showArchived = this.showArchived();
    if (!q && !labelIds.length && !memberIds.length && !listIds.length && !conditions.length && !unreadOnly && (!overdueOnly || showArchived) && (!inactiveOnly || showArchived) && (!prioritySetOnly || showArchived) && (!riskFilter || showArchived)) return null;
    const fieldsById = conditions.length ? this.state.customFieldsById() : null;
    const cfValuesByCard = conditions.length ? this.state.customFieldValuesByCardAndField() : null;
    const listSet = new Set(listIds);
    const labelFilterIds = new Set(labelIds);
    const memberFilterIds = new Set(memberIds);
    const priorityRanks = prioritySetOnly ? this.viewerPriorityRanks() : null;
    const labelIdsByCard = labelIds.length ? this.state.labelIdSetsByCard() : null;
    const assigneeIdsByCard = memberIds.length ? this.state.assigneeIdSetsByCard() : null;

    const matching = this.state.cards()
      .filter(c => showArchived ? !!c.archivedAt : !c.archivedAt)
      .filter(card => {
        if (q && !card.title.toLowerCase().includes(q) && !card.key.toLowerCase().includes(q) && card.number !== historicalKeyNumber) return false;
        if (listSet.size && !listSet.has(card.listId)) return false;
        if (unreadOnly && this.notifications.cardUnreadCount(card.id) === 0) return false;
        if (labelIdsByCard && !this.hasAny(labelIdsByCard.get(card.id), labelFilterIds)) return false;
        if (assigneeIdsByCard && !this.hasAny(assigneeIdsByCard.get(card.id), memberFilterIds)) return false;
        if (!showArchived && overdueOnly && (card.completedAt || !isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone))) return false;
        // Inactivity is a live-work signal, matching the health indicator: completed cards do not
        // become actionable again merely because their final update is more than 14 days old.
        if (!showArchived && inactiveOnly && (card.completedAt || !isCardInactive(card.updatedAt, Date.now(), this.state.inactiveCardsDays()))) return false;
        if (!showArchived && riskFilter) {
          if (card.completedAt) return false;
          if (riskFilter === "overdue" && !isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone)) return false;
          if (riskFilter === "unassigned" && (this.state.assigneesByCard().get(card.id)?.length ?? 0) > 0) return false;
          if (riskFilter === "inactive" && !isCardInactive(card.updatedAt, Date.now(), this.state.inactiveCardsDays())) return false;
        }
        // The queue drops completed cards (they take no rank), so this also hides the board's
        // recently-completed tiles — a done card no longer has a priority set, by definition.
        if (!showArchived && priorityRanks && !priorityRanks.has(card.id)) return false;
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
    const result = new Map<string, BoardLaneItem[]>();
    for (const [listId, cards] of this.cardsByList()) {
      result.set(listId, this.state.itemsForList(listId, cards));
    }
    return result;
  });

  readonly activeCards = computed(() =>
    this.state.cards().filter((card) => this.showArchived() ? !!card.archivedAt : !card.archivedAt),
  );

  readonly overviewOpen = signal(false);
  private readonly workRiskClock = signal(Date.now());
  readonly overviewPlacement: AnchoredPanelPlacement = { align: "end", gap: 6, width: 340, maxHeight: 520 };
  readonly boardOverview = computed(() => {
    const now = this.workRiskClock();
    const cards = this.state.cards().filter((card) => !card.archivedAt);
    const incomplete = cards.filter((card) => !card.completedAt);
    const overdue = incomplete.filter((card) => isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, new Date(now))).length;
    const nextWeek = localDateKey(7);
    const dueSoon = incomplete.filter((card) => {
      const due = card.dueDateLocalDate;
      return !!due && due >= localDateKey(0) && due <= nextWeek;
    }).length;
    const unassigned = incomplete.filter((card) => (this.state.assigneesByCard().get(card.id)?.length ?? 0) === 0).length;
    const inactive = incomplete.filter((card) => isCardInactive(card.updatedAt, now, this.state.inactiveCardsDays())).length;
    // Workspace admins choose which observable signals participate in health; the raw counts stay
    // visible for drill-down even when one signal is excluded from the status calculation.
    const risk = boardWorkRisk(
      { active: incomplete.length, overdue, unassigned, inactive },
      {
        overdue: this.state.boardHealthOverdueEnabled(),
        unassigned: this.state.boardHealthUnassignedEnabled(),
        inactive: this.state.boardHealthInactiveEnabled(),
      },
    );
    const listCounts = this.state.visibleLists().map((list) => ({
      id: list.id,
      name: list.name,
      icon: list.icon || "list",
      count: cards.filter((card) => card.listId === list.id).length,
    })).filter((entry) => entry.count > 0);
    return {
      total: cards.length,
      active: incomplete.length,
      overdue,
      dueSoon,
      unassigned,
      inactive,
      risk,
      listCounts,
    };
  });
  readonly inactiveCardsTooltip = computed(() => `Show cards inactive for ${this.state.inactiveCardsDays()} days`);

  toggleOverview(): void {
    this.overviewOpen.update((open) => !open);
  }

  setBoardRiskFilter(filter: BoardRiskFilter | null): void {
    this.boardRiskFilter.set(this.boardRiskFilter() === filter ? null : filter);
  }

  openPortfolio(): void {
    this.overviewOpen.set(false);
    void this.router.navigate(["/portfolio"]);
  }

  // ─── Kanban grouping ────────────────────────────────────────────────────────
  //
  // The kanban's columns are the workspace's lists by default. Pick any other dimension and the
  // columns become that dimension's values, with a drop writing the value onto the card instead of
  // moving it between lists — grouping by assignee is what turns a drag into a reassignment,
  // grouping by a select field turns it into a status change.
  //
  // `k-list` and `k-board-group-column` never coexist: list grouping keeps the real list column,
  // with its separators, bulk menu, inline composer and real `lists.id` to POST against, none of
  // which a value bucket like "Alex" or "High" has an equivalent for.
  readonly kanbanGroupBy = signal<GroupBy>("list");

  /**
   * Dimensions offered on the board kanban. Cross-board dimensions are meaningless on one board and
   * "no grouping" would just be one very tall column, so neither is offered; URL fields are excluded
   * because their values are effectively unique per card, which is a column per card.
   */
  readonly kanbanGroupByOptions = computed<{ value: GroupBy; label: string; icon: string }[]>(() => [
    ...GROUP_BY_OPTIONS.filter((option) => option.value !== "none"),
    ...this.filterableCustomFields()
      .filter((field) => field.type !== "url")
      .map((field) => ({ value: `cf:${field.id}` as GroupBy, label: field.name, icon: field.icon || "forms" })),
  ]);

  /**
   * The selected dimension, falling back to lists when it no longer exists — a custom field can be
   * archived while a stored preference still names it, and the alternative is a board that silently
   * renders one undifferentiated column.
   */
  readonly effectiveKanbanGroupBy = computed<GroupBy>(() => {
    const selected = this.kanbanGroupBy();
    return this.kanbanGroupByOptions().some((option) => option.value === selected) ? selected : "list";
  });

  readonly kanbanGroupByLabel = computed(() =>
    this.kanbanGroupByOptions().find((option) => option.value === this.effectiveKanbanGroupBy())?.label ?? "List"
  );

  readonly kanbanGroupByIcon = computed(() =>
    this.kanbanGroupByOptions().find((option) => option.value === this.effectiveKanbanGroupBy())?.icon ?? "layout-list"
  );

  readonly kanbanGrouped = computed(() => this.effectiveKanbanGroupBy() !== "list");

  /**
   * Whether to offer the toolbar's inline reset. Grouped *and* interactive: the stored preference is
   * restored before the board loads, and an × that cannot be clicked yet is just a wider button.
   */
  readonly kanbanGroupingResettable = computed(() => this.kanbanGrouped() && this.state.board() !== null);

  /**
   * Whether a drop into a column of this grouping can write a value.
   *
   * Due-date columns are buckets over ranges — there is no single date "This week" or "Overdue"
   * could mean — so they render as a read-only lens rather than guessing a date on the user's
   * behalf. Every other offered dimension maps a column to exactly one value.
   */
  readonly kanbanGroupingWritable = computed(() => {
    const mode = this.effectiveKanbanGroupBy();
    return mode !== "dueDate";
  });

  readonly kanbanGroups = computed<CardGroup[]>(() => {
    const mode = this.effectiveKanbanGroupBy();
    if (mode === "list") return [];
    const filtered = this.filteredCardIds();
    const cards = filtered ? this.activeCards().filter((card) => filtered.has(card.id)) : this.activeCards();
    return groupCards(cards, mode, "position", {
      lists: this.state.visibleLists(),
      labels: this.sortedLabels(),
      members: this.sortedFilterMembers(),
      customFields: this.state.customFields(),
      labelsByCard: this.state.labelsByCard(),
      assigneesByCard: this.state.assigneesByCard(),
      customFieldValuesByCardAndField: this.state.customFieldValuesByCardAndField(),
      currentUserId: this.currentUserId(),
      // A kanban column with no cards is the drop target for "give this card that value", so every
      // enumerable bucket has to render even when empty.
      includeEmptyGroups: true,
    });
  });

  readonly groupByMenuOpen = signal(false);
  readonly groupByMenuPlacement: AnchoredPanelPlacement = { align: "end", gap: 4, width: "measure", maxHeight: 320 };

  toggleGroupByMenu() {
    this.groupByMenuOpen.update((open) => !open);
  }

  setKanbanGroupBy(mode: GroupBy) {
    this.groupByMenuOpen.set(false);
    if (this.kanbanGroupBy() === mode) return;
    // Switching axis unmounts every column; a selection made against the old columns no longer
    // describes anything on screen.
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    this.kanbanGroupBy.set(mode);
    writeGroupBy(this.kanbanScopeKey(), mode);
  }

  /**
   * Distinct from the table's `board:<id>` scope on purpose: the two views answer different
   * questions and a user who groups a report by client should not find their board re-columned.
   */
  private kanbanScopeKey(): string {
    return `board:${this.boardId()}:kanban`;
  }
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
    this.showInactiveOnly() ||
    this.boardRiskFilter() !== null ||
    this.showPrioritySetOnly() ||
    this.showArchived() ||
    this.showCompleted()
  );
  readonly toolbarFilterActive = computed(() => {
    if (this.effectiveView() === "history") {
      return Boolean(this.searchQuery().trim()) || this.filterLabelIds().length > 0 || this.filterMemberIds().length > 0 || this.filterListIds().length > 0 || this.filterCfConditions().length > 0 || this.workDoneEventType() !== null;
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
  private listGrowthIdle: number | null = null;
  private listGrowthFrame: number | null = null;
  private listTitleResizeObserver: ResizeObserver | null = null;
  private listTitleMutationObserver: MutationObserver | null = null;
  private listTitleHeightFrame: number | null = null;
  private cardDragActive = false;
  private largeBoardClassApplied = false;

  /**
   * `k-board` owns the drag itself (snap release, edge auto-scroll, drop-target re-centring). Board
   * only has to pause the two things it layers on top and that are too expensive to run mid-drag:
   * staging further list columns, and re-measuring every list title.
   */
  onCardDragStateChanged(active: boolean) {
    this.cardDragActive = active;
    const el = this.listsEl()?.nativeElement;
    if (active) {
      // Do not mount every remaining list during CDK's latency-critical drag-start turn.
      // CDK has already snapshotted its receiving siblings at this point, so those newly
      // mounted targets cannot receive the current drag and only delay the first preview frame.
      this.cancelScheduledListGrowth();
      if (this.listTitleHeightFrame !== null) {
        window.cancelAnimationFrame(this.listTitleHeightFrame);
        this.listTitleHeightFrame = null;
      }
    } else if (el) {
      this.scheduleListTitleHeightSync(el);
    }
  }

  /** Edge auto-scroll reached the right of the canvas: stage the next list column before it lands. */
  onEdgeScrolledRight() {
    const el = this.listsEl()?.nativeElement;
    if (el) this.scheduleListGrowthNearRightEdge(el, true);
  }

  ngOnDestroy() {
    document.removeEventListener("click", this.handleDocumentClick);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    window.removeEventListener("kanera:new-card", this.handlePaletteNewCard);
    this.clearSearchDebounce();
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

  constructor() {
    document.addEventListener("click", this.handleDocumentClick);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    window.addEventListener("kanera:new-card", this.handlePaletteNewCard);
    effect((onCleanup) => {
      if (!this.overviewOpen()) return;
      // A computed cannot observe time passing. Refresh while the panel is open so due/inactivity
      // boundaries change the assessment without requiring an unrelated card mutation.
      this.workRiskClock.set(Date.now());
      const timer = window.setInterval(() => this.workRiskClock.set(Date.now()), 60_000);
      onCleanup(() => window.clearInterval(timer));
    });
    effect((onCleanup) => {
      // Re-measure list titles whenever the kanban scroller mounts.
      const el = this.listsEl()?.nativeElement;
      if (!el) return;
      this.startListTitleHeightSync(el);
      onCleanup(() => this.stopListTitleHeightSync());
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
      const boardId = this.boardId();
      const linkingEnabled = this.state.boardLinkingEnabled();
      // Route input binding can publish the next id one effect cycle before the board lifecycle
      // clears the previous hydration. Never apply the previous board's mirror hint to the new id.
      const hydratedBoardId = this.state.board()?.id;
      // Cached hydration is display-only until the live open succeeds. Waiting avoids issuing the
      // same status request once for IndexedDB and again for the authoritative server payload.
      const showingCachedBoard = this.offlineBoardCachedAt() !== null;
      if (hydratedBoardId !== boardId || showingCachedBoard || !linkingEnabled || !this.state.hasMirrorsAtHydration()) {
        this.mirrorCount.set(0);
        this.mirrorInboundCount.set(0);
        this.mirrorCanManage.set(false);
        return;
      }
      void this.refreshMirrorStatus(boardId);
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
      this.rememberedView.set(remembered === "table" || remembered === "notes" || remembered === "calendar" || remembered === "history" ? remembered : "board");
    });

    effect(() => {
      // Re-read per board: the grouping is a property of this board's kanban, not of the session.
      // A stored value naming an archived field is tolerated here and normalised by
      // `effectiveKanbanGroupBy`, so the preference survives a field being restored.
      const stored = readGroupBy(this.kanbanScopeKey());
      this.kanbanGroupBy.set(stored ?? "list");
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
        // --accent-soft resolves its var(--accent) where it is *declared*, so the :root
        // definition would stay the default teal here. Rebind it with the board colour so
        // engaged toolbar controls tint with the board rather than the app accent.
        style.setProperty("--accent-soft", `color-mix(in srgb, var(--color-${color}) 8%, transparent)`);
      } else {
        style.removeProperty("--accent");
        style.removeProperty("--accent-hover");
        style.removeProperty("--ring");
        style.removeProperty("--accent-soft");
      }
      this.workspaceService.setActiveAccentColor(color);
    });

    effect(() => {
      const snapshot = this.state.snapshot();
      if (!snapshot || this.offlineBoardCachedAt()) return;
      untracked(() => this.saveBoardSnapshot(snapshot));
    });

    // Filters, List/Table View columns, and export need every field's values, not just the
    // showOnCard ones inlined at board open, so load the full set the moment one is engaged.
    effect(() => {
      // Hidden (showOnCard=false) fields aren't inlined at board open, so load the full value set
      // whenever Table is active or a CF condition is active — otherwise a condition on a hidden
      // field would wrongly hide cards while its values are absent. Adding a condition in the
      // filter bar seeds it with an operand-less (inactive) operator, so this fires in time before it
      // can affect matching.
      // Grouping the kanban by a custom field needs the same full set: a hidden field's values are
      // absent at board open, so every card would otherwise pile into the "no value" column.
      const needed = this.effectiveView() === "table"
        || this.filterCfConditions().length > 0
        || this.kanbanGroupBy().startsWith("cf:");
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
      let pageViewCaptured = false;
      const completed = readCompletedFilter(`board:${boardId}`);
      // Search stays session-local; label/member/list/CF/unread/overdue/inactive filters are sticky per board
      // (restored here, persisted by the effect below), and the completed range keeps its own key.
      const saved = readFilters(`board:${boardId}`);
      this.setSearchQuery("");
      this.filterLabelIds.set(saved?.labelIds ?? []);
      this.filterMemberIds.set(saved?.memberIds ?? []);
      this.filterListIds.set(saved?.listIds ?? []);
      this.filterCfConditions.set(saved?.cfConditions ?? []);
      this.showUnreadOnly.set(saved?.showUnreadOnly ?? false);
      this.showOverdueOnly.set(saved?.showOverdueOnly ?? false);
      this.showInactiveOnly.set(saved?.showInactiveOnly ?? false);
      this.boardRiskFilter.set(null);
      this.showPrioritySetOnly.set(saved?.showPrioritySetOnly ?? false);
      this.showArchived.set(false);
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

      // The viewer's own queue, refetched under their own credentials — the invalidation event is a
      // bare ping (see `cardPriority:invalidated` in the shared events). Failure clears the pills
      // instead of leaving last session's order on screen.
      const refreshViewerQueue = () => {
        const viewerId = this.auth.user()?.id;
        if (!viewerId) return;
        void this.api.get<WorkPrioritiesResponse>(`/work/priorities/${viewerId}`)
          .then((queue) => {
            if (cancelled) return;
            this.viewerPriorityRanks.set(new Map(
              queue.items.flatMap((item) => item.card ? [[item.card.id, item.rank] as const] : []),
            ));
          })
          .catch(() => {
            if (!cancelled) this.viewerPriorityRanks.set(new Map());
          });
      };
      refreshViewerQueue();

      const applyBoard = (data: Awaited<ReturnType<typeof this.loadBoard>>) => {
        if (cancelled) return;
        this.state.hydrate(data);
        if (!pageViewCaptured && data.workspaceClientId) {
          // The authorised payload carries the board owner's org, not a cross-org guest's home org.
          this.analytics.pageCurrentRoute(data.workspaceClientId);
          pageViewCaptured = true;
        }
        this.offlineBoardCachedAt.set(null);
        hydrated = true;
        this.saveCurrentBoardSnapshot();
      };
      const applyCachedBoard = (snapshot: OfflineBoardSnapshot) => {
        if (cancelled) return;
        this.state.restoreSnapshot(snapshot);
        if (!pageViewCaptured && snapshot.workspaceClientId) {
          this.analytics.pageCurrentRoute(snapshot.workspaceClientId);
          pageViewCaptured = true;
        }
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
        if (cancelled) return;
        // Reconnect and foregrounding are convergence boundaries for the queue too: its
        // invalidation ping is not replayed for events missed while disconnected.
        refreshViewerQueue();
        if (!hydrated) return;
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
        onBoardMirrorsChanged: () => {
          // The event contains the full mirror for consumers that need it; this page intentionally
          // reloads the small status count and dialog collections to converge after any remote edit.
          this.mirrorRefreshVersion.update((version) => version + 1);
          void this.refreshMirrorStatus(boardId);
        },
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
      const onPriorityInvalidated: ServerToClientEvents[typeof SERVER_EVENTS.CARD_PRIORITY_INVALIDATED] = ({ targetUserId }) => {
        // Only the viewer's own queue draws pills here; a teammate's queue changing is not this
        // page's business (managers curate from Team Cards, where the focused person is explicit).
        if (targetUserId === this.auth.user()?.id) refreshViewerQueue();
      };
      socket.on(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, onPriorityInvalidated);
      socket.on(SERVER_EVENTS.CARD_DELETED, onCardDeleted);
      socket.on("board:deleted", onDeleted);
      socket.on("workspace:deleted", onWorkspaceDeleted);
      socket.on("workspace:member:updated", onWorkspaceMemberUpdated);
      socket.on("client:user:role-changed", onClientUserRoleChanged);
      socket.on("user:profile:updated", onUserProfileUpdated);
      socket.on("board:member:removed", onBoardMemberRemoved);
      // Resuming from sleep or backgrounding can leave the socket's automatic reconnect/rejoin
      // cycle stalled or racing the network coming back up, which would otherwise strand the
      // offline-cache fallback on screen indefinitely. Re-checking on visibility makes it self-heal.
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") refreshBoard();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      onCleanup(() => {
        cancelled = true;
        socket.off(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, onPriorityInvalidated);
        socket.off(SERVER_EVENTS.CARD_DELETED, onCardDeleted);
        socket.off("board:deleted", onDeleted);
        socket.off("workspace:deleted", onWorkspaceDeleted);
        socket.off("workspace:member:updated", onWorkspaceMemberUpdated);
        socket.off("client:user:role-changed", onClientUserRoleChanged);
        socket.off("user:profile:updated", onUserProfileUpdated);
        socket.off("board:member:removed", onBoardMemberRemoved);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        detach();
      });
    });

    // Persist the sticky filter set per board. Registered after the board-open effect so a board
    // switch restores the new board's filters before this writes them back under the new scope.
    effect(() => {
      const scope = `board:${this.boardId()}`;
      const filters: StoredFilters = {
        boardIds: [], // Board pages are already scoped to one board.
        labelIds: this.filterLabelIds(),
        memberIds: this.filterMemberIds(),
        listIds: this.filterListIds(),
        cfConditions: this.filterCfConditions(),
        showUnreadOnly: this.showUnreadOnly(),
        showOverdueOnly: this.showOverdueOnly(),
        showInactiveOnly: this.showInactiveOnly(),
        showPrioritySetOnly: this.showPrioritySetOnly(),
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
      workspaceClientId?: string | null;
      workspaceKind?: "standard" | "board";
      boardLinkingEnabled?: boolean;
      boardSyncAllowed?: boolean;
      hasMirrors?: boolean;
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
   * The board-open payload only inlines values for `showOnCard` fields. Filters, List/Table
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

  private readonly handleDocumentClick = (event: MouseEvent) => this.onDocumentClick(event);
  private readonly handleDocumentKeydown = (event: KeyboardEvent) => this.onDocumentKeydown(event);

  onDocumentClick(_event: MouseEvent) {
    if (this.skipNextDocumentClick) {
      this.skipNextDocumentClick = false;
      return;
    }
    // Every panel on this page dismisses itself through kAnchoredPanel / PanelStackService, and
    // card creation is a modal dialog that owns its own backdrop, so there is nothing left for a
    // page-level outside click to close.
  }

  onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.bulkSelectedCount() > 0 && !this.openCardId() && !this.bulkMenuOpen()) {
      event.preventDefault();
      this.clearBulkSelection();
      return;
    }
    if (event.key.toLowerCase() !== "f" || (!event.ctrlKey && !event.metaKey)) return;
    if (this.openCardId()) return;
    event.preventDefault();
    // The toolbar's search field is outside the collapsing body, so it is present to focus at every
    // width — which is why Ctrl/Cmd+F needs no "expand the toolbar first" step. It is absent only on
    // the Notes view, which has no query bar at all; the shortcut is then a no-op rather than
    // focusing something that filters nothing on screen.
    const input = this.el.nativeElement.querySelector<HTMLInputElement>('k-search-field .sf-input');
    input?.focus();
  }

  /**
   * Every "add card" affordance on this page — a list column's button, its menu entry, a grouped
   * column's `+`, the table's row composer — opens the same composer, seeded with wherever it was
   * pressed. One create surface means the properties available at creation never depend on which
   * button you happened to reach for. `atTop` still travels: the list menu's "Add card" inserts at
   * the top of the lane and the lane-footer button at the bottom, exactly as before.
   */
  onStartAdd(p: StartAddPayload) {
    this.listsEl()?.centerListForMobile(p.listId);
    this.skipNextDocumentClick = true;
    this.openComposer({ listId: p.listId, atTop: p.atTop });
  }

  // ─── Card composer ──────────────────────────────────────────────────────────

  readonly composerOpen = signal(false);
  readonly composerSeed = signal<CardComposerSeed | null>(null);
  private readonly handlePaletteNewCard = () => this.openComposer();

  /**
   * Opens the full composer. `seed` carries whatever the opening surface already decided — the
   * column's list, its assignee, its select option — so the user never re-picks what they just
   * pointed at. The composer merges it over any stored draft.
   */
  openComposer(seed: CardComposerSeed | null = null) {
    if (!this.state.canEdit()) return;
    this.composerSeed.set(seed);
    this.composerOpen.set(true);
  }

  onComposerCreated(card: AnyCard) {
    this.state.addCard(card);
  }

  closeComposer() {
    this.composerOpen.set(false);
    this.composerSeed.set(null);
  }

  /** The `+` on a grouped column: seed the column's own value plus the board's default list. */
  openComposerForGroup(groupKey: string) {
    const group = this.kanbanGroups().find((entry) => entry.key === groupKey);
    if (!group) return;
    this.openComposer({
      listId: this.state.visibleLists()[0]?.id,
      ...this.composerSeedForGroup(group),
    });
  }

  private composerSeedForGroup(group: CardGroup): CardComposerSeed {
    const mode = this.effectiveKanbanGroupBy();
    if (isNullGroup(group)) return {};
    if (mode.startsWith("cf:")) {
      const value = this.customFieldValueForGroup(group);
      return value ? { customFields: { [group.meta.fieldId!]: value } } : {};
    }
    switch (mode) {
      case "assignee":
        return group.meta.userId ? { assigneeIds: [group.meta.userId] } : {};
      case "label":
        return group.meta.labelId ? { labelIds: [group.meta.labelId] } : {};
      case "completion":
        return { completed: group.meta.completed === true };
      case "dueDate": {
        // Only the buckets that name a single day can seed a date; "This week" and "Overdue" are
        // ranges, and picking an arbitrary date inside one would be inventing an answer.
        const bucket = group.meta.bucket;
        if (bucket === "today") return { dueDateLocalDate: localDateKey(0) };
        if (bucket === "tomorrow") return { dueDateLocalDate: localDateKey(1) };
        return {};
      }
      default:
        return {};
    }
  }

  // ─── Grouped kanban drops ───────────────────────────────────────────────────

  /**
   * A drop between grouped columns writes the grouping value onto the card. Each branch goes through
   * the ordinary per-property endpoint, so the activity entry and realtime event are the same ones a
   * card-detail edit produces — a reassignment made by dragging is indistinguishable in the audit
   * trail from one made in the panel, which is what makes the gesture safe to offer.
   */
  async onGroupCardDrop(payload: GroupCardDropPayload) {
    if (!this.state.canEdit()) return;
    const groups = this.kanbanGroups();
    const target = groups.find((group) => group.key === payload.toGroupKey);
    if (!target) return;
    const source = payload.fromGroupKey ? groups.find((group) => group.key === payload.fromGroupKey) ?? null : null;
    const mode = this.effectiveKanbanGroupBy();
    const cardId = payload.cardId;

    try {
      if (mode.startsWith("cf:")) {
        await this.writeGroupCustomField(cardId, target, source);
        return;
      }
      switch (mode) {
        case "assignee":
          await this.writeGroupMembership(
            cardId,
            "assignees",
            this.state.assigneeIdSetsByCard().get(cardId),
            source?.meta.userId,
            target.meta.userId,
            isNullGroup(target),
          );
          return;
        case "label":
          await this.writeGroupMembership(
            cardId,
            "labels",
            this.state.labelIdSetsByCard().get(cardId),
            source?.meta.labelId,
            target.meta.labelId,
            isNullGroup(target),
          );
          return;
        case "completion": {
          const card = await this.api.patch<WireCard>(`/cards/${cardId}/completion`, {
            completed: target.meta.completed === true,
          });
          this.state.updateCard(card);
          return;
        }
        default:
          return;
      }
    } catch {
      // Every branch either settles from the server's response or rolls its optimistic write back,
      // so there is nothing left to repair here; the board simply keeps the card where it was.
    }
  }

  /**
   * Assignees and labels are both multi-valued, so a drag *moves* the card between columns rather
   * than replacing the whole set: the source column's value comes off, the target's goes on, and any
   * other value the card carries is left alone. Dropping into the empty bucket clears the set
   * outright — anything less and the card would bounce straight back out of the column the user just
   * dropped it into, which reads as the gesture having failed.
   */
  private async writeGroupMembership(
    cardId: string,
    kind: "assignees" | "labels",
    currentIds: Set<string> | undefined,
    sourceId: string | undefined,
    targetId: string | undefined,
    targetIsEmptyBucket: boolean,
  ) {
    const previous = [...(currentIds ?? [])];
    let next: string[];
    if (targetIsEmptyBucket) next = [];
    else {
      const ids = new Set(previous);
      if (sourceId) ids.delete(sourceId);
      if (targetId) ids.add(targetId);
      next = [...ids];
    }
    if (sameIdSet(previous, next)) return;

    const apply = kind === "assignees"
      ? (ids: string[]) => this.state.setCardAssignees(cardId, ids)
      : (ids: string[]) => this.state.setCardLabels(cardId, ids);
    apply(next);
    try {
      await this.api.put(
        `/cards/${cardId}/${kind}`,
        kind === "assignees" ? { userIds: next } : { labelIds: next },
      );
    } catch (error) {
      apply(previous);
      throw error;
    }
  }

  /**
   * Custom-field columns settle from the server's response rather than guessing optimistically: the
   * value row is what decides which column the card belongs in, and a locally-invented one that the
   * server then rejects would leave the card in a column it never actually entered.
   */
  private async writeGroupCustomField(cardId: string, target: CardGroup, source: CardGroup | null) {
    const fieldId = target.meta.fieldId;
    if (!fieldId) return;
    const field = this.state.customFields().find((entry) => entry.id === fieldId);
    if (!field) return;

    // A multi-value select/user field puts one card in several columns at once, so the drag has to
    // move it between them the way labels do rather than collapsing the card down to the one value
    // it was dropped on.
    const multi = "allowMultiple" in field && field.allowMultiple && (field.type === "select" || field.type === "user");
    const key = field.type === "select" ? "valueOptionIds" as const : "valueUserIds" as const;
    const value = multi
      ? this.mergedMultiValue(cardId, fieldId, key, target, source)
      : this.customFieldValueForGroup(target);

    if (!value) {
      await this.api.delete(`/cards/${cardId}/custom-fields/${fieldId}`);
      this.state.clearCustomFieldValue(cardId, fieldId);
      return;
    }
    const saved = await this.api.put<CardCustomFieldValue>(`/cards/${cardId}/custom-fields/${fieldId}`, value);
    this.state.upsertCustomFieldValue(saved);
  }

  private mergedMultiValue(
    cardId: string,
    fieldId: string,
    key: "valueOptionIds" | "valueUserIds",
    target: CardGroup,
    source: CardGroup | null,
  ): Record<string, unknown> | null {
    if (isNullGroup(target)) return null;
    const current = this.state.customFieldValuesByCardAndField().get(cardId)?.get(fieldId)?.[key] ?? [];
    const ids = new Set(current);
    const sourceKey = source?.meta.fieldValueKey;
    if (sourceKey && sourceKey !== NULL_GROUP_KEY) ids.delete(sourceKey);
    if (target.meta.fieldValueKey) ids.add(target.meta.fieldValueKey);
    return ids.size ? { [key]: [...ids] } : null;
  }

  /**
   * The write payload a custom-field column represents, or null for its "no value" bucket. The
   * column key already encodes the value (`cf:<fieldId>:<valueKey>`); this turns that back into the
   * one value column the field's type uses.
   */
  private customFieldValueForGroup(group: CardGroup): Record<string, unknown> | null {
    const fieldId = group.meta.fieldId;
    const valueKey = group.meta.fieldValueKey;
    if (!fieldId || !valueKey || valueKey === NULL_GROUP_KEY) return null;
    const field = this.state.customFields().find((entry) => entry.id === fieldId);
    if (!field) return null;
    switch (field.type) {
      case "select":
        return { valueOptionIds: [valueKey] };
      case "user":
        return { valueUserIds: [valueKey] };
      case "checkbox":
        return { valueCheckbox: valueKey === "true" };
      case "number": {
        const parsed = Number(valueKey);
        return Number.isFinite(parsed) ? { valueNumber: parsed } : null;
      }
      case "date":
        return { valueDate: valueKey };
      default:
        return { valueText: valueKey };
    }
  }

  // Every header popover is a kAnchoredPanel layer, so PanelStackService owns all dismissal. Two
  // deliberate omissions here:
  //
  // 1. No `stopPropagation()`. A click anywhere — including on a sibling trigger — has to reach the
  //    stack's document listener so it can dismiss whatever is open. Swallowing it left the previous
  //    panel open whenever the new trigger did not go on to open a panel of its own (an export
  //    already downloading, a members button with no members). Opening still works because
  //    `AnchoredPanelDirective` registers in `ngAfterViewInit`, by which point this click has
  //    finished propagating; and re-clicking a trigger still toggles, because this handler runs at the
  //    target before the event reaches document.
  // 2. No hand-written "close the others". That matrix was always missing a pair — mirror never
  //    closed the filter panel, background never closed the watcher list — which is exactly the bug
  //    class the stack exists to remove.
  //
  // Nothing here closes the collapsed toolbar body either: since k-page-toolbar registers it as a
  // stack layer, opening any of these popovers supersedes it automatically.
  toggleBackground() {
    if (this.state.board() === null) return;
    this.showBackground.update((v) => !v);
  }

  toggleMembersPopover() {
    if (this.state.board() === null || this.sortedBoardMembers().length === 0) return;
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

  toggleExportMenu() {
    if (!this.state.canEditRole() || this.state.board() === null || this.exportLoading()) return;
    this.exportMenuOpen.update((value) => !value);
  }

  toggleMirrorMenu() {
    if (!this.state.canEditRole()) return;
    this.mirrorMenuOpen.update((open) => !open);
  }

  openMirrorCreate() {
    if (this.mirrorCreateBlocked()) return;
    this.mirrorMenuOpen.set(false);
    this.mirrorCreateOpen.set(true);
  }

  onMirrorCreated() {
    // The realtime event may arrive before the POST response. Reload instead of incrementing so
    // those two completion paths cannot double-count the newly created relationship.
    void this.refreshMirrorStatus(this.boardId());
  }

  private async refreshMirrorStatus(boardId: string) {
    if (!this.state.canEditRole() || !this.state.boardLinkingEnabled()) {
      this.mirrorCount.set(0);
      this.mirrorInboundCount.set(0);
      this.mirrorCanManage.set(false);
      return;
    }
    try {
      // Mirror details are comparatively heavy and admin-only; the header only needs the exact
      // participation count so editors can see whether this board is linked.
      const { count, inboundCount, canManage } = await this.boardMirrors.status(boardId);
      if (this.boardId() === boardId) {
        this.mirrorCount.set(Number.isFinite(count) ? count : 0);
        this.mirrorInboundCount.set(Number.isFinite(inboundCount) ? inboundCount : 0);
        this.mirrorCanManage.set(canManage === true);
      }
    } catch {
      if (this.boardId() === boardId) {
        this.mirrorCount.set(0);
        this.mirrorInboundCount.set(0);
        this.mirrorCanManage.set(false);
      }
    }
  }

  openMirrorsDialog() {
    this.mirrorMenuOpen.set(false);
    this.mirrorsDialogOpen.set(true);
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

  toggleBoardWatcherPopover() {
    this.watcherPopoverOpen.update((open) => !open);
  }

  openCompletedHistory() {
    if (this.state.board() === null) return;
    this.completedPanelOpen.set(true);
    // A drawer, not a kAnchoredPanel layer, so it has to close the open popovers itself.
    this.panelStack.closeAll();
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
    // Live-work quick filters are meaningless over the archive, so entering it clears them instead
    // of showing an empty board.
    if (next) {
      this.showOverdueOnly.set(false);
      this.showInactiveOnly.set(false);
      this.showPrioritySetOnly.set(false);
    }
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

  /** Fan the shared filter bar's single value object back out to the individual sticky signals. */
  onFilterValueChange(v: FilterValue) {
    if (this.state.board() === null) return;
    this.filterLabelIds.set(v.labelIds);
    this.filterMemberIds.set(v.memberIds);
    this.filterListIds.set(v.listIds);
    this.filterCfConditions.set(v.cfConditions);
    this.showUnreadOnly.set(v.showUnreadOnly);
    this.showOverdueOnly.set(v.showOverdueOnly);
    this.showInactiveOnly.set(v.showInactiveOnly);
    this.showPrioritySetOnly.set(v.showPrioritySetOnly);
  }

  onFilterOpened() {
    if (this.state.board() === null) return;
    this.ensureCustomFieldValuesLoaded();
  }

  /** The filter bar emits the desired archived state; `toggleArchivedCards` flips + reloads. */
  onArchivedChange(next: boolean) {
    if (next !== this.showArchived()) void this.toggleArchivedCards();
  }

  /**
   * "Clear all" from the filter panel. Scoped to what that panel actually offers: search is its own
   * toolbar control with its own clear, and it is not counted by the panel's badge, so resetting it
   * from in here silently emptied a box the panel never claimed to own.
   */
  async clearFilters() {
    if (this.state.board() === null) return;
    const needsActiveCardsReload = this.showArchived() || this.showCompleted();
    const seq = ++this.filterLoadSeq;
    this.filterLabelIds.set([]);
    this.filterMemberIds.set([]);
    this.filterListIds.set([]);
    this.filterCfConditions.set([]);
    this.workDoneEventType.set(null);
    this.showUnreadOnly.set(false);
    this.showOverdueOnly.set(false);
    this.showInactiveOnly.set(false);
    this.boardRiskFilter.set(null);
    this.showPrioritySetOnly.set(false);
    this.showArchived.set(false);
    this.completedFrom.set("");
    this.completedTo.set("");
    writeCompletedFilter(`board:${this.boardId()}`, null);
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
    // Only a click that both started and ended on the canvas itself: a text selection released over
    // the board would otherwise clear a selection the user is still working with.
    if (e.target === e.currentTarget) this.clearBulkSelection();
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
    const next = payload.mode === "replace" ? new Set<string>() : new Set(this.bulkSelectedCardIds());
    for (const cardId of payload.orderedCardIds) {
      if (payload.mode === "remove") next.delete(cardId);
      else next.add(cardId);
    }
    this.bulkSelectedCardIds.set(next);
    this.lastBulkSelectedCardId.set(payload.mode === "remove" ? null : payload.orderedCardIds.at(-1) ?? null);
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
    // The card opens as a drawer over the board, not as a stack layer, and the card click that gets
    // here is stopped at the card (it has to be, or the board canvas reads it as a background click).
    // So close the open popovers here instead of leaving one stranded behind the drawer. Every entry
    // point into card detail — kanban, list, calendar, search — funnels through this method.
    this.panelStack.closeAll();
    const card = this.state.cardById(cardId);
    void this.router.navigate(["/b", this.boardId(), "c", cardId], {
      // A legacy query-form card link can still open the drawer, but every subsequent navigation
      // normalizes it to the path route so Kanera never generates another query-form card URL.
      queryParams: { cardId: null, lightboxAttachmentId: null },
      queryParamsHandling: "merge",
      ...(card ? { browserUrl: cardPath(card.organisationKey, card.key) } : {}),
    });
  }

  setView(mode: ViewMode) {
    if (this.state.board() === null) return;
    if (this.effectiveView() === mode) {
      // noteId belongs to the Notes view. Clear a stale selection even when the user clicks the
      // already-active non-notes view, which also repairs URLs produced by older clients.
      if (mode !== "notes" && this.noteId()) {
        void this.router.navigate(["/b", this.boardId()], {
          queryParams: { noteId: null },
          queryParamsHandling: "merge",
        });
      }
      return;
    }
    if (!this.unsavedWork.confirmNavigation()) return;
    if (this.bulkSelectedCount() > 0) this.clearBulkSelection();
    this.membersPopoverOpen.set(false);
    writeViewMode(`board:${this.boardId()}`, mode);
    this.rememberedView.set(mode);
    void this.router.navigate(["/b", this.boardId()], {
      // A note selection is meaningful only while Notes is active and must not leak into the
      // board, table, calendar, or dashboard URL when switching views.
      queryParams: { view: mode === "board" ? null : mode, noteId: null },
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
