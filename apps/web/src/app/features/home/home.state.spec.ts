import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { HomeItem, HomeTodayResponse } from "@kanera/shared/dto";
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
      byDay: [{ date: "2026-07-25", completedCards: 2, completedChecklistItems: 1 }],
      thisWeek: { completedCards: 5, completedChecklistItems: 2 },
      lastWeek: { completedCards: 3, completedChecklistItems: 0 },
    },
    boardCount: 3,
    ...overrides,
  };
}

function setup(options: {
  apiFails?: boolean;
  cached?: { key: string; cachedAt: string; response: HomeTodayResponse } | null;
} = {}) {
  const socket = new SocketStub();
  const leaveBoard = vi.fn();
  const joinBoard = vi.fn(() => leaveBoard);
  const get = vi.fn(async (path: string) => {
    if (options.apiFails) throw new Error("offline");
    if (path.startsWith("/home/today")) return payload();
    throw new Error(`unexpected GET ${path}`);
  });
  const saveHomeToday = vi.fn(async () => undefined);
  const loadHomeToday = vi.fn(async () => options.cached ?? null);
  const user = signal({ id: "user-1", clientId: "client-1", displayName: "Viewer" });

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      HomeState,
      { provide: ApiClient, useValue: { get } },
      { provide: AuthService, useValue: { user: user.asReadonly() } },
      { provide: OfflineCacheService, useValue: { saveHomeToday, loadHomeToday } },
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
  };
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

    expect(f.get).toHaveBeenCalledTimes(1);
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
    expect(f.state.weekDelta()).toBe(4);
  });

  it("coalesces a burst of card events into exactly one refetch", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    expect(f.get).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 5; index += 1) {
      f.socket.trigger("card:updated", { card: { id: `card-${index}`, completedAt: null, archivedAt: null } });
      vi.advanceTimersByTime(20);
    }
    expect(f.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(f.get).toHaveBeenCalledTimes(2);
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
    expect(f.get).toHaveBeenCalledTimes(1);
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
    expect(f.get).toHaveBeenCalledTimes(1);

    f.socket.trigger("notification:created", { notification: { reason: "watching" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.get).toHaveBeenCalledTimes(1);

    // A first assignment on a board home has not joined arrives only as a user-room notification.
    f.socket.trigger("notification:created", { notification: { reason: "assigned" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.get).toHaveBeenCalledTimes(2);

    f.socket.trigger("notification:created", { notification: { reason: "checklist_item_overdue" } });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.get).toHaveBeenCalledTimes(3);
  });

  it("refetches on reconnect rather than assuming missed events were replayed", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();

    f.socket.trigger("connect");
    await vi.advanceTimersByTimeAsync(400);
    expect(f.get).toHaveBeenCalledTimes(2);
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
    expect(f.get).toHaveBeenCalledTimes(2);
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
    expect(f.get).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(400);
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("refreshes on foreground resume even when no realtime event was queued", async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.state.initialize();
    expect(f.get).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(400);

    expect(f.get).toHaveBeenCalledTimes(2);
    expect(f.state.reconciling()).toBe(false);
  });

  it("rejoins only the boards in the newest agenda", async () => {
    const f = setup();
    await f.state.initialize();
    expect(f.joinBoard).toHaveBeenCalledTimes(1);

    f.get.mockResolvedValueOnce(payload({
      items: [item({ boardId: "board-2" }), item({ id: "card-3", cardId: "card-3", boardId: "board-3" })],
    }));
    await f.state.refresh();

    // The previous room is left before the new ones are joined.
    expect(f.leaveBoard).toHaveBeenCalled();
    expect(f.joinBoard).toHaveBeenLastCalledWith("board-3");
    expect(f.joinBoard).toHaveBeenCalledTimes(3);
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
