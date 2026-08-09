import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardDragCoordinator } from "../../features/board/card-drag-coordinator.service";
import { viewPreferenceKey } from "../browser/browser-contracts";
import { ApiClient } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import type { AppSocket } from "../realtime/socket.service";
import { SocketService } from "../realtime/socket.service";
import { MyPrioritiesService } from "./my-priorities.service";

const VIEWER_ID = "60000000-0000-4000-8000-000000000001";
const TEAMMATE_ID = "60000000-0000-4000-8000-000000000002";

class SocketStub {
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });
  readonly off = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.get(event)?.delete(handler);
    return this;
  });
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function entry(id: string, rank: number, cardId = `card-${rank}`): WorkPriorityItem {
  return {
    id,
    position: `${rank * 1000}.0000000000`,
    rank,
    card: {
      id: cardId,
      number: rank,
      key: `WORK-${rank}`,
      organisationKey: "0123456789ABCDEF",
      boardId: `board-${rank}`,
      workspaceId: "20000000-0000-4000-8000-000000000001",
      listId: "list-1",
      title: `Ranked ${rank}`,
      position: "1000.0000000000",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" },
  };
}

function queue(items = [entry("p1", 1), entry("p2", 2)]): WorkPrioritiesResponse {
  return {
    targetUserId: VIEWER_ID,
    items,
    totalCount: items.length,
    hiddenCount: 0,
    canReorder: true,
    reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
  };
}

function setup(options: { offline?: boolean } = {}) {
  const socket = new SocketStub();
  const online = signal(!options.offline);
  const leaveBoard = vi.fn();
  const joinBoard = vi.fn(() => leaveBoard);
  const get = vi.fn(async (path: string) => {
    if (!online()) throw new Error("offline");
    if (path.startsWith("/work/priorities/")) return queue();
    if (path === "/work/catalog") {
      return {
        organisations: [],
        workspaces: [],
        boards: [{ id: "board-9", workspaceId: "20000000-0000-4000-8000-000000000001", name: "Roadmap", icon: null, iconColor: null }],
        lists: [{ id: "list-1", name: "Doing" }],
        labels: [],
        customFields: [],
        people: [],
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string) => {
    if (!online()) throw new Error("offline");
    if (path === "/work/cards/query") {
      return { cards: [{ id: "card-9", boardId: "board-9", listId: "list-1", title: "Not queued yet" }], nextCursor: null };
    }
    return queue([entry("p2", 1), entry("p1", 2)]);
  });
  const del = vi.fn(async () => {
    if (!online()) throw new Error("offline");
    return queue([entry("p2", 1)]);
  });
  const patch = vi.fn(async () => ({}));

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiClient, useValue: { get, post, delete: del, patch } },
      { provide: AuthService, useValue: { user: signal({ id: VIEWER_ID, clientId: "client-1" }).asReadonly() } },
      { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), joinBoard, displayedOnline: online } },
    ],
  });

  return {
    service: TestBed.inject(MyPrioritiesService),
    drag: TestBed.inject(CardDragCoordinator),
    socket,
    online,
    get,
    post,
    del,
    patch,
    joinBoard,
    leaveBoard,
  };
}

const priorityGets = (get: { mock: { calls: unknown[][] } }) =>
  get.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("/work/priorities/"));

describe("MyPrioritiesService", () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });
  afterEach(() => vi.useRealTimers());

  it("loads the viewer's own queue and joins a room per queued card's board", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));

    expect(priorityGets(f.get)[0]?.[0]).toBe(`/work/priorities/${VIEWER_ID}`);
    expect(f.service.totalCount()).toBe(2);
    expect([...f.service.rankedCardIds()].sort()).toEqual(["card-1", "card-2"]);
    // Card edits to a queued card need no queue-specific fanout: they arrive as ordinary board
    // events, which is only true while these rooms are joined.
    expect(f.joinBoard).toHaveBeenCalledWith("board-1");
    expect(f.joinBoard).toHaveBeenCalledWith("board-2");
  });

  it("applies a queueChanged snapshot in place, and drops one that arrived late", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));
    const before = priorityGets(f.get).length;

    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_QUEUE_CHANGED, {
      targetUserId: VIEWER_ID,
      items: [entry("p2", 1), entry("p1", 2)],
      totalCount: 2,
      snapshotAt: "2026-08-09T10:00:00.000Z",
    });
    expect(f.service.items().map((item) => item.id)).toEqual(["p2", "p1"]);
    // The fast path is exactly that: no round trip for a change the server already described.
    expect(priorityGets(f.get).length).toBe(before);
    // Viewer-scoped fields the snapshot cannot carry must survive it.
    expect(f.service.canReorder()).toBe(true);

    // Two mutations can drain out of order; an older snapshot must not resurrect the old order.
    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_QUEUE_CHANGED, {
      targetUserId: VIEWER_ID,
      items: [entry("p1", 1), entry("p2", 2)],
      totalCount: 2,
      snapshotAt: "2026-08-09T09:00:00.000Z",
    });
    expect(f.service.items().map((item) => item.id)).toEqual(["p2", "p1"]);
  });

  it("ignores a snapshot addressed to somebody else", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));

    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_QUEUE_CHANGED, {
      targetUserId: TEAMMATE_ID,
      items: [],
      totalCount: 0,
      snapshotAt: "2026-08-09T10:00:00.000Z",
    });
    expect(f.service.items()).toHaveLength(2);
  });

  it("still converges on the bare invalidation ping alone, debounced to one refetch", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.service.initialise();
    await vi.advanceTimersByTimeAsync(0);
    const before = priorityGets(f.get).length;

    // A backend that has not shipped the snapshot event yet must still keep this client correct.
    for (let index = 0; index < 3; index += 1) {
      f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId: VIEWER_ID });
    }
    // Managers also receive pings for queues they curate; this service holds only its own.
    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId: TEAMMATE_ID });
    await vi.advanceTimersByTimeAsync(180);

    expect(priorityGets(f.get).length).toBe(before + 1);
  });

  it("defers socket-driven changes while a card drag is in flight, then flushes one refetch", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.service.initialise();
    await vi.advanceTimersByTimeAsync(0);
    const before = priorityGets(f.get).length;

    // The actor's own drop is echoed straight back to them; applying it mid-gesture would reorder
    // the queue under the pointer.
    f.drag.start("my-priorities-drawer");
    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_QUEUE_CHANGED, {
      targetUserId: VIEWER_ID,
      items: [entry("p2", 1), entry("p1", 2)],
      totalCount: 2,
      snapshotAt: "2026-08-09T10:00:00.000Z",
    });
    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId: VIEWER_ID });
    await vi.advanceTimersByTimeAsync(180);
    expect(f.service.items().map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(priorityGets(f.get).length).toBe(before);

    f.drag.end();
    await vi.advanceTimersByTimeAsync(180);
    expect(priorityGets(f.get).length).toBe(before + 1);
  });

  it("moves optimistically and rolls back to the exact snapshot on failure", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));
    const snapshot = f.service.queue();

    f.online.set(false);
    const pending = f.service.movePriority("p1", { beforeId: null });
    // Applied before the round trip: the row is under the pointer and must not wait for the server.
    expect(f.service.items().map((item) => item.id)).toEqual(["p2", "p1"]);
    expect(f.service.items().map((item) => item.rank)).toEqual([1, 2]);

    await expect(pending).rejects.toThrow();
    expect(f.service.queue()).toEqual(snapshot);
  });

  it("removes optimistically, renumbers, and settles on the server's queue", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));

    await f.service.removePriority("p1");
    expect(f.service.items().map((item) => item.id)).toEqual(["p2"]);
    expect(f.service.items().map((item) => item.rank)).toEqual([1]);
    expect(f.service.totalCount()).toBe(1);
  });

  it("adds optimistically from a remembered candidate and settles on the response", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));

    // Hosts that can already see a card (the My Cards dock) hand it over so the optimistic row
    // renders with a title rather than a blank placeholder.
    f.service.rememberCandidate({
      id: "card-9",
      title: "Not queued yet",
      boardId: "board-9",
      boardName: "Roadmap",
      boardIcon: null,
      boardIconColor: null,
      listName: "Doing",
    });
    const pending = f.service.addPriority("card-9", { beforeId: null });
    expect(f.service.items().at(-1)?.id).toBe("pending:card-9");
    expect(f.service.items().at(-1)?.context?.boardName).toBe("Roadmap");

    await pending;
    expect(f.service.items().map((item) => item.id)).toEqual(["p2", "p1"]);
  });

  it("withholds the queue offline rather than serving a stale order", async () => {
    const f = setup({ offline: true });
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.loadError()).not.toBeNull());

    expect(f.service.queue()).toBeNull();
    expect(priorityGets(f.get)).toHaveLength(0);
    expect(f.service.loadError()).toContain("offline");
  });

  it("resyncs when the connection comes back", async () => {
    const f = setup({ offline: true });
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.loadError()).not.toBeNull());

    f.online.set(true);
    // Events missed while disconnected are never replayed, so a full refetch is the only way back.
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));
  });

  it("pulses until seen, keeping the dock's existing read receipt", async () => {
    // The dock has always written this key for (viewer, viewer); reusing it means nobody's pulse
    // resets when the drawer ships.
    localStorage.setItem(viewPreferenceKey("upNextSeen", `${VIEWER_ID}:${VIEWER_ID}`), "p1|p2");
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));
    expect(f.service.changedSinceSeen()).toBe(false);

    f.socket.trigger(SERVER_EVENTS.CARD_PRIORITY_QUEUE_CHANGED, {
      targetUserId: VIEWER_ID,
      items: [entry("p2", 1), entry("p1", 2)],
      totalCount: 2,
      snapshotAt: "2026-08-09T10:00:00.000Z",
    });
    // A reorder pulses; an unrelated card edit does not, because the signature is the entry ids.
    expect(f.service.changedSinceSeen()).toBe(true);

    f.service.markSeen();
    expect(f.service.changedSinceSeen()).toBe(false);
    expect(localStorage.getItem(viewPreferenceKey("upNextSeen", `${VIEWER_ID}:${VIEWER_ID}`))).toBe("p2|p1");
  });

  it("patches a queued card in place from ordinary board events", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));

    f.socket.trigger(SERVER_EVENTS.CARD_UPDATED, {
      boardId: "board-1",
      card: { id: "card-1", title: "Renamed", listId: "list-1", boardId: "board-1", position: "1000.0000000000", dueDateLocalDate: "2026-08-20" },
    });
    expect(f.service.items()[0]?.card?.title).toBe("Renamed");
    expect(f.service.items()[0]?.card?.dueDateLocalDate).toBe("2026-08-20");
    // Both wire shapes omit null fields, so clearing a due date arrives as an *absent* key. A
    // spread merge would keep the old date; only an explicit field copy drops it.
    f.socket.trigger(SERVER_EVENTS.CARD_UPDATED, {
      boardId: "board-1",
      card: { id: "card-1", title: "Renamed", listId: "list-1", boardId: "board-1", position: "1000.0000000000" },
    });
    expect(f.service.items()[0]?.card?.dueDateLocalDate).toBeNull();

    f.socket.trigger(SERVER_EVENTS.CARD_DELETED, { boardId: "board-1", cardId: "card-1" });
    expect(f.service.items().map((item) => item.card?.id)).toEqual(["card-2"]);
    expect(f.service.totalCount()).toBe(1);
  });

  it("clears everything on teardown so no id survives an organisation switch", async () => {
    const f = setup();
    f.service.initialise();
    await vi.waitFor(() => expect(f.service.items()).toHaveLength(2));

    f.service.teardown();
    expect(f.service.queue()).toBeNull();
    expect(f.service.initialised()).toBe(false);
    expect(f.leaveBoard).toHaveBeenCalled();
  });
});
