import { computed, effect, inject, Injectable, signal } from "@angular/core";
import { cardPath } from "@kanera/shared/card-links";
import type {
  WorkCatalog,
  WorkPrioritiesResponse,
  WorkPriorityItem,
  WorkQueryResponse,
} from "@kanera/shared/dto";
import { SERVER_EVENTS, type ServerToClientEvents, type WireCard } from "@kanera/shared/events";
import { CardDragCoordinator } from "../../features/board/card-drag-coordinator.service";
import type { PriorityAddableCard } from "../../shared/priority-queue/priority-add-cards";
import {
  reorderedQueueItems,
  type PriorityAnchor,
} from "../../shared/priority-queue/priority-queue-math";
import { ApiClient } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import { viewPreferenceKey } from "../browser/browser-contracts";
import { registerSocketHandlers } from "../realtime/socket-handlers";
import { SocketService } from "../realtime/socket.service";

const OFFLINE_LOAD_ERROR = "You're offline. Reconnect to see what's next.";
const GENERIC_LOAD_ERROR = "Couldn't load Up next. Try again in a moment.";
/**
 * One refetch per burst. The same 180 ms the Global Work and Home consumers use, so a drag that
 * fires several moves costs one round trip on every surface.
 */
const INVALIDATION_DEBOUNCE_MS = 180;
export const MAX_UP_NEXT_ENTRIES = 50;

/**
 * The signed-in user's own "Up next" queue, app-wide.
 *
 * One instance, owned by the shell rather than by any page, because the queue is now a first-class
 * personal surface: the drawer opens it from anywhere, Home renders its head, and the My Cards dock
 * curates it. A single service is what makes those three impossible to disagree — there is no second
 * copy to keep in sync.
 *
 * Deliberately *not* cached offline. A stale sequence reads as an instruction, and someone following
 * "do this first" from last week's order has no way to tell; every surface withholds the queue when
 * offline rather than showing ranks it cannot vouch for.
 *
 * Only ever the viewer's own queue. Somebody else's — the Team Cards lanes, a focused teammate on
 * Team Cards — stays with `GlobalWorkState`, which holds the credentials-scoped, redaction-aware
 * copies those surfaces need.
 */
@Injectable({ providedIn: "root" })
export class MyPrioritiesService {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly sockets = inject(SocketService);
  private readonly cardDrag = inject(CardDragCoordinator);

  readonly queue = signal<WorkPrioritiesResponse | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly initialised = signal(false);
  readonly online = this.sockets.displayedOnline;

  readonly items = computed<WorkPriorityItem[]>(() => this.queue()?.items ?? []);
  readonly totalCount = computed(() => this.queue()?.totalCount ?? 0);
  readonly canReorder = computed(() => this.queue()?.canReorder ?? false);
  readonly atCapacity = computed(() => this.totalCount() >= MAX_UP_NEXT_ENTRIES);
  /** Single source of truth for "is this card ranked?" wherever the viewer's own queue is read. */
  readonly rankedCardIds = computed(
    () => new Set(this.items().flatMap((item) => (item.card ? [item.card.id] : []))),
  );
  readonly ranksByCardId = computed<Map<string, number>>(() =>
    new Map(this.items().flatMap((item) => (item.card ? [[item.card.id, item.rank] as const] : []))),
  );

  /** Candidate pool for the drawer's "Add card", loaded lazily and only while the drawer is open. */
  readonly addCandidates = signal<PriorityAddableCard[]>([]);
  readonly addCandidatesLoaded = signal(false);
  readonly addableCards = computed<PriorityAddableCard[]>(() => {
    if (!this.canReorder() || this.atCapacity()) return [];
    const ranked = this.rankedCardIds();
    return this.addCandidates().filter((card) => !ranked.has(card.id));
  });

  /**
   * "Your queue changed since you last looked at it", for the drawer trigger's pulse.
   *
   * The signature is the ordered entry ids, so a reorder pulses but an unrelated card edit does not.
   * Stored per viewer in localStorage rather than on the server — a read receipt is viewer-local
   * chrome, and losing it costs one spurious pulse. Same key the Global Work dock has always used
   * (`upNextSeen` for viewer:viewer), so nobody's pulse resets when this ships.
   */
  private readonly seenSignature = signal<string | null>(null);
  private readonly signature = computed(() => this.items().map((item) => item.id).join("|"));
  readonly changedSinceSeen = computed(() =>
    this.signature() !== "" && this.seenSignature() !== this.signature(),
  );

  private detach: (() => void) | null = null;
  private roomLeaves: (() => void)[] = [];
  private joinedBoardIds = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private requestVersion = 0;
  /**
   * A socket-driven change that arrived mid-drag. Applying it would reorder the queue under the
   * pointer, so it is held and flushed as one refetch when the gesture ends.
   */
  private pendingResync = false;
  /** The newest snapshot applied, so a late one that overtook it in flight is discarded. */
  private appliedSnapshotAt: string | null = null;
  private wasOnline = this.online();

  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !this.initialised()) return;
    // Foregrounding is a convergence boundary even when no event was missed: a suspended tab can
    // hold a socket that never noticed it went away.
    void this.refresh();
  };

  constructor() {
    // Reconnecting is the other convergence boundary: events missed while offline are not replayed.
    effect(() => {
      const online = this.online();
      if (!this.initialised()) {
        this.wasOnline = online;
        return;
      }
      if (online && !this.wasOnline) void this.refresh();
      this.wasOnline = online;
    });
    // Releasing a drag is when held work becomes safe to apply. See `pendingResync`.
    effect(() => {
      if (this.cardDrag.active() || !this.pendingResync) return;
      this.pendingResync = false;
      void this.refresh();
    });
  }

  initialise(): void {
    if (this.initialised()) return;
    this.initialised.set(true);
    this.restoreSeenSignature();
    void this.refresh();
    this.attachSocket();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  /** Called when the organisation switches: every id in the queue belongs to the old tenant. */
  teardown(): void {
    this.detach?.();
    this.detach = null;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.leaveRooms();
    // Bump the version so an in-flight response cannot land into the next organisation's session.
    this.requestVersion += 1;
    this.initialised.set(false);
    this.queue.set(null);
    this.loading.set(false);
    this.loadError.set(null);
    this.addCandidates.set([]);
    this.addCandidatesLoaded.set(false);
    this.appliedSnapshotAt = null;
    this.pendingResync = false;
  }

  async refresh(): Promise<void> {
    const userId = this.auth.user()?.id;
    if (!userId) return;
    if (!this.online()) {
      this.loading.set(false);
      this.loadError.set(OFFLINE_LOAD_ERROR);
      return;
    }
    const version = ++this.requestVersion;
    this.loading.set(true);
    try {
      const response = await this.api.get<WorkPrioritiesResponse>(`/work/priorities/${userId}`);
      if (version !== this.requestVersion) return;
      this.applyQueue(response);
      this.loadError.set(null);
    } catch {
      if (version !== this.requestVersion) return;
      this.loadError.set(this.online() ? GENERIC_LOAD_ERROR : OFFLINE_LOAD_ERROR);
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }

  /**
   * Every mutation settles by replacing the whole queue with the response rather than patching one
   * entry: a concurrent reorder by a manager is then already folded in, and there is no window where
   * the ranks on screen disagree with the server's. On failure the pre-gesture snapshot is restored
   * and the error is the caller's to surface, next to the row that failed.
   */
  async addPriority(cardId: string, anchor: PriorityAnchor): Promise<void> {
    const userId = this.auth.user()?.id;
    if (!userId) return;
    const snapshot = this.queue();
    this.applyOptimistic(null, cardId, anchor);
    try {
      this.applyQueue(await this.api.post<WorkPrioritiesResponse>(
        `/work/priorities/${userId}/cards`,
        { cardId, ...anchor },
      ));
    } catch (error) {
      this.queue.set(snapshot);
      throw error;
    }
  }

  async movePriority(priorityId: string, anchor: PriorityAnchor): Promise<void> {
    const snapshot = this.queue();
    this.applyOptimistic(priorityId, null, anchor);
    try {
      this.applyQueue(await this.api.post<WorkPrioritiesResponse>(
        `/card-priorities/${priorityId}/move`,
        anchor,
      ));
    } catch (error) {
      this.queue.set(snapshot);
      throw error;
    }
  }

  async removePriority(priorityId: string): Promise<void> {
    const snapshot = this.queue();
    this.queue.update((queue) => queue && {
      ...queue,
      items: queue.items.filter((item) => item.id !== priorityId).map((item, index) => ({ ...item, rank: index + 1 })),
      totalCount: Math.max(0, queue.totalCount - 1),
    });
    try {
      this.applyQueue(await this.api.delete<WorkPrioritiesResponse>(`/card-priorities/${priorityId}`));
    } catch (error) {
      this.queue.set(snapshot);
      throw error;
    }
  }

  /**
   * Quick-complete from a queue row. Completing drops the card out of the live queue server-side,
   * which arrives as the ordinary snapshot/invalidation — so nothing is patched here beyond the
   * card's own completion state, which keeps the row from flashing "incomplete" until it does.
   */
  async setCardCompleted(cardId: string, completed: boolean): Promise<void> {
    const snapshot = this.queue();
    this.patchCard(cardId, (card) => ({ ...card, completedAt: completed ? new Date() : null }));
    try {
      await this.api.patch<WireCard>(`/cards/${cardId}/completion`, { completed });
    } catch (error) {
      this.queue.set(snapshot);
      throw error;
    }
  }

  /**
   * The drawer's candidate pool: every active card assigned to the viewer, anywhere they can see.
   *
   * Paged to exhaustion because a disabled Add button must mean there truly are no eligible cards,
   * not merely none in the first page. Deliberately lazy and once per drawer session — this is two
   * requests nobody who never opens the drawer should pay for. The catalog supplies board and list
   * names, which `/work/cards/query` does not carry.
   */
  async loadAddCandidates(): Promise<void> {
    if (this.addCandidatesLoaded() || !this.online()) return;
    this.addCandidatesLoaded.set(true);
    const version = this.requestVersion;
    try {
      const [catalog, cards] = await Promise.all([
        this.api.get<WorkCatalog>("/work/catalog"),
        this.loadAssignedCards(),
      ]);
      if (version !== this.requestVersion) return;
      const boardsById = new Map(catalog.boards.map((board) => [board.id, board]));
      const listsById = new Map(catalog.lists.map((list) => [list.id, list]));
      this.addCandidates.set(cards.flatMap((card) => {
        const board = boardsById.get(card.boardId);
        // A card whose board is not in this viewer's catalog cannot be presented honestly (no board
        // name to disambiguate it in a cross-board list), so it is left out of the picker.
        if (!board) return [];
        return [{
          id: card.id,
          title: card.title,
          boardId: card.boardId,
          boardName: board.name,
          boardIcon: board.icon,
          boardIconColor: board.iconColor,
          listName: listsById.get(card.listId)?.name ?? "",
        }];
      }));
    } catch {
      // A failed candidate load leaves the picker empty and retryable on the next open; it must
      // never take the queue itself down with it.
      this.addCandidatesLoaded.set(false);
    }
  }

  /**
   * Teach the service about one card a *caller* can already see, so an add made outside the drawer
   * renders an optimistic row with its title and board trail. The drawer's own pool is lazy, and a
   * dock add must not have to wait for it.
   */
  rememberCandidate(card: PriorityAddableCard): void {
    this.addCandidates.update((current) =>
      current.some((candidate) => candidate.id === card.id) ? current : [...current, card],
    );
  }

  private async loadAssignedCards(): Promise<WorkQueryResponse["cards"]> {
    const cards: WorkQueryResponse["cards"] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.post<WorkQueryResponse>("/work/cards/query", {
        lens: "my",
        scope: { allAccessible: true, organisationIds: [], workspaceIds: [], boardIds: [] },
        filters: { assigneeIds: [], labelIds: [], listIds: [], customFieldValues: [], state: "active" },
        sort: "dueAsc",
        limit: 100,
        includeMetadata: false,
        ...(cursor ? { cursor } : {}),
      });
      const seen = new Set(cards.map((card) => card.id));
      cards.push(...page.cards.filter((card) => !seen.has(card.id)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && cards.length < 10_000);
    return cards;
  }

  /**
   * The shareable `/o/KEY/c/KEY-12` path for a queued card, for hosts navigating to it.
   *
   * Null when the entry is optimistic or unknown — the caller then navigates to the routed
   * `/b/:boardId/c/:cardId` form alone, which still opens the right card.
   */
  cardBrowserUrl(cardId: string): string | null {
    const card = this.items().find((item) => item.card?.id === cardId)?.card;
    return card ? cardPath(card.organisationKey, card.key) : null;
  }

  markSeen(): void {
    const key = this.seenKey();
    const signature = this.signature();
    this.seenSignature.set(signature);
    if (!key) return;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, signature);
    } catch {
      // Storage can be unavailable in privacy mode; the pulse just resets next visit.
    }
  }

  private seenKey(): string | null {
    const viewerId = this.auth.user()?.id;
    // Keyed (viewer, target) with both the same person, matching the Global Work dock's own key so
    // an existing read receipt carries over rather than pulsing once for everybody on release.
    return viewerId ? viewPreferenceKey("upNextSeen", `${viewerId}:${viewerId}`) : null;
  }

  private restoreSeenSignature(): void {
    const key = this.seenKey();
    try {
      this.seenSignature.set(key && typeof localStorage !== "undefined" ? localStorage.getItem(key) : null);
    } catch {
      this.seenSignature.set(null);
    }
  }

  private applyQueue(response: WorkPrioritiesResponse): void {
    this.queue.set(response);
    // A REST read is newer than anything already applied, so it also resets the snapshot watermark;
    // otherwise a settled mutation would be undone by a snapshot that predates it.
    this.appliedSnapshotAt = null;
    this.updateRooms();
  }

  private applyOptimistic(priorityId: string | null, cardId: string | null, anchor: PriorityAnchor): void {
    const queue = this.queue();
    if (!queue) return;
    const candidate = cardId ? this.addCandidates().find((card) => card.id === cardId) ?? null : null;
    const moving = priorityId
      ? queue.items.find((item) => item.id === priorityId)
      : cardId && candidate
        ? {
            id: `pending:${cardId}`,
            // The row renders from `context` until the server answers; the card body arrives with
            // that response, so an optimistic add shows its title and board without one.
            card: null,
            context: {
              boardName: candidate.boardName,
              boardIcon: candidate.boardIcon,
              boardIconColor: candidate.boardIconColor as never,
              listName: candidate.listName,
              workspaceName: "",
            },
            rank: 0,
            position: "0",
          } satisfies WorkPriorityItem
        : undefined;
    if (!moving) return;
    const rest = queue.items.filter((item) => item.id !== priorityId);
    const items = reorderedQueueItems(rest, moving, anchor);
    this.queue.set({ ...queue, items, totalCount: items.length });
  }

  private patchCard(cardId: string, patch: (card: NonNullable<WorkPriorityItem["card"]>) => NonNullable<WorkPriorityItem["card"]>): void {
    this.queue.update((queue) => queue && {
      ...queue,
      items: queue.items.map((item) => (item.card?.id === cardId ? { ...item, card: patch(item.card) } : item)),
    });
  }

  private attachSocket(): void {
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      /**
       * The fast path: the server pushes the viewer's whole queue after any change to it. Applied in
       * place, so a reorder made in another tab lands without a round trip.
       */
      [SERVER_EVENTS.CARD_PRIORITY_QUEUE_CHANGED]: (snapshot) => {
        if (snapshot.targetUserId !== this.auth.user()?.id) return;
        // Two mutations can drain from the outbox out of order; a snapshot older than the one
        // already applied would resurrect the previous order.
        if (this.appliedSnapshotAt && snapshot.snapshotAt <= this.appliedSnapshotAt) return;
        if (this.cardDrag.active()) {
          this.pendingResync = true;
          return;
        }
        this.appliedSnapshotAt = snapshot.snapshotAt;
        this.queue.update((queue) => ({
          // `canReorder`/`reorderableWorkspaceIds` are properties of this *viewer's* credentials,
          // which the snapshot does not carry — the queue is the viewer's own, so they are already
          // correct and must survive the swap. Before the first REST read there is no such value,
          // and the concurrent `refresh()` supplies it a moment later.
          canReorder: queue?.canReorder ?? false,
          reorderableWorkspaceIds: queue?.reorderableWorkspaceIds ?? [],
          targetUserId: snapshot.targetUserId,
          items: snapshot.items,
          totalCount: snapshot.totalCount,
          // Never redacted for the target — the snapshot is only ever sent to them.
          hiddenCount: 0,
        }));
        this.updateRooms();
      },
      /**
       * The convergence fallback, kept alongside the snapshot rather than replaced by it: an older
       * API that emits only this ping still keeps every surface correct, just one round trip slower.
       * Debounced, so a burst of reorders costs one refetch.
       */
      [SERVER_EVENTS.CARD_PRIORITY_INVALIDATED]: ({ targetUserId }) => {
        // Managers also receive invalidations for teammate queues they may curate; this service
        // holds only the viewer's own.
        if (targetUserId !== this.auth.user()?.id) return;
        this.scheduleRefresh();
      },
      // Card edits (a retitled or rescheduled queued card) are ordinary board events. They reach us
      // because `updateRooms()` joins a room per queued card's board — which is why the queue itself
      // needs no extra server fanout for them.
      //
      // Field-by-field, never a spread: both wire shapes *omit* null fields to stay small, so
      // `{...current, ...card}` would silently keep a due date the edit had just cleared. Only the
      // fields a queue row renders are copied; the rest of the summary (counts, cover, labels) is
      // not on this payload at all and must survive untouched.
      [SERVER_EVENTS.CARD_UPDATED]: ({ card }) => {
        this.patchCard(card.id, (current) => ({
          ...current,
          title: card.title,
          listId: card.listId,
          boardId: card.boardId,
          position: card.position,
          updatedAt: card.updatedAt,
          dueDateLocalDate: card.dueDateLocalDate ?? null,
          dueDateSlot: card.dueDateSlot ?? null,
          dueDateTimezone: card.dueDateTimezone ?? null,
          completedAt: card.completedAt ?? null,
          archivedAt: card.archivedAt ?? null,
        }));
      },
      [SERVER_EVENTS.CARD_DELETED]: ({ cardId }) => {
        this.queue.update((queue) => queue && {
          ...queue,
          items: queue.items.filter((item) => item.card?.id !== cardId).map((item, index) => ({ ...item, rank: index + 1 })),
          totalCount: Math.max(0, queue.totalCount - (queue.items.some((item) => item.card?.id === cardId) ? 1 : 0)),
        });
      },
    };
    this.detach = registerSocketHandlers(socket, handlers);
    socket.on("connect", this.onSocketConnect);
  }

  private readonly onSocketConnect = () => {
    if (!this.initialised()) return;
    void this.refresh();
  };

  private scheduleRefresh(): void {
    if (this.cardDrag.active()) {
      this.pendingResync = true;
      return;
    }
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, INVALIDATION_DEBOUNCE_MS);
  }

  /**
   * One board room per distinct board in the queue, so a queued card's title or due-date change
   * arrives live. Idempotent on an unchanged set: snapshots and refetches both call this, and
   * leaving then rejoining every room each time would churn the socket and briefly drop events.
   */
  private updateRooms(): void {
    if (!this.initialised()) return;
    const boardIds = new Set(this.items().flatMap((item) => (item.card ? [item.card.boardId] : [])));
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
}
