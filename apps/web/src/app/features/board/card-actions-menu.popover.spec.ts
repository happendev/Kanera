import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { BoardState } from "./board-state";
import { CardActionsMenuPopover } from "./card-actions-menu.popover";
import { CardQuickEditPopover } from "./card-quick-edit.popover";

function boardState(overrides: Partial<BoardState> = {}) {
  return {
    updateCard: vi.fn(),
    setCardAssignees: vi.fn(),
    setCardLabels: vi.fn(),
    labelIdsForCard: vi.fn(() => ["label-1"]),
    assigneeIdsForCard: vi.fn(() => ["user-1"]),
    cardLabels: signal([
      { id: "label-1", workspaceId: "workspace-1", name: "Urgent", color: "red", position: "1000.0000000000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "label-2", workspaceId: "workspace-1", name: "Backend", color: "blue", position: "2000.0000000000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
    ]),
    members: signal([
      { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "workspace" },
      { userId: "user-2", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" },
    ]),
    assignableMembers: signal([
      { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "workspace" },
      { userId: "user-2", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" },
    ]),
    ...overrides,
  };
}

function notificationsService(overrides: {
  isWatchingCard?: ReturnType<typeof vi.fn>;
  isWatchingBoard?: ReturnType<typeof vi.fn>;
  toggleCardWatch?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    isWatchingCard: vi.fn(() => false),
    isWatchingBoard: vi.fn(() => false),
    toggleCardWatch: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("CardActionsMenuPopover", () => {
  it("hides duplicate and copy actions when they are disabled", () => {
    TestBed.configureTestingModule({
      imports: [CardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notificationsService() },
        { provide: Router, useValue: { createUrlTree: vi.fn(), serializeUrl: vi.fn() } },
        { provide: BoardState, useValue: boardState() },
      ],
    });

    const fixture = TestBed.createComponent(CardActionsMenuPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.componentRef.setInput("allowDuplicate", false);
    fixture.componentRef.setInput("allowCopyToBoard", false);
    fixture.componentRef.setInput("allowMoveToBoard", false);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent.replace(/\s+/g, " ").trim();
    expect(text).toContain("Open in new tab");
    expect(text).toContain("Copy card link");
    expect(text).toContain("Watch card");
    expect(text).toContain("Quick edit");
    expect(text).toContain("Mark complete");
    expect(text).not.toContain("Move to board");
    expect(text).toContain("Archive card");
    expect(text).not.toContain("Duplicate card");
    expect(text).not.toContain("Copy to board");
  });

  it("supports notification-context completion and archive without a board state provider", async () => {
    const api = {
      post: vi.fn(),
      patch: vi.fn((path: string, body: unknown) => Promise.resolve({
        id: "card-1",
        boardId: "board-1",
        listId: "list-1",
        title: "Ship tests",
        completedAt: path.endsWith("/completion") && (body as { completed: boolean }).completed ? new Date("2026-05-21T00:00:00.000Z") : null,
        archivedAt: path.endsWith("/archive") && (body as { archived: boolean }).archived ? new Date("2026-05-21T00:00:00.000Z") : null,
      })),
      put: vi.fn(),
      delete: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [CardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notificationsService() },
        { provide: Router, useValue: { createUrlTree: vi.fn(), serializeUrl: vi.fn() } },
      ],
    });

    const fixture = TestBed.createComponent(CardActionsMenuPopover);
    const close = vi.fn();
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.componentRef.setInput("allowDuplicate", false);
    fixture.componentRef.setInput("allowCopyToBoard", false);
    fixture.componentRef.setInput("allowMoveToBoard", false);
    fixture.componentInstance.close.subscribe(close);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain("Quick edit");
    const quickEditButton = Array.from(element.querySelectorAll<HTMLButtonElement>(".cam-item"))
      .find((button) => button.textContent?.includes("Quick edit"))!;
    quickEditButton.click();
    fixture.detectChanges();
    expect(fixture.debugElement.query((de) => de.componentInstance instanceof CardQuickEditPopover)).toBeTruthy();
    const completeButton = Array.from(element.querySelectorAll<HTMLButtonElement>(".cam-item"))
      .find((button) => button.textContent?.includes("Mark complete"))!;
    completeButton.click();
    await fixture.whenStable();

    const archiveButton = Array.from(element.querySelectorAll<HTMLButtonElement>(".cam-item"))
      .find((button) => button.textContent?.includes("Archive card"))!;
    archiveButton.click();
    fixture.detectChanges();
    const confirmButton = element.querySelector<HTMLButtonElement>(".cam-confirm-yes")!;
    confirmButton.click();
    await fixture.whenStable();

    expect(api.patch).toHaveBeenCalledWith("/cards/card-1/completion", { completed: true });
    expect(api.patch).toHaveBeenCalledWith("/cards/card-1/archive", { archived: true });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("hides the card watch action while watching the board", () => {
    TestBed.configureTestingModule({
      imports: [CardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notificationsService({ isWatchingBoard: vi.fn(() => true) }) },
        { provide: Router, useValue: { createUrlTree: vi.fn(), serializeUrl: vi.fn() } },
        { provide: BoardState, useValue: boardState() },
      ],
    });

    const fixture = TestBed.createComponent(CardActionsMenuPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent.replace(/\s+/g, " ").trim();
    expect(text).not.toContain("Watch card");
    expect(text).not.toContain("Stop watching");
  });

  it("opens the quick edit panel from the actions menu", () => {
    TestBed.configureTestingModule({
      imports: [CardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notificationsService() },
        { provide: Router, useValue: { createUrlTree: vi.fn(), serializeUrl: vi.fn() } },
        { provide: BoardState, useValue: boardState() },
      ],
    });

    const fixture = TestBed.createComponent(CardActionsMenuPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.detectChanges();

    const quickEditButton = Array.from(fixture.nativeElement.querySelectorAll(".cam-item"))
      .find((button) => (button as HTMLButtonElement).textContent?.includes("Quick edit")) as HTMLButtonElement;
    quickEditButton.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("Quick edit");
    expect(fixture.debugElement.query((de) => de.componentInstance instanceof CardQuickEditPopover)).toBeTruthy();
  });

  it("copies the absolute card link from the actions menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const router = {
      createUrlTree: vi.fn(() => ({})),
      serializeUrl: vi.fn(() => "/b/board-1?cardId=card-1"),
    };
    TestBed.configureTestingModule({
      imports: [CardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notificationsService() },
        { provide: Router, useValue: router },
        { provide: BoardState, useValue: boardState() },
      ],
    });

    const fixture = TestBed.createComponent(CardActionsMenuPopover);
    const close = vi.fn();
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.componentInstance.close.subscribe(close);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const copyButton = Array.from(element.querySelectorAll<HTMLButtonElement>(".cam-item"))
      .find((button) => button.textContent?.includes("Copy card link"))!;
    copyButton.click();
    await fixture.whenStable();

    expect(router.createUrlTree).toHaveBeenCalledWith(["/b", "board-1"], { queryParams: { cardId: "card-1" } });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/b/board-1?cardId=card-1`);
    expect(close).toHaveBeenCalled();
  });

  it("toggles card watch state from the actions menu", async () => {
    const notifications = notificationsService({ isWatchingCard: vi.fn(() => true) });
    TestBed.configureTestingModule({
      imports: [CardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notifications },
        { provide: Router, useValue: { createUrlTree: vi.fn(), serializeUrl: vi.fn() } },
        { provide: BoardState, useValue: boardState() },
      ],
    });

    const fixture = TestBed.createComponent(CardActionsMenuPopover);
    const close = vi.fn();
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.componentInstance.close.subscribe(close);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const watchButton = Array.from(element.querySelectorAll<HTMLButtonElement>(".cam-item"))
      .find((button) => button.textContent?.includes("Stop watching"))!;
    watchButton.click();
    await fixture.whenStable();

    expect(notifications.toggleCardWatch).toHaveBeenCalledWith("card-1");
    expect(close).toHaveBeenCalled();
  });

  it("saves quick edited title and due date through the card update endpoint", async () => {
    const api = {
      patch: vi.fn((path: string, body: unknown) => Promise.resolve({ id: "card-1", title: (body as any).title ?? "Ship tests" })),
      put: vi.fn(),
    };
    const state = boardState();
    TestBed.configureTestingModule({
      imports: [CardQuickEditPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: BoardState, useValue: state },
      ],
    });

    const fixture = TestBed.createComponent(CardQuickEditPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.componentRef.setInput("dueDateLocalDate", "2026-05-20");
    fixture.detectChanges();

    fixture.componentInstance.draftTitle.set("Ship more tests");
    await fixture.componentInstance.saveTitle();
    await fixture.componentInstance.setDueDate("2026-05-26", "morning");
    await fixture.componentInstance.setDueDate("", "anyTime");

    expect(api.patch).toHaveBeenCalledWith("/cards/card-1", { title: "Ship more tests" });
    expect(api.patch).toHaveBeenCalledWith("/cards/card-1", { dueDateLocalDate: "2026-05-26", dueDateSlot: "morning" });
    expect(api.patch).toHaveBeenCalledWith("/cards/card-1", { dueDateLocalDate: null, dueDateSlot: null });
    expect(state.updateCard).toHaveBeenCalledTimes(3);
  });

  it("toggles members optimistically and rolls back on failure", async () => {
    const api = { put: vi.fn(() => Promise.reject(new Error("nope"))), patch: vi.fn() };
    const state = boardState({ assigneeIdsForCard: vi.fn(() => ["user-1"]) } as Partial<BoardState>);
    TestBed.configureTestingModule({
      imports: [CardQuickEditPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: BoardState, useValue: state },
      ],
    });

    const fixture = TestBed.createComponent(CardQuickEditPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.detectChanges();

    await expect(fixture.componentInstance.toggleAssignee("user-2")).rejects.toThrow("nope");

    expect(state.setCardAssignees).toHaveBeenNthCalledWith(1, "card-1", ["user-1", "user-2"]);
    expect(state.setCardAssignees).toHaveBeenNthCalledWith(2, "card-1", ["user-1"]);
  });

  it("shows assignable workspace members in quick edit even when they are not board members yet", () => {
    const state = boardState({
      members: signal([
        { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "board" },
      ]),
      assignableMembers: signal([
        { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "board" },
        { userId: "user-2", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" },
      ]),
    } as Partial<BoardState>);
    TestBed.configureTestingModule({
      imports: [CardQuickEditPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { put: vi.fn(), patch: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: BoardState, useValue: state },
      ],
    });

    const fixture = TestBed.createComponent(CardQuickEditPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("Ada");
  });

  it("does not submit stale removed assignee ids from quick edit", async () => {
    const api = { put: vi.fn(() => Promise.resolve({ assigneeIds: ["user-2"] })), patch: vi.fn() };
    const state = boardState({
      assigneeIdsForCard: vi.fn(() => ["removed-user", "user-1"]),
      assignableMembers: signal([
        { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "board" },
        { userId: "user-2", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" },
      ]),
    } as Partial<BoardState>);
    TestBed.configureTestingModule({
      imports: [CardQuickEditPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: BoardState, useValue: state },
      ],
    });

    const fixture = TestBed.createComponent(CardQuickEditPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.detectChanges();

    await fixture.componentInstance.toggleAssignee("user-2");

    expect(api.put).toHaveBeenCalledWith("/cards/card-1/assignees", { userIds: ["user-1", "user-2"] });
    expect(state.setCardAssignees).toHaveBeenCalledWith("card-1", ["user-1", "user-2"]);
  });

  it("toggles labels through the labels endpoint", async () => {
    const api = { put: vi.fn(() => Promise.resolve({ labelIds: ["label-1", "label-2"] })), patch: vi.fn() };
    const state = boardState();
    TestBed.configureTestingModule({
      imports: [CardQuickEditPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: BoardState, useValue: state },
      ],
    });

    const fixture = TestBed.createComponent(CardQuickEditPopover);
    fixture.componentRef.setInput("cardId", "card-1");
    fixture.componentRef.setInput("title", "Ship tests");
    fixture.detectChanges();

    await fixture.componentInstance.toggleLabel("label-2");

    expect(state.setCardLabels).toHaveBeenCalledWith("card-1", ["label-1", "label-2"]);
    expect(api.put).toHaveBeenCalledWith("/cards/card-1/labels", { labelIds: ["label-1", "label-2"] });
  });
});
