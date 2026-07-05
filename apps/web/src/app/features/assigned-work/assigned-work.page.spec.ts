import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import type { WireAssignedWorkPayload, WireBoardMemberUser, WireCardSummary, WireWorkspaceMember } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS, viewPreferenceKey } from "../../core/browser/browser-contracts";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AssignedWorkPage } from "./assigned-work.page";
import type { AssignedWorkState } from "./assigned-work-state";

class SocketStub {
  connected = false;
  readonly emit = vi.fn((event: string, ...args: unknown[]) => {
    if (event === "board:join") {
      const ack = args[1];
      if (typeof ack === "function") (ack as (ok: boolean) => void)(true);
    }
    return this;
  });
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

class ResizeObserverStub {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
}

function summary(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Overdue blocked task",
    position: "1000.0000000000",
    dueDateLocalDate: "2026-05-20",
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 0,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    coverUrl: null,
    labelIds: [],
    assigneeIds: ["user-1"],
    customFieldValues: [],
    ...overrides,
  };
}

function member(overrides: Partial<WireBoardMemberUser> = {}): WireBoardMemberUser {
  return {
    userId: "user-2",
    displayName: "Ada",
    avatarUrl: null,
    role: "editor",
    source: "workspace",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function payload(overrides: Partial<WireAssignedWorkPayload> = {}): WireAssignedWorkPayload {
  return {
    workspace: {
      id: "workspace-1",
      clientId: "client-1",
      name: "Delivery",
      icon: null,
      accentColor: null,
      completedCardsActiveDays: 35,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      archivedAt: null,
    },
    lists: [
      {
        id: "list-1",
        workspaceId: "workspace-1",
        name: "Todo",
        icon: null,
        color: null,
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    ],
    customFields: [],
    cardLabels: [
      {
        id: "label-1",
        workspaceId: "workspace-1",
        name: "Blocked",
        color: "rose",
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    ],
    members: [member({ userId: "user-1", displayName: "Me" }), member()],
    memberStats: [],
    boards: [
      { id: "board-1", workspaceId: "workspace-1", name: "Public", icon: null, iconColor: null },
      { id: "board-2", workspaceId: "workspace-1", name: "Private", icon: null, iconColor: null },
    ],
    cards: [
      summary({ id: "card-1", boardId: "board-1", labelIds: ["label-1"] }),
      summary({ id: "card-2", boardId: "board-2", title: "Later task", dueDateLocalDate: null, labelIds: [] }),
    ],
    targetUser: { userId: "user-1", displayName: "Me", avatarUrl: null, role: "member" },
    checklistItems: [],
    viewerRole: "admin",
    ...overrides,
  };
}

describe("AssignedWorkPage", () => {
  let fixture: ComponentFixture<AssignedWorkPage>;
  let component: AssignedWorkPage;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let router: { navigate: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn> };
  let offlineCache: { loadAssignedWork: ReturnType<typeof vi.fn>; saveAssignedWork: ReturnType<typeof vi.fn> };
  let socket: SocketStub;
  let cardUnreadCounts: ReturnType<typeof signal<Record<string, number>>>;

  function assignedState(component: AssignedWorkPage): AssignedWorkState {
    return (component as unknown as { state: AssignedWorkState }).state;
  }

  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    socket = new SocketStub();
    cardUnreadCounts = signal<Record<string, number>>({});
    api = {
      get: vi.fn((path: string) => {
        if (path.endsWith("/members")) {
          const addedAt = new Date("2026-05-21T00:00:00.000Z");
          const rows: WireWorkspaceMember[] = [
            { workspaceId: "workspace-1", userId: "user-1", displayName: "Me", avatarUrl: null, role: "member", addedAt },
            { workspaceId: "workspace-1", userId: "user-2", displayName: "Ada", avatarUrl: null, role: "member", addedAt },
            { workspaceId: "workspace-1", userId: "user-3", displayName: "Grace", avatarUrl: null, role: "admin", addedAt },
          ];
          return Promise.resolve(rows);
        }
        if (path === "/workspaces/workspace-1/assignees/cards") {
          return Promise.resolve(payload({ targetUser: { userId: "all", displayName: "All", avatarUrl: null, role: "member" } }));
        }
        return Promise.resolve(payload());
      }),
      post: vi.fn(() => Promise.resolve({ id: "card-1", listId: "list-1", position: "1500.0000000000" })),
    };
    router = { navigate: vi.fn(() => Promise.resolve(true)), navigateByUrl: vi.fn(() => Promise.resolve(true)) };
    offlineCache = { loadAssignedWork: vi.fn(), saveAssignedWork: vi.fn(() => Promise.resolve()) };

    await TestBed.configureTestingModule({
      imports: [AssignedWorkPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        {
          provide: AuthService,
          useValue: {
            user: signal({
              id: "user-1",
              clientId: "client-1",
              email: "me@example.com",
              displayName: "Me",
              avatarUrl: null,
              orgName: "Kanera",
              logoUrl: null,
              hasWorkspace: true,
              role: "member",
              timezone: "UTC",
            }),
          },
        },
        { provide: Router, useValue: router },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), joinWorkspace: vi.fn(() => vi.fn()), displayedOnline: signal(true) } },
        { provide: OfflineCacheService, useValue: offlineCache },
        { provide: NotificationsService, useValue: { cardUnreadCount: (cardId: string) => cardUnreadCounts()[cardId] ?? 0 } },
        { provide: WorkspaceService, useValue: { registerBoards: vi.fn(), cacheLists: vi.fn() } },
        { provide: AppTitleService, useValue: { set: vi.fn() } },
      ],
    })
      .overrideComponent(AssignedWorkPage, { set: { template: "" } })
      .compileComponents();

    fixture = TestBed.createComponent(AssignedWorkPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput("workspaceId", "workspace-1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filters cards by search, board, label, overdue state, and clears filters", () => {
    (component as any).state.hydrateAssignedWork(payload());
    component.searchQuery.set("blocked");
    component.boardFilter.set("board-1");
    component.filterLabelIds.set(["label-1"]);
    component.showOverdueOnly.set(true);

    expect(component.filteredCardsByList().get("list-1")?.map((c) => c.id)).toEqual(["card-1"]);

    component.boardFilter.set("board-2");
    expect(component.filteredCardsByList().get("list-1")).toEqual([]);

    component.clearFilters();
    expect(component.hasActiveFilter()).toBe(false);
    expect(component.filteredCardsByList().get("list-1")?.map((c) => c.id).sort()).toEqual(["card-1", "card-2"]);
  });

  it("filters cards and checklist items by reactive unread notification counts", () => {
    fixture.componentRef.setInput("view", "calendar");
    assignedState(component).hydrateAssignedWork(payload({
      checklistItems: [
        {
          itemId: "item-1", text: "First item", cardId: "card-1", cardTitle: "Overdue blocked task",
          checklistId: "checklist-1", listId: "list-1", boardId: "board-1", boardName: "Public",
          boardIcon: null, assigneeId: "user-1", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null,
        },
        {
          itemId: "item-2", text: "Second item", cardId: "card-2", cardTitle: "Later task",
          checklistId: "checklist-2", listId: "list-1", boardId: "board-2", boardName: "Private",
          boardIcon: null, assigneeId: "user-1", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null,
        },
      ],
    }));
    cardUnreadCounts.set({ "card-1": 1 });

    component.showUnreadOnly.set(true);

    expect(component.hasDropdownFilter()).toBe(true);
    expect(component.filteredCardIds()).toEqual(new Set(["card-1"]));
    expect(component.filteredChecklistItems().map((item) => item.itemId)).toEqual(["item-1"]);

    cardUnreadCounts.set({ "card-2": 1 });
    expect(component.filteredCardIds()).toEqual(new Set(["card-2"]));
    expect(component.filteredChecklistItems().map((item) => item.itemId)).toEqual(["item-2"]);

    fixture.componentRef.setInput("view", "history");
    expect(component.hasDropdownFilter()).toBe(false);
    expect(component.filteredCardIds()).toEqual(new Set(["card-1", "card-2"]));
    expect(component.filteredChecklistItems().map((item) => item.itemId)).toEqual(["item-1", "item-2"]);

    void component.clearFilters();
    expect(component.showUnreadOnly()).toBe(false);
  });

  it("treats overdue as a dropdown filter in calendar view", () => {
    fixture.componentRef.setInput("view", "calendar");
    assignedState(component).hydrateAssignedWork(payload());

    expect(component.hasDropdownFilter()).toBe(false);

    component.showOverdueOnly.set(true);

    expect(component.hasDropdownFilter()).toBe(true);
    expect(component.filteredCardIds()).toEqual(new Set(["card-1"]));
  });

  it("treats archived as a dropdown filter in calendar view", () => {
    fixture.componentRef.setInput("view", "calendar");
    assignedState(component).hydrateAssignedWork(payload());

    expect(component.hasDropdownFilter()).toBe(false);

    component.showArchived.set(true);

    expect(component.hasDropdownFilter()).toBe(true);
  });

  it("does not count overdue as a dropdown filter in history view", () => {
    fixture.componentRef.setInput("view", "history");
    assignedState(component).hydrateAssignedWork(payload());

    component.showOverdueOnly.set(true);

    expect(component.hasDropdownFilter()).toBe(false);
  });

  it("debounces applying search text to assigned-work filters", () => {
    vi.useFakeTimers();
    try {
      fixture.detectChanges();

      component.setSearchQuery("blocked");
      fixture.detectChanges();

      expect(component.searchInputValue()).toBe("blocked");
      expect(component.searchQuery()).toBe("");

      vi.advanceTimersByTime(199);
      expect(component.searchQuery()).toBe("");

      vi.advanceTimersByTime(1);
      expect(component.searchQuery()).toBe("blocked");

      component.setSearchQuery("");
      expect(component.searchQuery()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers assigned checklist section collapse separately for mine and team views", () => {
    fixture.detectChanges();

    expect(component.checklistSectionCollapsed()).toBe(true);

    component.toggleChecklistSection();

    expect(component.checklistSectionCollapsed()).toBe(false);
    expect(localStorage.getItem(`${STORAGE_KEYS.ASSIGNED_WORK_CHECKLIST_COLLAPSED_PREFIX}:workspace-1:me`)).toBe("0");

    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();

    expect(component.checklistSectionCollapsed()).toBe(true);

    component.toggleChecklistSection();

    expect(localStorage.getItem(`${STORAGE_KEYS.ASSIGNED_WORK_CHECKLIST_COLLAPSED_PREFIX}:workspace-1:team`)).toBe("0");
    expect(localStorage.getItem(`${STORAGE_KEYS.ASSIGNED_WORK_CHECKLIST_COLLAPSED_PREFIX}:workspace-1:me`)).toBe("0");
  });

  it("does not treat completed cards as overdue", () => {
    assignedState(component).hydrateAssignedWork(payload({
      cards: [
        summary({ id: "card-1", completedAt: new Date("2026-05-21T10:00:00.000Z") }),
        summary({ id: "card-2", title: "Open overdue task", position: "2000.0000000000" }),
      ],
    }));
    component.showOverdueOnly.set(true);

    expect(component.filteredCardsByList().get("list-1")?.map((c) => c.id)).toEqual(["card-2"]);
  });

  it("applies overdue filtering to assigned checklist items", () => {
    assignedState(component).hydrateAssignedWork(payload({
      checklistItems: [
        {
          itemId: "item-1",
          text: "Overdue checklist item",
          cardId: "card-1",
          cardTitle: "Overdue blocked task",
          checklistId: "checklist-1",
          listId: "list-1",
          boardId: "board-1",
          boardName: "Public",
          boardIcon: null,
          assigneeId: "user-1",
          dueDateLocalDate: "2026-05-20",
          dueDateSlot: "anyTime",
          dueDateTimezone: "UTC",
        },
        {
          itemId: "item-2",
          text: "Undated checklist item",
          cardId: "card-2",
          cardTitle: "Later task",
          checklistId: "checklist-1",
          listId: "list-1",
          boardId: "board-1",
          boardName: "Public",
          boardIcon: null,
          assigneeId: "user-1",
          dueDateLocalDate: null,
          dueDateSlot: null,
          dueDateTimezone: null,
        },
      ],
    }));

    component.showOverdueOnly.set(true);

    expect(component.filteredChecklistItems().map((item) => item.itemId)).toEqual(["item-1"]);
  });

  it("hydrates assigned checklist items from the initial assigned-work payload", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/members")) {
        const addedAt = new Date("2026-05-21T00:00:00.000Z");
        return Promise.resolve([
          { workspaceId: "workspace-1", userId: "user-1", displayName: "Me", avatarUrl: null, role: "member", addedAt },
          { workspaceId: "workspace-1", userId: "user-2", displayName: "Ada", avatarUrl: null, role: "member", addedAt },
        ] satisfies WireWorkspaceMember[]);
      }
      return Promise.resolve(payload({
        checklistItems: [
          {
            itemId: "item-1",
            text: "Confirm DNS cutover",
            cardId: "card-2",
            cardTitle: "Later task",
            checklistId: "checklist-1",
            listId: "list-1",
            boardId: "board-1",
            boardName: "Public",
            boardIcon: null,
            assigneeId: "user-1",
            dueDateLocalDate: "2026-05-20",
            dueDateSlot: "morning",
            dueDateTimezone: "UTC",
          },
        ],
      }));
    });

    fixture.detectChanges();
    await vi.waitFor(() => expect(assignedState(component).targetUser()?.userId).toBe("user-1"));

    expect(component.filteredChecklistItems().map((item) => item.itemId)).toEqual(["item-1"]);
    expect(component.showChecklistSection()).toBe(true);

    component.searchQuery.set("no match");

    expect(component.filteredChecklistItems()).toEqual([]);
    expect(component.showChecklistSection()).toBe(false);
  });

  it("keeps assigned-work list grouping sorted while applying archived visibility", () => {
    assignedState(component).hydrateAssignedWork(payload({
      cards: [
        summary({ id: "card-1", position: "3000.0000000000" }),
        summary({ id: "card-2", position: "1000.0000000000", completedAt: new Date("2026-05-21T10:00:00.000Z") }),
        summary({ id: "card-3", position: "2000.0000000000", archivedAt: new Date("2026-05-21T10:00:00.000Z") }),
      ],
    }));

    expect(component.filteredCardsByList().get("list-1")?.map((c) => c.id)).toEqual(["card-2", "card-1"]);

    component.showArchived.set(true);
    expect(component.filteredCardsByList().get("list-1")?.map((c) => c.id)).toEqual(["card-3"]);
  });

  it("keeps residual position ties stable by card id", () => {
    assignedState(component).hydrateAssignedWork(payload({
      cards: [
        summary({ id: "card-b", position: "1000.0000000000" }),
        summary({ id: "card-a", position: "1000.0000000000" }),
      ],
    }));

    expect(component.filteredCardsByList().get("list-1")?.map((c) => c.id)).toEqual(["card-a", "card-b"]);
  });

  it("posts cross-board drop anchors without board-local filtering", async () => {
    assignedState(component).hydrateAssignedWork(payload({
      cards: [
        summary({ id: "card-3", boardId: "board-2", position: "1000.0000000000" }),
        summary({ id: "card-1", boardId: "board-1", position: "2000.0000000000" }),
        summary({ id: "card-2", boardId: "board-2", position: "3000.0000000000" }),
      ],
    }));
    api.post.mockResolvedValueOnce({ id: "card-1", listId: "list-1", position: "2000.0000000000" });

    await component.onCardDrop({
      cardId: "card-1",
      toListId: "list-1",
      afterCardId: "card-3",
      beforeCardId: "card-2",
    });

    expect(api.post).toHaveBeenCalledWith("/cards/card-1/move", {
      listId: "list-1",
      afterCardId: "card-3",
      beforeCardId: "card-2",
    });
  });

  it("resolves team members by requested user, fallback, and excludes self from tabs", async () => {
    const resolveTargetUserId = (component as any).resolveTargetUserId.bind(component) as (workspaceId: string, mode: string, requestedUserId?: string) => Promise<string | null>;

    await expect(resolveTargetUserId("workspace-1", "team", "user-3")).resolves.toBe("user-3");
    expect(component.members().map((m) => m.userId)).toEqual(["user-2", "user-3"]);

    await expect(resolveTargetUserId("workspace-1", "team", "missing")).resolves.toBe("user-2");
    await expect(resolveTargetUserId("workspace-1", "team")).resolves.toBe("all");
  });

  it("loads team assigned work once through the aggregate All endpoint and uses payload members for tabs", async () => {
    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();
    await vi.waitFor(() => expect(assignedState(component).targetUser()?.userId).toBe("all"));

    const memberLoads = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path === "/workspaces/workspace-1/members");
    const cardLoads = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith("/workspaces/workspace-1/assignees/") && path.endsWith("/cards"));
    expect(memberLoads).toHaveLength(1);
    expect(cardLoads).toEqual(["/workspaces/workspace-1/assignees/cards"]);
    expect(component.members().map((m) => m.userId)).toEqual(["user-2"]);
    expect(component.selectedUserId()).toBe("all");

    socket.trigger("connect");
    await Promise.resolve();
    const cardLoadsAfterFirstConnect = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith("/workspaces/workspace-1/assignees/") && path.endsWith("/cards"));
    expect(cardLoadsAfterFirstConnect).toHaveLength(1);
  });

  it("refreshes assigned work on reconnect without reloading members", async () => {
    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();
    await vi.waitFor(() => expect(assignedState(component).targetUser()?.userId).toBe("all"));

    socket.trigger("connect");
    socket.trigger("connect");

    await vi.waitFor(() => {
      const cardLoads = api.get.mock.calls
        .map(([path]) => path as string)
        .filter((path) => path.startsWith("/workspaces/workspace-1/assignees/") && path.endsWith("/cards"));
      expect(cardLoads).toHaveLength(2);
    });
    const memberLoads = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path === "/workspaces/workspace-1/members");
    expect(memberLoads).toHaveLength(1);
  });

  it("hydrates from the team:last offline cache when the online load fails before a user is selected", async () => {
    api.get.mockRejectedValue(new Error("offline"));
    offlineCache.loadAssignedWork.mockImplementation((key: string) =>
      Promise.resolve(key === "workspace-1:team" ? { payload: payload({ targetUser: { userId: "all", displayName: "All", avatarUrl: null, role: "member" } }), tabMembers: [member()], cachedAt: "2026-05-21T00:00:00.000Z" } : null),
    );

    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.offlineAssignedCachedAt()).toBe("2026-05-21T00:00:00.000Z"));

    expect(component.selectedUserId()).toBe("all");
    expect(component.members().map((m) => m.userId)).toEqual(["user-2"]);
  });

  it("uses the saved team view before assigned-work data finishes loading", () => {
    localStorage.setItem(viewPreferenceKey("mode", "assignedWork:workspace-1:team"), "list");

    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();

    expect(component.effectiveView()).toBe("list");
  });

  it("accepts calendar as an assigned-work view mode", () => {
    fixture.componentRef.setInput("view", "calendar");
    fixture.detectChanges();

    expect(component.effectiveView()).toBe("calendar");
  });

  it("uses saved calendar preferences for team cards", () => {
    localStorage.setItem(viewPreferenceKey("mode", "assignedWork:workspace-1:team"), "calendar");
    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();

    expect(component.effectiveView()).toBe("calendar");
  });

  it("stores the assigned-work background as a view preference", () => {
    component.setAssignedBackground("forest");
    expect(localStorage.getItem(viewPreferenceKey("background", "assignedWork:workspace-1:me"))).toBe("forest");
    expect(component.assignedBackground()).toBe("forest");

    component.setAssignedBackground(null);
    expect(localStorage.getItem(viewPreferenceKey("background", "assignedWork:workspace-1:me"))).toBeNull();
    expect(component.assignedBackground()).toBeNull();
  });

  it("refreshes the assigned-work background when another tab changes it", () => {
    const key = viewPreferenceKey("background", "assignedWork:workspace-1:me");
    expect(component.assignedBackground()).toBeNull();

    localStorage.setItem(key, "ocean");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "ocean" }));

    expect(component.assignedBackground()).toBe("ocean");
  });

  it("does not reuse a previous assigned-work route view when opening team cards", () => {
    localStorage.setItem(viewPreferenceKey("mode", "assignedWork:workspace-1:me"), "board");
    localStorage.setItem(viewPreferenceKey("mode", "assignedWork:workspace-1:team"), "list");

    fixture.detectChanges();
    expect(component.effectiveView()).toBe("board");

    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();

    expect(component.effectiveView()).toBe("list");
  });

  it("uses the aggregate team list preference before All is hydrated", () => {
    localStorage.setItem(viewPreferenceKey("mode", "assignedWork:workspace-1:team"), "list");

    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();

    expect(component.effectiveView()).toBe("list");
  });

  it("uses an existing per-member team list preference before the member is resolved", () => {
    localStorage.setItem(viewPreferenceKey("mode", "assignedWork:workspace-1:user-2"), "list");

    fixture.componentRef.setInput("mode", "team");
    fixture.componentRef.setInput("userId", "user-2");
    fixture.detectChanges();

    expect(component.effectiveView()).toBe("list");
  });

  it("navigates member tabs with userId and All back to the canonical team route", () => {
    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();

    component.selectUser("user-2");
    expect(router.navigate).toHaveBeenCalledWith(["/w", "workspace-1", "team"], { queryParams: { userId: "user-2" } });

    component.selectUser("all");
    expect(router.navigate).toHaveBeenCalledWith(["/w", "workspace-1", "team"], {
      queryParams: { userId: null },
      queryParamsHandling: "merge",
    });
  });

  it("keeps completed history closed for the All tab", () => {
    fixture.componentRef.setInput("mode", "team");
    fixture.detectChanges();
    assignedState(component).hydrateAssignedWork(payload({ targetUser: { userId: "all", displayName: "All", avatarUrl: null, role: "member" } }));
    component.selectedUserId.set("all");

    component.openCompletedHistory();

    expect(component.completedPanelOpen()).toBe(false);
  });

  it("keeps the current team view visible while switching user tabs", async () => {
    const user3Load = deferred<WireAssignedWorkPayload>();
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/members")) {
        const addedAt = new Date("2026-05-21T00:00:00.000Z");
        return Promise.resolve([
          { workspaceId: "workspace-1", userId: "user-1", displayName: "Me", avatarUrl: null, role: "member", addedAt },
          { workspaceId: "workspace-1", userId: "user-2", displayName: "Ada", avatarUrl: null, role: "member", addedAt },
          { workspaceId: "workspace-1", userId: "user-3", displayName: "Grace", avatarUrl: null, role: "admin", addedAt },
        ] satisfies WireWorkspaceMember[]);
      }
      if (path.includes("/assignees/user-3/cards")) return user3Load.promise;
      return Promise.resolve(payload({
        members: [member({ userId: "user-1", displayName: "Me" }), member({ userId: "user-2", displayName: "Ada" }), member({ userId: "user-3", displayName: "Grace", role: "admin" })],
        cards: [summary({ id: "card-user-2", assigneeIds: ["user-2"] })],
        targetUser: { userId: "user-2", displayName: "Ada", avatarUrl: null, role: "member" },
      }));
    });

    fixture.componentRef.setInput("mode", "team");
    fixture.componentRef.setInput("userId", "user-2");
    fixture.detectChanges();
    await vi.waitFor(() => expect((component as any).state.targetUser()?.userId).toBe("user-2"));
    const initialMemberLoads = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path === "/workspaces/workspace-1/members");
    expect(initialMemberLoads).toHaveLength(1);

    fixture.componentRef.setInput("userId", "user-3");
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.selectedUserId()).toBe("user-3"));
    const memberLoadsAfterSwitch = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path === "/workspaces/workspace-1/members");
    expect(memberLoadsAfterSwitch).toHaveLength(1);

    expect((component as any).state.cards().map((c: WireCardSummary) => c.id)).toEqual(["card-user-2"]);
    expect((component as any).state.targetUser()?.userId).toBe("user-2");

    user3Load.resolve(payload({
      members: [member({ userId: "user-1", displayName: "Me" }), member({ userId: "user-2", displayName: "Ada" }), member({ userId: "user-3", displayName: "Grace", role: "admin" })],
      cards: [summary({ id: "card-user-3", assigneeIds: ["user-3"] })],
      targetUser: { userId: "user-3", displayName: "Grace", avatarUrl: null, role: "admin" },
    }));
    await vi.waitFor(() => expect((component as any).state.targetUser()?.userId).toBe("user-3"));

    expect((component as any).state.cards().map((c: WireCardSummary) => c.id)).toEqual(["card-user-3"]);
  });

  it("moves cards optimistically and rolls back when the API rejects the drop", async () => {
    (component as any).state.hydrateAssignedWork(payload({ viewerRole: "admin" }));
    const previous = (component as any).state.snapshotCards();
    api.post.mockRejectedValueOnce(new Error("nope"));

    await expect(component.onCardDrop({ cardId: "card-1", toListId: "list-1" })).rejects.toThrow("nope");

    expect((component as any).state.snapshotCards()).toEqual(previous);
  });

  it("moves assigned-work cards relative to cross-board neighbours", async () => {
    (component as any).state.hydrateAssignedWork(payload({
      viewerRole: "admin",
      cards: [
        summary({ id: "card-1", boardId: "board-1", position: "1000.0000000000" }),
        summary({ id: "card-2", boardId: "board-2", position: "2000.0000000000" }),
        summary({ id: "card-3", boardId: "board-1", position: "3000.0000000000" }),
      ],
    }));

    await component.onCardDrop({ cardId: "card-1", toListId: "list-1", beforeCardId: "card-2" });

    expect(api.post).toHaveBeenCalledWith("/cards/card-1/move", {
      listId: "list-1",
      beforeCardId: "card-2",
    });
  });

  it("allows assigned-work bulk selections to span boards", () => {
    assignedState(component).hydrateAssignedWork(payload({
      viewerRole: "admin",
      cards: [
        summary({ id: "card-1", boardId: "board-1", position: "1000.0000000000" }),
        summary({ id: "card-2", boardId: "board-1", position: "2000.0000000000" }),
        summary({ id: "card-3", boardId: "board-2", position: "3000.0000000000" }),
      ],
    }));

    component.onBulkSelectionRequested({ cardId: "card-1", orderedCardIds: ["card-1", "card-2", "card-3"], shiftKey: false, additive: true });
    component.onBulkSelectionRequested({ cardId: "card-2", orderedCardIds: ["card-1", "card-2", "card-3"], shiftKey: true, additive: true });

    expect(component.bulkSelectedCardIdList().sort()).toEqual(["card-1", "card-2"]);
    expect(component.bulkSelectionBoardId()).toBe("board-1");

    component.onBulkSelectionRequested({ cardId: "card-3", orderedCardIds: ["card-1", "card-2", "card-3"], shiftKey: false, additive: true });

    expect(component.bulkSelectedCardIdList().sort()).toEqual(["card-1", "card-2", "card-3"]);
    expect(component.bulkSelectedCards().map((card) => card.boardId).sort()).toEqual(["board-1", "board-1", "board-2"]);
  });

  it("selects a complete assigned-work group for individual users and All", () => {
    assignedState(component).hydrateAssignedWork(payload({ viewerRole: "admin" }));
    component.bulkSelectedCardIds.set(new Set(["existing-card"]));

    component.onBulkListSelectionRequested({ orderedCardIds: ["card-1", "card-2"], additive: false });
    expect(component.bulkSelectedCardIdList()).toEqual(["card-1", "card-2"]);

    component.onBulkListSelectionRequested({ orderedCardIds: ["card-3"], additive: true });
    expect(component.bulkSelectedCardIdList()).toEqual(["card-1", "card-2", "card-3"]);

    fixture.componentRef.setInput("mode", "team");
    component.selectedUserId.set("all");
    component.onBulkListSelectionRequested({ orderedCardIds: ["other-card"], additive: false });
    expect(component.bulkSelectedCardIdList()).toEqual(["other-card"]);
  });

  it("clears assigned-work bulk selection when opening a card or changing views", () => {
    assignedState(component).hydrateAssignedWork(payload({ viewerRole: "admin" }));

    component.onBulkSelectionRequested({ cardId: "card-1", orderedCardIds: ["card-1", "card-2"], shiftKey: false, additive: true });
    expect(component.bulkSelectedCount()).toBe(1);

    component.openCardDetail("card-1");

    expect(component.bulkSelectedCount()).toBe(0);
    expect(router.navigate).toHaveBeenCalledWith(["/w", "workspace-1", "u", "user-1"], {
      queryParams: { cardId: "card-1" },
      queryParamsHandling: "merge",
    });

    component.onBulkSelectionRequested({ cardId: "card-1", orderedCardIds: ["card-1", "card-2"], shiftKey: false, additive: true });
    component.setView("list");

    expect(component.bulkSelectedCount()).toBe(0);
  });

  it("navigates to the board from assigned-work card board badges", () => {
    component.openBoard("board-1");

    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1"]);
  });

  it("opens add-card mode for individual assigned-work users with board and assignee defaults", () => {
    assignedState(component).hydrateAssignedWork(payload());

    component.onStartAdd({ listId: "list-1", atTop: true });

    expect(component.canCreateAssignedCards()).toBe(true);
    expect(component.addingToListId()).toBe("list-1");
    expect(component.addingAtTop()).toBe(true);
    expect(component.defaultAddCardBoardId()).toBe("board-1");
    expect(component.addCardAssigneeIds()).toEqual(["user-1"]);
  });

  it("keeps add-card mode open for the click that starts it", () => {
    assignedState(component).hydrateAssignedWork(payload());

    component.onStartAdd({ listId: "list-1", atTop: false });
    component.onDocumentClick(new MouseEvent("click"));

    expect(component.addingToListId()).toBe("list-1");
  });

  it("keeps add-card mode open when text selection starts inside the form and ends outside", () => {
    const form = document.createElement("form");
    form.className = "add-card-form";
    const textarea = document.createElement("textarea");
    form.append(textarea);
    fixture.nativeElement.prepend(form);
    component.addingToListId.set("list-1");

    textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(component.addingToListId()).toBe("list-1");
  });

  it("closes add-card mode when a click starts outside the form", () => {
    const form = document.createElement("form");
    form.className = "lv-add-popover";
    fixture.nativeElement.prepend(form);
    component.addingToListId.set("list-1");

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(component.addingToListId()).toBeNull();
  });

  it("does not open add-card mode for the aggregate all assigned-work view", () => {
    assignedState(component).hydrateAssignedWork(payload({ targetUser: { userId: "all", displayName: "All", avatarUrl: null, role: "member" } }));

    component.onStartAdd({ listId: "list-1", atTop: false });

    expect(component.canCreateAssignedCards()).toBe(false);
    expect(component.addingToListId()).toBeNull();
  });

  it("adds newly created assigned-work cards and pins the selected user as assignee", () => {
    assignedState(component).hydrateAssignedWork(payload());

    component.onAssignedCardCreated(summary({ id: "card-new", title: "New work", assigneeIds: [] }));

    expect(assignedState(component).hasCard("card-new")).toBe(true);
    expect(assignedState(component).assigneeIdsForCard("card-new")).toEqual(["user-1"]);
  });

  it("keeps completed cards out of assigned-work refreshes by default", async () => {
    api.get.mockImplementation((path: string) => {
      if (path.endsWith("/members")) {
        const addedAt = new Date("2026-05-21T00:00:00.000Z");
        const rows: WireWorkspaceMember[] = [
          { workspaceId: "workspace-1", userId: "user-1", displayName: "Me", avatarUrl: null, role: "member", addedAt },
          { workspaceId: "workspace-1", userId: "user-2", displayName: "Ada", avatarUrl: null, role: "member", addedAt },
        ];
        return Promise.resolve(rows);
      }
      return Promise.resolve(payload({
        cards: [
          summary({ id: "card-2", title: "Open task", position: "2000.0000000000" }),
        ],
      }));
    });

    fixture.detectChanges();
    await vi.waitFor(() => expect(component.selectedUserId()).toBe("user-1"));

    expect((component as any).state.cards().map((card: WireCardSummary) => card.id)).toEqual(["card-2"]);

    socket.trigger("card:updated", {
      boardId: "board-1",
      card: {
        id: "card-1",
        listId: "list-1",
        boardId: "board-1",
        title: "Completed task",
        description: null,
        position: "1000.0000000000",
        dueDateLocalDate: null,
        dueDateSlot: null,
        completedAt: new Date("2026-05-21T10:00:00.000Z"),
        archivedAt: null,
        createdById: "user-1",
        coverAttachmentId: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T10:00:00.000Z"),
      },
    });

    await vi.waitFor(() => {
      const cardLoads = api.get.mock.calls
        .map(([path]) => path as string)
        .filter((path) => path.startsWith("/workspaces/workspace-1/assignees/user-1/cards"));
      expect(cardLoads.at(-1)).toBe("/workspaces/workspace-1/assignees/user-1/cards");
    });
    expect((component as any).state.cards().map((card: WireCardSummary) => card.id)).toEqual(["card-2"]);
  });

  it("refreshes assigned work after board rooms are rejoined on reconnect", async () => {
    socket.connected = true;

    fixture.detectChanges();
    await vi.waitFor(() => expect(component.selectedUserId()).toBe("user-1"));

    const cardLoadCount = () =>
      api.get.mock.calls
        .map(([path]) => path as string)
        .filter((path) => path.startsWith("/workspaces/workspace-1/assignees/user-1/cards"))
        .length;
    expect(cardLoadCount()).toBe(1);

    socket.trigger("connect");

    await vi.waitFor(() => expect(cardLoadCount()).toBe(2));
    const lastCardLoad = api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith("/workspaces/workspace-1/assignees/user-1/cards"))
      .at(-1);
    expect(lastCardLoad).toBe("/workspaces/workspace-1/assignees/user-1/cards");
  });

  it("moves to the nearest remaining team tab when the selected member is removed", () => {
    fixture.componentRef.setInput("mode", "team");
    component.members.set([member({ userId: "user-2", displayName: "Ada" }), member({ userId: "user-3", displayName: "Grace" })]);
    component.selectedUserId.set("user-2");
    router.navigate.mockClear();

    component.handleRemovedMemberTab("user-2");

    expect(component.members().map((member) => member.userId)).toEqual(["user-3"]);
    expect(component.selectedUserId()).toBe("user-3");
    expect(router.navigate).toHaveBeenCalledWith(["/w", "workspace-1", "team"], {
      queryParams: { userId: "user-3" },
      replaceUrl: true,
    });
  });
});
