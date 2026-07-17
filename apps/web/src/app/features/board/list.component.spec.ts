import { CdkDrag } from "@angular/cdk/drag-drop";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import type { CardAttachmentRow, WireCardSummary } from "@kanera/shared/events";
import type { List } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BoardState, type BoardLaneItem } from "./board-state";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";
import { ListComponent } from "./list.component";

function laneCardIds(items: BoardLaneItem[]): string[] {
  return items.map((item) => (item.kind === "card" ? item.card.id : item.separator.id));
}

function summaryCard(id: string): WireCardSummary {
  return {
    id,
    listId: "list-1",
    boardId: "board-1",
    title: `Card ${id}`,
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
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
  };
}

// Signed media URLs carry their expiry in the `e=` query param; the cover
// staleness guard keys off that, so tests mint URLs with a chosen expiry.
function signedCoverUrl(expiryMs: number): string {
  return `https://board.kanera.app/api/media/client-1/cards/card-1/cover.png?t=token&e=${expiryMs}`;
}

function coverAttachment(url: string): CardAttachmentRow {
  return {
    id: "att-1",
    cardId: "card-1",
    fileName: "cover.png",
    mimeType: "image/png",
    byteSize: 1024,
    url,
    thumbnailUrl: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    uploadedById: "user-1",
    uploadedByName: "Uploader",
    uploadedByAvatarUrl: null,
    source: "attachment",
    commentId: null,
  };
}

function list(overrides: Partial<List> = {}): List {
  return {
    id: "list-1",
    workspaceId: "workspace-1",
    name: "Done",
    icon: null,
    color: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ListComponent", () => {
  let api: {
    patch: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    createCard: ReturnType<typeof vi.fn>;
    sockets: { online: ReturnType<typeof signal<boolean>> };
  };
  let notifications: { watchCreatedCardLocally: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<ListComponent>;

  beforeEach(async () => {
    const post = vi.fn((_path: string, _body: unknown) => Promise.resolve({}));
    api = {
      patch: vi.fn(() => Promise.resolve({})),
      post,
      createCard: vi.fn((path: string, body: unknown) => post(path, body)),
      sockets: { online: signal(true) },
    };
    notifications = { watchCreatedCardLocally: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [ListComponent],
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        provideRouter([]),
        { provide: ApiClient, useValue: api },
        { provide: NotificationsService, useValue: { ...notifications, isWatchingCard: () => false, isWatchingBoard: () => false, cardUnreadCount: () => 0 } },
        // Child k-card components inject these; lightweight mocks keep the list spec isolated.
        { provide: BoardState, useValue: { canEdit: signal(false), canEditRole: signal(false), isCardChecklistExpanded: () => false, checklistsForCard: () => [] } },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ListComponent);
    fixture.componentRef.setInput("list", list());
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("allLists", [list(), list({ id: "list-2", name: "Todo" })]);
    fixture.componentRef.setInput("cards", []);
  });

  it("shows no completion state in the board list header", () => {
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).not.toContain("Completed");
  });

  it("does not expose completion setup from reused board list UI", () => {
    fixture.detectChanges();
    fixture.componentInstance.toggleMenu(new MouseEvent("click"));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).not.toContain("Optional. Cards moved here are marked complete automatically. Checklist items are not changed.");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("extends the card drop target through the kanban lane for short lists", () => {
    const lane = document.createElement("div");
    lane.className = "lists";
    document.body.appendChild(lane);
    lane.appendChild(fixture.nativeElement);

    try {
      fixture.componentRef.setInput("cards", [summaryCard("card-1")]);
      fixture.detectChanges();

      lane.getBoundingClientRect = () => new DOMRect(0, 80, 320, 620);
      (fixture.nativeElement as HTMLElement).getBoundingClientRect = () => new DOMRect(8, 100, 270, 150);
      const cardsEl = fixture.nativeElement.querySelector(".cards") as HTMLElement;
      Object.defineProperty(cardsEl, "offsetHeight", { value: 72, configurable: true });

      document.body.classList.add("is-card-dragging");
      document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      const rect = cardsEl.getBoundingClientRect();

      expect(rect.bottom).toBe(700);
      expect(rect.height).toBeGreaterThan(0);
      expect(cardsEl.style.getPropertyValue("--k-drop-extension-top")).toBe("72px");
      expect(cardsEl.style.getPropertyValue("--k-drop-extension-height")).toBe("628px");
    } finally {
      document.body.classList.remove("is-card-dragging");
      fixture.destroy();
      lane.remove();
    }
  });

  it("caps rendered cards on large lists and grows near the scroll boundary", () => {
    const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
    fixture.componentRef.setInput("cards", cards);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    // Initial cap renders far fewer than the 75 cards in the list.
    expect(fixture.componentInstance.renderedCards().length).toBe(30);
    expect(fixture.componentInstance.hiddenCardCount()).toBe(45);
    expect(element.querySelectorAll("k-card").length).toBe(30);

    fixture.componentInstance.onCardsScroll({
      scrollHeight: 2000,
      scrollTop: 1200,
      clientHeight: 300,
    } as HTMLElement);
    fixture.detectChanges();

    expect(fixture.componentInstance.renderedCards().length).toBe(75);
    expect(fixture.componentInstance.hiddenCardCount()).toBe(0);
    expect(element.querySelectorAll("k-card").length).toBe(75);
  });

  it("keeps drag start cheap and grows a long source list only while edge-scrolling", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    try {
      const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
      fixture.componentRef.setInput("cards", cards);
      fixture.componentRef.setInput("canEdit", true);
      fixture.detectChanges();

      const cardsEl = fixture.nativeElement.querySelector(".cards") as HTMLElement;
      Object.defineProperty(cardsEl, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(cardsEl, "clientHeight", { value: 300, configurable: true });
      const readRect = vi.fn(() => ({
        left: 100,
        top: 100,
        right: 400,
        bottom: 400,
        width: 300,
        height: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect));
      cardsEl.getBoundingClientRect = readRect;
      cardsEl.scrollTop = 1200;

      fixture.componentInstance.onDragStarted({} as never);
      expect(fixture.componentInstance.renderedCards().length).toBe(30);

      fixture.componentInstance.onDragMoved({ pointerPosition: { x: 200, y: 399 } } as never);
      for (let i = 0; i < 5 && cardsEl.scrollTop === 1200; i += 1) {
        frameCallbacks.shift()?.(i);
      }
      fixture.detectChanges();

      expect(cardsEl.scrollTop).toBeGreaterThan(1200);
      expect(fixture.componentInstance.renderedCards().length).toBe(75);

      fixture.componentInstance.onDragEnded();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("does not expand a target list just because a dragged card enters it", () => {
    const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
    fixture.componentRef.setInput("cards", cards);
    fixture.detectChanges();

    expect(fixture.componentInstance.renderedCards().length).toBe(30);

    fixture.componentInstance.onDropListEntered();
    fixture.detectChanges();

    expect(fixture.componentInstance.receiving()).toBe(true);
    expect(fixture.componentInstance.renderedCards().length).toBe(30);
    expect(fixture.componentInstance.hiddenCardCount()).toBe(45);
  });

  it("keeps very long lists capped until the pointer reaches an edge-scroll zone", () => {
    const cards = Array.from({ length: 300 }, (_, i) => summaryCard(`card-${i}`));
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("canEdit", true);
    fixture.detectChanges();

    expect(fixture.componentInstance.renderedCards().length).toBe(30);

    fixture.componentInstance.onDragStarted({} as never);
    fixture.detectChanges();

    expect(fixture.componentInstance.renderedCards().length).toBe(30);
    expect(fixture.componentInstance.hiddenCardCount()).toBe(270);

    fixture.componentInstance.onDragEnded();
  });

  it("auto-scrolls when a card from another list is dragged over its bottom edge", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    try {
      const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
      fixture.componentRef.setInput("cards", cards);
      fixture.componentRef.setInput("canEdit", true);
      fixture.detectChanges();

      const cardsEl = fixture.nativeElement.querySelector(".cards") as HTMLElement;
      Object.defineProperty(cardsEl, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(cardsEl, "clientHeight", { value: 300, configurable: true });
      const readRect = vi.fn(() => ({
        left: 100,
        top: 100,
        right: 400,
        bottom: 400,
        width: 300,
        height: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect));
      cardsEl.getBoundingClientRect = readRect;
      cardsEl.scrollTop = 1200;

      document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      (fixture.nativeElement as HTMLElement).dispatchEvent(new CustomEvent<{ x: number; y: number }>(APP_DOM_EVENTS.CARD_DRAG_OVER_LIST, { detail: { x: 200, y: 399 } }));
      for (let i = 0; i < 5 && cardsEl.scrollTop === 1200; i += 1) {
        frameCallbacks.shift()?.(i);
      }
      fixture.detectChanges();

      expect(cardsEl.scrollTop).toBeGreaterThan(1200);
      expect(fixture.componentInstance.renderedCards().length).toBe(75);
    } finally {
      document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("ignores global drag moves outside this list column", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    try {
      fixture.componentRef.setInput("cards", Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`)));
      fixture.detectChanges();

      const cardsEl = fixture.nativeElement.querySelector(".cards") as HTMLElement;
      Object.defineProperty(cardsEl, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(cardsEl, "clientHeight", { value: 300, configurable: true });
      const readRect = vi.fn(() => ({
        left: 100,
        top: 100,
        right: 400,
        bottom: 400,
        width: 300,
        height: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect));
      cardsEl.getBoundingClientRect = readRect;
      cardsEl.scrollTop = 1200;

      document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
      readRect.mockClear();
      document.dispatchEvent(new CustomEvent<{ x: number; y: number }>(APP_DOM_EVENTS.CARD_DRAG_MOVE, { detail: { x: 20, y: 399 } }));
      frameCallbacks.shift()?.(0);

      expect(cardsEl.scrollTop).toBe(1200);
      expect(readRect).not.toHaveBeenCalled();
    } finally {
      document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("renders every filtered card so narrowed results are not hidden behind the cap", () => {
    const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("filteredCardIds", new Set(cards.map((card) => card.id)));
    fixture.detectChanges();

    expect(fixture.componentInstance.renderedCards().length).toBe(75);
    expect(fixture.componentInstance.hiddenCardCount()).toBe(0);
  });

  it("selects every matching card, including cards beyond the rendered scroll slice", () => {
    const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
    const matchingIds = new Set(cards.filter((_, i) => i % 2 === 0).map((card) => card.id));
    const emitted: unknown[] = [];
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("filteredCardIds", matchingIds);
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentInstance.bulkListSelectionRequested.subscribe((event) => emitted.push(event));
    fixture.detectChanges();

    fixture.componentInstance.selectAllCards(new MouseEvent("click", { shiftKey: true }));

    expect(emitted).toEqual([{
      orderedCardIds: cards.filter((card) => matchingIds.has(card.id)).map((card) => card.id),
      additive: true,
    }]);
  });

  it("emits the rendered-slice boundary neighbor when dropping at the visible end", () => {
    const cards = Array.from({ length: 75 }, (_, i) => summaryCard(`card-${i}`));
    const emitted: unknown[] = [];
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentInstance.cardDropped.subscribe((event) => emitted.push(event));
    fixture.detectChanges();

    // The lane renders BoardLaneItems and emits typed anchors, so the drop event carries the
    // wrapped card item and the container holds the interleaved rendered items.
    const container = { data: fixture.componentInstance.renderedItems() };
    fixture.componentInstance.onDrop({
      item: { data: { kind: "card", card: cards[0] } },
      previousContainer: container,
      container,
      previousIndex: 0,
      currentIndex: 29,
    } as never);

    expect(emitted).toEqual([{
      cardId: "card-0",
      toListId: "list-1",
      afterItem: { type: "card", id: "card-29" },
    }]);
  });

  it("keeps the committed placeholder order while a same-list drop is handed to parent state", () => {
    const cards = ["card-a", "card-b", "card-c", "card-d"].map(summaryCard);
    const emitted: unknown[] = [];
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentInstance.cardDropped.subscribe((event) => emitted.push(event));
    fixture.detectChanges();

    const container = { data: fixture.componentInstance.renderedItems(), id: "dl-list-1" };
    fixture.componentInstance.onDrop({
      item: { data: { kind: "card", card: cards[0] } },
      previousContainer: container,
      container,
      previousIndex: 0,
      currentIndex: 2,
    } as never);
    fixture.detectChanges();

    // The committed placeholder order is held on renderedItems() (the rendered lane), not the
    // card-only renderedCards() helper used for capping.
    expect(laneCardIds(fixture.componentInstance.renderedItems())).toEqual(["card-b", "card-c", "card-a", "card-d"]);
    expect(emitted).toEqual([{
      cardId: "card-a",
      toListId: "list-1",
      beforeItem: { type: "card", id: "card-d" },
    }]);
  });

  it("does not emit unchanged card or separator drops", () => {
    const cards = ["card-a", "card-b"].map(summaryCard);
    const separator = {
      id: "separator-a", boardId: "board-1", listId: "list-1", title: "Section", color: null,
      position: "1500.0000000000", createdById: "user-1",
      createdAt: new Date("2026-05-21T00:00:00.000Z"), updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };
    const cardEvents: unknown[] = [];
    const separatorEvents: unknown[] = [];
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("items", [
      { kind: "card", card: cards[0] },
      { kind: "separator", separator },
      { kind: "card", card: cards[1] },
    ]);
    fixture.componentInstance.cardDropped.subscribe((event) => cardEvents.push(event));
    fixture.componentInstance.separatorDropped.subscribe((event) => separatorEvents.push(event));
    fixture.detectChanges();

    const container = { data: fixture.componentInstance.renderedItems(), id: "dl-list-1" };
    for (const [item, index] of container.data.map((entry, index) => [entry, index] as const)) {
      fixture.componentInstance.onDrop({
        item: { data: item }, previousContainer: container, container,
        previousIndex: index, currentIndex: index,
      } as never);
    }

    expect(cardEvents).toEqual([]);
    expect(separatorEvents).toEqual([]);
  });

  it("disables separator dragging while its title or color editor is open", () => {
    const separator = {
      id: "separator-a", boardId: "board-1", listId: "list-1", title: "Section", color: null,
      position: "1500.0000000000", createdById: "user-1",
      createdAt: new Date("2026-05-21T00:00:00.000Z"), updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentRef.setInput("items", [{ kind: "separator", separator }]);
    fixture.detectChanges();

    const separatorElement = fixture.debugElement.query(By.css("k-separator"));
    const drag = separatorElement.injector.get(CdkDrag);
    const editButton = separatorElement.query(By.css('[aria-label="Edit separator"]')).nativeElement as HTMLButtonElement;

    expect(drag.disabled).toBe(false);
    editButton.click();
    fixture.detectChanges();
    expect(drag.disabled).toBe(true);

    (separatorElement.query(By.css('[aria-label="Cancel"]')).nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(drag.disabled).toBe(false);

    editButton.click();
    fixture.detectChanges();
    (separatorElement.query(By.css("form")).nativeElement as HTMLFormElement).dispatchEvent(new Event("submit"));
    fixture.detectChanges();
    expect(drag.disabled).toBe(false);
  });

  it("temporarily removes a cross-list source card until parent state catches up", () => {
    const cards = ["card-a", "card-b"].map(summaryCard);
    fixture.componentRef.setInput("cards", cards);
    fixture.detectChanges();

    document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_SOURCE_COMMITTED, {
      detail: { listId: "list-1", cardId: "card-a" },
    }));
    fixture.detectChanges();

    expect(laneCardIds(fixture.componentInstance.renderedItems())).toEqual(["card-b"]);

    fixture.componentRef.setInput("cards", [cards[1]]);
    fixture.detectChanges();
    fixture.componentRef.setInput("cards", cards);
    fixture.detectChanges();

    expect(laneCardIds(fixture.componentInstance.renderedItems())).toEqual(["card-a", "card-b"]);
  });

  it("shows target list colors in the move-all-cards menu", () => {
    fixture.componentRef.setInput("allLists", [
      list(),
      list({ id: "list-2", name: "Todo", icon: "flag", color: "green" }),
    ]);
    fixture.detectChanges();

    fixture.componentInstance.toggleMenu(new MouseEvent("click"));
    fixture.componentInstance.toggleMoveListPicker(new MouseEvent("click"));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const icon = element.querySelector(".menu-sub-panel .ti-flag") as HTMLElement | null;
    expect(icon?.style.color).toBe("var(--color-green)");
  });

  it("scopes moving all cards to the current board", async () => {
    api.post.mockResolvedValueOnce({ moved: 2 });

    await fixture.componentInstance.moveAllCards("list-2");

    expect(api.post).toHaveBeenCalledWith("/lists/list-1/cards/move", {
      targetListId: "list-2",
      boardId: "board-1",
    });
  });

  it("scopes archiving all cards to the current board", async () => {
    api.patch.mockResolvedValueOnce({ archived: 2 });

    await fixture.componentInstance.archiveCards();

    expect(api.patch).toHaveBeenCalledWith("/lists/list-1/cards/archive", { boardId: "board-1" });
  });

  it("creates cards on the selected board with default assignees", async () => {
    api.post.mockResolvedValueOnce(summaryCard("card-new"));
    fixture.componentRef.setInput("addCardBoards", [
      { id: "board-1", name: "Public", icon: null, iconColor: null },
      { id: "board-2", name: "Private", icon: "lock", iconColor: "blue" },
    ]);
    fixture.componentRef.setInput("defaultAddCardBoardId", "board-2");
    fixture.componentRef.setInput("defaultAddCardAssigneeIds", ["user-1"]);
    fixture.componentRef.setInput("addingListId", "list-1");
    fixture.componentRef.setInput("addAtTop", true);
    fixture.detectChanges();

    fixture.componentInstance.newTitle.set("Assigned card");
    await fixture.componentInstance.addCard(new Event("submit"));

    expect(api.createCard).toHaveBeenCalledTimes(1);
    const [createPath, createBody] = api.createCard.mock.calls[0] as [string, {
      title: string;
      atTop: boolean;
      assigneeIds: string[];
      clientToken: string;
    }];
    expect(createPath).toBe("/boards/board-2/lists/list-1/cards");
    expect(createBody).toMatchObject({
      title: "Assigned card",
      atTop: true,
      assigneeIds: ["user-1"],
    });
    expect(createBody.clientToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(notifications.watchCreatedCardLocally).toHaveBeenCalledWith("card-new");
  });

  it("retries an ambiguous create with one stable token and emits the card once", async () => {
    vi.useFakeTimers();
    try {
      api.post
        .mockRejectedValueOnce(new TypeError("connection reset"))
        .mockResolvedValueOnce(summaryCard("card-new"));
      api.createCard.mockImplementation((path: string, body: Record<string, unknown> & { clientToken: string }) =>
        ApiClient.prototype.createCard.call(api as unknown as ApiClient, path, body));
      const emittedIds: string[] = [];
      fixture.componentInstance.cardCreated.subscribe((card) => emittedIds.push(card.id));
      fixture.detectChanges();
      fixture.componentInstance.newTitle.set("Retry me");

      const create = fixture.componentInstance.addCard(new Event("submit"));
      await vi.runAllTimersAsync();
      await create;

      expect(api.post).toHaveBeenCalledTimes(2);
      const firstBody = api.post.mock.calls[0]?.[1] as { clientToken: string };
      const secondBody = api.post.mock.calls[1]?.[1] as { clientToken: string };
      expect(firstBody.clientToken).toMatch(/^[0-9a-f-]{36}$/i);
      expect(secondBody.clientToken).toBe(firstBody.clientToken);
      expect(emittedIds).toEqual(["card-new"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a rejected card create", async () => {
    api.post.mockRejectedValueOnce(new ApiError(400, { message: "invalid card" }));
    api.createCard.mockImplementation((path: string, body: Record<string, unknown> & { clientToken: string }) =>
      ApiClient.prototype.createCard.call(api as unknown as ApiClient, path, body));
    fixture.detectChanges();
    fixture.componentInstance.newTitle.set("Rejected");

    await expect(fixture.componentInstance.addCard(new Event("submit"))).rejects.toBeInstanceOf(ApiError);

    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous create after connectivity drops", async () => {
    api.post.mockImplementationOnce(() => {
      api.sockets.online.set(false);
      return Promise.reject(new TypeError("connection lost"));
    });
    api.createCard.mockImplementation((path: string, body: Record<string, unknown> & { clientToken: string }) =>
      ApiClient.prototype.createCard.call(api as unknown as ApiClient, path, body));
    fixture.detectChanges();
    fixture.componentInstance.newTitle.set("Wait for online");

    await expect(fixture.componentInstance.addCard(new Event("submit"))).rejects.toThrow("connection lost");

    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("suppresses a cover from a restored attachment whose signed URL has expired", () => {
    // The real regression: coverUrlForCard prefers the cover attachment's url
    // over the summary coverUrl, so an expired attachment-sourced cover from a
    // restored offline snapshot must be dropped too — not just summary covers.
    const card = { ...summaryCard("card-1"), coverAttachmentId: "att-1" };
    fixture.componentRef.setInput("coverAttachmentById", new Map([
      ["att-1", coverAttachment(signedCoverUrl(Date.now() - 1000))],
    ]));
    fixture.detectChanges();

    expect(fixture.componentInstance.coverUrlForCard(card)).toBeNull();
  });

  it("keeps a cover from a restored attachment whose signed URL is still valid", () => {
    const validUrl = signedCoverUrl(Date.now() + 60 * 60_000);
    const card = { ...summaryCard("card-1"), coverAttachmentId: "att-1" };
    fixture.componentRef.setInput("coverAttachmentById", new Map([
      ["att-1", coverAttachment(validUrl)],
    ]));
    fixture.detectChanges();

    expect(fixture.componentInstance.coverUrlForCard(card)).toBe(validUrl);
  });

  it("treats a near-expiry attachment cover as stale to avoid a reload-time 404 race", () => {
    // Within the skew window the token would still pass `e > now` yet 404 by the
    // time the request lands; the guard must drop it ahead of real expiry.
    const card = { ...summaryCard("card-1"), coverAttachmentId: "att-1" };
    fixture.componentRef.setInput("coverAttachmentById", new Map([
      ["att-1", coverAttachment(signedCoverUrl(Date.now() + 60_000))],
    ]));
    fixture.detectChanges();

    expect(fixture.componentInstance.coverUrlForCard(card)).toBeNull();
  });

  it("suppresses an expired summary cover when there is no cover attachment", () => {
    const card = { ...summaryCard("card-1"), coverUrl: signedCoverUrl(Date.now() - 1000) };
    fixture.detectChanges();

    expect(fixture.componentInstance.coverUrlForCard(card)).toBeNull();
  });

  it("opens the add-card board menu above when the selector is near the viewport bottom", () => {
    fixture.detectChanges();
    const button = document.createElement("button");
    button.getBoundingClientRect = () => new DOMRect(20, 720, 220, 28);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(760);
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "currentTarget", { configurable: true, value: button });

    fixture.componentInstance.toggleAddCardBoardPicker(event);

    expect(fixture.componentInstance.boardPickerOpen()).toBe(true);
    expect(fixture.componentInstance.boardPickerOpenAbove()).toBe(true);
  });
});
