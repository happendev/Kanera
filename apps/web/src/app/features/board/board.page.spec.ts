import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import type { Board, List } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { RecentBoardsService } from "../../core/recent-boards/recent-boards.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { AppTitleService } from "../../core/title/app-title.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BoardPage } from "./board.page";
import type { BoardState } from "./board-state";

class SocketStub {
  connected = true;
  readonly emit = vi.fn((event: string, ...args: unknown[]) => {
    if (event === "board:join") {
      const ack = args[1];
      if (typeof ack === "function") (ack as (ok: boolean) => void)(true);
    }
    return this;
  });
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
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
  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    id: "board-1",
    workspaceId: "workspace-1",
    groupId: null,
    name: "Roadmap",
    description: null,
    icon: null,
    iconColor: null,
    backgroundGradient: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function list(overrides: Partial<List> = {}): List {
  return {
    id: "list-1",
    workspaceId: "workspace-1",
    name: "Todo",
    icon: null,
    color: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function card(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Ship tests",
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
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  };
}

function assignedCard(id: string, assigneeIds: string[]): WireCardSummary {
  return card({ id, title: id, assigneeIds });
}

function member(overrides: Partial<WireBoardMemberUser> = {}): WireBoardMemberUser {
  return {
    userId: "user-1",
    displayName: "Me User",
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

describe("BoardPage", () => {
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
  let offlineCache: { saveBoard: ReturnType<typeof vi.fn>; loadBoard: ReturnType<typeof vi.fn>; revokeBoardAccess: ReturnType<typeof vi.fn> };
  let recentBoards: { record: ReturnType<typeof vi.fn> };
  let cardUnreadCounts: ReturnType<typeof signal<Record<string, number>>>;
  let router: { navigate: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn> };
  let socket: SocketStub;

  function boardState(component: BoardPage): BoardState {
    return (component as unknown as { state: BoardState }).state;
  }

  function appTitle() {
    return TestBed.inject(AppTitleService) as unknown as { set: ReturnType<typeof vi.fn> };
  }

  function flushEffects() {
    TestBed.tick();
  }

  function createInitializedBoardPage() {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();
    flushEffects();
    appTitle().set.mockClear();
    return fixture;
  }

  function boardPayload() {
    return {
      board: board(),
      lists: [list()],
      cards: [
        card({ id: "card-1", completedAt: new Date("2026-05-21T10:00:00.000Z") }),
        card({ id: "card-2", title: "Open overdue task", position: "2000.0000000000" }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor" as const,
    };
  }

  beforeEach(async () => {
    localStorage.clear();
    api = {
      get: vi.fn(() => Promise.resolve([])),
      post: vi.fn(() => Promise.resolve(boardPayload())),
      patch: vi.fn(() => Promise.resolve(card({ dueDateLocalDate: "2026-05-22", dueDateSlot: "morning" }))),
    };
    offlineCache = {
      saveBoard: vi.fn(() => Promise.resolve()),
      loadBoard: vi.fn(() => Promise.resolve(null)),
      revokeBoardAccess: vi.fn(() => Promise.resolve()),
    };
    recentBoards = { record: vi.fn() };
    cardUnreadCounts = signal<Record<string, number>>({});
    router = { navigate: vi.fn(() => Promise.resolve(true)), navigateByUrl: vi.fn(() => Promise.resolve(true)) };
    socket = new SocketStub();

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: Router, useValue: router },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), joinWorkspace: vi.fn(() => vi.fn()), online: signal(true), displayedOnline: signal(true), reconnecting: signal(false), accessRefreshing: signal(false) } },
        { provide: OfflineCacheService, useValue: offlineCache },
        { provide: WorkspaceService, useValue: { registerBoards: vi.fn(), removeBoard: vi.fn(), cacheLists: vi.fn(), accentColorForBoard: vi.fn(() => null), setActiveAccentColor: vi.fn(), listsForBoard: vi.fn(() => [list()]) } },
        { provide: AppTitleService, useValue: { set: vi.fn() } },
        { provide: NotificationsService, useValue: { isWatchingBoard: () => false, cardUnreadCount: (cardId: string) => cardUnreadCounts()[cardId] ?? 0 } },
        { provide: RecentBoardsService, useValue: recentBoards },
      ],
    })
      .overrideComponent(BoardPage, { set: { template: "" } })
      .compileComponents();
  });

  it("sets the fallback board title before board data loads", () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();
    flushEffects();

    expect(appTitle().set).toHaveBeenLastCalledWith("Board");
  });

  it("keeps add-card mode open when text selection starts inside the form and ends outside", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    const form = document.createElement("form");
    form.className = "add-card-form";
    const textarea = document.createElement("textarea");
    form.append(textarea);
    fixture.nativeElement.append(form);
    component.addingToListId.set("list-1");

    textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(component.addingToListId()).toBe("list-1");
  });

  it("does not treat a selection release on the board surface as a background click", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    const form = document.createElement("form");
    form.className = "add-card-form";
    const textarea = document.createElement("textarea");
    form.append(textarea);
    fixture.nativeElement.append(form);
    component.addingToListId.set("list-1");
    textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const boardSurface = document.createElement("div");
    const backgroundClick = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(backgroundClick, "target", { value: boardSurface });
    Object.defineProperty(backgroundClick, "currentTarget", { value: boardSurface });

    component.onListsBackgroundClick(backgroundClick);

    expect(component.addingToListId()).toBe("list-1");
  });

  it("closes add-card mode when a click starts outside the form", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    const form = document.createElement("form");
    form.className = "add-card-form";
    fixture.nativeElement.append(form);
    component.addingToListId.set("list-1");

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(component.addingToListId()).toBeNull();
  });

  it("filters cards by reactive unread notification counts and clears the filter", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    fixture.componentRef.setInput("view", "calendar");
    boardState(component).hydrate(boardPayload());
    cardUnreadCounts.set({ "card-2": 1 });

    component.showUnreadOnly.set(true);

    expect(component.toolbarFilterActive()).toBe(true);
    expect(component.filteredCardIds()).toEqual(new Set(["card-2"]));

    cardUnreadCounts.set({ "card-1": 2 });
    expect(component.filteredCardIds()).toEqual(new Set(["card-1"]));

    fixture.componentRef.setInput("view", "history");
    expect(component.toolbarFilterActive()).toBe(false);
    expect(component.filteredCardIds()).toBeNull();

    void component.clearFilters();
    expect(component.showUnreadOnly()).toBe(false);
    expect(component.filteredCardIds()).toBeNull();
  });

  it("sets the loaded board name as the title when no card detail is open", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    fixture.detectChanges();
    flushEffects();

    expect(appTitle().set).toHaveBeenLastCalledWith("Roadmap");
  });

  it("sets the open card title before the board name while card detail is open", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    component.openCardId.set("card-2");
    fixture.detectChanges();
    flushEffects();

    expect(appTitle().set).toHaveBeenLastCalledWith("Open overdue task", "Roadmap");
  });

  it("keeps the open card resolvable when it drops out of the live collection, and closes on a real delete", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    component.openCardId.set("card-2");
    flushEffects();

    // Sticky modal: the held summary keeps openCard non-null after a background refresh / filter
    // change removes the card from state.cards() (openCardId unchanged).
    expect(component.openCard()?.id).toBe("card-2");
    boardState(component).removeCard("card-2");
    flushEffects();
    expect(component.openCard()?.id).toBe("card-2");

    // A real CARD_DELETED for the open card clears the held summary and closes the modal.
    socket.trigger("card:deleted", { boardId: "board-1", cardId: "card-2" });
    flushEffects();
    expect(component.openCard()).toBeNull();
    expect(router.navigate).toHaveBeenCalled();
  });

  it("does not resurrect a held card from a previous visit after navigating through an unavailable card", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    component.openCardId.set("card-2");
    flushEffects();

    // card-2 leaves the live collection but stays open via the held summary.
    boardState(component).removeCard("card-2");
    flushEffects();
    expect(component.openCard()?.id).toBe("card-2");

    // Navigate to a card that isn't in the collection: nothing resolves and card-2's held summary
    // must not leak across the id change.
    component.openCardId.set("card-unavailable");
    flushEffects();
    expect(component.openCard()).toBeNull();

    // Returning to card-2 while it is still outside the collection must not revive the stale summary.
    component.openCardId.set("card-2");
    flushEffects();
    expect(component.openCard()).toBeNull();
  });

  it("returns to the board title after card detail closes", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    component.openCardId.set("card-2");
    fixture.detectChanges();
    flushEffects();

    component.openCardId.set(null);
    fixture.detectChanges();
    flushEffects();

    expect(appTitle().set).toHaveBeenLastCalledWith("Roadmap");
  });

  it("updates the title when the open card title changes", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    const state = boardState(component);
    state.hydrate(boardPayload());
    component.openCardId.set("card-2");
    fixture.detectChanges();
    flushEffects();

    state.updateCard(card({ id: "card-2", title: "Updated card title", position: "2000.0000000000" }));
    fixture.detectChanges();
    flushEffects();

    expect(appTitle().set).toHaveBeenLastCalledWith("Updated card title", "Roadmap");
  });

  it("uses completed history cards for card detail titles", () => {
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    component.completedHistoryCard.set(card({ id: "completed-1", title: "Finished milestone" }));
    component.openCardId.set("completed-1");
    fixture.detectChanges();
    flushEffects();

    expect(appTitle().set).toHaveBeenLastCalledWith("Finished milestone", "Roadmap");
  });

  it("excludes completed cards from the overdue filter", async () => {
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    boardState(component).hydrate({
      board: board(),
      lists: [list()],
      cards: [
        card({ id: "card-1", completedAt: new Date("2026-05-21T10:00:00.000Z") }),
        card({ id: "card-2", title: "Open overdue task", position: "2000.0000000000" }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    component.showOverdueOnly.set(true);

    expect(component.filteredCardIds()).toEqual(new Set(["card-2"]));
  });

  it("treats overdue as a dropdown filter in calendar view", () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("view", "calendar");
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());

    expect(component.toolbarFilterActive()).toBe(false);

    component.showOverdueOnly.set(true);

    expect(component.toolbarFilterActive()).toBe(true);
    expect(component.filteredCardIds()).toEqual(new Set(["card-2"]));
  });

  it("treats archived as a dropdown filter in calendar view", () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("view", "calendar");
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());

    expect(component.toolbarFilterActive()).toBe(false);

    component.showArchived.set(true);

    expect(component.toolbarFilterActive()).toBe(true);
  });

  it("does not count overdue as a dropdown filter in history view", () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("view", "history");
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());

    component.showOverdueOnly.set(true);

    expect(component.toolbarFilterActive()).toBe(false);
  });

  it("debounces applying search text to card filters", () => {
    vi.useFakeTimers();
    try {
      const fixture = TestBed.createComponent(BoardPage);
      const component = fixture.componentInstance;
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.detectChanges();

      component.setSearchQuery("open");
      fixture.detectChanges();

      expect(component.searchInputValue()).toBe("open");
      expect(component.searchQuery()).toBe("");

      vi.advanceTimersByTime(199);
      expect(component.searchQuery()).toBe("");

      vi.advanceTimersByTime(1);
      expect(component.searchQuery()).toBe("open");

      component.setSearchQuery("");
      expect(component.searchQuery()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups active board cards by list in one sorted result", () => {
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    boardState(component).hydrate({
      board: board(),
      lists: [list({ id: "list-1" }), list({ id: "list-2", name: "Done", position: "2000.0000000000" })],
      cards: [
        card({ id: "card-1", listId: "list-1", position: "3000.0000000000" }),
        card({ id: "card-2", listId: "list-1", position: "1000.0000000000", completedAt: new Date("2026-05-21T10:00:00.000Z") }),
        card({ id: "card-3", listId: "list-2", position: "2000.0000000000" }),
        card({ id: "card-4", listId: "list-2", position: "1000.0000000000", archivedAt: new Date("2026-05-21T10:00:00.000Z") }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    expect(component.cardsByList().get("list-1")?.map((c) => c.id)).toEqual(["card-2", "card-1"]);
    expect(component.cardsByList().get("list-2")?.map((c) => c.id)).toEqual(["card-3"]);

    component.showArchived.set(true);
    expect(component.cardsByList().get("list-1")).toEqual([]);
    expect(component.cardsByList().get("list-2")?.map((c) => c.id)).toEqual(["card-4"]);
  });

  it("replaces or extends bulk selection from a list-menu selection", () => {
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());
    component.bulkSelectedCardIds.set(new Set(["card-existing"]));

    component.onBulkListSelectionRequested({ orderedCardIds: ["card-1", "card-2"], additive: false });
    expect([...component.bulkSelectedCardIds()]).toEqual(["card-1", "card-2"]);

    component.onBulkListSelectionRequested({ orderedCardIds: ["card-3"], additive: true });
    expect([...component.bulkSelectedCardIds()]).toEqual(["card-1", "card-2", "card-3"]);
  });

  it("stages one rendered list column and coalesces scroll events near the rendered edge", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    try {
      boardState(component).hydrate({
        board: board(),
        lists: Array.from({ length: 20 }, (_, i) =>
          list({ id: `list-${i}`, name: `List ${i}`, position: `${(i + 1) * 1000}.0000000000` }),
        ),
        cards: [],
        customFields: [],
        cardLabels: [],
        members: [],
        viewerRole: "editor",
      });

      expect(component.renderedLists().length).toBe(8);
      const callbacksBeforeScroll = frameCallbacks.length;

      const scroller = {
        scrollWidth: 2400,
        scrollLeft: 1300,
        clientWidth: 400,
      } as HTMLElement;
      component.onListsScroll(scroller);
      component.onListsScroll(scroller);

      expect(frameCallbacks).toHaveLength(callbacksBeforeScroll + 1);
      expect(component.renderedLists().length).toBe(8);

      frameCallbacks[callbacksBeforeScroll]?.(0);
      expect(component.renderedLists().length).toBe(9);
    } finally {
      fixture.destroy();
      requestFrame.mockRestore();
    }
  });

  it("cancels pending staged list growth when the board is destroyed", () => {
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    boardState(component).hydrate({
      board: board(),
      lists: Array.from({ length: 20 }, (_, i) =>
        list({ id: `list-${i}`, name: `List ${i}`, position: `${(i + 1) * 1000}.0000000000` }),
      ),
      cards: [],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    component.onListsScroll({ scrollWidth: 2400, scrollLeft: 1300, clientWidth: 400 } as HTMLElement);
    fixture.destroy();

    expect(cancelFrame).toHaveBeenCalledWith(42);
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("still reveals every list before CDK snapshots targets for a card drag", () => {
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    boardState(component).hydrate({
      board: board(),
      lists: Array.from({ length: 20 }, (_, i) =>
        list({ id: `list-${i}`, name: `List ${i}`, position: `${(i + 1) * 1000}.0000000000` }),
      ),
      cards: [],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    const scroller = document.createElement("div");
    const detach = (component as unknown as { attachScrollDragHandlers: (el: HTMLElement) => () => void })
      .attachScrollDragHandlers(scroller);

    try {
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      expect(component.renderedLists().length).toBe(20);
      expect(scroller.classList.contains("is-card-dragging")).toBe(true);
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
      expect(scroller.classList.contains("is-card-dragging")).toBe(false);
    } finally {
      detach();
      fixture.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("settles each mobile drag on its own drop target", async () => {
    const originalMatchMedia = window.matchMedia;
    const originalCss = globalThis.CSS;
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { ...originalCss, escape: (value: string) => value },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    const scroller = document.createElement("div");
    const first = document.createElement("k-list");
    first.dataset["listId"] = "list-1";
    const second = document.createElement("k-list");
    second.dataset["listId"] = "list-2";
    const firstScroll = vi.fn();
    const secondScroll = vi.fn();
    first.scrollIntoView = firstScroll;
    second.scrollIntoView = secondScroll;
    scroller.append(first, second);
    const detach = (component as unknown as { attachScrollDragHandlers: (el: HTMLElement) => () => void })
      .attachScrollDragHandlers(scroller);

    try {
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: "list-1" }));
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
      await Promise.resolve();
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: "list-2" }));
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
      await Promise.resolve();

      expect(firstScroll).toHaveBeenCalledOnce();
      expect(firstScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest", inline: "center" });
      expect(secondScroll).toHaveBeenCalledOnce();
      expect(secondScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest", inline: "center" });

      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
      document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: "list-1" }));
      await Promise.resolve();
      expect(firstScroll).toHaveBeenCalledTimes(2);
    } finally {
      detach();
      fixture.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      Object.defineProperty(window, "matchMedia", { value: originalMatchMedia, configurable: true });
      Object.defineProperty(globalThis, "CSS", { value: originalCss, configurable: true });
    }
  });

  it("accepts calendar as a board view mode", () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("view", "calendar");
    fixture.detectChanges();

    expect(fixture.componentInstance.effectiveView()).toBe("calendar");
  });

  it("opens the board with a single board-open request", async () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.post).toHaveBeenCalledWith("/boards/board-1/open", {});
    expect(api.get).not.toHaveBeenCalledWith("/workspaces/workspace-1/members");
    expect(api.post).not.toHaveBeenCalledWith("/boards/board-1/visit", {});
    expect(recentBoards.record).toHaveBeenCalledWith("board-1");
  });

  it("has no header members before a board is loaded", () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");

    expect(fixture.componentInstance.headerMembers()).toEqual([]);
    expect(fixture.componentInstance.headerMemberOverflow()).toBe(0);
    expect(fixture.componentInstance.membersButtonLabel()).toBe("0 board members");
  });

  it("uses a singular accessible label for one board member", async () => {
    api.post.mockResolvedValue({
      ...boardPayload(),
      members: [member()],
    });
    const fixture = createInitializedBoardPage();

    await vi.waitFor(() => expect(fixture.componentInstance.sortedBoardMembers().length).toBe(1));
    expect(fixture.componentInstance.membersButtonLabel()).toBe("1 board member");
  });

  it("shows board members and caps the header stack at five ordered by role then user", async () => {
    const payload = {
      ...boardPayload(),
      cards: [
        assignedCard("card-1", ["user-3"]),
        assignedCard("card-2", ["user-3"]),
        assignedCard("card-3", ["user-6"]),
      ],
      members: [
        member({ userId: "user-2", displayName: "Ada", role: "member" }),
        member({ userId: "user-3", displayName: "Grace", role: "editor" }),
        member({ userId: "user-4", displayName: "Katherine", role: "observer" }),
        member({ userId: "user-5", displayName: "Margaret", role: "member" }),
        member({ userId: "user-6", displayName: "Radia", role: "admin", pinned: true }),
        member({ userId: "user-1", displayName: "Me User", role: "editor" }),
      ],
    };
    api.post.mockResolvedValue(payload);
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;

    await vi.waitFor(() => expect(component.sortedBoardMembers().length).toBe(6));
    expect(api.get).not.toHaveBeenCalledWith("/workspaces/workspace-1/members");
    expect(component.headerMembers().map((row) => row.userId)).toEqual(["user-6", "user-3", "user-1", "user-2", "user-5"]);
    expect(component.headerMemberOverflow()).toBe(1);
    expect(component.membersButtonLabel()).toBe("6 board members");

    const event = { stopPropagation: vi.fn() } as unknown as MouseEvent;
    component.toggleMembersPopover(event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(component.membersPopoverOpen()).toBe(true);
  });

  it("downloads a full board JSON archive from the board export endpoint", async () => {
    const archive = {
      format: "kanera.board.export",
      version: 1,
      exportedAt: "2026-05-27T12:00:00.000Z",
      board: board({ name: "Roadmap/Launch" }),
      lists: [],
      labels: [],
      customFields: [],
      members: [],
      cards: [],
      cardAssignees: [],
      cardLabelAssignments: [],
      cardCustomFieldValues: [],
      checklists: [],
      comments: [],
      commentReactions: [],
      cardWatchers: [],
      attachments: [],
    };
    api.get.mockResolvedValueOnce(archive);
    const anchor = document.createElement("a");
    const click = vi.spyOn(anchor, "click").mockImplementation(() => undefined);
    const createElement = vi.spyOn(document, "createElement").mockReturnValue(anchor);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:board-export");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    boardState(fixture.componentInstance).viewerRole.set("editor");

    try {
      await fixture.componentInstance.exportBoardJson();

      expect(api.get).toHaveBeenCalledWith("/boards/board-1/export");
      expect(createObjectUrl).toHaveBeenCalledOnce();
      expect(anchor.download).toBe("Roadmap-Launch-2026-05-27T12-00-00-000Z.json");
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:board-export");
    } finally {
      createElement.mockRestore();
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
      click.mockRestore();
    }
  });

  it("does not request a board export for an observer", async () => {
    const fixture = createInitializedBoardPage();
    boardState(fixture.componentInstance).viewerRole.set("observer");
    api.get.mockClear();

    await fixture.componentInstance.exportBoardJson();

    expect(api.get).not.toHaveBeenCalledWith("/boards/board-1/export");
  });

  it("shows same-org members and guests together when both belong to the board", async () => {
    api.post.mockResolvedValueOnce({
      ...boardPayload(),
      cards: [
        assignedCard("card-1", ["guest-2"]),
        assignedCard("card-2", ["guest-2"]),
        assignedCard("card-3", ["guest-1"]),
      ],
      members: [
        member({ userId: "user-1", displayName: "Me User", source: "workspace" }),
        member({ userId: "user-2", displayName: "Ada", source: "workspace" }),
        member({ userId: "guest-1", displayName: "Guest One", source: "board" }),
        member({ userId: "guest-2", displayName: "Guest Two", source: "board" }),
      ],
    });
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    const component = fixture.componentInstance;
    fixture.detectChanges();

    await vi.waitFor(() => expect(component.sortedBoardMembers().length).toBe(4));
    expect(component.sortedBoardMembers().map((row) => row.userId)).toEqual(["user-2", "guest-1", "guest-2", "user-1"]);
  });

  it("removes another user from the board member header when their membership is removed", async () => {
    api.post.mockResolvedValueOnce({
      ...boardPayload(),
      members: [
        member({ userId: "user-1", displayName: "Me User" }),
        member({ userId: "user-2", displayName: "Ada" }),
      ],
    });
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    await vi.waitFor(() => expect(component.sortedBoardMembers().length).toBe(2));

    socket.trigger("board:member:removed", { boardId: "board-1", userId: "user-2" });

    expect(component.sortedBoardMembers().map((row) => row.userId)).toEqual(["user-1"]);
    expect(component.membersButtonLabel()).toBe("1 board member");
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it("makes a newly added board member immediately available to assignment pickers", async () => {
    api.post.mockResolvedValueOnce({ ...boardPayload(), members: [member({ userId: "user-1" })] });
    const fixture = createInitializedBoardPage();
    const component = fixture.componentInstance;
    await vi.waitFor(() => expect(component.assignableMembers().map((row) => row.userId)).toEqual(["user-1"]));

    socket.trigger("board:member:added", {
      boardId: "board-1",
      member: { boardId: "board-1", userId: "user-2", role: "editor", assignedItemsOnly: false, pinned: false, addedAt: new Date() },
      user: member({ userId: "user-2", displayName: "Ben", source: "board" }),
    });

    expect(component.assignableMembers().map((row) => row.userId)).toEqual(["user-2", "user-1"]);
    expect(component.membersButtonLabel()).toBe("2 board members");
  });

  it("removes a member and their card assignments immediately after the members menu mutation", () => {
    const fixture = TestBed.createComponent(BoardPage);
    const component = fixture.componentInstance;
    const state = boardState(component);
    state.members.set([
      member({ userId: "user-1" }),
      member({ userId: "user-2" }),
    ]);
    state.assignableMembers.set(state.members());
    state.setCardAssignees("card-1", ["user-1", "user-2"]);

    component.removeBoardMemberFromView("user-2");

    // An open-board request that started before the removal may resolve afterward with stale data.
    state.hydrate({
      ...boardPayload(),
      members: [member({ userId: "user-1" }), member({ userId: "user-2" })],
      cards: [card({ assigneeIds: ["user-1", "user-2"] })],
    });

    expect(component.sortedBoardMembers().map((row) => row.userId)).toEqual(["user-1"]);
    expect(component.membersButtonLabel()).toBe("1 board member");
    expect(state.assignableMembers().map((row) => row.userId)).toEqual(["user-1"]);
    expect(state.assigneesForCard("card-1").map((row) => row.userId)).toEqual(["user-1"]);
  });

  it("does not include workspace-only users as assignment candidates", async () => {
    api.post.mockResolvedValueOnce({
      ...boardPayload(),
      members: [
        member({ userId: "user-1", displayName: "Me User", source: "workspace" }),
      ],
    });
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    const component = fixture.componentInstance;
    fixture.detectChanges();

    await vi.waitFor(() => expect(component.assignableMembers().map((row) => row.userId)).toEqual(["user-1"]));
    expect(boardState(component).assignableMembers().map((row) => row.userId)).toEqual(["user-1"]);
    expect(api.get).not.toHaveBeenCalledWith("/workspaces/workspace-1/members");
  });

  it("skips recording a local recent board on board refreshes", async () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    const component = fixture.componentInstance as unknown as {
      loadBoard: (boardId: string, includeCompleted: boolean, includeArchived: boolean, recordVisit: boolean) => Promise<unknown>;
    };

    await component.loadBoard("board-1", true, false, false);

    expect(api.post).toHaveBeenCalledWith("/boards/board-1/open?includeCompleted=true", {});
    expect(recentBoards.record).not.toHaveBeenCalled();
  });

  it("refetches with a completed range and restores the persisted board preference", async () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    const component = fixture.componentInstance;
    boardState(component).hydrate(boardPayload());

    await component.applyCompletedRange({ from: "2026-01-01", to: "2026-01-31" });

    // The picked day is sent as a local start/end-of-day instant; build the expected URL the same
    // way so the assertion is timezone-agnostic across CI runners.
    const expectedParams = new URLSearchParams();
    expectedParams.set("completedFrom", new Date("2026-01-01T00:00:00.000").toISOString());
    expectedParams.set("completedTo", new Date("2026-01-31T23:59:59.999").toISOString());
    const expectedUrl = `/boards/board-1/open?${expectedParams}`;

    expect(api.post).toHaveBeenCalledWith(expectedUrl, {});
    expect(localStorage.getItem("kanera.view.completed:board:board-1")).toBe(
      JSON.stringify({ from: "2026-01-01", to: "2026-01-31" }),
    );

    api.post.mockClear();
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.completedFrom()).toBe("2026-01-01"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith(expectedUrl, {}));
  });

  it("ignores stale archived-card loads after toggling archived cards back off", async () => {
    const archivedLoad = deferred<ReturnType<typeof boardPayload>>();
    const activeLoad = deferred<ReturnType<typeof boardPayload>>();
    api.post.mockImplementation((url: string) => {
      if (url.includes("archived=true")) return archivedLoad.promise;
      return activeLoad.promise;
    });
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    const component = fixture.componentInstance;
    boardState(component).hydrate({
      ...boardPayload(),
      cards: [card({ id: "active-card" })],
    });

    const showArchived = component.toggleArchivedCards();
    const showActive = component.toggleArchivedCards();
    activeLoad.resolve({ ...boardPayload(), cards: [card({ id: "active-card" })] });
    await showActive;
    archivedLoad.resolve({ ...boardPayload(), cards: [card({ id: "archived-card", archivedAt: new Date("2026-05-21T10:00:00.000Z") })] });
    await showArchived;

    expect(component.showArchived()).toBe(false);
    expect(boardState(component).cards().map((c) => c.id)).toEqual(["active-card"]);
    expect(component.cardsByList().get("list-1")?.map((c) => c.id)).toEqual(["active-card"]);
  });

  it("reloads active cards when clearing filters from archived view", async () => {
    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    const component = fixture.componentInstance;
    boardState(component).hydrate({
      ...boardPayload(),
      cards: [card({ id: "archived-card", archivedAt: new Date("2026-05-21T10:00:00.000Z") })],
    });
    component.showArchived.set(true);
    api.post.mockResolvedValue({ ...boardPayload(), cards: [card({ id: "active-card" })] });

    await component.clearFilters();

    expect(api.post).toHaveBeenCalledWith("/boards/board-1/open", {});
    expect(component.showArchived()).toBe(false);
    expect(boardState(component).cards().map((c) => c.id)).toEqual(["active-card"]);
    expect(component.cardsByList().get("list-1")?.map((c) => c.id)).toEqual(["active-card"]);
  });

  it("navigates away when opening the board fails without a cached snapshot", async () => {
    const router = TestBed.inject(Router) as unknown as { navigateByUrl: ReturnType<typeof vi.fn> };
    api.post.mockRejectedValueOnce(new Error("denied"));

    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();

    await vi.waitFor(() => expect(router.navigateByUrl).toHaveBeenCalledWith("/"));
  });

  it("restores cached board data when opening the board fails", async () => {
    const cachedAt = "2026-05-21T12:00:00.000Z";
    api.post.mockRejectedValueOnce(new Error("offline"));
    offlineCache.loadBoard.mockResolvedValueOnce({
      ...boardPayload(),
      boardId: "board-1",
      cachedAt,
      workspaceLists: [list()],
      customFieldValues: [],
      cardLabelAssignments: [],
      cardAssignees: [],
      cardAttachments: [],
      detailedCards: [],
      commentCounts: [],
    });

    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.offlineBoardCachedAt()).toBe(cachedAt));
    expect(boardState(fixture.componentInstance).board()?.id).toBe("board-1");
  });

  // A resume from sleep (or just backgrounding the tab) can leave the socket's own
  // reconnect/rejoin cycle stalled or racing the network coming back up, which would
  // otherwise strand the offline-cache banner on screen indefinitely with no further retry.
  // These tests capture the page's own `document.addEventListener("visibilitychange", ...)`
  // handler and invoke it directly rather than dispatching a real document event, since the
  // handler is registered by an effect with no reset between tests and a global dispatch
  // would also fire every other test's leftover listener.
  it("refetches and clears the cached-offline banner when the tab becomes visible again", async () => {
    const cachedAt = "2026-05-21T12:00:00.000Z";
    api.post.mockRejectedValueOnce(new Error("offline"));
    offlineCache.loadBoard.mockResolvedValueOnce({
      ...boardPayload(),
      boardId: "board-1",
      cachedAt,
      workspaceLists: [list()],
      customFieldValues: [],
      cardLabelAssignments: [],
      cardAssignees: [],
      cardAttachments: [],
      detailedCards: [],
      commentCounts: [],
    });
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.offlineBoardCachedAt()).toBe(cachedAt));

    const onVisibilityChange = addEventListenerSpy.mock.calls.find((call: unknown[]) => call[0] === "visibilitychange")?.[1] as (() => void) | undefined;
    expect(onVisibilityChange).toBeDefined();
    api.post.mockResolvedValue(boardPayload());
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    onVisibilityChange!();

    await vi.waitFor(() => expect(fixture.componentInstance.offlineBoardCachedAt()).toBeNull());
    addEventListenerSpy.mockRestore();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("does not refetch when the tab visibility handler fires while the tab is hidden", async () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const fixture = createInitializedBoardPage();
    const onVisibilityChange = addEventListenerSpy.mock.calls.find((call: unknown[]) => call[0] === "visibilitychange")?.[1] as (() => void) | undefined;
    expect(onVisibilityChange).toBeDefined();
    api.post.mockClear();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });

    onVisibilityChange!();
    await Promise.resolve();

    expect(api.post).not.toHaveBeenCalled();
    void fixture;
    addEventListenerSpy.mockRestore();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("stops listening for tab visibility once the board page is destroyed", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const fixture = createInitializedBoardPage();
    const onVisibilityChange = addEventListenerSpy.mock.calls.find((call: unknown[]) => call[0] === "visibilitychange")?.[1];
    expect(onVisibilityChange).toBeDefined();

    fixture.destroy();

    expect(removeEventListenerSpy).toHaveBeenCalledWith("visibilitychange", onVisibilityChange);
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("purges cached board data and navigates away when access is denied", async () => {
    api.post.mockRejectedValueOnce(new ApiError(404, { message: "board not found" }));
    offlineCache.loadBoard.mockResolvedValue({
      ...boardPayload(),
      boardId: "board-1",
      cachedAt: "2026-05-21T12:00:00.000Z",
      workspaceLists: [list()],
      customFieldValues: [],
      cardLabelAssignments: [],
      cardAssignees: [],
      cardAttachments: [],
      detailedCards: [],
      commentCounts: [],
    });

    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();

    await vi.waitFor(() => expect(router.navigateByUrl).toHaveBeenCalledWith("/"));
    expect(offlineCache.revokeBoardAccess).toHaveBeenCalledWith("board-1");
    expect(boardState(fixture.componentInstance).board()).toBeNull();
  });

  it("refreshes the active board when the current user's workspace role changes", async () => {
    const fixture = createInitializedBoardPage();
    await vi.waitFor(() => expect(boardState(fixture.componentInstance).board()?.id).toBe("board-1"));
    api.post.mockResolvedValueOnce({
      ...boardPayload(),
      viewerRole: "editor",
      viewerSource: "workspace",
      viewerIsWorkspaceAdmin: true,
    });

    socket.trigger("workspace:member:updated", {
      workspaceId: "workspace-1",
      member: { workspaceId: "workspace-1", userId: "user-1", role: "admin", addedAt: new Date() },
    });

    await vi.waitFor(() => expect(boardState(fixture.componentInstance).viewerIsWorkspaceAdmin()).toBe(true));
    expect(boardState(fixture.componentInstance).viewerRole()).toBe("editor");
  });

  it("shows a cached board snapshot while the fresh board request is still loading", async () => {
    const cachedAt = "2026-05-21T12:00:00.000Z";
    let resolveOpen!: (payload: ReturnType<typeof boardPayload>) => void;
    api.post.mockReturnValueOnce(new Promise((resolve) => {
      resolveOpen = resolve;
    }));
    offlineCache.loadBoard.mockResolvedValueOnce({
      ...boardPayload(),
      board: board({ name: "Cached roadmap" }),
      boardId: "board-1",
      cachedAt,
      workspaceLists: [list()],
      customFieldValues: [],
      cardLabelAssignments: [],
      cardAssignees: [],
      cardAttachments: [],
      detailedCards: [],
      commentCounts: [],
    });

    const fixture = TestBed.createComponent(BoardPage);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();

    await vi.waitFor(() => expect(boardState(fixture.componentInstance).board()?.name).toBe("Cached roadmap"));
    expect(fixture.componentInstance.offlineBoardCachedAt()).toBe(cachedAt);

    resolveOpen(boardPayload());

    await vi.waitFor(() => expect(boardState(fixture.componentInstance).board()?.name).toBe("Roadmap"));
    expect(fixture.componentInstance.offlineBoardCachedAt()).toBeNull();
  });
});
