import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";
import type { HomeDueBucket, HomeItem, HomeTodayResponse, WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";

/**
 * Bucket render order, and the trend window the server sends.
 *
 * Redeclared here rather than imported: the web bundle only takes *types* from `@kanera/shared/dto`
 * because that package's runtime entry pulls in zod. `HomeDueBucket` still types the tuple, so
 * adding a bucket server-side fails the build here rather than silently dropping a group.
 * Canonical definitions: HOME_DUE_BUCKETS / HOME_TREND_DAYS in packages/shared/src/dto/home.ts.
 */
const BUCKET_ORDER: readonly HomeDueBucket[] = ["overdue", "today", "tomorrow", "laterThisWeek"];
const TREND_DAYS = 28;

/** Trailing debounce on realtime-triggered refetches. Matches GlobalWorkState's storm control. */
const REALTIME_REFRESH_MS = 180;

/**
 * Periodic refresh while the tab is visible. Slot cut-offs (09:00 / 13:00 / 17:00 / 21:00) and
 * midnight rollover both change bucketing with no event at all, so home has to poll for them.
 */
const VISIBLE_POLL_MS = 5 * 60 * 1000;

const EMPTY_RESPONSE: HomeTodayResponse = {
  timeZone: "UTC",
  today: "",
  horizonEnd: "",
  counts: {
    overdueCards: 0,
    overdueChecklistItems: 0,
    dueTodayCards: 0,
    dueTodayChecklistItems: 0,
    dueTomorrowCards: 0,
    dueTomorrowChecklistItems: 0,
    dueLaterThisWeekCards: 0,
    dueLaterThisWeekChecklistItems: 0,
    dueWithin7DaysCards: 0,
    dueWithin7DaysChecklistItems: 0,
    assignedCards: 0,
    assignedChecklistItems: 0,
  },
  items: [],
  itemsTruncated: false,
  trend: {
    days: TREND_DAYS,
    byDay: [],
    thisWeek: { completedCards: 0 },
    lastWeek: { completedCards: 0 },
  },
  boardCount: 0,
  automationExecutionsRemaining: null,
  proUsage: null,
};

export interface HomeAgendaGroup {
  bucket: HomeDueBucket;
  label: string;
  items: HomeItem[];
  /** Exact server count for the bucket, which may exceed `items.length` when the list is capped. */
  count: number;
}

const BUCKET_LABELS: Record<HomeDueBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  laterThisWeek: "Later this week",
};

/**
 * Home's data and realtime lifecycle, provided by `HomePage` rather than at root.
 *
 * Page-provided is the correct lifetime: the agenda is discarded and refetched on navigate-away and
 * back, and every socket handler detaches with the page. Extracted from the component for the same
 * reasons `GlobalWorkState` was — a request-version guard, a race between network and IndexedDB,
 * debounced refreshes, and dynamic room membership are far easier to assert against as an object
 * than through a rendered fixture.
 */
@Injectable()
export class HomeState {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly sockets = inject(SocketService);

  readonly response = signal<HomeTodayResponse>(EMPTY_RESPONSE);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Set only when the visible data came from IndexedDB; drives the offline banner. */
  readonly cachedAt = signal<string | null>(null);
  readonly lastSyncedAt = signal<string | null>(null);
  readonly reconciling = signal(false);
  readonly online = computed(() => this.sockets.displayedOnline());

  readonly counts = computed(() => this.response().counts);
  readonly trend = computed(() => this.response().trend);
  readonly boardCount = computed(() => this.response().boardCount);
  readonly automationExecutionsRemaining = computed(() => this.response().automationExecutionsRemaining);
  readonly itemsTruncated = computed(() => this.response().itemsTruncated);

  /** Bucket counts include both entity kinds; the tiles and group badges read the same numbers. */
  readonly overdueTotal = computed(() => this.counts().overdueCards + this.counts().overdueChecklistItems);
  readonly dueTodayTotal = computed(() => this.counts().dueTodayCards + this.counts().dueTodayChecklistItems);
  readonly dueWithin7DaysTotal = computed(() =>
    this.counts().dueWithin7DaysCards + this.counts().dueWithin7DaysChecklistItems);
  readonly completedThisWeek = computed(() => this.trend().thisWeek.completedCards);
  readonly completedLastWeek = computed(() => this.trend().lastWeek.completedCards);
  readonly weekDelta = computed(() => this.completedThisWeek() - this.completedLastWeek());

  /** Groups in bucket order. A bucket with no items is omitted — an empty heading is noise here. */
  readonly groups = computed<HomeAgendaGroup[]>(() => {
    const items = this.response().items;
    const counts = this.counts();
    const bucketCounts: Record<HomeDueBucket, number> = {
      overdue: counts.overdueCards + counts.overdueChecklistItems,
      today: counts.dueTodayCards + counts.dueTodayChecklistItems,
      tomorrow: counts.dueTomorrowCards + counts.dueTomorrowChecklistItems,
      laterThisWeek: counts.dueLaterThisWeekCards + counts.dueLaterThisWeekChecklistItems,
    };
    return BUCKET_ORDER
      .map((bucket) => ({
        bucket,
        label: BUCKET_LABELS[bucket],
        items: items.filter((item) => item.bucket === bucket),
        count: bucketCounts[bucket],
      }))
      .filter((group) => group.items.length > 0);
  });

  readonly isAllClear = computed(() => this.response().items.length === 0);

  // "Your priorities" is no longer fetched or cached here: the queue is a shell-wide surface owned
  // by `MyPrioritiesService`, which the Home block reads directly. That is what makes the block, the
  // drawer and the My Cards dock the same queue rather than three copies on three cadences.

  private requestVersion = 0;
  private realtimeAttached = false;
  private socket: AppSocket | null = null;
  private detachRealtime: (() => void) | null = null;
  private roomLeaves: (() => void)[] = [];
  private joinedBoardIds = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** True when a refresh was requested while the tab was hidden; flushed on visibilitychange. */
  private queuedWhileHidden = false;

  private readonly onSocketConnect = () => {
    if (this.loading()) return;
    // Reconnect convergence: events missed while disconnected are not replayed, so the only way
    // back to a correct agenda is a full refetch.
    this.reconciling.set(true);
    this.scheduleRefresh();
  };

  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    if (this.loading()) return;
    // Foregrounding is a convergence boundary even when no event was queued: time-slot cut-offs
    // and browser suspension can both make a seemingly connected agenda stale.
    this.queuedWhileHidden = false;
    this.reconciling.set(true);
    this.scheduleRefresh();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      this.detachRealtime?.();
      this.detachRealtime = null;
      if (this.socket) this.socket.off("connect", this.onSocketConnect);
      this.leaveRooms();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
      }
    });
  }

  async initialize(): Promise<void> {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.reconciling.set(true);
    this.error.set(null);
    // Attached before the first load so `updateRooms()` has somewhere to join when it lands.
    this.attachRealtime();

    // Race the cache against the network. The cache only paints if the network has not already
    // landed, so a fast connection never flashes stale data.
    const cachedPromise = this.offlineCache.loadHomeToday(this.cacheKey())
      .then((cached) => {
        if (!cached || version !== this.requestVersion || this.cachedAt()) return;
        if (this.response() !== EMPTY_RESPONSE) return;
        this.response.set(cached.response);
        this.cachedAt.set(cached.cachedAt);
        this.lastSyncedAt.set(cached.cachedAt);
        this.updateRooms();
      })
      .catch(() => undefined);

    try {
      await this.load(version);
    } catch {
      await cachedPromise;
      // Only a hard error when there is nothing to show. With a cached snapshot the page stays
      // useful and the offline banner explains why the numbers may be stale.
      if (version === this.requestVersion && !this.cachedAt()) {
        this.error.set("We couldn’t load your day. Check your connection and try again.");
      }
    } finally {
      if (version === this.requestVersion) {
        this.loading.set(false);
        this.reconciling.set(false);
      }
    }
  }

  async retry(): Promise<void> {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.reconciling.set(true);
    this.error.set(null);
    try {
      await this.load(version);
    } catch {
      if (version === this.requestVersion && !this.cachedAt()) {
        this.error.set("We couldn’t load your day. Check your connection and try again.");
      }
    } finally {
      if (version === this.requestVersion) {
        this.loading.set(false);
        this.reconciling.set(false);
      }
    }
  }

  /** Immediate refetch, bypassing the debounce. Used by realtime handlers and by tests. */
  async refresh(): Promise<void> {
    const version = ++this.requestVersion;
    this.reconciling.set(true);
    try {
      await this.load(version);
    } catch {
      // A failed background refresh keeps the last good payload on screen rather than blanking it.
    } finally {
      if (version === this.requestVersion) this.reconciling.set(false);
    }
  }

  private async load(version: number): Promise<void> {
    // The browser zone is authoritative for a person sitting in front of the page; the server
    // falls back to their profile zone when this is unavailable.
    const timeZone = this.browserTimeZone();
    const url = timeZone ? `/home/today?timeZone=${encodeURIComponent(timeZone)}` : "/home/today";
    const response = await this.api.get<HomeTodayResponse>(url);
    if (version !== this.requestVersion) return;
    this.response.set(response);
    this.error.set(null);
    // A successful network read supersedes any cached snapshot, so the offline banner clears.
    this.cachedAt.set(null);
    this.lastSyncedAt.set(new Date().toISOString());
    this.updateRooms();
    await this.offlineCache.saveHomeToday(this.cacheKey(), response).catch(() => undefined);
  }

  private browserTimeZone(): string | null {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  }

  private attachRealtime(): void {
    if (this.realtimeAttached) return;
    this.realtimeAttached = true;
    const socket = this.sockets.connect();
    this.socket = socket;
    const refresh = () => this.scheduleRefresh();

    /**
     * Deliberately no socket-patching of the payload beyond the optimistic removals below.
     * `counts`, `bucket` and `trend` derive from per-slot, per-zone SQL plus a coalescing-aware
     * completion rule; recomputing them client-side would mean reimplementing overdueSql, the slot
     * table, the two-zone rule and the coalescing rule, which is exactly how the two drift.
     */
    this.detachRealtime = registerSocketHandlers(socket, {
      [SERVER_EVENTS.CARD_UPDATED]: ({ card }) => {
        // Completing a card in another tab should make it vanish now, not in 180ms. Only the
        // removal is optimistic; the authoritative counts and trend still come from the refetch.
        if (card.completedAt || card.archivedAt) this.dropCard(card.id);
        refresh();
      },
      [SERVER_EVENTS.CARD_DELETED]: ({ cardId }) => {
        this.dropCard(cardId);
        refresh();
      },
      [SERVER_EVENTS.CARD_MOVED]: refresh,
      [SERVER_EVENTS.CARD_ASSIGNEES_SET]: refresh,
      [SERVER_EVENTS.CARD_VISIBILITY_GRANTED]: refresh,
      [SERVER_EVENTS.CARD_VISIBILITY_REVOKED]: refresh,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED]: refresh,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED]: refresh,
      [SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED]: refresh,
      [SERVER_EVENTS.CARD_CHECKLIST_DELETED]: refresh,
      [SERVER_EVENTS.BOARD_UPDATED]: refresh,
      [SERVER_EVENTS.BOARD_DELETED]: refresh,
      // A board created elsewhere (another tab, or an AI agent bootstrapping via the public API)
      // reaches the creator's user room as board:created and, for a new workspace or standalone
      // board, workspace:member:added. Home joins no board rooms while it is empty, so these are the
      // only signals that end the getting-started state without a reload. The debounce coalesces
      // the pair into one refetch, which also updates boardCount.
      [SERVER_EVENTS.BOARD_CREATED]: refresh,
      [SERVER_EVENTS.WORKSPACE_MEMBER_ADDED]: refresh,
      [SERVER_EVENTS.WORKSPACE_DELETED]: refresh,
      // Access changes are refresh triggers, not local tree surgery: the server is the authority
      // on what the viewer can now see, and patching locally would silently diverge from it.
      [SERVER_EVENTS.BOARD_MEMBER_ADDED]: refresh,
      [SERVER_EVENTS.BOARD_MEMBER_REMOVED]: refresh,
      [SERVER_EVENTS.WORKSPACE_MEMBER_UPDATED]: refresh,
      // No priority-queue handler: the block renders `MyPrioritiesService`, which owns its own
      // realtime convergence. Reordering your queue does not change the agenda, so this page has
      // nothing to refetch for it either.
      [SERVER_EVENTS.NOTIFICATION_CREATED]: ({ notification }) => {
        // Card events are board-scoped and home only joins rooms for boards it currently shows, so
        // a first assignment on an unseen board arrives in no joined room. The user-room
        // notification is the only signal that always reaches us. These three reasons are exactly
        // the ones that can change the agenda; "mentioned"/"watching" cannot, so they must not
        // cause a refetch.
        if (
          notification.reason === "assigned"
          || notification.reason === "overdue"
          || notification.reason === "checklist_item_overdue"
        ) refresh();
      },
    });
    socket.on("connect", this.onSocketConnect);

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void this.refresh();
    }, VISIBLE_POLL_MS);
  }

  /**
   * Coalesces a burst of events into one refetch, and queues rather than fires while the tab is
   * hidden — home is the tab people leave open, and a background tab must not poll the API on every
   * event in a busy workspace.
   */
  private scheduleRefresh(): void {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.queuedWhileHidden = true;
      return;
    }
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REALTIME_REFRESH_MS);
  }

  /** Removes a card row and any checklist rows belonging to it, and decrements its bucket count. */
  private dropCard(cardId: string): void {
    this.response.update((response) => {
      const removed = response.items.filter((item) => item.cardId === cardId);
      if (removed.length === 0) return response;
      const counts = { ...response.counts };
      for (const item of removed) {
        const isCard = item.kind === "card";
        if (item.bucket === "overdue") {
          if (isCard) counts.overdueCards = Math.max(0, counts.overdueCards - 1);
          else counts.overdueChecklistItems = Math.max(0, counts.overdueChecklistItems - 1);
        } else {
          const cardKey = item.bucket === "today"
            ? "dueTodayCards"
            : item.bucket === "tomorrow" ? "dueTomorrowCards" : "dueLaterThisWeekCards";
          const itemKey = item.bucket === "today"
            ? "dueTodayChecklistItems"
            : item.bucket === "tomorrow" ? "dueTomorrowChecklistItems" : "dueLaterThisWeekChecklistItems";
          if (isCard) {
            counts[cardKey] = Math.max(0, counts[cardKey] - 1);
            counts.dueWithin7DaysCards = Math.max(0, counts.dueWithin7DaysCards - 1);
          } else {
            counts[itemKey] = Math.max(0, counts[itemKey] - 1);
            counts.dueWithin7DaysChecklistItems = Math.max(0, counts.dueWithin7DaysChecklistItems - 1);
          }
        }
        if (isCard) counts.assignedCards = Math.max(0, counts.assignedCards - 1);
      }
      return { ...response, counts, items: response.items.filter((item) => item.cardId !== cardId) };
    });
  }

  /**
   * Join one board room per distinct board on the agenda — a handful, rather than the blanket join
   * of every workspace the old home page did. The priority block's boards are not included: the
   * queue is service-owned and joins its own rooms, so counting them here would mean two owners for
   * the same subscriptions.
   *
   * Idempotent on an unchanged set: leaving and rejoining every room on every refresh would churn
   * the socket for nothing and briefly drop events between the leave and the rejoin.
   */
  private updateRooms(): void {
    if (!this.realtimeAttached) return;
    const boardIds = new Set(this.response().items.map((item) => item.boardId));
    if (boardIds.size === this.joinedBoardIds.size && [...boardIds].every((id) => this.joinedBoardIds.has(id))) {
      return;
    }
    this.leaveRooms();
    this.joinedBoardIds = boardIds;
    this.roomLeaves = [...boardIds].map((boardId) => this.sockets.joinBoard(boardId));
  }

  private leaveRooms(): void {
    for (const leave of this.roomLeaves.splice(0)) leave();
    this.joinedBoardIds = new Set();
  }

  private cacheKey(): string {
    const user = this.auth.user();
    // Per user, not just per client: the agenda is personal, unlike the shared shell snapshot.
    return `${user?.clientId ?? "unknown"}:${user?.id ?? "unknown"}`;
  }
}
