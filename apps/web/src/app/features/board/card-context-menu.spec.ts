import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireCardSummary } from "@kanera/shared/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BoardState } from "./board-state";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";
import { CardComponent } from "./card.component";

function card(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Ship tests",
    position: "1000.0000000000",
    dueDateLocalDate: null,
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

describe("CardComponent context menu", () => {
  const originalMatchMedia = window.matchMedia;
  const originalMaxTouchPoints = navigator.maxTouchPoints;

  afterEach(() => {
    document.body.classList.remove("is-card-dragging");
    Object.defineProperty(window, "matchMedia", { value: originalMatchMedia, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: originalMaxTouchPoints, configurable: true });
    vi.restoreAllMocks();
  });

  function createComponent(inputs: { bulkSelected?: boolean } = {}) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        { provide: BoardState, useValue: { canEdit: signal(true), canEditRole: signal(true), isCardChecklistExpanded: () => false, checklistsForCard: () => [] } },
        { provide: NotificationsService, useValue: { isWatchingCard: () => false, isWatchingBoard: () => false, cardUnreadCount: () => 0 } },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
      ],
    }).overrideComponent(CardComponent, { set: { template: "" } });

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    if (inputs.bulkSelected !== undefined) fixture.componentRef.setInput("bulkSelected", inputs.bulkSelected);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function contextMenuEvent(init: MouseEventInit & { pointerType?: string } = {}): MouseEvent {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
    if (init.pointerType) Object.defineProperty(event, "pointerType", { value: init.pointerType });
    return event;
  }

  function setCoarsePointer(matches: boolean) {
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn(() => ({ matches }) as MediaQueryList),
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", { value: matches ? 1 : 0, configurable: true });
  }

  it("opens the actions menu on desktop right-click", () => {
    setCoarsePointer(false);
    const component = createComponent();

    const event = contextMenuEvent({ button: 2, clientX: 120, clientY: 80 });
    component.onCardContextMenu(event);

    expect(event.defaultPrevented).toBe(true);
    expect(component.actionsMenuOpen()).toBe(true);
    expect(component.actionsMenuPoint()).toEqual({ x: 120, y: 80 });
  });

  it("opens the bulk menu from the action button when the card is bulk-selected", () => {
    const component = createComponent({ bulkSelected: true });
    const bulkMenu = vi.fn();
    component.bulkMenuIntent.subscribe(bulkMenu);

    const button = document.createElement("button");
    document.body.appendChild(button);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    component.toggleActionsMenu(event);
    button.remove();

    expect(component.actionsMenuOpen()).toBe(false);
    expect(bulkMenu).toHaveBeenCalledWith({ cardId: "card-1", point: { x: 0, y: 0 } });
  });

  it("opens the bulk menu on right-click when the card is bulk-selected", () => {
    setCoarsePointer(false);
    const component = createComponent({ bulkSelected: true });
    const bulkMenu = vi.fn();
    component.bulkMenuIntent.subscribe(bulkMenu);

    const event = contextMenuEvent({ button: 2, clientX: 120, clientY: 80 });
    component.onCardContextMenu(event);

    expect(component.actionsMenuOpen()).toBe(false);
    expect(bulkMenu).toHaveBeenCalledWith({ cardId: "card-1", point: { x: 120, y: 80 } });
  });

  it("opens the card detail route in a new tab on middle-click", () => {
    const component = createComponent();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    component.onCardLinkAuxClick(event);

    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("/b/board-1?cardId=card-1", "_blank", "noopener");
  });

  it("ignores non-middle auxiliary clicks", () => {
    const component = createComponent();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 });
    component.onCardLinkAuxClick(event);

    expect(event.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("suppresses touch long-press context menus without opening actions", () => {
    setCoarsePointer(true);
    const component = createComponent();

    const event = contextMenuEvent({ button: 0, pointerType: "touch" });
    component.onCardContextMenu(event);

    expect(event.defaultPrevented).toBe(true);
    expect(component.actionsMenuOpen()).toBe(false);
  });

  it("suppresses context menus while a card drag is active", () => {
    setCoarsePointer(false);
    document.body.classList.add("is-card-dragging");
    const component = createComponent();

    const event = contextMenuEvent({ button: 2 });
    component.onCardContextMenu(event);

    expect(event.defaultPrevented).toBe(true);
    expect(component.actionsMenuOpen()).toBe(false);
  });
});
