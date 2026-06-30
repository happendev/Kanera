import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { DefaultUrlSerializer, Router } from "@angular/router";
import type { NotificationRow } from "@kanera/shared/dto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { SocketService } from "../../core/realtime/socket.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { CardActionsMenuPopover } from "../board/card-actions-menu.popover";
import { NotificationsPanelComponent } from "./notifications-panel.component";

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this);
  }

  trigger(isIntersecting = true) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
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
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
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

function activity(overrides: Partial<NonNullable<NotificationRow["activity"]>> = {}): NonNullable<NotificationRow["activity"]> {
  return {
    id: "activity-1",
    actorId: "user-2",
    actorKind: "user",
    apiKeyId: null,
    apiKeyName: null,
    boardId: "board-1",
    workspaceId: "workspace-1",
    entityType: "card",
    entityId: "card-1",
    action: "updated",
    payload: {},
    feedVisible: true,
    coalesceKey: null,
    coalescedCount: 1,
    coalescedUntil: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function selectByLabel(fixture: ComponentFixture<NotificationsPanelComponent>, label: string): HTMLSelectElement {
  const host = fixture.nativeElement as HTMLElement;
  const select = host.querySelector(`select[aria-label="${label}"]`);
  expect(select).toBeInstanceOf(HTMLSelectElement);
  return select as HTMLSelectElement;
}

describe("NotificationsPanelComponent", () => {
  let fixture: ComponentFixture<NotificationsPanelComponent>;
  let component: NotificationsPanelComponent;
  let service: {
    items: ReturnType<typeof signal<NotificationRow[]>>;
    unreadCount: ReturnType<typeof signal<number>>;
    includeRead: ReturnType<typeof signal<boolean>>;
    online: ReturnType<typeof signal<boolean>>;
    loading: ReturnType<typeof signal<boolean>>;
    loadError: ReturnType<typeof signal<string | null>>;
    hasMore: ReturnType<typeof signal<boolean>>;
    boardFilter: ReturnType<typeof signal<string | null>>;
    userFilter: ReturnType<typeof signal<string | null>>;
    initialise: ReturnType<typeof vi.fn>;
    loadFirstPage: ReturnType<typeof vi.fn>;
    setIncludeRead: ReturnType<typeof vi.fn>;
    setBoardFilter: ReturnType<typeof vi.fn>;
    setUserFilter: ReturnType<typeof vi.fn>;
    loadMore: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
    markUnread: ReturnType<typeof vi.fn>;
    markAllRead: ReturnType<typeof vi.fn>;
    isWatchingCard: ReturnType<typeof vi.fn>;
    isWatchingBoard: ReturnType<typeof vi.fn>;
    toggleCardWatch: ReturnType<typeof vi.fn>;
  };
  let router: {
    url: string;
    navigate: ReturnType<typeof vi.fn>;
    navigateByUrl: ReturnType<typeof vi.fn>;
    parseUrl: (url: string) => ReturnType<DefaultUrlSerializer["parse"]>;
    createUrlTree: ReturnType<typeof vi.fn>;
    serializeUrl: ReturnType<typeof vi.fn>;
  };
  let api: { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let workspaceService: {
    activeAccentColor: ReturnType<typeof signal<string | null>>;
    notificationBoardOptions: ReturnType<typeof signal<{ boardId: string; boardName: string; boardIcon: string | null; boardIconColor: string | null }[]>>;
    notificationUserOptions: ReturnType<typeof signal<{ userId: string; displayName: string; avatarUrl: string | null }[]>>;
    registerBoards: ReturnType<typeof vi.fn>;
    cacheLists: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    IntersectionObserverStub.instances = [];
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    service = {
      items: signal<NotificationRow[]>([]),
      unreadCount: signal(0),
      includeRead: signal(false),
      online: signal(true),
      loading: signal(false),
      loadError: signal<string | null>(null),
      hasMore: signal(true),
      boardFilter: signal(null),
      userFilter: signal(null),
      initialise: vi.fn(),
      loadFirstPage: vi.fn(() => Promise.resolve()),
      setIncludeRead: vi.fn((value: boolean) => {
        service.includeRead.set(value);
        return Promise.resolve();
      }),
      setBoardFilter: vi.fn((value: string | null) => {
        service.boardFilter.set(value);
        return Promise.resolve();
      }),
      setUserFilter: vi.fn((value: string | null) => {
        service.userFilter.set(value);
        return Promise.resolve();
      }),
      loadMore: vi.fn(() => Promise.resolve()),
      markRead: vi.fn(() => Promise.resolve()),
      markUnread: vi.fn(() => Promise.resolve()),
      markAllRead: vi.fn(() => Promise.resolve()),
      isWatchingCard: vi.fn(() => false),
      isWatchingBoard: vi.fn(() => false),
      toggleCardWatch: vi.fn(() => Promise.resolve()),
    };
    const serializer = new DefaultUrlSerializer();
    router = {
      url: "/",
      navigate: vi.fn(() => Promise.resolve(true)),
      navigateByUrl: vi.fn(() => Promise.resolve(true)),
      parseUrl: (url: string) => serializer.parse(url),
      createUrlTree: vi.fn(() => ({})),
      serializeUrl: vi.fn(() => "/b/board-1?cardId=card-1"),
    };
    api = {
      post: vi.fn(() => Promise.resolve({
        board: { id: "board-1", workspaceId: "workspace-1", groupId: null, name: "Board", description: null, icon: null, iconColor: null, backgroundGradient: null, position: "1000", visibility: "workspace", archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
        lists: [{ id: "list-1", workspaceId: "workspace-1", name: "Todo", color: null, icon: null, position: "1000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() }],
        cards: [{ id: "card-1", boardId: "board-1", listId: "list-1", title: "Ship tests", position: "1000", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null, completedAt: null, archivedAt: null, labelIds: ["label-1"], assigneeIds: ["user-1"], customFieldValues: [], attachmentCount: 0, commentCount: 0, coverUrl: null, createdAt: new Date(), updatedAt: new Date() }],
        customFields: [],
        cardLabels: [{ id: "label-1", workspaceId: "workspace-1", name: "Urgent", color: "red", position: "1000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() }],
        members: [{ userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "workspace", clientId: "client-1" }],
        viewerRole: "editor",
        viewerSource: "workspace",
      })),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    workspaceService = {
      activeAccentColor: signal(null),
      notificationBoardOptions: signal([]),
      notificationUserOptions: signal([]),
      registerBoards: vi.fn(),
      cacheLists: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [NotificationsPanelComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: NotificationsService, useValue: service },
        { provide: Router, useValue: router },
        { provide: SocketService, useValue: { online: signal(true) } },
        { provide: WorkspaceService, useValue: workspaceService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(NotificationsPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    document.body.classList.remove("k-no-scroll");
    vi.unstubAllGlobals();
  });

  it("opens and loads the first page, then closes on escape", async () => {
    component.toggle();
    fixture.detectChanges();
    await Promise.resolve();

    expect(service.initialise).toHaveBeenCalledTimes(1);
    expect(component.open()).toBe(true);
    expect(service.loadFirstPage).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("k-no-scroll")).toBe(true);

    vi.useFakeTimers();
    component.onEscape();
    vi.advanceTimersByTime(110);
    vi.useRealTimers();

    expect(component.open()).toBe(false);
  });

  it("shows an offline state instead of a spinner when notifications cannot load", async () => {
    service.loadError.set("You're offline. Reconnect to refresh notifications.");

    component.toggle();
    fixture.detectChanges();
    await Promise.resolve();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".kanera-spin")).toBeNull();
    expect(host.querySelector(".empty-title")?.textContent?.trim()).toBe("Notifications unavailable");
    expect(host.textContent).toContain("You're offline. Reconnect to refresh notifications.");
  });

  it("keeps existing notifications visible when a load error is present", () => {
    service.items.set([notification()]);
    service.loadError.set("You're offline. Reconnect to refresh notifications.");

    component.toggle();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".notif-item")).not.toBeNull();
    expect(host.querySelector(".empty-title")?.textContent?.trim()).not.toBe("Notifications unavailable");
  });

  it("resolves GitHub links in comments with the notification workspace context", async () => {
    service.items.set([notification({ commentBody: "https://github.com/acme/kanera/pull/42" })]);

    component.toggle();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.post).toHaveBeenCalledWith("/github-links/resolve", {
      urls: ["https://github.com/acme/kanera/pull/42"],
      workspaceId: "workspace-1",
    });
  });

  it("offers refresh instead of claiming the user is caught up when unread count remains positive", () => {
    service.items.set([]);
    service.unreadCount.set(9);
    service.includeRead.set(false);
    service.boardFilter.set(null);
    service.userFilter.set(null);

    component.toggle();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".empty-title")?.textContent?.trim()).toBe("Refreshing unread notifications");
    expect(host.textContent).not.toContain("You're all caught up");

    service.loadFirstPage.mockClear();
    const refreshButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Refresh")) as HTMLButtonElement | undefined;
    refreshButton?.click();
    expect(service.loadFirstPage).toHaveBeenCalledTimes(1);
  });

  it("reloads the open drawer when connectivity returns", () => {
    component.toggle();
    fixture.detectChanges();
    expect(service.loadFirstPage).toHaveBeenCalledTimes(1);

    service.online.set(false);
    TestBed.flushEffects();
    service.online.set(true);
    TestBed.flushEffects();

    expect(service.loadFirstPage).toHaveBeenCalledTimes(2);
  });

  it("renders the service feed verbatim and delegates include-read toggling", async () => {
    // The service owns per-tab filtering; the panel mirrors items() directly,
    // so whatever the active feed holds is exactly what renders.
    service.items.set([
      notification({ id: "unread", readAt: null }),
      notification({ id: "read", readAt: new Date("2026-05-21T01:00:00.000Z") }),
    ]);

    expect(component.displayedItems().map((n) => n.id)).toEqual(["unread", "read"]);

    await component.toggleIncludeRead();

    expect(service.setIncludeRead).toHaveBeenCalledWith(true);
  });

  it("keeps the board select value when the selected board option loads after open", () => {
    service.boardFilter.set("board-1");
    workspaceService.notificationBoardOptions.set([]);
    component.toggle();
    fixture.detectChanges();

    let select = selectByLabel(fixture, "Filter notifications by board");
    expect(component.selectedBoardFilterFallbackId()).toBe("board-1");
    expect(select.value).toBe("board-1");

    workspaceService.notificationBoardOptions.set([{ boardId: "board-1", boardName: "Delivery", boardIcon: null, boardIconColor: null }]);
    fixture.detectChanges();

    expect(component.selectedBoardFilterFallbackId()).toBeNull();
    select = selectByLabel(fixture, "Filter notifications by board");
    expect(select.value).toBe("board-1");
  });

  it("keeps the user select value when the selected user option loads after open", () => {
    service.userFilter.set("user-2");
    workspaceService.notificationUserOptions.set([]);
    component.toggle();
    fixture.detectChanges();

    let select = selectByLabel(fixture, "Filter notifications by user");
    expect(component.selectedUserFilterFallbackId()).toBe("user-2");
    expect(select.value).toBe("user-2");

    workspaceService.notificationUserOptions.set([{ userId: "user-2", displayName: "Grace", avatarUrl: null }]);
    fixture.detectChanges();

    expect(component.selectedUserFilterFallbackId()).toBeNull();
    select = selectByLabel(fixture, "Filter notifications by user");
    expect(select.value).toBe("user-2");
  });

  it("guards mark-read and mark-all-read while offline", async () => {
    service.online.set(false);
    const event = { stopPropagation: vi.fn() } as unknown as Event;

    await component.markRead(event, "notification-1");
    await component.toggleRead(event, notification());
    await component.markAllRead();

    expect(event.stopPropagation).toHaveBeenCalledTimes(2);
    expect(service.markRead).not.toHaveBeenCalled();
    expect(service.markUnread).not.toHaveBeenCalled();
    expect(service.markAllRead).not.toHaveBeenCalled();
  });

  it("toggles a notification between read and unread", async () => {
    const event = { stopPropagation: vi.fn() } as unknown as Event;

    await component.toggleRead(event, notification());
    await component.toggleRead(event, notification({ readAt: new Date("2026-05-21T01:00:00.000Z") }));

    expect(service.markRead).toHaveBeenCalledWith("notification-1");
    expect(service.markUnread).toHaveBeenCalledWith("notification-1");
  });

  it("summarises checklist activity with friendly notification text", () => {
    expect(component.changeSummary(notification({
      activity: activity({
        action: "checklist:created",
        payload: { title: "Launch tasks" },
      }),
    }))).toMatchObject({ text: "added checklist", value: "Launch tasks" });

    expect(component.changeSummary(notification({
      activity: activity({
        action: "checklist:deleted",
        payload: {},
      }),
    }))).toMatchObject({ text: "deleted checklist", value: undefined });

    expect(component.changeSummary(notification({
      activity: activity({
        action: "checklist:completed",
        payload: { title: "Launch tasks" },
      }),
    }))).toMatchObject({ text: "completed checklist", value: "Launch tasks" });

    expect(component.changeSummary(notification({
      activity: activity({
        action: "checklist:renamed",
        payload: { fromValue: "Old", toValue: "New" },
      }),
    }))).toMatchObject({ text: "renamed checklist to", value: "New" });
  });

  it("summarises checklist-item overdue notifications distinctly from card overdue", () => {
    // Checklist-item overdue rows carry no activity, so they must not fall
    // through to the generic "card is overdue" branch.
    expect(component.changeSummary(notification({
      reason: "checklist_item_overdue",
      activity: null,
    }))).toMatchObject({ icon: "ti ti-calendar-exclamation", text: "checklist item is overdue" });

    expect(component.changeSummary(notification({
      reason: "overdue",
      activity: null,
    }))).toMatchObject({ text: "card is overdue" });
  });

  it("humanises unknown activity actions instead of showing raw event ids", () => {
    expect(component.changeSummary(notification({
      activity: activity({
        action: "checklist:futureAction",
        payload: {},
      }),
    })).text).toBe("checklist future action");
  });

  it("loads more when the sentinel intersects", async () => {
    service.items.set([notification()]);
    component.toggle();
    fixture.detectChanges();
    await fixture.whenStable();

    IntersectionObserverStub.instances.at(-1)?.trigger(true);
    await Promise.resolve();

    expect(service.loadMore).toHaveBeenCalledTimes(1);
  });

  it("routes board and card notifications to the board detail query", async () => {
    await component.openNotification(notification());

    expect(service.markRead).toHaveBeenCalledWith("notification-1");
    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1"], {
      queryParams: { cardId: "card-1" },
      queryParamsHandling: "merge",
    });
  });

  it("routes board-only notifications to the board", async () => {
    await component.openNotification(notification({ cardId: null }));

    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1"]);
  });

  it("routes the notification board breadcrumb to the board without opening the card", async () => {
    service.items.set([notification()]);
    component.toggle();
    fixture.detectChanges();
    const openNotification = vi.spyOn(component, "openNotification");

    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".board-link")!;
    boardLink.click();
    await fixture.whenStable();

    expect(openNotification).not.toHaveBeenCalled();
    expect(service.markRead).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1"]);
    expect(router.navigate).not.toHaveBeenCalledWith(["/b", "board-1"], expect.objectContaining({
      queryParams: { cardId: "card-1" },
    }));
  });

  it("opens card notifications in the current assigned-work page", async () => {
    router.url = "/w/workspace-1/team?userId=user-2";

    await component.openNotification(notification());

    expect(router.navigate).not.toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalled();
    const tree = router.navigateByUrl.mock.calls[0]?.[0] as ReturnType<DefaultUrlSerializer["parse"]>;
    expect(tree.queryParams["cardId"]).toBe("card-1");
  });

  it("opens card notifications in a new tab on middle-click", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    component.openNotificationInNewTab(event, notification());

    expect(event.defaultPrevented).toBe(true);
    expect(service.markRead).toHaveBeenCalledWith("notification-1");
    expect(open).toHaveBeenCalledWith("/b/board-1?cardId=card-1", "_blank", "noopener");
  });

  it("opens board-only notifications in a new tab on middle-click", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    component.openNotificationInNewTab(event, notification({ cardId: null }));

    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("/b/board-1", "_blank", "noopener");
  });

  it("opens the notification board breadcrumb in a new tab without the card query", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    component.openBoardInNewTab(event, notification());

    expect(event.defaultPrevented).toBe(true);
    expect(service.markRead).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/b/board-1", "_blank", "noopener");
  });

  it("opens the card actions menu from right-click on editable card notifications", async () => {
    service.items.set([notification()]);
    component.toggle();
    fixture.detectChanges();
    const openNotification = vi.spyOn(component, "openNotification");

    const item = (fixture.nativeElement as HTMLElement).querySelector(".notif-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(openNotification).not.toHaveBeenCalled();
    expect(component.actionsMenuNotificationId()).toBe("notification-1");
    expect(component.actionsMenuPoint()).toEqual({ x: 120, y: 80 });
    expect(api.post).toHaveBeenCalledWith("/boards/board-1/open", {});
    expect(fixture.debugElement.query((de) => de.componentInstance instanceof CardActionsMenuPopover)).toBeTruthy();

    const quickEditButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(".cam-item"))
      .find((button) => button.textContent?.includes("Quick edit"))!;
    quickEditButton.click();
    fixture.detectChanges();

    const quickEditText = (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(quickEditText).toContain("Me User");
    expect(quickEditText).toContain("Urgent");
    const selectedRows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".cqe-row.is-selected"));
    expect(selectedRows.some((row) => row.textContent?.includes("Me User"))).toBe(true);
    expect(selectedRows.some((row) => row.textContent?.includes("Urgent"))).toBe(true);
  });

  it("does not open card actions for observer notifications", () => {
    service.items.set([notification({ viewerRole: "observer" })]);
    component.toggle();
    fixture.detectChanges();

    const item = (fixture.nativeElement as HTMLElement).querySelector(".notif-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    fixture.detectChanges();

    expect(component.actionsMenuNotificationId()).toBeNull();
    expect(fixture.debugElement.query((de) => de.componentInstance instanceof CardActionsMenuPopover)).toBeFalsy();
  });

  it("does not open card actions for board-only notifications", () => {
    service.items.set([notification({ cardId: null, cardTitle: null })]);
    component.toggle();
    fixture.detectChanges();

    const item = (fixture.nativeElement as HTMLElement).querySelector(".notif-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    fixture.detectChanges();

    expect(component.actionsMenuNotificationId()).toBeNull();
    expect(fixture.debugElement.query((de) => de.componentInstance instanceof CardActionsMenuPopover)).toBeFalsy();
  });

  it("loads the archived board payload for archived card notifications", async () => {
    const archivedNotification = notification({ cardArchivedAt: new Date("2026-05-21T00:00:00.000Z") });
    component.toggle();

    await component.openCardActions(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), archivedNotification);

    expect(api.post).toHaveBeenCalledWith("/boards/board-1/open?archived=true", {});
  });

  it("clears the card actions menu when the drawer closes", async () => {
    service.items.set([notification()]);
    component.toggle();
    fixture.detectChanges();
    await component.openCardActions(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), notification());

    vi.useFakeTimers();
    component.close();
    vi.advanceTimersByTime(110);
    vi.useRealTimers();

    expect(component.open()).toBe(false);
    expect(component.actionsMenuNotificationId()).toBeNull();
    expect(component.actionsMenuPoint()).toBeNull();
  });
});
