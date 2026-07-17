import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import type { WireCardLabel, WireCardSummary } from "@kanera/shared/events";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import type { AnyCustomField } from "./board-state";
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
    coverImageWidth: null,
    coverImageHeight: null,
    coverImageColor: null,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  };
}

function label(overrides: Partial<WireCardLabel> = {}): WireCardLabel {
  return {
    id: "label-1",
    workspaceId: "workspace-1",
    name: "Urgent",
    color: "red",
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function customField(overrides: Partial<AnyCustomField> = {}): AnyCustomField {
  return {
    id: "field-1",
    workspaceId: "workspace-1",
    name: "Approved",
    icon: "checkbox",
    type: "checkbox",
    allowMultiple: false,
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function customFieldValue(overrides: Partial<CardCustomFieldValue> = {}): CardCustomFieldValue {
  return {
    cardId: "card-1",
    fieldId: "field-1",
    valueText: null,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function boardStateStub() {
  return {
    canEdit: signal(false),
    canEditRole: signal(false),
    isCardChecklistExpanded: () => false,
    checklistsForCard: () => [],
  };
}


describe("CardComponent", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED);
  });

  function configure(cardUnreadCount = 0) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        provideRouter([]),
        { provide: BoardState, useValue: boardStateStub() },
        { provide: NotificationsService, useValue: { isWatchingCard: () => false, isWatchingBoard: () => false, cardUnreadCount: () => cardUnreadCount } },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
      ],
    });
  }

  it("adds the selected class while its detail modal is open", () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        { provide: BoardState, useValue: boardStateStub() },
        { provide: NotificationsService, useValue: { isWatchingCard: () => false, isWatchingBoard: () => false, cardUnreadCount: () => 0 } },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
      ],
    })
      .overrideComponent(CardComponent, { set: { template: "" } });

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("selected", true);
    fixture.detectChanges();

    expect(fixture.nativeElement.classList.contains("is-selected")).toBe(true);
  });

  it("keeps the card actions menu open after a right click", () => {
    const state = boardStateStub();
    state.canEdit.set(true);
    state.canEditRole.set(true);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        provideRouter([]),
        { provide: BoardState, useValue: state },
        { provide: NotificationsService, useValue: { isWatchingCard: () => false, isWatchingBoard: () => false, cardUnreadCount: () => 0 } },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
      ],
    }).overrideComponent(CardComponent, { set: { template: "" } });

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.detectChanges();

    fixture.componentInstance.onCardContextMenu(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }));
    TestBed.tick();

    expect(fixture.componentInstance.actionsMenuOpen()).toBe(true);
    expect(fixture.componentInstance.actionsMenuPoint()).toEqual({ x: 120, y: 80 });
  });

  it("does not mark completed due dates as overdue", () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        { provide: BoardState, useValue: boardStateStub() },
        { provide: NotificationsService, useValue: { isWatchingCard: () => false, isWatchingBoard: () => false, cardUnreadCount: () => 0 } },
        { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
      ],
    })
      .overrideComponent(CardComponent, { set: { template: "" } });

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ completedAt: new Date("2026-05-21T10:00:00.000Z") }));

    expect(fixture.componentInstance.dueDateOverdue()).toBe(false);
  });

  it("does not render an unread dot when the card has no unread notifications", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".card-unread-dot")).toBeNull();
  });

  it("renders an unread dot before the card title", () => {
    configure(2);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(".card-body") as HTMLElement;
    const dot = body.querySelector(".card-unread-dot") as HTMLElement | null;
    const title = body.querySelector(".card-title-text") as HTMLElement | null;

    expect(dot?.getAttribute("aria-label")).toBe("Unread notifications");
    expect(title?.textContent?.trim()).toBe("Ship tests");
    expect(Array.from(body.children).indexOf(dot!)).toBeLessThan(Array.from(body.children).indexOf(title!));
  });

  it("keeps the completed icon before the unread dot and title", () => {
    configure(1);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ completedAt: new Date("2026-05-21T10:00:00.000Z") }));
    fixture.componentRef.setInput("showActions", false);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(".card-body") as HTMLElement;
    expect(Array.from(body.children).map((el) => (el as HTMLElement).className)).toEqual([
      "ti ti-circle-check card-complete-icon",
      "card-unread-dot",
      "card-title-text",
    ]);
  });

  it("shows a checklist indicator when the card has checklist items", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ dueDateLocalDate: null, checklistDoneCount: 1, checklistTotalCount: 3 }));
    fixture.componentRef.setInput("showActions", false);
    fixture.detectChanges();

    const indicator = fixture.nativeElement.querySelector(".card-indicator .ti-checklist")?.closest(".card-indicator") as HTMLElement | null;
    const progress = fixture.nativeElement.querySelector(".checklist-progress-fill") as HTMLElement | null;

    expect(indicator?.getAttribute("title")).toBeNull();
    expect(parseFloat(progress?.style.width ?? "0")).toBeCloseTo(100 / 3, 4);
  });

  it("hides show-on-card checkbox custom fields with no value row", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ dueDateLocalDate: null }));
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("customFields", [customField()]);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(".cf-badge") as HTMLElement | null;

    expect(badge).toBeNull();
  });

  it("hides show-on-card checkbox custom fields when the value is false", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ dueDateLocalDate: null }));
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("customFields", [customField()]);
    fixture.componentRef.setInput("customFieldValuesByField", new Map([["field-1", customFieldValue({ valueCheckbox: false })]]));
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(".cf-badge") as HTMLElement | null;

    expect(badge).toBeNull();
  });

  it("renders show-on-card checkbox custom fields when the value is true", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ dueDateLocalDate: null }));
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("customFields", [customField()]);
    fixture.componentRef.setInput("customFieldValuesByField", new Map([["field-1", customFieldValue({ valueCheckbox: true })]]));
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(".cf-badge") as HTMLElement | null;
    const checkbox = badge?.querySelector(".ti-checkbox.cf-value") as HTMLElement | null;

    expect(badge?.textContent?.trim()).toContain("Approved");
    expect(checkbox).not.toBeNull();
  });
  it("reserves a proportional cover before the image loads", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ coverUrl: "/cover-wide.jpg", coverImageWidth: 800, coverImageHeight: 400 }));

    expect(fixture.componentInstance.coverAspectRatio()).toBe("800 / 400");
    expect(fixture.componentInstance.coverHeightPx()).toBeNull();
  });

  it("uses the stable fallback for legacy or invalid cover dimensions", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ coverUrl: "/cover-legacy.jpg" }));
    expect(fixture.componentInstance.coverAspectRatio()).toBeNull();
    expect(fixture.componentInstance.coverHeightPx()).toBe("160px");

    fixture.componentRef.setInput("card", card({ coverUrl: "/cover-invalid.jpg", coverImageWidth: 0, coverImageHeight: 400 }));
    expect(fixture.componentInstance.coverAspectRatio()).toBeNull();
    expect(fixture.componentInstance.coverHeightPx()).toBe("160px");
  });

  it("updates reserved geometry when the summary cover dimensions change or are removed", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card({ coverUrl: "/cover-first.jpg", coverImageWidth: 800, coverImageHeight: 400 }));
    expect(fixture.componentInstance.coverAspectRatio()).toBe("800 / 400");

    fixture.componentRef.setInput("card", card({ coverUrl: "/cover-second.jpg", coverImageWidth: 400, coverImageHeight: 800 }));
    expect(fixture.componentInstance.coverAspectRatio()).toBe("400 / 800");

    fixture.componentRef.setInput("card", card());
    expect(fixture.componentInstance.coverAspectRatio()).toBeNull();
    expect(fixture.componentInstance.coverHeightPx()).toBe("160px");
  });

  it("recreates the optimized cover when a move changes its list priority", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("coverUrl", "/cover-priority.jpg");
    fixture.componentRef.setInput("coverPriority", true);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const priorityImage = element.querySelector(".card-cover img") as HTMLImageElement;

    fixture.componentRef.setInput("coverPriority", false);
    expect(() => fixture.detectChanges()).not.toThrow();
    const lazyImage = element.querySelector(".card-cover img") as HTMLImageElement;

    expect(lazyImage).not.toBe(priorityImage);
  });

  it("renders labels expanded by default", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("labels", [label()]);
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector(".label-chip") as HTMLElement | null;
    expect(chip?.classList.contains("is-compressed")).toBe(false);
    expect(chip?.textContent?.trim()).toBe("Urgent");
    expect(localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED)).toBeNull();
  });

  it("compresses and expands all card labels from a label click", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("labels", [label()]);
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector(".label-chip") as HTMLElement;
    chip.click();
    fixture.detectChanges();

    expect(localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED)).toBe("1");
    expect(chip.classList.contains("is-compressed")).toBe(true);
    expect(chip.querySelector(".label-chip-text")?.textContent?.trim()).toBe("Urgent");
    expect(chip.getAttribute("aria-label")).toBe("Expand labels: Urgent");

    chip.click();
    fixture.detectChanges();

    expect(localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED)).toBeNull();
    expect(chip.classList.contains("is-compressed")).toBe(false);
    expect(chip.textContent?.trim()).toBe("Urgent");
  });

  it("does not open the card when a label is clicked", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("labels", [label()]);
    const opened: string[] = [];
    fixture.componentInstance.openCard.subscribe((id) => opened.push(id));
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector(".label-chip") as HTMLElement;
    chip.click();

    expect(opened).toEqual([]);
  });

  it("opens the board from the board badge without opening the card", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("boardSummary", { id: "board-1", name: "Roadmap", icon: null, iconColor: null });
    fixture.componentRef.setInput("allowBoardNavigation", true);
    const openedCards: string[] = [];
    const openedBoards: string[] = [];
    fixture.componentInstance.openCard.subscribe((id) => openedCards.push(id));
    fixture.componentInstance.boardOpened.subscribe((id) => openedBoards.push(id));
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(".card-board-badge") as HTMLElement;
    badge.click();

    expect(openedBoards).toEqual(["board-1"]);
    expect(openedCards).toEqual([]);
  });

  it("opens the card from the card body when board navigation is enabled", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("boardSummary", { id: "board-1", name: "Roadmap", icon: null, iconColor: null });
    fixture.componentRef.setInput("allowBoardNavigation", true);
    const openedCards: string[] = [];
    fixture.componentInstance.openCard.subscribe((id) => openedCards.push(id));
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector(".card-title-text") as HTMLElement;
    title.click();

    expect(openedCards).toEqual(["card-1"]);
  });

  it("renders the board badge as static text unless board navigation is enabled", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("boardSummary", { id: "board-1", name: "Roadmap", icon: null, iconColor: null });
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(".card-board-badge") as HTMLElement;
    expect(badge.getAttribute("role")).toBeNull();
    expect(badge.getAttribute("tabindex")).toBeNull();
    expect(badge.classList.contains("is-clickable")).toBe(false);
  });

  it("updates label compression when another tab changes the preference", () => {
    configure(0);

    const fixture = TestBed.createComponent(CardComponent);
    fixture.componentRef.setInput("card", card());
    fixture.componentRef.setInput("showActions", false);
    fixture.componentRef.setInput("labels", [label()]);
    fixture.detectChanges();

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.CARD_LABELS_COMPRESSED, newValue: "1" }));
    fixture.detectChanges();

    let chip = fixture.nativeElement.querySelector(".label-chip") as HTMLElement;
    expect(chip.classList.contains("is-compressed")).toBe(true);
    expect(chip.querySelector(".label-chip-text")?.textContent?.trim()).toBe("Urgent");

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.CARD_LABELS_COMPRESSED, newValue: null }));
    fixture.detectChanges();

    chip = fixture.nativeElement.querySelector(".label-chip") as HTMLElement;
    expect(chip.classList.contains("is-compressed")).toBe(false);
    expect(chip.textContent?.trim()).toBe("Urgent");
  });

  it("updates other cards on the same page when a label is clicked", () => {
    configure(0);

    const first = TestBed.createComponent(CardComponent);
    first.componentRef.setInput("card", card({ id: "card-1" }));
    first.componentRef.setInput("showActions", false);
    first.componentRef.setInput("labels", [label()]);
    first.detectChanges();

    const second = TestBed.createComponent(CardComponent);
    second.componentRef.setInput("card", card({ id: "card-2" }));
    second.componentRef.setInput("showActions", false);
    second.componentRef.setInput("labels", [label({ id: "label-2", name: "Blocked" })]);
    second.detectChanges();

    const firstChip = first.nativeElement.querySelector(".label-chip") as HTMLElement;
    firstChip.click();
    first.detectChanges();
    second.detectChanges();

    const secondChip = second.nativeElement.querySelector(".label-chip") as HTMLElement;
    expect(firstChip.classList.contains("is-compressed")).toBe(true);
    expect(secondChip.classList.contains("is-compressed")).toBe(true);
    expect(secondChip.getAttribute("aria-label")).toBe("Expand labels: Blocked");
  });
});
