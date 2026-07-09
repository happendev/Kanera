import { Injectable, computed, effect, inject, signal } from "@angular/core";
import type { NotificationRow, NotificationsPage, WatcherUser } from "@kanera/shared/dto";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { ApiClient } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import { STORAGE_KEYS } from "../browser/browser-contracts";
import { registerSocketHandlers } from "../realtime/socket-handlers";
import { SocketService } from "../realtime/socket.service";
import { MentionSoundService } from "./mention-sound.service";

const PAGE_SIZE = 25;
const READ_NOTIFICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 10,080 minutes
const OFFLINE_LOAD_ERROR = "You're offline. Reconnect to refresh notifications.";
const GENERIC_LOAD_ERROR = "Couldn't refresh notifications. Try again in a moment.";
const ACTIVE_CARD_VIEW_TTL_MS = 15_000;
const ACTIVE_CARD_VIEW_HEARTBEAT_MS = 5_000;

interface ActiveCardViewEntry {
  cardId: string;
  boardId: string;
  userId: string;
  updatedAt: number;
}

@Injectable({ providedIn: "root" })
export class NotificationsService {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly sockets = inject(SocketService);
  private readonly mentionSound = inject(MentionSoundService);

  readonly items = signal<NotificationRow[]>([]);
  readonly unreadCount = signal<number>(0);
  readonly nextCursor = signal<string | null>(null);
  readonly hasMore = computed(() => this.nextCursor() !== null);
  readonly loading = signal<boolean>(false);
  readonly loadError = signal<string | null>(null);
  readonly initialised = signal<boolean>(false);
  readonly includeRead = signal<boolean>(false);
  readonly online = this.sockets.displayedOnline;
  readonly boardUnreadCounts = signal<Record<string, number>>({});
  readonly cardUnreadCounts = signal<Record<string, number>>({});
  readonly watchedCards = signal<Set<string>>(new Set());
  readonly watchedBoards = signal<Set<string>>(new Set());
  readonly cardWatchers = signal<Record<string, WatcherUser[]>>({});
  readonly boardWatchers = signal<Record<string, WatcherUser[]>>({});
  readonly boardFilter = signal<string | null>(localStorage.getItem(STORAGE_KEYS.NOTIFICATION_BOARD_FILTER) ?? null);
  readonly userFilter = signal<string | null>(localStorage.getItem(STORAGE_KEYS.NOTIFICATION_USER_FILTER) ?? null);

  private detach: (() => void) | null = null;
  private readonly unreadItems = signal<NotificationRow[]>([]);
  private readonly allItems = signal<NotificationRow[]>([]);
  private readonly unreadNextCursor = signal<string | null>(null);
  private readonly allNextCursor = signal<string | null>(null);
  private readonly activeCardBoards = signal<Record<string, string>>({});
  private readonly createdCardWatches = new Set<string>();
  private readonly activeCardViewerId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private activeCardViewSeq = 0;
  private readonly activeCardReadRequests = new Map<string, { inFlight: boolean; pending: boolean; boardId: string }>();
  private wasOnline = this.online();

  constructor() {
    this.refreshActiveCardViews();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => {
        if (event.key === STORAGE_KEYS.ACTIVE_CARD_VIEWS) this.refreshActiveCardViews();
      });
    }

    effect(() => {
      const online = this.online();
      if (!this.initialised()) {
        this.wasOnline = online;
        return;
      }
      if (online && !this.wasOnline) void this.resync();
      this.wasOnline = online;
    });
  }

  initialise(): void {
    if (this.initialised()) return;
    this.initialised.set(true);
    void this.refreshUnreadCount();
    void this.refreshBoardUnreadCounts();
    void this.refreshCardUnreadCounts();
    void this.loadWatchedCards();
    void this.loadWatchedBoards();
    this.attachSocket();
  }

  teardown(): void {
    this.detach?.();
    this.detach = null;
    this.initialised.set(false);
    this.items.set([]);
    this.unreadItems.set([]);
    this.allItems.set([]);
    this.unreadCount.set(0);
    this.boardUnreadCounts.set({});
    this.cardUnreadCounts.set({});
    this.nextCursor.set(null);
    this.unreadNextCursor.set(null);
    this.allNextCursor.set(null);
    this.loadError.set(null);
    this.watchedCards.set(new Set());
    this.watchedBoards.set(new Set());
    this.cardWatchers.set({});
    this.boardWatchers.set({});
    this.boardFilter.set(null);
    this.userFilter.set(null);
  }

  async refreshUnreadCount(): Promise<void> {
    const { count } = await this.api.get<{ count: number }>("/notifications/unread-count");
    this.unreadCount.set(count);
  }

  async refreshBoardUnreadCounts(): Promise<void> {
    const rows = await this.api.get<{ boardId: string; count: number }[]>("/notifications/board-unread-counts");
    this.boardUnreadCounts.set(Object.fromEntries(rows.map((row) => [row.boardId, row.count])));
  }

  async refreshCardUnreadCounts(): Promise<void> {
    const rows = await this.api.get<{ cardId: string; count: number }[]>("/notifications/card-unread-counts");
    this.cardUnreadCounts.set(Object.fromEntries(rows.map((row) => [row.cardId, row.count])));
  }

  async loadFirstPage(): Promise<void> {
    if (!this.online()) {
      this.loading.set(false);
      this.loadError.set(OFFLINE_LOAD_ERROR);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    const includeRead = this.includeRead();
    try {
      const page = await this.fetchNotificationsPage(includeRead);
      const visibleItems = page.items.filter((n) => this.isVisibleNotification(n));
      this.setFeed(includeRead, visibleItems, page.nextCursor);
      this.unreadCount.set(page.unreadCount);
      this.loadError.set(null);
    } catch {
      this.loadError.set(this.online() ? GENERIC_LOAD_ERROR : OFFLINE_LOAD_ERROR);
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loading()) return;
    if (!this.online()) {
      this.loading.set(false);
      this.loadError.set(OFFLINE_LOAD_ERROR);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    const includeRead = this.includeRead();
    try {
      const page = await this.fetchNotificationsPage(includeRead, cursor);
      // Dedupe defensively: a realtime upsert can land a row that a later page
      // also returns. mergeUniqueById keeps the first (already-displayed) copy,
      // so appended pages never duplicate or reorder rows already on screen.
      const nextItems = this.mergeUniqueById([...this.feedItems(includeRead), ...page.items]).filter((n) => this.isVisibleNotification(n));
      this.setFeed(includeRead, nextItems, page.nextCursor);
      this.unreadCount.set(page.unreadCount);
      this.loadError.set(null);
    } catch {
      this.loadError.set(this.online() ? GENERIC_LOAD_ERROR : OFFLINE_LOAD_ERROR);
    } finally {
      this.loading.set(false);
    }
  }

  async setIncludeRead(value: boolean): Promise<void> {
    if (this.includeRead() === value) return;
    this.includeRead.set(value);
    this.syncActiveFeed();
    await this.loadFirstPage();
  }

  private async fetchNotificationsPage(includeRead = this.includeRead(), cursor?: string): Promise<NotificationsPage> {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
    });
    if (includeRead) params.set("includeRead", "true");
    if (cursor) params.set("cursor", cursor);
    const boardId = this.boardFilter();
    if (boardId) params.set("boardId", boardId);
    const actorId = this.userFilter();
    if (actorId) params.set("actorId", actorId);
    const path = includeRead ? "/notifications" : "/notifications/unread";
    return this.api.get<NotificationsPage>(`${path}?${params.toString()}`);
  }

  private feedItems(includeRead: boolean): NotificationRow[] {
    return includeRead ? this.allItems() : this.unreadItems();
  }

  private setFeed(includeRead: boolean, items: NotificationRow[], nextCursor: string | null): void {
    if (includeRead) {
      this.allItems.set(items);
      this.allNextCursor.set(nextCursor);
    } else {
      this.unreadItems.set(items.filter((n) => !n.readAt));
      this.unreadNextCursor.set(nextCursor);
    }
    if (this.includeRead() === includeRead) this.syncActiveFeed();
  }

  private syncActiveFeed(): void {
    if (this.includeRead()) {
      this.items.set(this.allItems());
      this.nextCursor.set(this.allNextCursor());
    } else {
      this.items.set(this.unreadItems());
      this.nextCursor.set(this.unreadNextCursor());
    }
  }

  private clearFeeds(): void {
    this.unreadItems.set([]);
    this.allItems.set([]);
    this.unreadNextCursor.set(null);
    this.allNextCursor.set(null);
    this.syncActiveFeed();
  }

  async setBoardFilter(boardId: string | null): Promise<void> {
    if (this.boardFilter() === boardId) return;
    this.boardFilter.set(boardId);
    if (boardId) {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATION_BOARD_FILTER, boardId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.NOTIFICATION_BOARD_FILTER);
    }
    this.clearFeeds();
    await this.loadFirstPage();
  }

  async setUserFilter(userId: string | null): Promise<void> {
    if (this.userFilter() === userId) return;
    this.userFilter.set(userId);
    if (userId) {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATION_USER_FILTER, userId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.NOTIFICATION_USER_FILTER);
    }
    this.clearFeeds();
    await this.loadFirstPage();
  }

  async markRead(id: string): Promise<void> {
    if (!this.online()) return;
    const target = this.items().find((n) => n.id === id);
    if (!target || target.readAt) return;
    const optimisticReadAt = new Date().toISOString();
    this.applyReadLocal([id], optimisticReadAt);
    try {
      await this.api.post(`/notifications/read`, { notificationIds: [id] });
    } catch {
      // Roll back if the server rejected the update.
      this.upsertNotificationInFeeds({ ...target, readAt: null });
      this.syncActiveFeed();
      this.unreadCount.update((c) => c + 1);
      this.incrementBoardUnreadCardCount(target.boardId, target.cardId);
      this.incrementCardUnreadCount(target.cardId);
    }
  }

  async markUnread(id: string): Promise<void> {
    if (!this.online()) return;
    const target = this.items().find((n) => n.id === id);
    if (!target?.readAt) return;
    const previousReadAt = target.readAt;
    this.applyUnreadLocal([id]);
    try {
      await this.api.post(`/notifications/unread`, { notificationIds: [id] });
    } catch {
      this.upsertNotificationInFeeds({ ...target, readAt: previousReadAt });
      this.syncActiveFeed();
      this.unreadCount.update((c) => Math.max(0, c - 1));
      this.decrementBoardUnreadCardCount(target.boardId, target.cardId);
      this.decrementCardUnreadCount(target.cardId);
    }
  }

  async markAllRead(): Promise<void> {
    if (!this.online()) return;
    const readAt = new Date().toISOString();
    const unreadIds = this.items().filter((n) => !n.readAt).map((n) => n.id);
    this.applyReadLocal(unreadIds, readAt);
    this.unreadCount.set(0);
    this.boardUnreadCounts.set({});
    this.cardUnreadCounts.set({});
    try {
      await this.api.post(`/notifications/read-all`, {});
    } catch {
      await this.refreshUnreadCount();
      await this.refreshBoardUnreadCounts();
      await this.refreshCardUnreadCounts();
      await this.loadFirstPage();
    }
  }

  async markCardNotificationsRead(cardId: string, boardId: string): Promise<void> {
    if (!this.online()) return;

    const readAt = new Date();
    const hadLoadedItems = this.items().length > 0;
    const knownCardCount = this.cardUnreadCounts()[cardId] ?? 0;
    const loadedUnreadCount = this.items().filter((n) => n.cardId === cardId && !n.readAt).length;
    const unreadDelta = Math.max(knownCardCount, loadedUnreadCount);
    if (unreadDelta > 0) {
      this.allItems.update((current) =>
        current.map((n) => (n.cardId === cardId && !n.readAt ? { ...n, readAt } : n)).filter((n) => this.isVisibleNotification(n)),
      );
      this.unreadItems.update((current) => current.filter((n) => n.cardId !== cardId));
      this.syncActiveFeed();
      this.unreadCount.update((count) => Math.max(0, count - unreadDelta));
      this.decrementBoardUnreadCount(boardId);
      this.clearCardUnreadCount(cardId);
    }

    try {
      await this.api.post(`/notifications/cards/${cardId}/read`, {});
    } catch {
      await Promise.all([
        this.refreshUnreadCount().catch(() => undefined),
        this.refreshBoardUnreadCounts().catch(() => undefined),
        this.refreshCardUnreadCounts().catch(() => undefined),
      ]);
      if (hadLoadedItems) await this.loadFirstPage().catch(() => undefined);
    }
  }

  async loadWatchedCards(): Promise<void> {
    const rows = await this.api.get<{ cardId: string }[]>("/card-watches");
    const next = new Set(rows.map((r) => r.cardId));
    for (const cardId of this.createdCardWatches) next.add(cardId);
    this.watchedCards.set(next);
  }

  async loadWatchedBoards(): Promise<void> {
    const rows = await this.api.get<{ boardId: string }[]>("/board-watches");
    this.watchedBoards.set(new Set(rows.map((r) => r.boardId)));
  }

  async loadCardWatchers(cardId: string): Promise<WatcherUser[]> {
    const rows = await this.api.get<WatcherUser[]>(`/cards/${cardId}/watchers`);
    this.cardWatchers.update((current) => ({ ...current, [cardId]: rows }));
    return rows;
  }

  async loadBoardWatchers(boardId: string): Promise<WatcherUser[]> {
    const rows = await this.api.get<WatcherUser[]>(`/boards/${boardId}/watchers`);
    this.boardWatchers.update((current) => ({ ...current, [boardId]: rows }));
    return rows;
  }

  isWatchingCard(cardId: string): boolean {
    return this.watchedCards().has(cardId);
  }

  isWatchingBoard(boardId: string): boolean {
    return this.watchedBoards().has(boardId);
  }

  cardUnreadCount(cardId: string): number {
    return this.cardUnreadCounts()[cardId] ?? 0;
  }

  beginViewingCard(cardId: string, boardId: string): () => void {
    let active = true;
    const viewId = `${this.activeCardViewerId}:${++this.activeCardViewSeq}`;
    const userId = this.currentUserId();
    if (userId) this.writeActiveCardView(viewId, cardId, boardId, userId);
    this.requestActiveCardRead(cardId, boardId);
    const heartbeat = window.setInterval(() => {
      if (active && userId) this.writeActiveCardView(viewId, cardId, boardId, userId);
    }, ACTIVE_CARD_VIEW_HEARTBEAT_MS);

    return () => {
      if (!active) return;
      active = false;
      window.clearInterval(heartbeat);
      this.removeActiveCardView(viewId);
    };
  }

  watchCreatedCardLocally(cardId: string): void {
    this.createdCardWatches.add(cardId);
    this.watchedCards.update((set) => {
      if (set.has(cardId)) return set;
      const next = new Set(set);
      next.add(cardId);
      return next;
    });
  }

  async toggleCardWatch(cardId: string): Promise<void> {
    if (!this.online()) return;
    const watching = this.isWatchingCard(cardId);
    const wasCreatedWatch = this.createdCardWatches.has(cardId);
    if (watching) this.createdCardWatches.delete(cardId);
    this.watchedCards.update((set) => {
      const next = new Set(set);
      if (watching) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
    try {
      if (watching) await this.api.delete(`/cards/${cardId}/watch`);
      else await this.api.put(`/cards/${cardId}/watch`, {});
      this.updateWatcherCache("card", cardId, !watching);
    } catch {
      if (watching && wasCreatedWatch) this.createdCardWatches.add(cardId);
      this.watchedCards.update((set) => {
        const next = new Set(set);
        if (watching) next.add(cardId);
        else next.delete(cardId);
        return next;
      });
    }
  }

  async toggleBoardWatch(boardId: string): Promise<void> {
    if (!this.online()) return;
    const watching = this.isWatchingBoard(boardId);
    this.watchedBoards.update((set) => {
      const next = new Set(set);
      if (watching) next.delete(boardId);
      else next.add(boardId);
      return next;
    });
    try {
      if (watching) await this.api.delete(`/boards/${boardId}/watch`);
      else await this.api.put(`/boards/${boardId}/watch`, {});
      this.updateWatcherCache("board", boardId, !watching);
    } catch {
      this.watchedBoards.update((set) => {
        const next = new Set(set);
        if (watching) next.add(boardId);
        else next.delete(boardId);
        return next;
      });
    }
  }

  private updateWatcherCache(kind: "card" | "board", id: string, watching: boolean): void {
    const cache = kind === "card" ? this.cardWatchers : this.boardWatchers;
    cache.update((current) => {
      const rows = current[id];
      if (!rows) return current;
      const nextRows = watching
        ? this.addWatcher(rows)
        : rows.filter((watcher) => watcher.userId !== this.currentUserId());
      return { ...current, [id]: nextRows };
    });
  }

  private currentUserId(): string | null {
    return this.auth.user()?.id ?? null;
  }

  private addWatcher(rows: WatcherUser[]): WatcherUser[] {
    const userId = this.currentUserId();
    if (!userId || rows.some((watcher) => watcher.userId === userId)) return rows;
    const next = [...rows, { userId, displayName: "Me", avatarUrl: null }];
    next.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return next;
  }

  private applyReadLocal(ids: string[], readAt: string): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const readAtDate = new Date(readAt);
    const affected = this.knownNotifications(ids).filter((n) => !n.readAt);
    // Mutate only the canonical feeds and project into `items` via
    // syncActiveFeed. Updating `items` separately let the rendered order drift
    // from allItems, so the next sync would snap just-read rows to the top.
    // In-place map (no reorder); rows not in a feed reappear on the next fetch.
    this.allItems.update((current) =>
      current
        .map((n) => (idSet.has(n.id) && !n.readAt ? { ...n, readAt: readAtDate } : n))
        .filter((n) => this.isVisibleNotification(n)),
    );
    this.unreadItems.update((current) => current.filter((n) => !idSet.has(n.id)));
    this.syncActiveFeed();
    for (const row of affected) {
      this.decrementBoardUnreadCardCount(row.boardId, row.cardId);
      this.decrementCardUnreadCount(row.cardId);
    }
    if (affected.length > 0) {
      this.unreadCount.update((c) => Math.max(0, c - affected.length));
    }
  }

  private applyUnreadLocal(ids: string[]): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const affected = this.knownNotifications(ids).filter((n) => n.readAt).map((n) => ({ ...n, readAt: null }));
    this.allItems.update((current) => current.map((n) => (idSet.has(n.id) && n.readAt ? { ...n, readAt: null } : n)));
    for (const row of affected) {
      this.upsertUnreadItem(row);
      this.incrementBoardUnreadCardCount(row.boardId, row.cardId);
      this.incrementCardUnreadCount(row.cardId);
    }
    this.syncActiveFeed();
    if (affected.length > 0) {
      this.unreadCount.update((c) => c + affected.length);
    }
  }

  private knownNotifications(ids: string[]): NotificationRow[] {
    const idSet = new Set(ids);
    return this.mergeUniqueById([...this.items(), ...this.unreadItems(), ...this.allItems()]).filter((n) => idSet.has(n.id));
  }

  private upsertNotificationInFeeds(notification: NotificationRow): void {
    this.allItems.update((current) => this.upsertNotification(current, notification).filter((n) => this.isVisibleNotification(n)));
    if (notification.readAt) {
      this.unreadItems.update((current) => current.filter((n) => n.id !== notification.id));
    } else {
      this.upsertUnreadItem(notification);
    }
  }

  private upsertUnreadItem(notification: NotificationRow): void {
    if (notification.readAt || !this.isVisibleNotification(notification)) return;
    this.unreadItems.update((current) => this.upsertNotification(current, notification).filter((n) => !n.readAt));
  }

  private upsertNotification(current: NotificationRow[], notification: NotificationRow): NotificationRow[] {
    const without = current.filter((n) => n.id !== notification.id);
    return [notification, ...without];
  }

  private mergeUniqueById(items: NotificationRow[]): NotificationRow[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  private activeBoardForCard(cardId: string | null): string | null {
    if (!cardId) return null;
    return this.activeCardBoards()[cardId] ?? null;
  }

  private handleOpenCardNotification(notification: NotificationRow): boolean {
    const activeBoardId = this.activeBoardForCard(notification.cardId);
    if (!notification.cardId || !activeBoardId) return false;

    // Open-card suppression is browser-local UX state shared via localStorage.
    // The API still creates the notification because it cannot know which card
    // detail each browser tab is actively showing.
    const readAt = notification.readAt ?? new Date();
    const readNotification = { ...notification, readAt };
    if (this.includeRead() && this.isVisibleNotification(readNotification)) {
      this.upsertNotificationInFeeds(readNotification);
      this.syncActiveFeed();
    } else {
      this.allItems.update((current) => current.filter((n) => n.id !== notification.id));
      this.unreadItems.update((current) => current.filter((n) => n.id !== notification.id));
      this.syncActiveFeed();
    }
    this.requestActiveCardRead(notification.cardId, notification.boardId ?? activeBoardId);
    return true;
  }

  private requestActiveCardRead(cardId: string, boardId: string): void {
    const existing = this.activeCardReadRequests.get(cardId);
    if (existing?.inFlight) {
      existing.pending = true;
      existing.boardId = boardId;
      return;
    }

    const state = existing ?? { inFlight: false, pending: false, boardId };
    state.inFlight = true;
    state.pending = false;
    state.boardId = boardId;
    this.activeCardReadRequests.set(cardId, state);

    void this.markCardNotificationsRead(cardId, boardId)
      .catch(() => undefined)
      .finally(() => {
        state.inFlight = false;
        if (state.pending) {
          const nextBoardId = state.boardId;
          state.pending = false;
          this.activeCardReadRequests.delete(cardId);
          this.requestActiveCardRead(cardId, nextBoardId);
          return;
        }
        this.activeCardReadRequests.delete(cardId);
      });
  }

  private writeActiveCardView(viewId: string, cardId: string, boardId: string, userId: string): void {
    const now = Date.now();
    const entries = this.readActiveCardViews(now);
    entries[viewId] = { cardId, boardId, userId, updatedAt: now };
    this.persistActiveCardViews(entries);
    this.applyActiveCardViews(entries);
  }

  private removeActiveCardView(viewId: string): void {
    const entries = this.readActiveCardViews();
    delete entries[viewId];
    this.persistActiveCardViews(entries);
    this.applyActiveCardViews(entries);
  }

  private refreshActiveCardViews(): void {
    const entries = this.readActiveCardViews();
    this.applyActiveCardViews(entries);
  }

  private readActiveCardViews(now = Date.now()): Record<string, ActiveCardViewEntry> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_CARD_VIEWS) ?? "{}");
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const entries: Record<string, ActiveCardViewEntry> = {};
    for (const [viewerId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<ActiveCardViewEntry>;
      if (typeof entry.cardId !== "string" || typeof entry.boardId !== "string" || typeof entry.userId !== "string" || typeof entry.updatedAt !== "number") continue;
      if (now - entry.updatedAt > ACTIVE_CARD_VIEW_TTL_MS) continue;
      entries[viewerId] = { cardId: entry.cardId, boardId: entry.boardId, userId: entry.userId, updatedAt: entry.updatedAt };
    }
    return entries;
  }

  private persistActiveCardViews(entries: Record<string, ActiveCardViewEntry>): void {
    if (Object.keys(entries).length > 0) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_CARD_VIEWS, JSON.stringify(entries));
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_CARD_VIEWS);
    }
  }

  private applyActiveCardViews(entries: Record<string, ActiveCardViewEntry>): void {
    const userId = this.currentUserId();
    if (!userId) {
      this.activeCardBoards.set({});
      return;
    }
    const activeCards: Record<string, string> = {};
    for (const entry of Object.values(entries)) {
      // Open-card auto-read is per recipient. localStorage is shared across
      // sessions on the same browser, so never let another user's open card
      // suppress this user's notification badge for the same card.
      if (entry.userId === userId) activeCards[entry.cardId] = entry.boardId;
    }
    this.activeCardBoards.set(activeCards);
  }

  private async resync(): Promise<void> {
    await Promise.all([
      this.refreshUnreadCount().catch(() => undefined),
      this.refreshBoardUnreadCounts().catch(() => undefined),
      this.refreshCardUnreadCounts().catch(() => undefined),
      this.loadWatchedCards().catch(() => undefined),
      this.loadWatchedBoards().catch(() => undefined),
    ]);
    if (this.items().length > 0) {
      await this.loadFirstPage().catch(() => undefined);
    }
  }

  private attachSocket(): void {
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      [SERVER_EVENTS.NOTIFICATION_CREATED]: ({ notification }) => {
        if (!notification.readAt && this.handleOpenCardNotification(notification)) return;
        const visible = this.isVisibleNotification(notification);
        const alreadyKnown = this.knownNotifications([notification.id]).length > 0;
        if (visible) {
          this.upsertNotificationInFeeds(notification);
          this.syncActiveFeed();
        }
        if (!notification.readAt && !alreadyKnown) {
          // Badge counts are global app state, not panel-list state. A board or
          // actor filter can hide the row while the bell/nav counts still need to
          // reflect the incoming user-scoped notification. Board nav badges count
          // distinct unread cards, not notification rows, so a second notification
          // for the same unread card must not make the board look like two cards.
          this.unreadCount.update((c) => c + 1);
          this.incrementBoardUnreadCardCount(notification.boardId, notification.cardId);
          this.incrementCardUnreadCount(notification.cardId);
        }
        if (visible && !alreadyKnown && !notification.readAt && this.shouldPlayAttentionSound(notification)) {
          this.mentionSound.playMention();
        }
      },
      [SERVER_EVENTS.NOTIFICATION_UPDATED]: ({ notification }) => {
        if (!notification.readAt && this.handleOpenCardNotification(notification)) return;
        if (!this.isVisibleNotification(notification)) {
          this.allItems.update((current) => current.filter((n) => n.id !== notification.id));
          this.unreadItems.update((current) => current.filter((n) => n.id !== notification.id));
          this.syncActiveFeed();
          if (!notification.readAt) void this.refreshUnreadCount();
          void this.refreshBoardUnreadCounts();
          void this.refreshCardUnreadCounts();
          return;
        }
        let previousReadAt: NotificationRow["readAt"] | undefined;
        let previousBoardId: NotificationRow["boardId"] | undefined;
        let previousCardId: NotificationRow["cardId"] | undefined;
        let inserted = false;
        const previous = this.knownNotifications([notification.id])[0];
        if (previous) {
          previousReadAt = previous.readAt;
          previousBoardId = previous.boardId;
          previousCardId = previous.cardId;
        } else {
          inserted = true;
        }
        this.upsertNotificationInFeeds(previous ? { ...previous, ...notification } : notification);
        this.syncActiveFeed();
        if (!notification.readAt) {
          void this.refreshUnreadCount();
        }
        if (inserted && !notification.readAt) {
          this.incrementBoardUnreadCardCount(notification.boardId, notification.cardId);
          this.incrementCardUnreadCount(notification.cardId);
        } else if (previousReadAt !== notification.readAt || previousBoardId !== notification.boardId || previousCardId !== notification.cardId) {
          void this.refreshBoardUnreadCounts();
          void this.refreshCardUnreadCounts();
        }
      },
      [SERVER_EVENTS.NOTIFICATION_DELETED]: ({ notificationIds }) => {
        const deletedIds = new Set(notificationIds);
        this.allItems.update((current) => current.filter((notification) => !deletedIds.has(notification.id)));
        this.unreadItems.update((current) => current.filter((notification) => !deletedIds.has(notification.id)));
        this.syncActiveFeed();
        // A sibling tab may not have loaded the deleted rows, so the IDs alone
        // cannot safely produce count deltas. Re-read every badge aggregate.
        void this.refreshUnreadCount();
        void this.refreshBoardUnreadCounts();
        void this.refreshCardUnreadCounts();
      },
      [SERVER_EVENTS.NOTIFICATION_READ]: ({ notificationIds, readAt }) => {
        this.applyReadLocal(notificationIds, readAt);
        // applyReadLocal only adjusts unreadCount for items currently in the
        // signal — a sibling tab that never opened the panel won't know about
        // the affected ids, so re-sync from the server to keep the bell badge
        // honest across tabs.
        void this.refreshUnreadCount();
        void this.refreshBoardUnreadCounts();
        void this.refreshCardUnreadCounts();
      },
      [SERVER_EVENTS.NOTIFICATION_UNREAD]: ({ notificationIds }) => {
        this.applyUnreadLocal(notificationIds);
        void this.refreshUnreadCount();
        void this.refreshBoardUnreadCounts();
        void this.refreshCardUnreadCounts();
      },
      [SERVER_EVENTS.NOTIFICATION_ALL_READ]: ({ readAt }) => {
        const readAtDate = new Date(readAt);
        this.allItems.update((current) =>
          current.map((n) => (n.readAt ? n : { ...n, readAt: readAtDate })).filter((n) => this.isVisibleNotification(n)),
        );
        this.unreadItems.set([]);
        this.syncActiveFeed();
        this.unreadCount.set(0);
        this.boardUnreadCounts.set({});
        this.cardUnreadCounts.set({});
      },
    };
    this.detach = registerSocketHandlers(socket, handlers);
  }

  private shouldPlayAttentionSound(notification: NotificationRow): boolean {
    // The API uses "assigned" both for direct assignment and for activity on cards
    // already assigned to the viewer. Mentions stay explicit-attention too.
    return notification.reason === "mentioned" || notification.reason === "assigned";
  }

  private isVisibleNotification(notification: NotificationRow): boolean {
    const boardId = this.boardFilter();
    if (boardId && notification.boardId !== boardId) return false;
    const actorId = this.userFilter();
    if (actorId && notification.activity?.actorId !== actorId) return false;
    if (!notification.readAt) return true;
    return Date.now() - new Date(notification.createdAt as unknown as string).getTime() <= READ_NOTIFICATION_WINDOW_MS;
  }

  private incrementBoardUnreadCardCount(boardId: string | null, cardId: string | null): void {
    if (!boardId || !cardId || (this.cardUnreadCounts()[cardId] ?? 0) > 0) return;
    this.boardUnreadCounts.update((counts) => ({ ...counts, [boardId]: (counts[boardId] ?? 0) + 1 }));
  }

  private incrementCardUnreadCount(cardId: string | null): void {
    if (!cardId) return;
    this.cardUnreadCounts.update((counts) => ({ ...counts, [cardId]: (counts[cardId] ?? 0) + 1 }));
  }

  private decrementBoardUnreadCardCount(boardId: string | null, cardId: string | null): void {
    if (!boardId || !cardId || (this.cardUnreadCounts()[cardId] ?? 0) > 1) return;
    this.decrementBoardUnreadCount(boardId);
  }

  private decrementBoardUnreadCount(boardId: string | null): void {
    if (!boardId) return;
    this.boardUnreadCounts.update((counts) => {
      const nextCount = Math.max(0, (counts[boardId] ?? 0) - 1);
      if (nextCount > 0) return { ...counts, [boardId]: nextCount };
      const { [boardId]: _removed, ...next } = counts;
      return next;
    });
  }

  private decrementCardUnreadCount(cardId: string | null): void {
    if (!cardId) return;
    this.cardUnreadCounts.update((counts) => {
      const nextCount = Math.max(0, (counts[cardId] ?? 0) - 1);
      if (nextCount > 0) return { ...counts, [cardId]: nextCount };
      const { [cardId]: _removed, ...next } = counts;
      return next;
    });
  }

  private clearCardUnreadCount(cardId: string): void {
    this.cardUnreadCounts.update((counts) => {
      if (!(cardId in counts)) return counts;
      const { [cardId]: _removed, ...next } = counts;
      return next;
    });
  }
}
