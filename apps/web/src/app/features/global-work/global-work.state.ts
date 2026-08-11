import { DestroyRef, Injectable, computed, effect, inject, signal } from "@angular/core";
import type {
  PortfolioSummary,
  SavedWorkView,
  WorkCatalog,
  WorkDisplayMode,
  WorkFilters,
  WorkGroupBy,
  WorkCustomFieldCondition,
  WorkPrioritiesResponse,
  WorkPriorityQueuesResponse,
  WorkQueryResponse,
  WorkSort,
  WorkTablePresentation,
  WorkViewDefinition,
  WorkViewShareCandidate,
} from "@kanera/shared/dto";
import type { WorkViewLens, WorkViewVisibility } from "@kanera/shared/schema";
import { SERVER_EVENTS, expandCardSummary, type WireCardSummary, type WireGlobalWorkSeparator } from "@kanera/shared/events";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";
import { CardDragCoordinator } from "../board/card-drag-coordinator.service";
import {
  DEFAULT_COMPLETION,
  readGlobalWorkPreference,
  sanitizeGlobalWorkDefinition,
  writeGlobalWorkPreference,
} from "./global-work-preference";

const EMPTY_CATALOG: WorkCatalog = {
  organisations: [],
  workspaces: [],
  boards: [],
  lists: [],
  labels: [],
  customFields: [],
  people: [],
};

const EMPTY_RESPONSE: WorkQueryResponse = {
  cards: [],
  separators: [],
  separatorWorkspaceIds: [],
  checklistItems: [],
  totals: {
    cards: 0,
    overdue: 0,
    dueSoon: 0,
    completed: 0,
    checklistItems: 0,
    overdueChecklistItems: 0,
  },
  nextCursor: null,
};

function defaultTablePresentation(): WorkTablePresentation {
  return {
    columnVisibility: {},
    columnOrder: [],
    columnWidths: {},
    aggregates: {},
    aggregateSplitBy: "none",
    collapsedGroupKeys: [],
  };
}

function defaultDefinition(lens: WorkViewLens): WorkViewDefinition {
  return {
    scope: { allAccessible: true, organisationIds: [], workspaceIds: [], boardIds: [] },
    filters: {
      q: "",
      assigneeIds: [],
      listIds: [],
      labelIds: [],
      customFieldConditions: [],
      completion: DEFAULT_COMPLETION,
      unassignedOnly: false,
      dueFrom: null,
      dueTo: null,
      overdueOnly: false,
      overdueChecklistOnly: false,
      unreadOnly: false,
      prioritySetOnly: false,
      archived: false,
      completedFrom: null,
      completedTo: null,
      lastActivityBefore: null,
      lastMovedBefore: null,
    },
    groupBy: lens === "portfolio" ? "board" : "dueDate",
    sort: "dueAsc",
    display: lens === "portfolio" ? "summary" : "board",
    columns: ["source", "list", "assignees", "dueDate", "completion"],
    table: defaultTablePresentation(),
    portfolioDays: 30,
    collapsedOrganisationIds: [],
    collapsedWorkspaceIds: [],
    collapsedSectionIds: [],
  };
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

/** The card fields the query projection keeps in sync, whether from a realtime echo or a local edit. */
export interface VisibleCardPatch {
  id: string;
  listId: string;
  boardId: string;
  title: string;
  position: string;
  dueDateLocalDate?: string | null;
  dueDateSlot?: WireCardSummary["dueDateSlot"];
  dueDateTimezone?: string | null;
  completedAt?: string | Date | null;
  archivedAt?: string | Date | null;
  updatedAt: string | Date;
}

@Injectable()
export class GlobalWorkState {
  private readonly api = inject(ApiClient);
  readonly auth = inject(AuthService);
  readonly sockets = inject(SocketService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly cardDrag = inject(CardDragCoordinator);
  /** The viewer's own queue lives app-wide; this page reads and mutates it through the service. */
  private readonly myPriorities = inject(MyPrioritiesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly lens = signal<WorkViewLens>("my");
  readonly definition = signal<WorkViewDefinition>(defaultDefinition("my"));
  readonly catalog = signal<WorkCatalog>(EMPTY_CATALOG);
  readonly response = signal<WorkQueryResponse>(EMPTY_RESPONSE);
  readonly portfolio = signal<PortfolioSummary | null>(null);
  readonly savedViews = signal<SavedWorkView[]>([]);
  readonly shareCandidates = signal<WorkViewShareCandidate[]>([]);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly cachedAt = signal<string | null>(null);
  readonly lastSyncedAt = signal<string | null>(null);
  readonly reconciling = signal(false);
  readonly recoveringConnection = signal(false);
  /**
   * Background reconciliation refreshes an already-usable projection. It is not an offline state
   * and must not disable the page after ordinary realtime events such as the viewer's own drag.
   */
  readonly interactionReady = computed(() =>
    this.sockets.displayedOnline() && !this.loading() && !this.cachedAt()
  );
  /**
   * Group and Sort away from the lens default.
   *
   * Exposed rather than derived in the page because the default itself is lens-dependent (portfolio
   * groups by board, everything else by due date) and `defaultDefinition` is private to this file.
   * The toolbar triggers accent on these, so the reader can tell "grouped by Assignee" from "showing
   * the default grouping" without opening the menu.
   */
  readonly groupByIsSet = computed(() => this.definition().groupBy !== defaultDefinition(this.lens()).groupBy);
  readonly sortIsSet = computed(() => this.definition().sort !== defaultDefinition(this.lens()).sort);
  /** The portfolio's reporting window is a query control like Group and Sort, so it accents too. */
  readonly portfolioDaysIsSet = computed(
    () => this.definition().portfolioDays !== defaultDefinition(this.lens()).portfolioDays,
  );
  readonly reconciliationVersion = signal(0);
  readonly selectedViewId = signal<string | null>(null);
  readonly drilldownLabel = signal<string | null>(null);
  readonly collapsedTableGroupKeys = signal<string[]>([]);
  readonly collapsedHistoryDayKeys = signal<string[]>([]);
  readonly collapsedChecklistGroupIds = signal<string[]>([]);

  readonly cards = computed(() => this.response().cards.map((card) => ({
    ...expandCardSummary(card),
    workspaceId: card.workspaceId,
  })));
  readonly separators = computed(() => this.response().separators);
  readonly separatorWorkspaceIds = computed(() => new Set(this.response().separatorWorkspaceIds));
  /**
   * The one person this view is about: yourself on My Cards, or the single teammate in focus on Team
   * Cards. Personal separators and priority queues both key off it — they are the two surfaces that
   * only mean anything when exactly one person is in focus, and neither exists for a whole team or
   * the portfolio.
   */
  readonly focusedTargetUserId = computed(() => {
    if (this.lens() === "my") return this.auth.user()?.id ?? null;
    if (this.lens() !== "team") return null;
    const assigneeIds = this.definition().filters.assigneeIds;
    return assigneeIds.length === 1 ? assigneeIds[0] ?? null : null;
  });
  /**
   * Somebody else's queue — a teammate focused on Team Cards. The viewer's own is not stored here
   * at all (see `priorities`), so there is exactly one copy of it in the app.
   */
  private readonly otherPriorities = signal<WorkPrioritiesResponse | null>(null);
  /**
   * The focused person's queue.
   *
   * For the viewer themselves this is the shell-wide `MyPrioritiesService` signal, not a second
   * fetch: the drawer, Home's block and this page's dock are then the same queue by construction,
   * and a reorder in any of them is instantly correct in the others. Only a *teammate's* queue is
   * loaded and mutated here, where the redaction-aware, credentials-scoped copy belongs.
   */
  readonly priorities = computed<WorkPrioritiesResponse | null>(() =>
    this.focusedTargetUserId() === this.auth.user()?.id
      ? this.myPriorities.queue()
      : this.otherPriorities(),
  );
  /**
   * Every queue this viewer may read — the Team Cards lanes display, one lane per teammate.
   *
   * Loaded whenever the team lens is active rather than when the lanes display is selected,
   * because `setDisplay` deliberately does not re-query; the batch is one request. Deliberately
   * absent from the offline cache: like the docked panel, a stale sequence reads as an
   * instruction, so the lanes display is withheld on a cached snapshot instead of showing last
   * week's order.
   */
  readonly teamPriorities = signal<WorkPriorityQueuesResponse | null>(null);
  /**
   * Team Cards deliberately excludes the viewer's own assignments. Priority view still includes a
   * self lane, so its add picker gets a separate My Cards projection instead of weakening Team
   * Cards' normal meaning.
   */
  private readonly teamPrioritySelfCards = signal<WorkQueryResponse["cards"]>([]);
  readonly teamPrioritySelfCandidateCards = computed(() => this.teamPrioritySelfCards().map((card) => ({
    ...expandCardSummary(card),
    workspaceId: card.workspaceId,
  })));
  /**
   * Single source of truth for "is this card ranked?". The tiles' rank pills and the "+ Up next"
   * affordance both derive from this one set, so a card can never simultaneously show a rank and
   * offer to be added.
   */
  readonly rankedCardIds = computed(
    () => new Set((this.priorities()?.items ?? []).flatMap((item) => item.card ? [item.card.id] : [])),
  );
  /**
   * Whether the Up next panel is docked open. Lens-scoped chrome like the collapse sets: a manager
   * who curates with the panel open on Team Cards should not also find it covering My Cards.
   */
  readonly upNextPanelOpen = signal(false);
  readonly selectedView = computed(() =>
    this.savedViews().find((view) => view.id === this.selectedViewId()) ?? null
  );
  readonly scopedBoards = computed(() => {
    const scope = this.definition().scope;
    if (scope.allAccessible) return this.catalog().boards;
    const organisationIds = new Set(scope.organisationIds);
    const workspaceIds = new Set(scope.workspaceIds);
    const boardIds = new Set(scope.boardIds);
    const workspaceById = new Map(this.catalog().workspaces.map((workspace) => [workspace.id, workspace]));
    return this.catalog().boards.filter((board) => {
      const organisationId = workspaceById.get(board.workspaceId)?.organisationId;
      return Boolean(
        (organisationId && organisationIds.has(organisationId))
        || workspaceIds.has(board.workspaceId)
        || boardIds.has(board.id)
      );
    });
  });
  readonly canLoadMore = computed(() => Boolean(this.response().nextCursor));

  private initializedLens: WorkViewLens | null = null;
  private readonly preferencesReady = signal(false);
  private requestVersion = 0;
  private realtimeAttached = false;
  private realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeRefreshNeedsCatalog = false;
  private queuedWhileHidden = false;
  private queuedWhileDragging = false;
  private dragIdleWaiters: Array<() => void> = [];
  private readonly roomLeaves = new Map<string, () => void>();
  private detachRealtime: (() => void) | null = null;
  private socket: AppSocket | null = null;

  constructor() {
    effect(() => {
      if (!this.preferencesReady()) return;
      const userId = this.auth.user()?.id;
      if (!userId) return;
      writeGlobalWorkPreference(userId, this.lens(), {
        definition: this.definition(),
        selectedViewId: this.selectedViewId(),
        drilldownLabel: this.drilldownLabel(),
        collapsedTableGroupKeys: this.collapsedTableGroupKeys(),
        collapsedHistoryDayKeys: this.collapsedHistoryDayKeys(),
        collapsedChecklistGroupIds: this.collapsedChecklistGroupIds(),
        upNextPanelOpen: this.upNextPanelOpen(),
      });
    });
    // A card drag is a live, pointer-anchored interaction; releasing the held work when it ends is
    // what keeps a reconcile from swapping the lanes out from under it. See whenCardDragIdle.
    effect(() => {
      if (this.cardDrag.active()) return;
      for (const resolve of this.dragIdleWaiters.splice(0)) resolve();
      if (!this.queuedWhileDragging) return;
      this.queuedWhileDragging = false;
      // `realtimeRefreshNeedsCatalog` is sticky, so a catalog-level event deferred during the drag
      // is not downgraded by passing false here.
      this.scheduleRealtimeRefresh(false);
    });
    this.destroyRef.onDestroy(() => {
      // Layout gestures write eagerly, but this final write also captures state changed indirectly
      // by applying a saved view immediately before navigating away.
      this.persistPreference();
      // Nothing is left to apply after teardown; unblock any pending waiter so its promise settles.
      for (const resolve of this.dragIdleWaiters.splice(0)) resolve();
      if (this.realtimeRefreshTimer !== null) clearTimeout(this.realtimeRefreshTimer);
      this.leaveRooms();
      this.detachRealtime?.();
      if (this.socket) this.socket.off("connect", this.onSocketConnect);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
      }
    });
  }

  async initialize(lens: WorkViewLens): Promise<void> {
    if (this.initializedLens === lens) return;
    this.preferencesReady.set(false);
    this.initializedLens = lens;
    this.lens.set(lens);
    const userId = this.auth.user()?.id;
    const preference = userId ? readGlobalWorkPreference(userId, lens) : null;
    this.definition.set(preference?.definition ?? defaultDefinition(lens));
    this.catalog.set(EMPTY_CATALOG);
    this.response.set(EMPTY_RESPONSE);
    this.portfolio.set(null);
    this.otherPriorities.set(null);
    this.teamPriorities.set(null);
    this.teamPrioritySelfCards.set([]);
    this.savedViews.set([]);
    this.shareCandidates.set([]);
    this.cachedAt.set(null);
    this.lastSyncedAt.set(null);
    this.recoveringConnection.set(false);
    this.selectedViewId.set(preference?.selectedViewId ?? null);
    this.drilldownLabel.set(lens === "portfolio" ? preference?.drilldownLabel ?? null : null);
    this.collapsedTableGroupKeys.set(preference?.definition.table.collapsedGroupKeys ?? []);
    this.collapsedHistoryDayKeys.set(preference?.collapsedHistoryDayKeys ?? []);
    this.collapsedChecklistGroupIds.set(preference?.collapsedChecklistGroupIds ?? []);
    // Open unless this person has explicitly closed it: the queue is the page's headline feature,
    // and hiding it behind an unpressed toggle is how the old display mode went undiscovered.
    this.upNextPanelOpen.set(preference?.upNextPanelOpen !== false);
    this.error.set(null);
    this.loading.set(true);
    this.reconciling.set(true);
    this.preferencesReady.set(true);
    // Realtime must exist before either source resolves. Otherwise a cache-only cold start has no
    // connect handler or room refs and can remain stale forever after the network returns.
    this.attachRealtime();
    const version = ++this.requestVersion;
    const cacheKey = this.cacheKey(lens);
    let networkApplied = false;

    const cachedPromise = this.offlineCache.loadGlobalWork(cacheKey)
      .then((cached) => {
        if (!cached || networkApplied || version !== this.requestVersion || this.cachedAt()) return;
        this.catalog.set(cached.catalog);
        const previousDefinition = this.definition();
        const definition = sanitizeGlobalWorkDefinition(
          {
            ...cached.definition,
            // IndexedDB stores query results and can lag behind layout-only gestures. Those gestures
            // do not change the returned cards, so the current per-lens browser layout safely wins.
            // In particular, table presentation is written to localStorage immediately but the
            // query cache is not; letting the stale cached copy win here makes a discarded tab look
            // as though its columns were reset when the browser restores it.
            display: previousDefinition.display,
            groupBy: previousDefinition.groupBy,
            sort: previousDefinition.sort,
            table: previousDefinition.table,
            collapsedOrganisationIds: previousDefinition.collapsedOrganisationIds,
            collapsedWorkspaceIds: previousDefinition.collapsedWorkspaceIds,
            collapsedSectionIds: previousDefinition.collapsedSectionIds,
          },
          lens,
          cached.catalog,
          this.auth.user()?.id ?? null,
        );
        this.definition.set(definition);
        if (JSON.stringify(definition) !== JSON.stringify(previousDefinition)) {
          this.drilldownLabel.set(null);
        }
        this.response.set(cached.response);
        this.portfolio.set(cached.portfolio);
        this.savedViews.set(cached.savedViews);
        this.cachedAt.set(cached.cachedAt);
        this.lastSyncedAt.set(cached.cachedAt);
        this.updateRooms();
      })
      .catch(() => undefined);

    try {
      await this.refreshAll(version, {
        onNetworkApplied: () => {
          networkApplied = true;
        },
      });
    } catch {
      await cachedPromise;
      if (version === this.requestVersion && !this.hasUsableData()) {
        this.error.set("We couldn’t load this view. Check your connection and try again.");
      }
    } finally {
      if (version === this.requestVersion) {
        this.loading.set(false);
        this.reconciling.set(false);
      }
    }
  }

  async refresh(): Promise<void> {
    const version = ++this.requestVersion;
    this.recoveringConnection.set(false);
    this.loading.set(true);
    this.reconciling.set(true);
    this.error.set(null);
    // An explicit "refresh this page" must also refresh the viewer's own queue, which is no longer
    // part of `refreshAll`'s Promise.all. Only here, not on background reconciles: those run on the
    // realtime debounce, where the service has already converged on the same events.
    if (this.isSelfQueue()) void this.myPriorities.refresh();
    try {
      await this.refreshAll(version);
    } catch {
      if (version === this.requestVersion && !this.hasUsableData()) {
        this.error.set("We couldn’t refresh this view.");
      }
    } finally {
      if (version === this.requestVersion) {
        this.loading.set(false);
        this.reconciling.set(false);
      }
    }
  }

  async queryFirstPage(): Promise<void> {
    if (!this.interactionReady()) return;
    const version = ++this.requestVersion;
    // This foreground query supersedes any in-flight background reconcile. Clear its status now;
    // the loading flag below owns readiness until the requested projection has settled.
    this.reconciling.set(false);
    this.recoveringConnection.set(false);
    this.loading.set(true);
    this.error.set(null);
    try {
      const cardsRequest = this.lens() === "portfolio" && this.definition().display === "summary"
        ? Promise.resolve(EMPTY_RESPONSE)
        : this.loadCards();
      const [response, priorities, teamPriorities, selfCandidateCards] = await Promise.all([
        cardsRequest,
        this.loadPriorities(),
        this.loadTeamPriorities(),
        this.loadTeamPrioritySelfCards(version),
      ]);
      if (version !== this.requestVersion) return;
      this.response.set(response);
      this.otherPriorities.set(priorities);
      this.teamPriorities.set(teamPriorities);
      this.teamPrioritySelfCards.set(selfCandidateCards);
      if (["board", "priorities"].includes(this.definition().display)) {
        await this.loadRemainingCards(version);
      }
      if (this.lens() === "portfolio") {
        this.portfolio.set(await this.loadPortfolio());
      }
      this.cachedAt.set(null);
      this.lastSyncedAt.set(new Date().toISOString());
      this.updateRooms();
      await this.persistCache();
    } catch {
      if (version === this.requestVersion) this.error.set("We couldn’t apply those filters.");
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.response().nextCursor;
    if (!cursor || this.loadingMore() || !this.interactionReady()) return;
    this.loadingMore.set(true);
    try {
      const page = await this.loadCards(cursor);
      const current = this.response();
      const seen = new Set(current.cards.map((card) => card.id));
      this.response.set({
        ...page,
        cards: [...current.cards, ...page.cards.filter((card) => !seen.has(card.id))],
        checklistItems: current.checklistItems,
        totals: current.totals,
        separators: current.separators,
        separatorWorkspaceIds: current.separatorWorkspaceIds,
      });
    } finally {
      this.loadingMore.set(false);
    }
  }

  setSearch(q: string): void {
    this.patchFilters({ q });
  }

  setAssignees(assigneeIds: string[]): void {
    this.patchFilters({ assigneeIds });
  }

  setCompletion(completion: WorkFilters["completion"]): void {
    this.patchFilters({ completion });
  }

  setOverdueOnly(overdueOnly: boolean): void {
    this.patchFilters({ overdueOnly });
  }

  setUnreadOnly(unreadOnly: boolean): void {
    this.patchFilters({ unreadOnly });
  }

  setArchived(archived: boolean): void {
    this.patchFilters({ archived });
  }

  setDueRange(dueFrom: string | null, dueTo: string | null): void {
    this.patchFilters({ dueFrom, dueTo });
  }

  setListIds(listIds: string[]): void {
    this.patchFilters({ listIds });
  }

  setLabelIds(labelIds: string[]): void {
    this.patchFilters({ labelIds });
  }

  setCustomFieldConditions(customFieldConditions: WorkCustomFieldCondition[]): void {
    this.patchFilters({ customFieldConditions });
  }

  updateFilters(patch: Partial<WorkFilters>): void {
    this.patchFilters(patch);
  }

  setScope(workspaceIds: string[], boardIds: string[], organisationIds: string[] = []): void {
    this.definition.update((definition) => ({
      ...definition,
      scope: {
        allAccessible: organisationIds.length === 0 && workspaceIds.length === 0 && boardIds.length === 0,
        organisationIds,
        workspaceIds,
        boardIds,
      },
    }));
    this.updateRooms();
  }

  setGrouping(groupBy: WorkGroupBy): void {
    this.definition.update((definition) => ({
      ...definition,
      groupBy,
      table: { ...definition.table, collapsedGroupKeys: [] },
    }));
    // Table group keys are dimension-scoped; a board id and a list id must never accidentally fold
    // one another after the grouping axis changes.
    this.collapsedTableGroupKeys.set([]);
    this.persistPreference();
  }

  setSort(sort: WorkSort): void {
    this.definition.update((definition) => ({ ...definition, sort }));
  }

  /**
   * Return one presentation axis to the lens default, for the toolbar's inline clear.
   *
   * These live here for the same reason `groupByIsSet` and friends do: the default is
   * lens-dependent and `defaultDefinition` is private to this file, so the page can be told a
   * control is away from its default but cannot work out what to put it back to.
   */
  resetGrouping(): void {
    this.setGrouping(defaultDefinition(this.lens()).groupBy);
  }

  resetSort(): void {
    this.setSort(defaultDefinition(this.lens()).sort);
  }

  resetPortfolioDays(): void {
    this.setPortfolioDays(defaultDefinition(this.lens()).portfolioDays);
  }

  /** Restore only the table/calendar presentation axes; query scope and filters remain intentional. */
  resetTablePresentation(): void {
    const defaults = defaultDefinition(this.lens());
    this.definition.update((definition) => ({
      ...definition,
      groupBy: defaults.groupBy,
      sort: defaults.sort,
      table: defaults.table,
    }));
    this.collapsedTableGroupKeys.set([]);
    this.persistPreference();
  }

  setTablePresentation(table: WorkTablePresentation): void {
    const normalized = {
      ...table,
      columnVisibility: { ...table.columnVisibility },
      columnOrder: [...table.columnOrder],
      columnWidths: { ...table.columnWidths },
      aggregates: { ...table.aggregates },
      collapsedGroupKeys: [...new Set(table.collapsedGroupKeys)].slice(0, 500),
    };
    this.definition.update((definition) => ({ ...definition, table: normalized }));
    this.collapsedTableGroupKeys.set(normalized.collapsedGroupKeys);
    this.persistPreference();
  }

  setDisplay(display: WorkDisplayMode): void {
    // The portfolio summary shows aggregates, not cards, and hides the search box with them. Clearing
    // the title filter on the way in stops a query typed during a drill-down from silently narrowing
    // every count and heatmap with no visible control explaining why.
    const clearSearch = this.lens() === "portfolio" && display === "summary";
    // Priority is the whole-team queue overview. Carrying a hidden teammate filter into it would
    // leave other lanes without add-card candidates even though their queues are visible.
    const clearTeamFocus = this.lens() === "team"
      && display === "priorities"
      && this.definition().filters.assigneeIds.length > 0;
    this.definition.update((definition) => ({
      ...definition,
      display,
      ...(clearSearch || clearTeamFocus
        ? {
            filters: {
              ...definition.filters,
              ...(clearSearch ? { q: "" } : {}),
              ...(clearTeamFocus ? { assigneeIds: [] } : {}),
            },
          }
        : {}),
    }));
    this.persistPreference();
    // Summary renders only portfolio aggregates. Defer the card projection until the viewer opens
    // a row display; switching either direction queries exactly the data that display needs.
    if (this.lens() === "portfolio") {
      this.teamPrioritySelfCards.set([]);
      void this.queryFirstPage();
      return;
    }
    if (display === "priorities") {
      void this.queryFirstPage();
    } else if (display === "board") {
      this.teamPrioritySelfCards.set([]);
      void this.loadRemainingCards(this.requestVersion)
        .then(() => this.persistCache())
        .catch(() => this.error.set("We couldn’t load every card. Try refreshing the page."));
    } else {
      this.teamPrioritySelfCards.set([]);
    }
  }

  setPortfolioDays(portfolioDays: number): void {
    this.definition.update((definition) => ({
      ...definition,
      portfolioDays: Math.max(1, Math.min(60, Math.round(portfolioDays))),
    }));
  }

  /** Portfolio summary tree only; workspaces below a collapsed organisation stay in the set. */
  toggleOrganisationCollapsed(organisationId: string): void {
    this.definition.update((definition) => ({
      ...definition,
      collapsedOrganisationIds: toggleId(definition.collapsedOrganisationIds, organisationId),
    }));
    this.persistPreference();
  }

  toggleWorkspaceCollapsed(workspaceId: string): void {
    this.definition.update((definition) => ({
      ...definition,
      collapsedWorkspaceIds: toggleId(definition.collapsedWorkspaceIds, workspaceId),
    }));
    this.persistPreference();
  }

  toggleSectionCollapsed(sectionId: string): void {
    this.definition.update((definition) => ({
      ...definition,
      collapsedSectionIds: toggleId(definition.collapsedSectionIds, sectionId),
    }));
    this.persistPreference();
  }

  setCollapsedTableGroupKeys(keys: readonly string[]): void {
    const normalized = [...new Set(keys)].slice(0, 500);
    this.collapsedTableGroupKeys.set(normalized);
    this.definition.update((definition) => ({
      ...definition,
      table: { ...definition.table, collapsedGroupKeys: normalized },
    }));
    this.persistPreference();
  }

  setCollapsedHistoryDayKeys(keys: readonly string[]): void {
    this.collapsedHistoryDayKeys.set([...new Set(keys)].slice(0, 60));
    this.persistPreference();
  }

  setUpNextPanelOpen(open: boolean): void {
    this.upNextPanelOpen.set(open);
    this.persistPreference();
  }

  toggleChecklistGroupCollapsed(groupId: string): void {
    this.collapsedChecklistGroupIds.update((ids) => toggleId(ids, groupId));
    this.persistPreference();
  }

  applySavedView(view: SavedWorkView): void {
    if (view.lens !== this.lens()) return;
    this.selectedViewId.set(view.id);
    this.drilldownLabel.set(null);
    this.definition.set(view.definition);
    this.collapsedTableGroupKeys.set(view.definition.table.collapsedGroupKeys);
    this.updateRooms();
    void this.queryFirstPage();
  }

  clearSavedView(): void {
    const defaults = defaultDefinition(this.lens());
    this.selectedViewId.set(null);
    this.drilldownLabel.set(null);
    this.definition.set(defaults);
    this.collapsedTableGroupKeys.set(defaults.table.collapsedGroupKeys);
    this.updateRooms();
    void this.queryFirstPage();
  }

  async createSavedView(name: string, visibility: WorkViewVisibility): Promise<void> {
    if (!name.trim() || this.saving()) return;
    this.saving.set(true);
    try {
      const view = await this.api.post<SavedWorkView>("/work-views", {
        name: name.trim(),
        lens: this.lens(),
        visibility,
        definition: this.definition(),
      });
      this.savedViews.update((views) => [view, ...views]);
      this.selectedViewId.set(view.id);
      await this.persistCache();
    } finally {
      this.saving.set(false);
    }
  }

  async updateSavedView(name?: string, visibility?: WorkViewVisibility): Promise<void> {
    const view = this.selectedView();
    if (!view?.editable || this.saving()) return;
    this.saving.set(true);
    try {
      const updated = await this.api.patch<SavedWorkView>(`/work-views/${view.id}`, {
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(visibility ? { visibility } : {}),
        definition: this.definition(),
      });
      this.savedViews.update((views) => views.map((candidate) => candidate.id === updated.id ? updated : candidate));
      await this.persistCache();
    } finally {
      this.saving.set(false);
    }
  }

  async deleteSavedView(): Promise<void> {
    const view = this.selectedView();
    if (!view?.editable || this.saving()) return;
    this.saving.set(true);
    try {
      await this.api.delete(`/work-views/${view.id}`);
      this.savedViews.update((views) => views.filter((candidate) => candidate.id !== view.id));
      this.clearSavedView();
      await this.persistCache();
    } finally {
      this.saving.set(false);
    }
  }

  async addShare(userId: string): Promise<void> {
    const view = this.selectedView();
    if (!view?.editable || view.sharedUserIds.includes(userId)) return;
    await this.api.post(`/work-views/${view.id}/shares`, { userId });
    this.savedViews.update((views) => views.map((candidate) =>
      candidate.id === view.id
        ? { ...candidate, sharedUserIds: [...candidate.sharedUserIds, userId] }
        : candidate
    ));
  }

  async removeShare(userId: string): Promise<void> {
    const view = this.selectedView();
    if (!view?.editable) return;
    await this.api.delete(`/work-views/${view.id}/shares/${userId}`);
    this.savedViews.update((views) => views.map((candidate) =>
      candidate.id === view.id
        ? { ...candidate, sharedUserIds: candidate.sharedUserIds.filter((id) => id !== userId) }
        : candidate
    ));
  }

  async setCardCompleted(cardId: string, completed: boolean): Promise<void> {
    await this.api.patch(`/cards/${cardId}/completion`, { completed });
    await this.queryFirstPage();
  }

  async moveCard(
    cardId: string,
    listId: string,
    anchor: { afterItem: { type: "card" | "separator"; id: string } | null }
      | { beforeItem: { type: "card" | "separator"; id: string } | null }
      | { afterCardId: string | null }
      | { beforeCardId: string | null },
  ): Promise<void> {
    const snapshot = this.response();
    const moving = snapshot.cards.find((card) => card.id === cardId);
    if (!moving) return;
    const lane = [
      ...snapshot.cards
        .filter((card) => card.id !== cardId && card.listId === listId)
        .map((card) => ({ type: "card" as const, id: card.id, position: card.position })),
      ...snapshot.separators
        .filter((separator) => separator.listId === listId)
        .map((separator) => ({ type: "separator" as const, id: separator.id, position: separator.position })),
    ].sort((a, b) => Number(a.position) - Number(b.position) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    let previous: string | null = null;
    let next: string | null = null;
    const itemAnchor = "afterCardId" in anchor
      ? { afterItem: anchor.afterCardId ? { type: "card" as const, id: anchor.afterCardId } : null }
      : "beforeCardId" in anchor
        ? { beforeItem: anchor.beforeCardId ? { type: "card" as const, id: anchor.beforeCardId } : null }
        : anchor;
    if ("afterItem" in itemAnchor) {
      if (itemAnchor.afterItem === null) next = lane[0]?.position ?? null;
      else {
        const index = lane.findIndex((item) => item.type === itemAnchor.afterItem?.type && item.id === itemAnchor.afterItem.id);
        previous = lane[index]?.position ?? null;
        next = index >= 0 ? lane[index + 1]?.position ?? null : null;
      }
    } else if (itemAnchor.beforeItem === null) {
      previous = lane.at(-1)?.position ?? null;
    } else {
      const index = lane.findIndex((item) => item.type === itemAnchor.beforeItem?.type && item.id === itemAnchor.beforeItem.id);
      next = lane[index]?.position ?? null;
      previous = index > 0 ? lane[index - 1]?.position ?? null : null;
    }
    const optimisticPosition = this.optimisticPosition(previous, next);
    this.response.update((response) => ({
      ...response,
      cards: response.cards.map((card) =>
        card.id === cardId ? { ...card, listId, position: optimisticPosition } : card
      ),
    }));
    try {
      const moved = await this.api.post<{ id: string; listId: string; position: string }>(
        `/cards/${cardId}/move`,
        {
          listId,
          ...itemAnchor,
          ...(this.focusedTargetUserId() ? { globalWorkUserId: this.focusedTargetUserId() } : {}),
        },
      );
      this.response.update((response) => ({
        ...response,
        cards: response.cards.map((card) =>
          card.id === moved.id ? { ...card, listId: moved.listId, position: moved.position } : card
        ),
      }));
    } catch (error) {
      this.response.set(snapshot);
      throw error;
    }
  }

  /**
   * True while the focused queue is the viewer's own, which the shell service owns.
   *
   * Every mutation below branches on this rather than duplicating the optimistic logic: delegating
   * is what stops the dock and the drawer from being two stores that can disagree.
   */
  private isSelfQueue(): boolean {
    const targetUserId = this.focusedTargetUserId();
    return targetUserId !== null && targetUserId === this.auth.user()?.id;
  }

  /**
   * Add a card to the focused person's priority queue.
   *
   * Every mutation settles by replacing the whole queue with the response rather than patching one
   * entry: a concurrent reorder by another manager is then already folded in, and there is no window
   * where the ranks on screen disagree with the server's.
   */
  async addPriority(cardId: string, anchor: { afterId?: string | null; beforeId?: string | null }): Promise<void> {
    const targetUserId = this.focusedTargetUserId();
    if (!targetUserId) return;
    if (this.isSelfQueue()) {
      // Seed the service's optimistic row from *this page's* cards: the drawer's lazily-loaded
      // candidate pool may not be there yet, and a dock add must still show the row immediately.
      this.seedSelfCandidate(cardId);
      await this.myPriorities.addPriority(cardId, anchor);
      return;
    }
    const snapshot = this.otherPriorities();
    this.applyOptimisticPriority(null, cardId, anchor);
    try {
      this.otherPriorities.set(await this.api.post<WorkPrioritiesResponse>(
        `/work/priorities/${targetUserId}/cards`,
        { cardId, ...anchor },
      ));
    } catch (error) {
      this.otherPriorities.set(snapshot);
      throw error;
    }
  }

  async movePriority(priorityId: string, anchor: { afterId?: string | null; beforeId?: string | null }): Promise<void> {
    if (this.isSelfQueue()) {
      await this.myPriorities.movePriority(priorityId, anchor);
      return;
    }
    const snapshot = this.otherPriorities();
    this.applyOptimisticPriority(priorityId, null, anchor);
    try {
      this.otherPriorities.set(await this.api.post<WorkPrioritiesResponse>(
        `/card-priorities/${priorityId}/move`,
        anchor,
      ));
    } catch (error) {
      this.otherPriorities.set(snapshot);
      throw error;
    }
  }

  async removePriority(priorityId: string): Promise<void> {
    if (this.isSelfQueue()) {
      await this.myPriorities.removePriority(priorityId);
      return;
    }
    const snapshot = this.otherPriorities();
    this.otherPriorities.update((queue) => queue && {
      ...queue,
      items: queue.items.filter((item) => item.id !== priorityId).map((item, index) => ({ ...item, rank: index + 1 })),
      totalCount: Math.max(0, queue.totalCount - 1),
    });
    try {
      this.otherPriorities.set(await this.api.delete<WorkPrioritiesResponse>(`/card-priorities/${priorityId}`));
    } catch (error) {
      this.otherPriorities.set(snapshot);
      throw error;
    }
  }

  /**
   * Hand the shell service the board/list context for a card this page can see, so an add made from
   * the dock renders its optimistic row with a title and board trail rather than a blank placeholder.
   */
  private seedSelfCandidate(cardId: string): void {
    const card = this.cards().find((candidate) => candidate.id === cardId);
    if (!card) return;
    const board = this.catalog().boards.find((candidate) => candidate.id === card.boardId);
    if (!board) return;
    this.myPriorities.rememberCandidate({
      id: card.id,
      title: card.title,
      boardId: card.boardId,
      boardName: board.name,
      boardIcon: board.icon,
      boardIconColor: board.iconColor,
      listName: this.catalog().lists.find((list) => list.id === card.listId)?.name ?? "",
    });
  }

  /**
   * Reorder one lane of the Team Cards lanes display. Same endpoint and same settle-by-replacement
   * as `movePriority`, but applied to the matching queue inside `teamPriorities` — the two signals
   * are separate copies, and each mutation must update the one its display is reading.
   */
  async moveTeamPriority(
    targetUserId: string,
    priorityId: string,
    anchor: { afterId?: string | null; beforeId?: string | null },
  ): Promise<void> {
    const snapshot = this.teamPriorities();
    const lane = snapshot?.queues.find((candidate) => candidate.target.userId === targetUserId);
    const moving = lane?.queue.items.find((item) => item.id === priorityId);
    if (lane && moving) {
      const rest = lane.queue.items.filter((item) => item.id !== priorityId);
      const items = this.reorderedQueueItems(rest, moving, anchor);
      this.patchTeamQueue(targetUserId, { ...lane.queue, items });
    }
    try {
      this.patchTeamQueue(
        targetUserId,
        await this.api.post<WorkPrioritiesResponse>(`/card-priorities/${priorityId}/move`, anchor),
      );
    } catch (error) {
      this.teamPriorities.set(snapshot);
      throw error;
    }
  }

  /** Add to one lane without relying on the Team Cards teammate filter to focus its owner. */
  async addTeamPriority(
    targetUserId: string,
    cardId: string,
    anchor: { afterId?: string | null; beforeId?: string | null },
  ): Promise<void> {
    const snapshot = this.teamPriorities();
    const lane = snapshot?.queues.find((candidate) => candidate.target.userId === targetUserId);
    const card = [...this.cards(), ...this.teamPrioritySelfCandidateCards()]
      .find((candidate) => candidate.id === cardId) ?? null;
    if (lane && card) {
      const moving: WorkPrioritiesResponse["items"][number] = {
        id: `pending:${cardId}`,
        card,
        // The server response supplies canonical board/list context; the card already contains the
        // ids needed for the optimistic row while the lane picker closes.
        context: null,
        rank: 0,
        position: "0",
      };
      const items = this.reorderedQueueItems(lane.queue.items, moving, anchor);
      this.patchTeamQueue(targetUserId, { ...lane.queue, items, totalCount: items.length });
    }
    try {
      this.patchTeamQueue(
        targetUserId,
        await this.api.post<WorkPrioritiesResponse>(`/work/priorities/${targetUserId}/cards`, {
          cardId,
          ...anchor,
        }),
      );
    } catch (error) {
      this.teamPriorities.set(snapshot);
      throw error;
    }
  }

  async removeTeamPriority(targetUserId: string, priorityId: string): Promise<void> {
    const snapshot = this.teamPriorities();
    this.teamPriorities.update((all) => all && {
      queues: all.queues.map((lane) => lane.target.userId === targetUserId
        ? {
            ...lane,
            queue: {
              ...lane.queue,
              items: lane.queue.items
                .filter((item) => item.id !== priorityId)
                .map((item, index) => ({ ...item, rank: index + 1 })),
              totalCount: Math.max(0, lane.queue.totalCount - 1),
            },
          }
        : lane),
    });
    try {
      this.patchTeamQueue(
        targetUserId,
        await this.api.delete<WorkPrioritiesResponse>(`/card-priorities/${priorityId}`),
      );
    } catch (error) {
      this.teamPriorities.set(snapshot);
      throw error;
    }
  }

  /** Fold one lane's fresh server queue into the batch without touching the other lanes. */
  private patchTeamQueue(targetUserId: string, queue: WorkPrioritiesResponse): void {
    this.teamPriorities.update((all) => all && {
      queues: all.queues.map((lane) => lane.target.userId === targetUserId ? { ...lane, queue } : lane),
    });
  }

  /**
   * Show the drop where the pointer released it, before the round trip.
   *
   * Ranks are renumbered locally so the badges never briefly disagree with the row order; the
   * server's response then replaces the lot, including any entry this viewer cannot see (which is
   * why an optimistic rank is a guess, not a claim — a redacted neighbour can shift it).
   */
  private applyOptimisticPriority(
    priorityId: string | null,
    cardId: string | null,
    anchor: { afterId?: string | null; beforeId?: string | null },
  ): void {
    const queue = this.otherPriorities();
    if (!queue) return;
    const card = cardId ? this.cards().find((candidate) => candidate.id === cardId) ?? null : null;
    if (cardId && !card) return;
    const rest = queue.items.filter((item) => item.id !== priorityId);
    const moving = priorityId
      ? queue.items.find((item) => item.id === priorityId)
      : {
          id: `pending:${cardId}`,
          card: card as WorkPrioritiesResponse["items"][number]["card"],
          // Resolved server-side; the queue surfaces read board/list names from the catalog, so an
          // optimistic row renders identically without it.
          context: null,
          rank: 0,
          position: "0",
        };
    if (!moving) return;
    const items = this.reorderedQueueItems(rest, moving, anchor);
    this.otherPriorities.set({ ...queue, items, totalCount: items.length });
  }

  /**
   * Place `moving` among `rest` at the anchor and renumber ranks — the shared optimistic-reorder
   * core for both the focused queue and a team lane. The interpolated position is a stand-in the
   * server response replaces; it only has to sort the row into the right slot locally.
   */
  private reorderedQueueItems(
    rest: WorkPrioritiesResponse["items"],
    moving: WorkPrioritiesResponse["items"][number],
    anchor: { afterId?: string | null; beforeId?: string | null },
  ): WorkPrioritiesResponse["items"] {
    let previous: string | null = null;
    let next: string | null = null;
    if (anchor.afterId === null) next = rest[0]?.position ?? null;
    else if (anchor.beforeId === null) previous = rest.at(-1)?.position ?? null;
    else if (anchor.afterId) {
      const index = rest.findIndex((item) => item.id === anchor.afterId);
      previous = rest[index]?.position ?? null;
      next = index >= 0 ? rest[index + 1]?.position ?? null : null;
    } else if (anchor.beforeId) {
      const index = rest.findIndex((item) => item.id === anchor.beforeId);
      next = rest[index]?.position ?? null;
      previous = index > 0 ? rest[index - 1]?.position ?? null : null;
    }
    const position = this.optimisticPosition(previous, next);
    return [...rest, { ...moving, position }]
      .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id))
      .map((item, index) => ({ ...item, rank: index + 1 }));
  }

  addSeparator(separator: WireGlobalWorkSeparator): void {
    this.response.update((response) => ({
      ...response,
      separators: [...response.separators.filter((candidate) => candidate.id !== separator.id), separator],
    }));
  }

  updateSeparator(separator: WireGlobalWorkSeparator): void {
    this.response.update((response) => ({
      ...response,
      separators: response.separators.map((candidate) => candidate.id === separator.id ? separator : candidate),
    }));
  }

  removeSeparator(separatorId: string): void {
    this.response.update((response) => ({
      ...response,
      separators: response.separators.filter((separator) => separator.id !== separatorId),
    }));
  }

  async moveSeparator(
    separatorId: string,
    listId: string,
    anchor: { afterItem?: { type: "card" | "separator"; id: string } | null; beforeItem?: { type: "card" | "separator"; id: string } | null },
  ): Promise<void> {
    const snapshot = this.response();
    const separator = snapshot.separators.find((candidate) => candidate.id === separatorId);
    if (!separator) return;
    const lane = [
      ...snapshot.cards
        .filter((card) => card.listId === listId)
        .map((card) => ({ type: "card" as const, id: card.id, position: card.position })),
      ...snapshot.separators
        .filter((candidate) => candidate.id !== separatorId && candidate.listId === listId)
        .map((candidate) => ({ type: "separator" as const, id: candidate.id, position: candidate.position })),
    ].sort((a, b) => Number(a.position) - Number(b.position) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    let previous: string | null = null;
    let next: string | null = null;
    if (anchor.afterItem !== undefined) {
      if (anchor.afterItem === null) next = lane[0]?.position ?? null;
      else {
        const index = lane.findIndex((item) => item.type === anchor.afterItem?.type && item.id === anchor.afterItem.id);
        previous = lane[index]?.position ?? null;
        next = index >= 0 ? lane[index + 1]?.position ?? null : null;
      }
    } else if (anchor.beforeItem === null) {
      previous = lane.at(-1)?.position ?? null;
    } else if (anchor.beforeItem) {
      const index = lane.findIndex((item) => item.type === anchor.beforeItem?.type && item.id === anchor.beforeItem.id);
      next = lane[index]?.position ?? null;
      previous = index > 0 ? lane[index - 1]?.position ?? null : null;
    }
    const optimisticPosition = this.optimisticPosition(previous, next);
    this.response.update((response) => ({
      ...response,
      separators: response.separators.map((candidate) =>
        candidate.id === separatorId ? { ...candidate, listId, position: optimisticPosition } : candidate
      ),
    }));
    try {
      const moved = await this.api.post<{ id: string; listId: string; position: string }>(
        `/global-work-separators/${separatorId}/move`,
        { listId, ...anchor },
      );
      this.response.update((response) => ({
        ...response,
        separators: response.separators.map((candidate) =>
          candidate.id === moved.id ? { ...candidate, listId: moved.listId, position: moved.position } : candidate
        ),
      }));
    } catch (error) {
      this.response.set(snapshot);
      throw error;
    }
  }

  async createCard(boardId: string, listId: string, title: string, assigneeIds: string[]): Promise<void> {
    await this.api.createCard(`/boards/${boardId}/lists/${listId}/cards`, {
      title: title.trim(),
      assigneeIds,
      clientToken: crypto.randomUUID(),
    });
    this.reconcileCardsInBackground();
  }

  /**
   * Converge after a card is created outside this projection without turning the live page into a
   * foreground loading state. Creation emits a realtime event too, so this goes through the same
   * debounce: whichever signal arrives first schedules one atomic refresh and the other coalesces.
   */
  reconcileCardsInBackground(): void {
    if (!this.interactionReady()) return;
    this.scheduleRealtimeRefresh(false);
  }

  private patchFilters(patch: Partial<WorkFilters>): void {
    this.definition.update((definition) => ({
      ...definition,
      filters: { ...definition.filters, ...patch },
    }));
  }

  private persistPreference(): void {
    if (!this.preferencesReady()) return;
    const userId = this.auth.user()?.id;
    if (!userId) return;
    writeGlobalWorkPreference(userId, this.lens(), {
      definition: this.definition(),
      selectedViewId: this.selectedViewId(),
      drilldownLabel: this.drilldownLabel(),
      collapsedTableGroupKeys: this.collapsedTableGroupKeys(),
      collapsedHistoryDayKeys: this.collapsedHistoryDayKeys(),
      collapsedChecklistGroupIds: this.collapsedChecklistGroupIds(),
      upNextPanelOpen: this.upNextPanelOpen(),
    });
  }

  private optimisticPosition(previous: string | null, next: string | null): string {
    if (previous === null && next === null) return "1000.0000000000";
    if (previous === null) return (Number(next) - 1000).toFixed(10);
    if (next === null) return (Number(previous) + 1000).toFixed(10);
    return ((Number(previous) + Number(next)) / 2).toFixed(10);
  }

  /**
   * `atomicCards` swaps the progressive card paging for a single settled value — see loadAllCards.
   * Background reconciles pass it; the first paint and an explicit user refresh do not, because
   * there the page is either empty or already showing a spinner.
   */
  private async refreshAll(
    version: number,
    options: { onNetworkApplied?: () => void; atomicCards?: boolean } = {},
  ): Promise<void> {
    const { onNetworkApplied, atomicCards = false } = options;
    const requestedDefinition = this.definition();
    const initialCardsRequest = this.lens() === "portfolio" && requestedDefinition.display === "summary"
      ? Promise.resolve(EMPTY_RESPONSE)
      : atomicCards ? this.loadAllCards(version) : this.loadCards();
    // Priorities rides in the same Promise.all as the cards, so the ranked lane and the tail can
    // never be applied at different instants — the invariant that keeps a card from briefly
    // appearing in both, or in neither.
    const [
      catalog,
      initialResponse,
      savedViews,
      shareCandidates,
      initialPortfolio,
      priorities,
      teamPriorities,
      initialSelfCandidateCards,
    ] = await Promise.all([
      this.api.get<WorkCatalog>("/work/catalog"),
      initialCardsRequest,
      this.api.get<SavedWorkView[]>("/work-views"),
      this.api.get<WorkViewShareCandidate[]>("/work-views/share-candidates"),
      this.lens() === "portfolio" ? this.loadPortfolio() : Promise.resolve(null),
      this.loadPriorities(),
      this.loadTeamPriorities(),
      this.loadTeamPrioritySelfCards(version),
    ]);
    if (version !== this.requestVersion) return;
    this.catalog.set(catalog);
    const previousDefinition = this.definition();
    const definition = sanitizeGlobalWorkDefinition(
      previousDefinition,
      this.lens(),
      catalog,
      this.auth.user()?.id ?? null,
    );
    const definitionChanged = JSON.stringify(definition) !== JSON.stringify(previousDefinition);
    const queryDefinitionChanged = JSON.stringify(definition) !== JSON.stringify(requestedDefinition);
    this.definition.set(definition);
    if (definitionChanged) this.drilldownLabel.set(null);
    let response = initialResponse;
    let portfolio = initialPortfolio;
    let selfCandidateCards = initialSelfCandidateCards;
    if (queryDefinitionChanged) {
      // A cached definition can paint while this request is in flight, and remembered sources can
      // become inaccessible. Refetch whenever the now-canonical definition differs from the one
      // that produced the first response so controls, rows, and aggregates always describe one view.
      const correctedCardsRequest = this.lens() === "portfolio" && definition.display === "summary"
        ? Promise.resolve(EMPTY_RESPONSE)
        : atomicCards ? this.loadAllCards(version) : this.loadCards();
      [response, portfolio, selfCandidateCards] = await Promise.all([
        correctedCardsRequest,
        this.lens() === "portfolio" ? this.loadPortfolio() : Promise.resolve(null),
        this.loadTeamPrioritySelfCards(version),
      ]);
      if (version !== this.requestVersion) return;
    }
    // Close the initial network-vs-IndexedDB race only after every query required for the canonical
    // definition has succeeded. A failed corrective query must still be allowed to fall back.
    onNetworkApplied?.();
    // Never publish a new card set while a drag is holding one of them.
    await this.whenCardDragIdle();
    if (version !== this.requestVersion) return;
    this.response.set(response);
    this.savedViews.set(savedViews);
    this.shareCandidates.set(shareCandidates);
    this.portfolio.set(portfolio);
    this.otherPriorities.set(priorities);
    this.teamPriorities.set(teamPriorities);
    this.teamPrioritySelfCards.set(selfCandidateCards);
    if (
      this.selectedViewId()
      && !savedViews.some((view) => view.id === this.selectedViewId() && view.lens === this.lens())
    ) {
      this.selectedViewId.set(null);
    }
    if (!atomicCards && ["board", "priorities"].includes(this.definition().display)) {
      await this.loadRemainingCards(version);
    }
    this.cachedAt.set(null);
    this.lastSyncedAt.set(new Date().toISOString());
    this.error.set(null);
    this.updateRooms();
    await this.persistCache();
    if (version === this.requestVersion) {
      this.reconciliationVersion.update((current) => current + 1);
    }
  }

  /**
   * The priority queue is its own endpoint, not a sort on the card query.
   *
   * Rank belongs to the (user, card) pair, the card query pages behind a seen-ids cursor that
   * assumes the sort key is a card property, and — decisively — the queue must show every ranked
   * card even when the current filters and scope exclude it, or the numbering would lie. Nothing
   * joined into the card query could do that, since it inherits the query's own filters.
   *
   * Fetched whenever exactly one *other* person is in focus, on every display: the rank pills on
   * card tiles and the Up next panel both read it ambiently, so it cannot wait for a display switch.
   * One indexed range scan per query reload is the whole cost. Returns null for a whole team or
   * the portfolio — a queue belongs to one person — and for the viewer themselves, whose queue the
   * shell-wide `MyPrioritiesService` already owns and keeps live.
   */
  private loadPriorities(): Promise<WorkPrioritiesResponse | null> {
    const targetUserId = this.focusedTargetUserId();
    if (!targetUserId || this.isSelfQueue()) return Promise.resolve(null);
    return this.api.get<WorkPrioritiesResponse>(`/work/priorities/${targetUserId}`).catch((error: unknown) => {
      // Any member can focus a teammate on Team Cards, but the queue endpoint deliberately 403s
      // viewers without admin authority over a shared workspace. That is "no queue surface for
      // you", not a page failure — this ride-along must never take the whole card query down
      // with it. Anything other than a 403 still propagates into the normal error path.
      if (error instanceof ApiError && error.status === 403) return null;
      throw error;
    });
  }

  /**
   * The batch behind the Team Cards lanes display: every queue this viewer may read, in one
   * request. The server scopes it to the caller (a plain member simply gets their own lane back),
   * so unlike `loadPriorities` there is no cross-user 403 to absorb here.
   */
  private loadTeamPriorities(): Promise<WorkPriorityQueuesResponse | null> {
    if (this.lens() !== "team") return Promise.resolve(null);
    return this.api.get<WorkPriorityQueuesResponse>("/work/priorities");
  }

  /**
   * Candidate cards for the self lane while Team Cards is showing Priority view.
   *
   * The ordinary team query excludes the signed-in user by product definition. Reusing the same
   * scope, filters, and sort with the My Cards lens supplies only the missing assignments. Pages are
   * exhausted here because a disabled Add button must mean there are truly no eligible cards, not
   * merely none in the first 100 results.
   */
  private async loadTeamPrioritySelfCards(version: number): Promise<WorkQueryResponse["cards"]> {
    if (this.lens() !== "team" || this.definition().display !== "priorities") return [];
    const definition = this.definition();
    const cards: WorkQueryResponse["cards"] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.post<WorkQueryResponse>("/work/cards/query", {
        lens: "my",
        scope: definition.scope,
        // My Cards forces the viewer as assignee server-side; clear the hidden Team Cards focus so
        // the request body still describes the candidate projection honestly.
        filters: { ...definition.filters, assigneeIds: [] },
        sort: definition.sort,
        limit: 100,
        includeMetadata: false,
        ...(cursor ? { cursor } : {}),
      });
      if (version !== this.requestVersion) return [];
      const seen = new Set(cards.map((card) => card.id));
      cards.push(...page.cards.filter((card) => !seen.has(card.id)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && cards.length < 10_000);
    return cards;
  }

  private loadCards(cursor?: string): Promise<WorkQueryResponse> {
    const definition = this.definition();
    return this.api.post<WorkQueryResponse>("/work/cards/query", {
      lens: this.lens(),
      scope: definition.scope,
      filters: definition.filters,
      sort: definition.sort,
      limit: 100,
      includeMetadata: !cursor,
      ...(cursor ? { cursor } : {}),
    });
  }

  private async loadRemainingCards(version: number): Promise<void> {
    if (this.loadingMore() || !this.response().nextCursor) return;
    this.loadingMore.set(true);
    try {
      // A board's "Next" card is only meaningful when every matching lane item is loaded.
      // Keep each request bounded at 100, but converge the interactive board before enabling drag.
      while (version === this.requestVersion && this.response().nextCursor && this.response().cards.length < 10_000) {
        const cursor = this.response().nextCursor;
        if (!cursor) break;
        const page = await this.loadCards(cursor);
        if (version !== this.requestVersion) return;
        const current = this.response();
        const seen = new Set(current.cards.map((card) => card.id));
        this.response.set({
          ...page,
          cards: [...current.cards, ...page.cards.filter((card) => !seen.has(card.id))],
          checklistItems: current.checklistItems,
          totals: current.totals,
          separators: current.separators,
          separatorWorkspaceIds: current.separatorWorkspaceIds,
        });
        if (page.nextCursor === cursor) break;
      }
    } finally {
      this.loadingMore.set(false);
    }
  }

  /**
   * Page the whole result set into one value without publishing anything in between.
   *
   * `loadRemainingCards` is the progressive twin of this: correct for the first paint, where the
   * first hundred cards on screen beat a blank page. It is wrong for a background reconcile, which
   * has a complete board already showing — writing the first page over it collapsed the lanes to
   * 100 cards, raised the "loading all matching cards" notice above them, disabled every drop list,
   * and then grew the board back a page at a time. That is the layout jumping around after a drop.
   */
  private async loadAllCards(version: number): Promise<WorkQueryResponse> {
    const merged = await this.loadCards();
    // Only the board display needs every match at once; the table paginates behind "Load more".
    if (this.definition().display !== "board") return merged;
    const seen = new Set(merged.cards.map((card) => card.id));
    let combined = merged;
    while (version === this.requestVersion && combined.nextCursor && combined.cards.length < 10_000) {
      const cursor = combined.nextCursor;
      const page = await this.loadCards(cursor);
      const fresh = page.cards.filter((card) => !seen.has(card.id));
      for (const card of fresh) seen.add(card.id);
      combined = {
        ...page,
        cards: [...combined.cards, ...fresh],
        checklistItems: combined.checklistItems,
        totals: combined.totals,
        separators: combined.separators,
        separatorWorkspaceIds: combined.separatorWorkspaceIds,
      };
      if (page.nextCursor === cursor) break;
    }
    return combined;
  }

  /** Resolves immediately unless a card drag is in flight, in which case it waits for the drop. */
  private whenCardDragIdle(): Promise<void> {
    if (!this.cardDrag.active()) return Promise.resolve();
    return new Promise<void>((resolve) => this.dragIdleWaiters.push(resolve));
  }

  private loadPortfolio(): Promise<PortfolioSummary> {
    const definition = this.definition();
    return this.api.post<PortfolioSummary>("/work/portfolio/query", {
      scope: definition.scope,
      filters: definition.filters,
      days: definition.portfolioDays,
      // The heatmap buckets by calendar day, so the server needs the viewer's zone to decide which
      // square a late-evening event belongs to.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
  }

  private attachRealtime(): void {
    if (this.realtimeAttached) return;
    this.realtimeAttached = true;
    const socket = this.sockets.connect();
    this.socket = socket;
    const refreshCards = () => this.scheduleRealtimeRefresh(false);
    const refreshCatalog = () => this.scheduleRealtimeRefresh(true);
    this.detachRealtime = registerSocketHandlers(socket, {
      [SERVER_EVENTS.CARD_UPDATED]: ({ card }) => {
        this.patchVisibleCard(card);
        refreshCards();
      },
      [SERVER_EVENTS.CARD_MOVED]: ({ cardId, toListId, position }) => {
        this.response.update((response) => ({
          ...response,
          cards: response.cards.map((card) => card.id === cardId ? { ...card, listId: toListId, position } : card),
        }));
        refreshCards();
      },
      [SERVER_EVENTS.CARD_REBALANCED]: ({ positions }) => {
        const positionsById = new Map(positions.map((position) => [position.id, position.position]));
        this.response.update((response) => ({
          ...response,
          cards: response.cards.map((card) => {
            const position = positionsById.get(card.id);
            return position === undefined ? card : { ...card, position };
          }),
        }));
        refreshCards();
      },
      [SERVER_EVENTS.CARD_DELETED]: ({ cardId }) => {
        this.response.update((response) => ({
          ...response,
          cards: response.cards.filter((card) => card.id !== cardId),
        }));
        refreshCards();
      },
      [SERVER_EVENTS.CARD_ASSIGNEES_SET]: ({ cardId, assigneeIds }) => {
        this.response.update((response) => ({
          ...response,
          cards: response.cards.map((card) => card.id === cardId ? { ...card, assigneeIds } : card),
        }));
        refreshCards();
      },
      [SERVER_EVENTS.CARD_LABELS_SET]: ({ cardId, labelIds }) => {
        this.response.update((response) => ({
          ...response,
          cards: response.cards.map((card) => card.id === cardId ? { ...card, labelIds } : card),
        }));
        refreshCards();
      },
      [SERVER_EVENTS.CARD_CREATED]: refreshCards,
      [SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_CREATED]: refreshCards,
      [SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_UPDATED]: refreshCards,
      [SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_MOVED]: refreshCards,
      [SERVER_EVENTS.GLOBAL_WORK_SEPARATOR_DELETED]: refreshCards,
      // A bare invalidation ping: the queue is an access-filtered projection, so each client refetches
      // it under its own credentials rather than trusting a broadcast payload. Routing it through the
      // ordinary card refresh is what earns the 180 ms debounce, `whenCardDragIdle()` and the
      // hidden-tab queueing for free, and keeps both lanes in one `Promise.all`.
      [SERVER_EVENTS.CARD_PRIORITY_INVALIDATED]: ({ targetUserId }) => {
        // The viewer's own queue is service-owned and converges there; refetching it here would be
        // a second request for the same rows and a second chance for the two copies to disagree.
        if (targetUserId === this.auth.user()?.id && this.lens() !== "team") return;
        // The team lens holds every readable queue (the lanes display rides teamPriorities), so any
        // target's ping is relevant there; elsewhere only the focused person's queue is on screen.
        if (targetUserId === this.focusedTargetUserId() || this.lens() === "team") refreshCards();
      },
      [SERVER_EVENTS.CARD_VISIBILITY_GRANTED]: refreshCards,
      [SERVER_EVENTS.CARD_VISIBILITY_REVOKED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_CREATED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_UPDATED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_MOVED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_REBALANCED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_DELETED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED]: refreshCards,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED]: refreshCards,
      [SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET]: refreshCards,
      [SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED]: refreshCards,
      [SERVER_EVENTS.COMMENT_CREATED]: refreshCards,
      [SERVER_EVENTS.COMMENT_DELETED]: refreshCards,
      [SERVER_EVENTS.CARD_ATTACHMENT_CREATED]: refreshCards,
      [SERVER_EVENTS.CARD_ATTACHMENT_DELETED]: refreshCards,
      [SERVER_EVENTS.LIST_CREATED]: refreshCatalog,
      [SERVER_EVENTS.LIST_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.LIST_MOVED]: refreshCatalog,
      [SERVER_EVENTS.LIST_REBALANCED]: refreshCatalog,
      [SERVER_EVENTS.LIST_DELETED]: refreshCatalog,
      [SERVER_EVENTS.CARD_LABEL_CREATED]: refreshCatalog,
      [SERVER_EVENTS.CARD_LABEL_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.CARD_LABEL_MOVED]: refreshCatalog,
      [SERVER_EVENTS.CARD_LABEL_REBALANCED]: refreshCatalog,
      [SERVER_EVENTS.CARD_LABEL_DELETED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_CREATED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_MOVED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_REBALANCED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_DELETED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_CREATED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_MOVED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_REBALANCED]: refreshCatalog,
      [SERVER_EVENTS.CUSTOM_FIELD_OPTION_DELETED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_CREATED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_MOVED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_REBALANCED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_DELETED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_MEMBER_ADDED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_MEMBER_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.BOARD_MEMBER_REMOVED]: refreshCatalog,
      [SERVER_EVENTS.WORKSPACE_UPDATED]: ({ workspace }) => {
        this.response.update((response) => ({
          ...response,
          cards: response.cards.map((card) => card.workspaceId === workspace.id
            ? { ...card, key: `${workspace.cardKeyPrefix}-${card.number}` }
            : card),
        }));
        refreshCatalog();
      },
      [SERVER_EVENTS.WORKSPACE_DELETED]: refreshCatalog,
      [SERVER_EVENTS.WORKSPACE_MEMBER_ADDED]: refreshCatalog,
      [SERVER_EVENTS.WORKSPACE_MEMBER_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.WORKSPACE_MEMBER_REMOVED]: refreshCatalog,
      [SERVER_EVENTS.CLIENT_UPDATED]: refreshCatalog,
      [SERVER_EVENTS.CLIENT_USER_ADDED]: refreshCatalog,
      [SERVER_EVENTS.CLIENT_USER_ROLE_CHANGED]: refreshCatalog,
      [SERVER_EVENTS.CLIENT_USER_REMOVED]: refreshCatalog,
      [SERVER_EVENTS.USER_PROFILE_UPDATED]: refreshCatalog,
    });
    socket.on("connect", this.onSocketConnect);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private readonly onSocketConnect = () => {
    if (this.loading()) return;
    // Room refs are rejoined by SocketService first. Refetching after reconnect is the final
    // convergence boundary for mutations or access changes missed while disconnected. Keep this
    // status separate from routine realtime reconciliation: the latter runs after ordinary card
    // events (including the viewer's own drag echo) and must not insert a loading banner.
    this.recoveringConnection.set(true);
    this.reconciling.set(true);
    this.scheduleRealtimeRefresh(true);
  };

  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    if (this.loading()) return;
    // A foreground transition is itself a convergence boundary: browsers can suspend timers and
    // websocket delivery without producing a timely disconnect event.
    this.queuedWhileHidden = false;
    this.reconciling.set(true);
    this.scheduleRealtimeRefresh(true);
  };

  /**
   * Optimistic counterparts to the realtime handlers above, for edits made inside this page.
   *
   * They write the same fields the matching `SERVER_EVENTS.*` handler writes, so the viewer's own
   * echo is a no-op rather than a second, visibly different update. `patchVisibleCard` is shared
   * with CARD_UPDATED for exactly that reason.
   */
  applyCardUpdate(card: VisibleCardPatch): void {
    this.patchVisibleCard(card);
  }

  applyCardAssignees(cardId: string, assigneeIds: string[]): void {
    this.response.update((response) => ({
      ...response,
      cards: response.cards.map((card) => card.id === cardId ? { ...card, assigneeIds } : card),
    }));
  }

  applyCardLabels(cardId: string, labelIds: string[]): void {
    this.response.update((response) => ({
      ...response,
      cards: response.cards.map((card) => card.id === cardId ? { ...card, labelIds } : card),
    }));
  }

  private patchVisibleCard(card: VisibleCardPatch): void {
    this.response.update((response) => ({
      ...response,
      cards: response.cards.map((current) => current.id === card.id ? {
        ...current,
        listId: card.listId,
        boardId: card.boardId,
        title: card.title,
        position: card.position,
        dueDateLocalDate: card.dueDateLocalDate ?? null,
        dueDateSlot: card.dueDateSlot ?? null,
        dueDateTimezone: card.dueDateTimezone ?? null,
        completedAt: card.completedAt ? new Date(card.completedAt) : null,
        archivedAt: card.archivedAt ? new Date(card.archivedAt) : null,
        updatedAt: new Date(card.updatedAt),
      } : current),
    }));
  }

  private scheduleRealtimeRefresh(includeCatalog: boolean): void {
    this.realtimeRefreshNeedsCatalog ||= includeCatalog;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.queuedWhileHidden = true;
      return;
    }
    if (this.cardDrag.active()) {
      // The viewer's own drop is echoed straight back to them, so without this every drag ended by
      // scheduling a refetch of the board it had just moved a card on. Wait for the pointer.
      this.queuedWhileDragging = true;
      return;
    }
    if (this.realtimeRefreshTimer !== null) clearTimeout(this.realtimeRefreshTimer);
    this.realtimeRefreshTimer = setTimeout(() => {
      this.realtimeRefreshTimer = null;
      const refreshCatalog = this.realtimeRefreshNeedsCatalog || this.queuedWhileHidden;
      this.realtimeRefreshNeedsCatalog = false;
      this.queuedWhileHidden = false;
      void this.reconcileInBackground(refreshCatalog);
    }, 180);
  }

  private async reconcileInBackground(includeCatalog: boolean): Promise<void> {
    const version = ++this.requestVersion;
    this.reconciling.set(true);
    try {
      if (includeCatalog) {
        await this.refreshAll(version, { atomicCards: true });
      } else {
        const cardsRequest = this.lens() === "portfolio" && this.definition().display === "summary"
          ? Promise.resolve(EMPTY_RESPONSE)
          : this.loadAllCards(version);
        const [response, portfolio, priorities, teamPriorities] = await Promise.all([
          cardsRequest,
          this.lens() === "portfolio" ? this.loadPortfolio() : Promise.resolve(null),
          this.loadPriorities(),
          this.loadTeamPriorities(),
        ]);
        if (version !== this.requestVersion) return;
        await this.whenCardDragIdle();
        if (version !== this.requestVersion) return;
        this.response.set(response);
        if (this.lens() === "portfolio") this.portfolio.set(portfolio);
        this.otherPriorities.set(priorities);
        this.teamPriorities.set(teamPriorities);
        this.cachedAt.set(null);
        this.lastSyncedAt.set(new Date().toISOString());
        this.error.set(null);
        this.updateRooms();
        await this.persistCache();
        if (version === this.requestVersion) {
          // Work Done owns a separate query. Publishing a fresh card projection must invalidate it
          // too, otherwise ordinary card events update every Global Work display except History.
          this.reconciliationVersion.update((current) => current + 1);
        }
      }
    } catch {
      // Reconciliation is best-effort. Keep the last successful live or cached projection visible;
      // the socket watchdog, a later event, or the next foreground transition will retry.
    } finally {
      if (version === this.requestVersion) {
        this.reconciling.set(false);
        this.recoveringConnection.set(false);
      }
    }
  }

  private updateRooms(): void {
    if (!this.realtimeAttached) return;
    const scopedBoards = this.scopedBoards();
    const workspaceIds = new Set(
      scopedBoards
        .map((board) => this.catalog().workspaces.find((workspace) => workspace.id === board.workspaceId))
        .filter((workspace) => workspace?.viewerCanAccessWorkspace)
        .map((workspace) => workspace!.id),
    );
    const desiredRooms = new Map<string, () => () => void>();
    for (const board of scopedBoards) {
      desiredRooms.set(`board:${board.id}`, () => this.sockets.joinBoard(board.id));
    }
    for (const workspaceId of workspaceIds) {
      desiredRooms.set(`workspace:${workspaceId}`, () => this.sockets.joinWorkspace(workspaceId));
    }

    // Retain unchanged refs so a routine card reconcile cannot create a leave/join gap in which a
    // second event is missed. Join additions before releasing removals when the selected scope does
    // change, keeping the page subscribed throughout the transition.
    for (const [key, join] of desiredRooms) {
      if (!this.roomLeaves.has(key)) this.roomLeaves.set(key, join());
    }
    for (const [key, leave] of [...this.roomLeaves]) {
      if (desiredRooms.has(key)) continue;
      leave();
      this.roomLeaves.delete(key);
    }
  }

  private leaveRooms(): void {
    for (const leave of this.roomLeaves.values()) leave();
    this.roomLeaves.clear();
  }

  private async persistCache(): Promise<void> {
    await this.offlineCache.saveGlobalWork(
      this.cacheKey(this.lens()),
      this.definition(),
      this.catalog(),
      this.response(),
      this.portfolio(),
      this.savedViews(),
    ).catch(() => undefined);
  }

  private cacheKey(lens: WorkViewLens): string {
    const user = this.auth.user();
    return `${user?.clientId ?? "unknown"}:${user?.id ?? "unknown"}:${lens}`;
  }

  private hasUsableData(): boolean {
    return this.cachedAt() !== null || this.lastSyncedAt() !== null;
  }
}
