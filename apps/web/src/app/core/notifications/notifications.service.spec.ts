import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { NotificationRow, NotificationsPage } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import type { AppSocket } from "../realtime/socket.service";
import { SocketService } from "../realtime/socket.service";
import { MentionSoundService } from "./mention-sound.service";
import { NotificationsService } from "./notifications.service";

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

function notification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "notification-1",
    userId: "user-1",
    activityId: "activity-1",
    cardId: "card-1",
    checklistItemId: null,
    listId: "list-1",
    boardId: "board-1",
    workspaceId: "workspace-1",
    reason: "watching",
    readAt: null,
    createdAt: new Date(),
    activity: null,
    actorName: "Ada",
    actorAvatarUrl: null,
    cardTitle: "Ship tests",
    cardCompletedAt: null,
    cardArchivedAt: null,
    cardDueDateLocalDate: null,
    cardDueDateSlot: null,
    cardDueDateTimezone: null,
    checklistItemText: null,
    checklistItemDueDateLocalDate: null,
    checklistItemDueDateSlot: null,
    checklistItemDueDateTimezone: null,
    viewerRole: "editor",
    listName: "Todo",
    listColor: null,
    listIcon: null,
    boardName: "Board",
    boardIcon: null,
    boardIconColor: null,
    workspaceName: "Workspace",
    workspaceIcon: null,
    workspaceAccentColor: null,
    attachment: null,
    commentBody: null,
    ...overrides,
  };
}

function page(items: NotificationRow[], nextCursor: string | null = null, unreadCount = items.filter((n) => !n.readAt).length): NotificationsPage {
  return { items, nextCursor, unreadCount };
}

describe("NotificationsService", () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let socket: SocketStub;
  let online: ReturnType<typeof signal<boolean>>;
  let mentionSound: { playMention: ReturnType<typeof vi.fn> };
  let service: NotificationsService;

  beforeEach(() => {
    localStorage.clear();
    api = {
      get: vi.fn((path: string) => {
        if (path === "/notifications/unread-count") return Promise.resolve({ count: 2 });
        if (path === "/notifications/board-unread-counts") return Promise.resolve([{ boardId: "board-1", count: 2 }]);
        if (path === "/notifications/card-unread-counts") return Promise.resolve([{ cardId: "card-1", count: 2 }]);
        if (path === "/card-watches") return Promise.resolve([{ cardId: "card-watched" }]);
        if (path === "/board-watches") return Promise.resolve([{ boardId: "board-watched" }]);
        return Promise.resolve(page([notification()]));
      }),
      post: vi.fn(() => Promise.resolve({})),
      put: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    };
    socket = new SocketStub();
    online = signal(true);
    mentionSound = { playMention: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        NotificationsService,
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: MentionSoundService, useValue: mentionSound },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), displayedOnline: online } },
      ],
    });
    service = TestBed.inject(NotificationsService);
  });

  it("loads the first page and subsequent pages with expected query params", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.startsWith("/notifications?") || path.startsWith("/notifications/unread?")) return Promise.resolve(page([notification()], "cursor-1", 4));
      return Promise.resolve([]);
    });
    service.loadError.set("Previous error");

    await service.loadFirstPage();
    await service.loadMore();

    expect(api.get).toHaveBeenNthCalledWith(1, "/notifications/unread?limit=25");
    expect(api.get).toHaveBeenNthCalledWith(2, "/notifications/unread?limit=25&cursor=cursor-1");
    expect(service.unreadCount()).toBe(4);
    expect(service.loadError()).toBeNull();
  });

  it("keeps unread and all notification pages separate when switching tabs", async () => {
    api.get.mockImplementation((path: string) => {
      if (path === "/notifications/unread?limit=25") return Promise.resolve(page([notification({ id: "unread" })], null, 1));
      if (path === "/notifications?limit=25&includeRead=true") return Promise.resolve(page([notification({ id: "read-only", readAt: new Date() })], null, 1));
      return Promise.resolve([]);
    });

    await service.loadFirstPage();
    expect(service.items().map((n) => n.id)).toEqual(["unread"]);

    await service.setIncludeRead(true);
    expect(service.items().map((n) => n.id)).toEqual(["read-only"]);

    await service.setIncludeRead(false);

    expect(service.items().map((n) => n.id)).toEqual(["unread"]);
    expect(service.unreadCount()).toBe(1);
    expect(service.loadError()).toBeNull();
  });

  it("does not load the first notifications page while offline", async () => {
    online.set(false);
    api.get.mockClear();

    await service.loadFirstPage();

    expect(api.get).not.toHaveBeenCalled();
    expect(service.loading()).toBe(false);
    expect(service.loadError()).toBe("You're offline. Reconnect to refresh notifications.");
  });

  it("does not load more notifications while offline", async () => {
    online.set(false);
    service.nextCursor.set("cursor-1");
    api.get.mockClear();

    await service.loadMore();

    expect(api.get).not.toHaveBeenCalled();
    expect(service.loading()).toBe(false);
    expect(service.loadError()).toBe("You're offline. Reconnect to refresh notifications.");
  });

  it("loads board unread counts", async () => {
    await service.refreshBoardUnreadCounts();

    expect(api.get).toHaveBeenCalledWith("/notifications/board-unread-counts");
    expect(service.boardUnreadCounts()).toEqual({ "board-1": 2 });
  });

  it("loads card unread counts", async () => {
    await service.refreshCardUnreadCounts();

    expect(api.get).toHaveBeenCalledWith("/notifications/card-unread-counts");
    expect(service.cardUnreadCounts()).toEqual({ "card-1": 2 });
    expect(service.cardUnreadCount("card-1")).toBe(2);
  });

  it("loads watcher lists and updates a visible board watcher cache after toggling", async () => {
    api.get.mockImplementation((path: string) => {
      if (path === "/boards/board-1/watchers") return Promise.resolve([{ userId: "user-2", displayName: "Ada", avatarUrl: null }]);
      return Promise.resolve([]);
    });

    await service.loadBoardWatchers("board-1");
    await service.toggleBoardWatch("board-1");

    expect(api.get).toHaveBeenCalledWith("/boards/board-1/watchers");
    expect(api.put).toHaveBeenCalledWith("/boards/board-1/watch", {});
    expect(service.boardWatchers()["board-1"].map((user) => user.userId)).toEqual(["user-2", "user-1"]);
  });

  it("resyncs board counts when returning online", async () => {
    service.initialise();
    await Promise.resolve();
    api.get.mockClear();

    online.set(false);
    TestBed.flushEffects();
    online.set(true);
    TestBed.flushEffects();
    await Promise.resolve();

    expect(api.get).toHaveBeenCalledWith("/notifications/unread-count");
    expect(api.get).toHaveBeenCalledWith("/notifications/board-unread-counts");
    expect(api.get).toHaveBeenCalledWith("/notifications/card-unread-counts");
  });

  it("adds board and user filters to notification page requests", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.startsWith("/notifications?")) return Promise.resolve(page([notification()], null, 1));
      return Promise.resolve([]);
    });

    await service.setBoardFilter("11111111-1111-1111-1111-111111111111");
    await service.setUserFilter("22222222-2222-2222-2222-222222222222");
    await service.loadMore();

    expect(api.get).toHaveBeenCalledWith("/notifications/unread?limit=25&boardId=11111111-1111-1111-1111-111111111111");
    expect(api.get).toHaveBeenCalledWith("/notifications/unread?limit=25&boardId=11111111-1111-1111-1111-111111111111&actorId=22222222-2222-2222-2222-222222222222");
  });

  it("reloads the first page when include-read changes", async () => {
    await service.setIncludeRead(true);

    expect(service.includeRead()).toBe(true);
    expect(api.get).toHaveBeenCalledWith("/notifications?limit=25&includeRead=true");
  });

  it("optimistically marks one notification read and rolls back on failure", async () => {
    service.items.set([notification()]);
    service.unreadCount.set(1);
    api.post.mockRejectedValueOnce(new Error("nope"));

    await service.markRead("notification-1");

    expect(api.post).toHaveBeenCalledWith("/notifications/read", { notificationIds: ["notification-1"] });
    expect(service.items()[0]?.readAt).toBeNull();
    expect(service.unreadCount()).toBe(1);
    expect(service.cardUnreadCounts()["card-1"]).toBe(1);
  });

  it("optimistically marks one notification unread and rolls back on failure", async () => {
    await service.setIncludeRead(true);
    service.items.set([notification({ readAt: new Date("2026-05-21T01:00:00.000Z") })]);
    service.unreadCount.set(0);
    api.post.mockRejectedValueOnce(new Error("nope"));

    await service.markUnread("notification-1");

    expect(api.post).toHaveBeenCalledWith("/notifications/unread", { notificationIds: ["notification-1"] });
    expect(service.items()[0]?.readAt).toEqual(new Date("2026-05-21T01:00:00.000Z"));
    expect(service.unreadCount()).toBe(0);
    expect(service.cardUnreadCounts()["card-1"] ?? 0).toBe(0);
  });

  it("optimistically marks all notifications read and reloads on failure", async () => {
    service.items.set([notification(), notification({ id: "notification-2" })]);
    service.unreadCount.set(2);
    api.post.mockRejectedValueOnce(new Error("nope"));

    await service.markAllRead();

    expect(api.post).toHaveBeenCalledWith("/notifications/read-all", {});
    expect(api.get).toHaveBeenCalledWith("/notifications/unread-count");
    expect(api.get).toHaveBeenCalledWith("/notifications/card-unread-counts");
    expect(api.get).toHaveBeenCalledWith("/notifications/unread?limit=25");
  });

  it("optimistically marks card notifications read and clears card counts", async () => {
    service.items.set([
      notification(),
      notification({ id: "notification-2", cardId: "card-2", boardId: "board-1" }),
    ]);
    service.unreadCount.set(3);
    service.boardUnreadCounts.set({ "board-1": 2 });
    service.cardUnreadCounts.set({ "card-1": 2, "card-2": 1 });

    await service.markCardNotificationsRead("card-1", "board-1");

    expect(api.post).toHaveBeenCalledWith("/notifications/cards/card-1/read", {});
    expect(service.items().find((n) => n.id === "notification-1")).toBeUndefined();
    expect(service.unreadCount()).toBe(1);
    expect(service.boardUnreadCounts()).toEqual({ "board-1": 1 });
    expect(service.cardUnreadCounts()).toEqual({ "card-2": 1 });
  });

  it("refreshes notification state when marking card notifications read fails", async () => {
    service.items.set([notification()]);
    service.unreadCount.set(1);
    service.boardUnreadCounts.set({ "board-1": 1 });
    service.cardUnreadCounts.set({ "card-1": 1 });
    api.post.mockRejectedValueOnce(new Error("nope"));

    await service.markCardNotificationsRead("card-1", "board-1");

    expect(api.get).toHaveBeenCalledWith("/notifications/unread-count");
    expect(api.get).toHaveBeenCalledWith("/notifications/board-unread-counts");
    expect(api.get).toHaveBeenCalledWith("/notifications/card-unread-counts");
    expect(api.get).toHaveBeenCalledWith("/notifications/unread?limit=25");
  });

  it("does not mutate read or watch state while offline", async () => {
    online.set(false);
    service.items.set([notification()]);
    service.unreadCount.set(1);
    service.cardUnreadCounts.set({ "card-1": 1 });

    await service.markRead("notification-1");
    await service.markUnread("notification-1");
    await service.markAllRead();
    await service.markCardNotificationsRead("card-1", "board-1");
    await service.toggleCardWatch("card-1");
    await service.toggleBoardWatch("board-1");

    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(service.unreadCount()).toBe(1);
    expect(service.cardUnreadCounts()).toEqual({ "card-1": 1 });
  });

  it("applies notification socket events to local state", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.startsWith("/notifications?") || path.startsWith("/notifications/unread?")) return Promise.resolve(page([notification()], null, 1));
      return Promise.resolve([]);
    });
    service.initialise();
    await Promise.resolve();
    await service.loadFirstPage();
    service.unreadCount.set(1);

    socket.trigger("notification:created", { notification: notification({ id: "notification-2" }) });
    expect(service.items().map((n) => n.id)).toEqual(["notification-2", "notification-1"]);
    expect(service.unreadCount()).toBe(2);
    expect(service.boardUnreadCounts()["board-1"]).toBe(1);
    expect(service.cardUnreadCounts()["card-1"]).toBe(1);

    socket.trigger("notification:created", { notification: notification({ id: "notification-3" }) });
    expect(service.unreadCount()).toBe(3);
    expect(service.boardUnreadCounts()["board-1"]).toBe(1);
    expect(service.cardUnreadCounts()["card-1"]).toBe(2);

    socket.trigger("notification:updated", { notification: notification({ id: "notification-1", cardTitle: "Updated" }) });
    expect(service.items()[0]?.id).toBe("notification-1");
    expect(service.items()[0]?.cardTitle).toBe("Updated");

    socket.trigger("notification:read", { notificationIds: ["notification-1"], readAt: "2026-05-21T01:00:00.000Z" });
    expect(service.items().find((n) => n.id === "notification-1")).toBeUndefined();

    socket.trigger("notification:unread", { notificationIds: ["notification-1"] });
    expect(service.items().find((n) => n.id === "notification-1")?.readAt).toBeNull();

    socket.trigger("notification:allRead", { readAt: "2026-05-21T02:00:00.000Z" });
    expect(service.items()).toEqual([]);
    expect(service.unreadCount()).toBe(0);
    expect(service.boardUnreadCounts()).toEqual({});
    expect(service.cardUnreadCounts()).toEqual({});
  });

  it("removes deleted notifications from both feeds and refreshes every badge aggregate", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.startsWith("/notifications?")) {
        return Promise.resolve(page([
          notification({ id: "notification-delete" }),
          notification({ id: "notification-keep", cardId: "card-2" }),
        ], null, 2));
      }
      if (path === "/notifications/unread-count") return Promise.resolve({ count: 1 });
      if (path === "/notifications/board-unread-counts") return Promise.resolve([{ boardId: "board-1", count: 1 }]);
      if (path === "/notifications/card-unread-counts") return Promise.resolve([{ cardId: "card-2", count: 1 }]);
      return Promise.resolve([]);
    });
    service.initialise();
    await service.setIncludeRead(true);

    socket.trigger("notification:deleted", { notificationIds: ["notification-delete"] });
    await vi.waitFor(() => expect(service.unreadCount()).toBe(1));

    expect(service.items().map((item) => item.id)).toEqual(["notification-keep"]);
    expect(service.boardUnreadCounts()).toEqual({ "board-1": 1 });
    expect(service.cardUnreadCounts()).toEqual({ "card-2": 1 });
    expect(api.get).toHaveBeenCalledWith("/notifications/unread-count");
    expect(api.get).toHaveBeenCalledWith("/notifications/board-unread-counts");
    expect(api.get).toHaveBeenCalledWith("/notifications/card-unread-counts");
  });

  it("updates global badge counts for notification socket events hidden by panel filters", async () => {
    service.initialise();
    await Promise.resolve();
    service.boardFilter.set("board-2");
    service.items.set([]);
    service.unreadCount.set(2);
    service.boardUnreadCounts.set({ "board-1": 1 });
    service.cardUnreadCounts.set({ "card-1": 2 });

    socket.trigger("notification:created", { notification: notification({ id: "notification-hidden" }) });

    expect(service.items()).toEqual([]);
    expect(service.unreadCount()).toBe(3);
    expect(service.boardUnreadCounts()).toEqual({ "board-1": 1 });
    expect(service.cardUnreadCounts()).toEqual({ "card-1": 3 });
  });

  it("increments the board badge only when a newly unread card appears", async () => {
    service.initialise();
    await Promise.resolve();
    service.boardUnreadCounts.set({ "board-1": 1 });
    service.cardUnreadCounts.set({ "card-1": 2 });

    socket.trigger("notification:created", { notification: notification({ id: "notification-same-card" }) });
    socket.trigger("notification:created", { notification: notification({ id: "notification-new-card", cardId: "card-2" }) });

    expect(service.boardUnreadCounts()).toEqual({ "board-1": 2 });
    expect(service.cardUnreadCounts()).toEqual({ "card-1": 3, "card-2": 1 });
  });

  it("plays the attention sound for new unread mention and assignment notifications", async () => {
    service.initialise();
    await Promise.resolve();

    socket.trigger("notification:created", { notification: notification({ id: "notification-mention", reason: "mentioned" }) });
    socket.trigger("notification:created", { notification: notification({ id: "notification-assigned", reason: "assigned" }) });

    expect(mentionSound.playMention).toHaveBeenCalledTimes(2);
  });

  it("does not play the attention sound for passive or non-new notification socket updates", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.startsWith("/notifications?") || path.startsWith("/notifications/unread?")) return Promise.resolve(page([notification({ id: "duplicate", reason: "mentioned" })], null, 1));
      return Promise.resolve([]);
    });
    service.initialise();
    await Promise.resolve();
    await service.loadFirstPage();

    socket.trigger("notification:created", { notification: notification({ id: "watching", reason: "watching" }) });
    socket.trigger("notification:created", { notification: notification({ id: "read-mention", reason: "mentioned", readAt: new Date("2026-05-21T01:00:00.000Z") }) });
    socket.trigger("notification:created", { notification: notification({ id: "duplicate", reason: "mentioned" }) });
    socket.trigger("notification:updated", { notification: notification({ id: "updated-mention", reason: "mentioned" }) });

    expect(mentionSound.playMention).not.toHaveBeenCalled();
  });

  it("rolls card and board watch toggles back when requests fail", async () => {
    service.watchedCards.set(new Set(["card-1"]));
    service.watchedBoards.set(new Set<string>());
    api.delete.mockRejectedValueOnce(new Error("nope"));
    api.put.mockRejectedValueOnce(new Error("nope"));

    await service.toggleCardWatch("card-1");
    await service.toggleBoardWatch("board-1");

    expect(service.isWatchingCard("card-1")).toBe(true);
    expect(service.isWatchingBoard("board-1")).toBe(false);
  });

  it("keeps locally watched created cards when a stale watch load finishes", async () => {
    service.watchCreatedCardLocally("card-new");

    await service.loadWatchedCards();

    expect(service.isWatchingCard("card-new")).toBe(true);
    expect(service.isWatchingCard("card-watched")).toBe(true);
  });

  it("does not restore a created-card watch after the user unwatches it", async () => {
    service.watchCreatedCardLocally("card-new");

    await service.toggleCardWatch("card-new");
    await service.loadWatchedCards();

    expect(api.delete).toHaveBeenCalledWith("/cards/card-new/watch");
    expect(service.isWatchingCard("card-new")).toBe(false);
  });
});
