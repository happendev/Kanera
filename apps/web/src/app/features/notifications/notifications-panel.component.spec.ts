import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { DefaultUrlSerializer, Router } from "@angular/router";
import type { NotificationRow } from "@kanera/shared/dto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ORGANISATION_SWITCH_NAVIGATOR } from "../../core/api/api.client";
import { AuthService, type AuthUser } from "../../core/auth/auth.service";
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
    clientId: "client-1",
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
    cardKey: "WORK-1",
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
    orgName: "Kanera",
    orgLogoUrl: null,
    attachment: null,
    commentBody: null,
    ...overrides,
    organisationKey: overrides.organisationKey ?? "0123456789ABCDEF",
  };
}

function activity(overrides: Partial<NonNullable<NotificationRow["activity"]>> = {}): NonNullable<NotificationRow["activity"]> {
  return {
    id: "activity-1",
    clientId: null,
    actorId: "user-2",
    actorKind: "user",
    apiKeyId: null,
    apiKeyName: null,
    supportSessionId: null,
    supportActorEmail: null,
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
    searchQuery: ReturnType<typeof signal<string>>;
    groupBy: ReturnType<typeof signal<"day" | "board" | "user" | "organisation">>;
    groupCounts: ReturnType<typeof signal<Record<string, number>>>;
    notificationUserOptions: ReturnType<typeof signal<{ userId: string; displayName: string; avatarUrl: string | null }[]>>;
    initialise: ReturnType<typeof vi.fn>;
    loadFirstPage: ReturnType<typeof vi.fn>;
    setIncludeRead: ReturnType<typeof vi.fn>;
    setBoardFilter: ReturnType<typeof vi.fn>;
    setUserFilter: ReturnType<typeof vi.fn>;
    setSearchQuery: ReturnType<typeof vi.fn>;
    setGroupBy: ReturnType<typeof vi.fn>;
    clearNotificationFilters: ReturnType<typeof vi.fn>;
    groupKey: ReturnType<typeof vi.fn>;
    groupCount: ReturnType<typeof vi.fn>;
    loadMore: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
    markManyRead: ReturnType<typeof vi.fn>;
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
  let authUser: ReturnType<typeof signal<AuthUser | null>>;
  let switchOrg: ReturnType<typeof vi.fn>;
  let pauseForOrganisationSwitch: ReturnType<typeof vi.fn>;
  let resumeAfterOrganisationSwitch: ReturnType<typeof vi.fn>;
  let navigateAfterOrganisationSwitch: ReturnType<typeof vi.fn>;
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
      searchQuery: signal(""),
      groupBy: signal<"day" | "board" | "user" | "organisation">("day"),
      groupCounts: signal<Record<string, number>>({}),
      notificationUserOptions: signal([]),
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
      setSearchQuery: vi.fn((value: string) => {
        service.searchQuery.set(value.trim());
        return Promise.resolve();
      }),
      setGroupBy: vi.fn((value: "day" | "board" | "user" | "organisation") => {
        service.groupBy.set(value);
        return Promise.resolve();
      }),
      clearNotificationFilters: vi.fn(() => {
        service.boardFilter.set(null);
        service.userFilter.set(null);
        service.searchQuery.set("");
        return Promise.resolve();
      }),
      groupKey: vi.fn((value: NotificationRow) => {
        if (service.groupBy() === "board") return value.boardId ? `board:${value.boardId}` : `workspace:${value.workspaceId}`;
        if (service.groupBy() === "user") return value.activity?.actorId ? `user:${value.activity.actorId}` : "system";
        if (service.groupBy() === "organisation") return `organisation:${value.clientId}`;
        return "day:2026-05-21";
      }),
      groupCount: vi.fn((key: string) => service.groupCounts()[key] ?? 0),
      loadMore: vi.fn(() => Promise.resolve()),
      markRead: vi.fn(() => Promise.resolve()),
      markManyRead: vi.fn(() => Promise.resolve()),
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
      serializeUrl: vi.fn(() => "/c/WORK-1"),
    };
    api = {
      post: vi.fn(() => Promise.resolve({
        board: { id: "board-1", workspaceId: "workspace-1", groupId: null, standaloneGroupId: null, name: "Board", description: null, icon: null, iconColor: null, backgroundGradient: null, position: "1000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
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
    authUser = signal<AuthUser | null>({
      id: "user-1",
      clientId: "client-1",
      activeClientId: "client-1",
      email: "me@example.com",
      displayName: "Me User",
      avatarUrl: null,
      orgName: "Kanera",
      logoUrl: null,
      deploymentMode: "hosted",
      hasWorkspace: true,
      role: "member",
      timezone: "UTC",
    });
    switchOrg = vi.fn(() => Promise.resolve(authUser()!));
    pauseForOrganisationSwitch = vi.fn();
    resumeAfterOrganisationSwitch = vi.fn();
    navigateAfterOrganisationSwitch = vi.fn();

    await TestBed.configureTestingModule({
      imports: [NotificationsPanelComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: ORGANISATION_SWITCH_NAVIGATOR, useValue: navigateAfterOrganisationSwitch },
        { provide: AuthService, useValue: { user: authUser.asReadonly(), switchOrg } },
        { provide: NotificationsService, useValue: service },
        { provide: Router, useValue: router },
        {
          provide: SocketService,
          // connect/joinWorkspace are for PresenceService: a k-avatar with [showPresence] installs
          // the shared presence listeners, which the block's actor stack and any user-activity row
          // both do.
          useValue: {
            online: signal(true),
            pauseForOrganisationSwitch,
            resumeAfterOrganisationSwitch,
            connect: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
            joinWorkspace: () => vi.fn(),
          },
        },
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

  it("traps modal focus and returns it to the bell after closing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // CDK's InteractivityChecker requires rendered geometry; jsdom has none unless supplied.
    const geometry = vi.spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      const bell = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".bell-btn")!;
      bell.focus();
      bell.click();
      await fixture.whenStable();

      const dialog = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".drawer")!;
      const close = dialog.querySelector<HTMLButtonElement>(".close-btn")!;
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(close);

      close.click();
      await vi.advanceTimersByTimeAsync(110);
      await fixture.whenStable();
      expect(document.activeElement).toBe(bell);
    } finally {
      geometry.mockRestore();
      vi.useRealTimers();
    }
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

  it("hides redundant organisation context for a user with one organisation", () => {
    service.items.set([notification()]);

    component.toggle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".notif-organisation")).toBeNull();
  });

  it("shows organisation context for multiple memberships or an external guest board", () => {
    authUser.update((user) => user ? {
      ...user,
      organisations: [
        { clientId: "client-1", name: "Kanera", logoUrl: null, role: "member", plan: "free", billingStatus: "none", hasWorkspace: true, isHome: true, unreadCount: 0 },
        { clientId: "client-2", name: "Client Two", logoUrl: null, role: "member", plan: "free", billingStatus: "none", hasWorkspace: true, isHome: false, unreadCount: 0 },
      ],
    } : user);
    service.items.set([notification()]);
    component.toggle();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".notif-organisation")?.textContent).toContain("Kanera");

    authUser.update((user) => user ? { ...user, organisations: undefined } : user);
    service.items.set([notification({ clientId: "client-2", orgName: "Client Two" })]);
    fixture.detectChanges();
    expect(host.querySelector(".notif-organisation")?.textContent).toContain("Client Two");
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
    service.notificationUserOptions.set([]);
    component.toggle();
    fixture.detectChanges();

    let select = selectByLabel(fixture, "Filter notifications by user");
    expect(component.selectedUserFilterFallbackId()).toBe("user-2");
    expect(select.value).toBe("user-2");

    service.notificationUserOptions.set([{ userId: "user-2", displayName: "Grace", avatarUrl: null }]);
    fixture.detectChanges();

    expect(component.selectedUserFilterFallbackId()).toBeNull();
    select = selectByLabel(fixture, "Filter notifications by user");
    expect(select.value).toBe("user-2");
  });

  it("combines organisation members with guest notification actors", () => {
    workspaceService.notificationUserOptions.set([
      { userId: "member-1", displayName: "Ada", avatarUrl: null },
      { userId: "shared-1", displayName: "Old name", avatarUrl: null },
    ]);
    service.notificationUserOptions.set([
      { userId: "guest-1", displayName: "Maya", avatarUrl: null },
      { userId: "shared-1", displayName: "Updated name", avatarUrl: null },
    ]);

    component.toggle();
    fixture.detectChanges();

    const select = selectByLabel(fixture, "Filter notifications by user");
    expect([...select.options].slice(1).map((option) => [option.value, option.text])).toEqual([
      ["member-1", "Ada"],
      ["guest-1", "Maya"],
      ["shared-1", "Updated name"],
    ]);
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
        action: "checklist:completed",
        payload: { title: "Final checks", parentItemText: "Ship release" },
      }),
    }))).toMatchObject({ text: "completed sub-checklist", value: "Final checks on Ship release" });

    expect(component.changeSummary(notification({
      activity: activity({
        action: "checklist:renamed",
        payload: { fromValue: "Old", toValue: "New" },
      }),
    }))).toMatchObject({ text: "renamed checklist to", value: "New" });
  });

  it("summarises self-assignment notifications without repeating the actor name", () => {
    expect(component.changeSummary(notification({
      actorName: "Amelia Hart",
      activity: activity({
        actorId: "user-2",
        actorKind: "user",
        action: "assignees:set",
        payload: {
          addedAssigneeNames: ["Amelia Hart"],
          fromValue: [],
          toValue: ["user-2"],
          assigneeNamesById: { "user-2": "Amelia Hart" },
        },
      }),
    }))).toMatchObject({ text: "assigned themself" });
  });

  it("keeps regular assignment notification names for other assignees", () => {
    expect(component.changeSummary(notification({
      actorName: "Amelia Hart",
      activity: activity({
        actorId: "user-2",
        actorKind: "user",
        action: "assignees:set",
        payload: {
          addedAssigneeNames: ["Grace Hopper"],
          fromValue: [],
          toValue: ["user-3"],
          assigneeNamesById: { "user-3": "Grace Hopper" },
        },
      }),
    }))).toMatchObject({ text: "assigned Grace Hopper" });
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

  it("groups notifications by board with exact counts and newest groups first", () => {
    service.groupBy.set("board");
    service.groupCounts.set({ "board:board-1": 9, "board:board-2": 3 });
    service.items.set([
      notification({ id: "old-board-1", createdAt: new Date("2026-05-20T10:00:00.000Z") }),
      notification({ id: "board-2", boardId: "board-2", boardName: "Operations", createdAt: new Date("2026-05-21T10:00:00.000Z") }),
      notification({ id: "new-board-1", createdAt: new Date("2026-05-22T10:00:00.000Z") }),
    ]);

    component.toggle();
    fixture.detectChanges();

    const headers = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".notif-group-header")];
    expect(headers.map((header) => header.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Board9", "Operations3"]);
    const firstGroupItems = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".notif-group:first-of-type .notif-item")];
    expect(firstGroupItems).toHaveLength(2);
  });

  it("collapses and expands each notification group independently", () => {
    service.groupBy.set("board");
    // Distinct cards on purpose: two same-day unread rows on one card would render as a single
    // card+day block, which is a different assertion than this test's group collapse behaviour.
    service.items.set([
      notification({ id: "board-1-a", cardId: "card-1", createdAt: new Date("2026-05-22T11:00:00.000Z") }),
      notification({ id: "board-1-b", cardId: "card-2", createdAt: new Date("2026-05-22T10:00:00.000Z") }),
      notification({ id: "board-2", boardId: "board-2", boardName: "Operations", createdAt: new Date("2026-05-21T10:00:00.000Z") }),
    ]);

    component.toggle();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const groups = [...host.querySelectorAll<HTMLElement>(".notif-group")];
    const firstToggle = groups[0]!.querySelector<HTMLButtonElement>(".notif-group-toggle")!;
    expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
    expect(groups[0]!.querySelectorAll(".notif-item")).toHaveLength(2);
    expect(groups[1]!.querySelectorAll(".notif-item")).toHaveLength(1);

    firstToggle.click();
    fixture.detectChanges();

    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");
    expect(groups[0]!.classList.contains("is-collapsed")).toBe(true);
    expect(groups[0]!.querySelectorAll(".notif-item")).toHaveLength(0);
    expect(groups[1]!.querySelectorAll(".notif-item")).toHaveLength(1);

    firstToggle.click();
    fixture.detectChanges();
    expect(groups[0]!.querySelectorAll(".notif-item")).toHaveLength(2);
  });

  it("re-arms paging when collapsing a group keeps the sentinel visible", async () => {
    service.groupBy.set("board");
    service.items.set([
      notification({ id: "board-1" }),
      notification({ id: "board-2", boardId: "board-2", boardName: "Operations" }),
    ]);

    component.toggle();
    fixture.detectChanges();
    await fixture.whenStable();

    const initialObserver = IntersectionObserverStub.instances.at(-1)!;
    const firstToggle = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".notif-group-toggle")!;
    firstToggle.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const rearmedObserver = IntersectionObserverStub.instances.at(-1)!;
    expect(rearmedObserver).not.toBe(initialObserver);
    expect(initialObserver.disconnect).toHaveBeenCalledTimes(1);

    rearmedObserver.trigger(true);
    await Promise.resolve();
    expect(service.loadMore).toHaveBeenCalledTimes(1);
  });

  describe("card+day blocks", () => {
    // Local-time construction: blocks bucket on the viewer's calendar day, so a "…Z" literal would
    // split or merge differently depending on where the suite runs.
    const localAt = (hour: number, minute = 0) => new Date(2026, 4, 21, hour, minute);
    const comment = (id: string, hour: number, actorName: string, actorId: string) =>
      notification({
        id,
        actorName,
        createdAt: localAt(hour),
        commentBody: `comment from ${actorName}`,
        activity: activity({ actorId, entityType: "comment", action: "created" }),
      });

    function openWithBurst(): HTMLElement {
      service.items.set([
        comment("n-3", 14, "Maya", "user-maya"),
        comment("n-2", 12, "Dylan", "user-dylan"),
        comment("n-1", 10, "Maya", "user-maya"),
      ]);
      component.toggle();
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    it("states the card context once and lists every update beneath it", () => {
      const host = openWithBurst();

      const clusters = host.querySelectorAll(".notif-cluster");
      expect(clusters).toHaveLength(1);
      expect(host.querySelectorAll(".notif-item:not(.notif-cluster)")).toHaveLength(0);
      // No count badge on the header: the entries below already are the count.
      expect(clusters[0]!.querySelector(".notif-cluster-count")).toBeNull();
      expect(clusters[0]!.querySelectorAll(".notif-entry")).toHaveLength(3);
      // Card key, breadcrumb and title appear once for the whole block, not once per update.
      expect(clusters[0]!.querySelectorAll(".notif-card-key")).toHaveLength(1);
      expect(clusters[0]!.querySelectorAll(".card-title")).toHaveLength(1);
      expect(clusters[0]!.querySelectorAll(".board-link")).toHaveLength(1);
      // No actor stack on the header — each entry pictures its own actor instead.
      expect(clusters[0]!.querySelectorAll(".notif-cluster-actors")).toHaveLength(0);
      expect(clusters[0]!.querySelectorAll(".notif-entry k-avatar")).toHaveLength(3);
    });

    it("marks every entry read from the block dot in a single request", async () => {
      const host = openWithBurst();

      const blockDot = host.querySelector<HTMLButtonElement>(".notif-cluster-head .read-dot")!;
      blockDot.click();
      await fixture.whenStable();

      expect(service.markManyRead).toHaveBeenCalledTimes(1);
      expect(service.markManyRead).toHaveBeenCalledWith(["n-3", "n-2", "n-1"]);
    });

    it("opens the card from the block and clears the whole block", async () => {
      const host = openWithBurst();

      host.querySelector<HTMLAnchorElement>(".notif-cluster .notif-card-link")!.click();
      await fixture.whenStable();

      expect(service.markManyRead).toHaveBeenCalledWith(["n-3", "n-2", "n-1"]);
      expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1", "c", "card-1"], {
        queryParams: { cardId: null, lightboxAttachmentId: null },
        queryParamsHandling: "merge",
        browserUrl: "/o/0123456789ABCDEF/c/WORK-1",
      });
    });

    it("carries exactly one read control for the whole block", () => {
      const host = openWithBurst();

      // A block is read or unread as one thing, so its three entries must not offer three dots.
      expect(host.querySelectorAll(".notif-cluster .read-dot")).toHaveLength(1);
      expect(host.querySelectorAll(".notif-entry .read-dot")).toHaveLength(0);
    });

    it("degrades a two-entry block back to a plain row once only one unread update is left", () => {
      service.items.set([comment("n-2", 12, "Maya", "user-maya"), comment("n-1", 10, "Maya", "user-maya")]);
      component.toggle();
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelectorAll(".notif-cluster")).toHaveLength(1);

      // Whatever cleared the other row — opening the card elsewhere, a board mark-read, another
      // session — the unread feed drops it and the block loses its reason to exist.
      service.items.set([comment("n-1", 10, "Maya", "user-maya")]);
      fixture.detectChanges();

      expect(host.querySelectorAll(".notif-cluster")).toHaveLength(0);
      expect(host.querySelectorAll(".notif-item")).toHaveLength(1);
    });

    it("keeps read rows as their own rows beside a block for the same card", () => {
      service.items.set([
        comment("unread-2", 14, "Maya", "user-maya"),
        comment("unread-1", 12, "Maya", "user-maya"),
        { ...comment("read-1", 11, "Maya", "user-maya"), readAt: localAt(11, 30) },
      ]);
      component.toggle();
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelectorAll(".notif-cluster")).toHaveLength(1);
      expect(host.querySelectorAll(".notif-item:not(.notif-cluster)")).toHaveLength(1);
    });

    it("keeps the group header count on notifications rather than rendered blocks", () => {
      service.groupCounts.set({ "day:2026-05-21": 3 });
      const host = openWithBurst();

      expect(host.querySelector(".notif-group-count")?.textContent?.trim()).toBe("3");
    });

    it("opens the card actions menu for the block's head row", async () => {
      const host = openWithBurst();

      host.querySelector(".notif-cluster")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.actionsMenuNotificationId()).toBe("n-3");
      expect(fixture.debugElement.query((de) => de.componentInstance instanceof CardActionsMenuPopover)).toBeTruthy();
    });
  });

  it("labels organisation groups and switches before opening a foreign-org notification", async () => {
    const foreign = notification({ clientId: "client-2", orgName: "Client Two", orgLogoUrl: null });
    service.groupBy.set("organisation");
    service.items.set([foreign]);
    component.toggle();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("Client Two");
    switchOrg.mockRejectedValueOnce(new Error("stop before jsdom navigation"));
    await component.openNotification(foreign);

    expect(switchOrg).toHaveBeenCalledWith("client-2");
    expect(pauseForOrganisationSwitch).toHaveBeenCalledTimes(1);
    expect(resumeAfterOrganisationSwitch).toHaveBeenCalledTimes(1);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("debounces notification search and clears it immediately", async () => {
    vi.useFakeTimers();
    component.setSearchQuery("Ship tests");
    vi.advanceTimersByTime(199);
    expect(service.setSearchQuery).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(service.setSearchQuery).toHaveBeenCalledWith("Ship tests");

    // An empty value takes the immediate path, which is how k-search-field's clear button gets its
    // instant response without a second output.
    component.setSearchQuery("");
    expect(component.searchInputValue()).toBe("");
    expect(service.setSearchQuery).toHaveBeenLastCalledWith("");
    vi.useRealTimers();
  });

  it("routes board and card notifications to the canonical board detail path", async () => {
    await component.openNotification(notification());

    expect(service.markManyRead).toHaveBeenCalledWith(["notification-1"]);
    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1", "c", "card-1"], {
      queryParams: { cardId: null, lightboxAttachmentId: null },
      queryParamsHandling: "merge",
      browserUrl: "/o/0123456789ABCDEF/c/WORK-1",
    });
  });

  it("opens image attachment notifications with the card detail lightbox target", async () => {
    service.items.set([notification({
      attachment: {
        id: "attachment-1",
        url: "https://example.com/spec.png",
        thumbnailUrl: "https://example.com/spec-thumb.png",
        mimeType: "image/png",
        fileName: "spec.png",
      },
    })]);
    component.toggle();
    fixture.detectChanges();

    const image = (fixture.nativeElement as HTMLElement).querySelector<HTMLImageElement>(".notif-attachment-preview img")!;
    image.click();
    await fixture.whenStable();

    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1", "c", "card-1"], {
      queryParams: { cardId: null, lightboxAttachmentId: "attachment-1" },
      queryParamsHandling: "merge",
      browserUrl: "/o/0123456789ABCDEF/c/WORK-1",
    });
  });

  it("shows the email file icon for .eml attachment notifications", () => {
    service.items.set([notification({
      attachment: {
        id: "attachment-1",
        url: "https://example.com/thread.eml",
        thumbnailUrl: null,
        mimeType: "message/rfc822",
        fileName: "thread.eml",
      },
    })]);
    component.toggle();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".notif-attachment-fallback .ti-mail")).not.toBeNull();
    expect(host.querySelector(".notif-attachment-fallback .ti-paperclip")).toBeNull();
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
    expect(service.markManyRead).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1"]);
    expect(router.navigate).not.toHaveBeenCalledWith(["/b", "board-1"], expect.objectContaining({
      queryParams: { cardId: "card-1" },
    }));
  });

  it("opens card notifications in a new tab on middle-click", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    component.openNotificationInNewTab(event, notification());

    expect(event.defaultPrevented).toBe(true);
    expect(service.markManyRead).toHaveBeenCalledWith(["notification-1"]);
    expect(open).toHaveBeenCalledWith("/o/0123456789ABCDEF/c/WORK-1", "_blank", "noopener");
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
    expect(service.markManyRead).not.toHaveBeenCalled();
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
    expect(quickEditText).toContain("Me");
    expect(quickEditText).toContain("Urgent");
    const selectedRows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".cqe-row.is-selected"));
    expect(selectedRows.some((row) => row.textContent?.includes("Me"))).toBe(true);
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
