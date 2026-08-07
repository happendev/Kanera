import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { HomeItem, HomeTodayResponse, WorkPrioritiesResponse } from "@kanera/shared/dto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { HomeState } from "./home.state";

type Handler = (payload?: never) => void;

class SocketStub {
  readonly handlers = new Map<string, Handler>();
  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });
  readonly off = vi.fn((event: string) => {
    this.handlers.delete(event);
    return this;
  });

  trigger(event: string, payload?: unknown): void {
    this.handlers.get(event)?.(payload as never);
  }
}

function item(overrides: Partial<HomeItem> = {}): HomeItem {
  return {
    kind: "card",
    id: "card-1",
    cardId: "card-1",
    cardKey: "WORK-1",
    title: "Ship the thing",
    cardTitle: null,
    bucket: "today",
    boardId: "board-1",
    boardName: "Roadmap",
    boardIcon: null,
    boardIconColor: null,
    workspaceId: "workspace-1",
    workspaceName: "Delivery",
    guestOrganisationName: null,
    listId: "list-1",
    listName: "Doing",
    labels: [],
    dueDateLocalDate: "2026-07-26",
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
    ...overrides,
    organisationKey: overrides.organisationKey ?? "0123456789ABCDEF",
  };
}

function payload(overrides: Partial<HomeTodayResponse> = {}): HomeTodayResponse {
  return {
    timeZone: "UTC",
    today: "2026-07-26",
    horizonEnd: "2026-08-02",
    counts: {
      overdueCards: 1,
      overdueChecklistItems: 0,
      dueTodayCards: 1,
      dueTodayChecklistItems: 0,
      dueTomorrowCards: 0,
      dueTomorrowChecklistItems: 0,
      dueLaterThisWeekCards: 0,
      dueLaterThisWeekChecklistItems: 0,
      dueWithin7DaysCards: 1,
      dueWithin7DaysChecklistItems: 0,
      assignedCards: 4,
      assignedChecklistItems: 1,
    },
    items: [
      item({ id: "card-overdue", cardId: "card-overdue", bucket: "overdue", title: "Late" }),
      item(),
    ],
    itemsTruncated: false,
    trend: {
      days: 28,
      byDay: [{ date: "2026-07-25", completedCards: 2 }],
      thisWeek: { completedCards: 5 },
      lastWeek: { completedCards: 3 },
    },
    boardCount: 3,
    automationExecutionsRemaining: null,
    proUsage: null,
    ...overrides,
  };
}

/** Two entries whose ranks are 1 and 3: #2 is completed, and Home drops completed entries. */
function priorityPayload(): WorkPrioritiesResponse {
  return {
    targetUserId: "user-1",
    items: [
      {
        id: "priority-1",
        position: "1000.0000000000",
        rank: 1,
        card: {
          id: "card-1",
          number: 1,
          key: "WORK-1",
          organisationKey: "0123456789ABCDEF",
          boardId: "board-1",
          workspaceId: "workspace-1",
          listId: "list-1",
          title: "Ship the thing",
          position: "1000.0000000000",
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        context: {
          boardName: "Roadmap",
          boardIcon: null,
          boardIconColor: null,
          listName: "Doing",
          workspaceName: "Delivery",
        },
      },
    ],
    totalCount: 2,
    hiddenCount: 0,
    canReorder: true,
    reorderableWorkspaceIds: ["workspace-1"],
  };
}

function setup(options: {
  apiFails?: boolean;
  cached?: { key: string; cachedAt: string; response: HomeTodayResponse } | null;
  priorities?: WorkPrioritiesResponse;
  cachedPriorities?: { key: string; cachedAt: string; response: WorkPrioritiesResponse } | null;
  /** Overrides `cachedPriorities` with a promise the test resolves itself, to stage a slow cache. */
  cachedPrioritiesPromise?: Promise<{ key: string; cachedAt: string; response: WorkPrioritiesResponse } | null>;
} = {}) {
  const socket = new SocketStub();
  const leaveBoard = vi.fn();
  const joinBoard = vi.fn(() => leaveBoard);
  const get = vi.fn(async (path: string) => {
    if (options.apiFails) throw new Error("offline");
    if (path.startsWith("/home/today")) return payload();
    if (path.startsWith("/work/priorities/")) return options.priorities ?? priorityPayload();
    throw new Error(`unexpected GET ${path}`);
  });
  const saveHomeToday = vi.fn(async () => undefined);
  const loadHomeToday = vi.fn(async () => options.cached ?? null);
  const saveHomePriorities = vi.fn(async () => undefined);
  const loadHomePriorities = vi.fn(() => options.cachedPrioritiesPromise ?? Promise.resolve(options.cachedPriorities ?? null));
  const user = signal({ id: "user-1", clientId: "client-1", displayName: "Viewer" });

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      HomeState,
      { provide: ApiClient, useValue: { get } },
      { provide: AuthService, useValue: { user: user.asReadonly() } },
      { provide: OfflineCacheService, useValue: { saveHomeToday, loadHomeToday, saveHomePriorities, loadHomePriorities } },
      {
        provide: SocketService,
        useValue: { connect: vi.fn(() => socket), joinBoard, displayedOnline: signal(true) },
      },
    ],
  });

  return {
    state: TestBed.inject(HomeState),
    socket,
    get,
    joinBoard,
    leaveBoard,
    saveHomeToday,
    loadHomeToday,
    saveHomePriorities,
  };
}

/**
 * Agenda requests only. `get` also serves the priority queue, which rides alongside the agenda on
 * the same triggers, so a raw call count would no longer measure agenda refetches.
 */
function agendaCalls(get: { mock: { calls: unknown[][] } }): number {
  return get.mock.calls.filter(([path]) => String(path).startsWith("/home/today")).length;
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
}

describe("HomeState", () => {
  beforeEach(() => {
    setVisibility("visible");
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it("loads the agenda, groups it in bucket order and caches the payload", async () => {
    const f = setup();
    await f.state.initialize();

    expect(agendaCalls(f.get)).toBe(1);
    expect(f.state.groups().map((group) => group.bucket)).toEqual(["overdue", "today"]);
    expect(f.state.error()).toBeNull();
    expect(f.state.cachedAt()).toBeNull();
    expect(f.state.loading()).toBe(false);
    expect(f.saveHomeToday).toHaveBeenCalledWith("client-1:user-1", payload());
    // One room per distinct board in the agenda, not a blanket join.
    expect(f.joinBoard).toHaveBeenCalledTimes(1);
    expect(f.joinBoard).toHaveBeenCalledWith("board-1");
  });

  it("omits buckets with no items and reports the exact server count per group", async () => {
    const f = setup();
    await f.state.initialize();

    const groups = f.state.groups();
    expect(groups.some((group) => group.bucket === "tomorrow")).toBe(false);
    expect(groups.find((group) => group.bucket === "overdue")!.count).toBe(1);
    expect(f.state.weekDelta()).toBe(2);
  });

  it("coalesces a burst of card events into exactly one refetch", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    expect(agendaCalls(f.get)).toBe(1);

    for (let index = 0; index < 5; index += 1) {
      f.socket.trigger("card:updated", { card: { id: `card-${index}`, completedAt: null, archivedAt: null } });
      vi.advanceTimersByTime(20);
    }
    expect(agendaCalls(f.get)).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(agendaCalls(f.get)).toBe(2);
  });

  it("removes a completed card optimistically, before the debounced refetch runs", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();

    f.socket.trigger("card:updated", {
      card: { id: "card-1", completedAt: "2026-07-26T10:00:00.000Z", archivedAt: null },
    });

    // Synchronously gone, and its bucket count decremented — no waiting for the network.
    expect(f.state.response().items.map((row) => row.id)).toEqual(["card-overdue"]);
    expect(f.state.counts().dueTodayCards).toBe(0);
    expect(f.state.counts().assignedCards).toBe(3);
    expect(agendaCalls(f.get)).toBe(1);
  });

  it("drops a checklist row when its parent card is deleted", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    f.state.response.update((response) => ({
      ...response,
      items: [...response.items, item({ kind: "checklistItem", id: "item-1", cardId: "card-1", cardTitle: "Ship the thing" })],
    }));

    f.socket.trigger("card:deleted", { cardId: "card-1" });

    expect(f.state.response().items.map((row) => row.id)).toEqual(["card-overdue"]);
  });

  it("refetches for an assignment notification but not for a mention", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();

    f.socket.trigger("notification:created", { notification: { reason: "mentioned" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(1);

    f.socket.trigger("notification:created", { notification: { reason: "watching" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(1);

    // A first assignment on a board home has not joined arrives only as a user-room notification.
    f.socket.trigger("notification:created", { notification: { reason: "assigned" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(2);

    f.socket.trigger("notification:created", { notification: { reason: "checklist_item_overdue" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(3);
  });

  it("refetches on reconnect rather than assuming missed events were replayed", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();

    f.socket.trigger("connect");
    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(2);
  });

  it("treats an access change as a refresh trigger, not local tree surgery", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    const before = f.state.response().items;

    f.socket.trigger("board:member:removed", { boardId: "board-1", userId: "user-1" });
    // Nothing is removed locally — the server decides what the viewer can still see.
    expect(f.state.response().items).toBe(before);

    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(2);
  });

  it("queues refreshes while the tab is hidden and flushes exactly one on return", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();

    setVisibility("hidden");
    for (let index = 0; index < 4; index += 1) {
      f.socket.trigger("card:moved", { cardId: `card-${index}` });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(agendaCalls(f.get)).toBe(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(400);
    expect(agendaCalls(f.get)).toBe(2);
  });

  it("refreshes on foreground resume even when no realtime event was queued", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    expect(agendaCalls(f.get)).toBe(1);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(400);

    expect(agendaCalls(f.get)).toBe(2);
    expect(f.state.reconciling()).toBe(false);
  });

  it("rejoins the boards in the newest agenda plus the priority queue's", async () => {
    const f = setup();
    await f.state.initialize();
    expect(f.joinBoard).toHaveBeenCalledTimes(1);

    f.get.mockResolvedValueOnce(payload({
      items: [item({ boardId: "board-2" }), item({ id: "card-3", cardId: "card-3", boardId: "board-3" })],
    }));
    await f.state.refresh();

    // The old membership is replaced by the union of the new agenda's boards and the queue's: the
    // priorities response still shows a board-1 card, so its room survives the agenda change.
    expect(f.leaveBoard).toHaveBeenCalled();
    const rejoined = (f.joinBoard.mock.calls as unknown[][]).slice(1).map((call) => call[0]);
    expect([...rejoined].sort()).toEqual(["board-1", "board-2", "board-3"]);
  });

  it("falls back to the cached snapshot without surfacing an error", async () => {
    const cachedResponse = payload({ items: [item({ id: "cached-card", cardId: "cached-card" })] });
    const f = setup({
      apiFails: true,
      cached: { key: "client-1:user-1", cachedAt: "2026-07-26T08:00:00.000Z", response: cachedResponse },
    });
    await f.state.initialize();

    expect(f.state.error()).toBeNull();
    expect(f.state.cachedAt()).toBe("2026-07-26T08:00:00.000Z");
    expect(f.state.response().items.map((row) => row.id)).toEqual(["cached-card"]);
  });

  it("surfaces an error only when there is nothing cached, and retry clears it", async () => {
    const f = setup({ apiFails: true });
    await f.state.initialize();

    expect(f.state.error()).not.toBeNull();
    expect(f.state.response().items).toEqual([]);

    f.get.mockImplementation(async () => payload());
    await f.state.retry();

    expect(f.state.error()).toBeNull();
    expect(f.state.response().items).toHaveLength(2);
    expect(f.state.loading()).toBe(false);
  });

  it("ignores a slow response once a newer request has started", async () => {
    const f = setup();
    const stale = payload({ items: [item({ id: "stale", cardId: "stale" })], boardCount: 99 });
    let releaseStale: (() => void) | null = null;
    f.get.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseStale = resolve; });
      return stale;
    });

    const first = f.state.initialize();
    const second = f.state.refresh();
    await second;
    releaseStale!();
    await first;

    // The newer response wins even though the older request settled last.
    expect(f.state.boardCount()).toBe(3);
    expect(f.state.response().items.map((row) => row.id)).toEqual(["card-overdue", "card-1"]);
  });

  it("does not paint the cache over a network response that already landed", async () => {
    const f = setup({
      cached: {
        key: "client-1:user-1",
        cachedAt: "2026-07-26T08:00:00.000Z",
        response: payload({ items: [item({ id: "cached-card", cardId: "cached-card" })] }),
      },
    });
    await f.state.initialize();

    expect(f.state.cachedAt()).toBeNull();
    expect(f.state.response().items.map((row) => row.id)).toEqual(["card-overdue", "card-1"]);
  });
});

describe("HomeState priorities block", () => {
  beforeEach(() => setVisibility("visible"));
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  const priorityGets = (get: { mock: { calls: unknown[][] } }) =>
    get.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("/work/priorities/"));

  it("loads the top of the queue beside the agenda and caches it separately", async () => {
    const f = setup();
    await f.state.initialize();

    expect(priorityGets(f.get)).toHaveLength(1);
    // Home asks for the top five with completed entries dropped: it answers "what's next".
    expect(priorityGets(f.get)[0]?.[0]).toBe("/work/priorities/user-1?limit=5");
    expect(f.state.priorities().map((entry) => entry.rank)).toEqual([1]);
    // Its own cache key, so a queue change never rewrites the agenda blob.
    expect(f.saveHomePriorities).toHaveBeenCalledWith("client-1:user-1", priorityPayload());
  });

  it("renders nothing for an empty queue, and hints only when there is assigned work", async () => {
    const empty = { ...priorityPayload(), items: [], totalCount: 0 };
    const f = setup({ priorities: empty });
    await f.state.initialize();

    expect(f.state.priorities()).toEqual([]);
    // The fixture has assigned work, so the one-line discoverability hint applies.
    expect(f.state.showPrioritiesHint()).toBe(true);
  });

  it("coalesces invalidation events into one refresh", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    const before = priorityGets(f.get).length;

    // Managers can receive invalidations for queues they may curate. Home is always the signed-in
    // person's queue, so another target must not cause a fetch here.
    f.socket.trigger("cardPriority:invalidated", { targetUserId: "teammate-1" });
    await vi.advanceTimersByTimeAsync(180);
    expect(priorityGets(f.get).length).toBe(before);

    f.socket.trigger("cardPriority:invalidated", { targetUserId: "user-1" });
    f.socket.trigger("cardPriority:invalidated", { targetUserId: "user-1" });
    await vi.advanceTimersByTimeAsync(180);

    expect(priorityGets(f.get).length).toBe(before + 1);
  });

  it("does not refetch the queue on the visible poll", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    const priorityCalls = priorityGets(f.get).length;
    const agendaCalls = f.get.mock.calls.filter(([path]) => String(path).startsWith("/home/today")).length;

    // The five-minute poll exists for slot cut-offs and midnight rollover, neither of which can
    // change a priority queue.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(f.get.mock.calls.filter(([path]) => String(path).startsWith("/home/today")).length)
      .toBe(agendaCalls + 1);
    expect(priorityGets(f.get).length).toBe(priorityCalls);
  });

  it("a slow cached snapshot cannot overwrite a fresh empty network queue", async () => {
    // The network says the queue is now empty; a stale cached snapshot with entries resolves after
    // it. Emptiness is why a length guard cannot work here — only "has the network landed" can.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const empty = { ...priorityPayload(), items: [], totalCount: 0 };
    const f = setup({
      priorities: empty,
      cachedPrioritiesPromise: gate.then(() => ({
        key: "client-1:user-1",
        cachedAt: "2026-07-25T00:00:00.000Z",
        response: priorityPayload(),
      })),
    });
    await f.state.initialize();
    expect(f.state.priorities()).toEqual([]);

    release();
    await new Promise((resolve) => setTimeout(resolve));
    expect(f.state.priorities()).toEqual([]);
  });

  it("joins rooms for boards shown only in the priority queue", async () => {
    const queue = priorityPayload();
    queue.items[0]!.card!.boardId = "board-2";
    const f = setup({ priorities: queue });
    await f.state.initialize();

    // The agenda's board and the queue-only board both get a room: a queued card's title or
    // due-date change must reach the page even when its board is absent from the agenda.
    expect(f.joinBoard).toHaveBeenCalledWith("board-1");
    expect(f.joinBoard).toHaveBeenCalledWith("board-2");
  });

  it("survives a cached agenda written before the queue existed", async () => {
    const f = setup({
      apiFails: true,
      cached: { key: "client-1:user-1", cachedAt: "2026-07-25T00:00:00.000Z", response: payload() },
      cachedPriorities: null,
    });
    await f.state.initialize();

    expect(f.state.priorities()).toEqual([]);
    expect(f.state.cachedAt()).toBe("2026-07-25T00:00:00.000Z");
  });
});
