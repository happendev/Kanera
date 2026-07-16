import { provideZonelessChangeDetection, signal } from "@angular/core";
import { Dialog } from "@angular/cdk/dialog";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import type { Board, BoardGroup, Workspace } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService, type GuestHomeGroup, type HomeGroup, type HomeResponse } from "../../core/offline/offline-cache.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { ThemeService } from "../../core/theme/theme.service";
import { UpdatesService } from "../../core/updates/updates.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AppShellComponent } from "./app-shell.component";

class SocketStub {
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.set(event, handler);
    return this;
  });
  readonly off = vi.fn(() => this);

  emitServer(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload);
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function workspace(overrides: Partial<Workspace & { role: string }> = {}): Workspace & { role: string } {
  return {
    id: "workspace-1",
    clientId: "client-1",
    name: "Delivery",
    kind: "standard",
    icon: null,
    accentColor: null,
    completedCardsActiveDays: 35,
    boardLinkingEnabled: true,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    archivedAt: null,
    role: "admin",
    ...overrides,
  };
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    id: "board-1",
    workspaceId: "workspace-1",
    groupId: null,
    standaloneGroupId: null,
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

function boardGroup(overrides: Partial<BoardGroup> = {}): BoardGroup {
  return {
    id: "group-1",
    workspaceId: "workspace-1",
    title: "Product",
    position: "1000.0000000000",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function group(overrides: Partial<HomeGroup> = {}): HomeGroup {
  const ws = overrides.workspace ?? workspace();
  return {
    workspace: ws,
    boardGroups: [],
    boards: [
      board({ id: "board-1", workspaceId: ws.id, name: "Roadmap", position: "1000.0000000000" }),
      board({ id: "board-2", workspaceId: ws.id, name: "Hiring Plan", position: "2000.0000000000" }),
    ],
    members: [
      {
        userId: "user-1",
        displayName: "Me User",
        avatarUrl: null,
        role: "admin",
      },
      {
        userId: "user-2",
        displayName: "Ada",
        avatarUrl: null,
        role: "member",
      },
    ],
    ...overrides,
  };
}

function guestGroup(overrides: Partial<GuestHomeGroup> = {}): GuestHomeGroup {
  const ws = overrides.workspace ?? workspace({ id: "guest-workspace-1", clientId: "client-2", name: "Client Delivery", role: "guest" });
  return {
    workspace: ws,
    clientName: "Client Co",
    boardGroups: [],
    boards: [
      {
        ...board({ id: "guest-board-1", workspaceId: ws.id, name: "Shared Launch", position: "1000.0000000000" }),
        myCards: 0,
        myOverdue: 0,
      },
    ],
    ...overrides,
  };
}

describe("AppShellComponent board search", () => {
  let fixture: ComponentFixture<AppShellComponent>;
  let component: AppShellComponent;

  async function render(
    response: HomeResponse = { groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 },
    options: {
      notificationSettings?: { push: { enabled: boolean }; pushEnabled: boolean };
      browserPush?: Partial<BrowserPushService>;
      user?: Partial<{
        id: string;
        clientId: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
        orgName: string;
        logoUrl: string | null;
        deploymentMode: "self_hosted" | "hosted";
        kaneraEnvironment: "development" | "test" | "staging" | "production";
        hasWorkspace: boolean;
        role: string;
        timezone: string;
      }>;
      isOrgAdmin?: boolean;
      maxBoards?: number | null;
      workspaceAccents?: Record<string, string>;
    } = {},
  ) {
    const socket = new SocketStub();
    const joinBoard = vi.fn(() => vi.fn());
    const joinWorkspace = vi.fn(() => vi.fn());
    const notificationSettings = options.notificationSettings ?? { push: { enabled: false }, pushEnabled: false };
    const subscribed = signal(false);
    const browserPush = {
      initialise: vi.fn(() => Promise.resolve()),
      unsupportedReason: signal("unsupported"),
      permission: signal("default"),
      subscribed,
      subscribe: vi.fn(() => {
        subscribed.set(true);
        return Promise.resolve();
      }),
      unsubscribeForLogout: vi.fn(() => Promise.resolve()),
      ...options.browserPush,
    };
    const api = {
      get: vi.fn((path: string) => {
        if (path === "/home/boards") return Promise.resolve(response);
        return Promise.resolve(notificationSettings);
      }),
      patch: vi.fn(() => Promise.resolve({ push: { enabled: true }, pushEnabled: true })),
      request: vi.fn(() => Promise.resolve({})),
    };
    const notifications = {
      initialise: vi.fn(),
      items: signal([]),
      unreadCount: signal(0),
      boardUnreadCounts: signal<Record<string, number>>({}),
      includeRead: signal(false),
      online: signal(true),
      loading: signal(false),
      hasMore: signal(false),
      boardFilter: signal(null),
      userFilter: signal(null),
      loadFirstPage: vi.fn(() => Promise.resolve()),
      setIncludeRead: vi.fn(() => Promise.resolve()),
      setBoardFilter: vi.fn(() => Promise.resolve()),
      setUserFilter: vi.fn(() => Promise.resolve()),
      loadMore: vi.fn(() => Promise.resolve()),
      markRead: vi.fn(() => Promise.resolve()),
      markUnread: vi.fn(() => Promise.resolve()),
      markAllRead: vi.fn(() => Promise.resolve()),
      markBoardNotificationsRead: vi.fn(() => Promise.resolve()),
    };
    const workspaceService = {
      activeAccentColor: signal(null),
      notificationBoardOptions: signal([]),
      notificationUserOptions: signal([]),
      registerBoards: vi.fn(),
      upsertBoard: vi.fn(),
      removeBoard: vi.fn(),
      registerMembers: vi.fn(),
      upsertMember: vi.fn(),
      removeMember: vi.fn(),
      updateMemberProfile: vi.fn(),
      loadLists: vi.fn(() => Promise.resolve()),
      accentColorForWorkspace: vi.fn((workspaceId: string): string | null => options.workspaceAccents?.[workspaceId] ?? null),
      updateAccentColor: vi.fn(),
      removeWorkspace: vi.fn(),
    };
    const authUser = signal({
      id: "user-1",
      clientId: "client-1",
      email: "me@example.com",
      displayName: "Me User",
      avatarUrl: null,
      orgName: "Kanera",
      logoUrl: null,
      deploymentMode: "self_hosted" as const,
      hasWorkspace: true,
      role: "member",
      timezone: "UTC",
      ...options.user,
    });
    await TestBed.configureTestingModule({
      imports: [AppShellComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: Dialog, useValue: { open: vi.fn() } },
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: api,
        },
        {
          provide: AuthService,
          useValue: {
            user: authUser,
            updateUser: (update: (user: ReturnType<typeof authUser>) => ReturnType<typeof authUser>) => authUser.update(update),
            isOrgAdmin: signal(options.isOrgAdmin ?? false),
            maxBoards: signal(options.maxBoards ?? null),
            supportSession: signal(null),
            getAccessToken: vi.fn(() => "token"),
            broadcastLogout: vi.fn(),
            clearSession: vi.fn(),
          },
        },
        {
          provide: BrowserPushService,
          useValue: browserPush,
        },
        {
          provide: OfflineCacheService,
          useValue: {
            saveShell: vi.fn(() => Promise.resolve()),
            loadShell: vi.fn(() => Promise.resolve(null)),
            revokeBoardAccess: vi.fn(() => Promise.resolve()),
            clearAll: vi.fn(() => Promise.resolve()),
          },
        },
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(() => socket.asSocket()),
            joinWorkspace,
            joinBoard,
            disconnect: vi.fn(),
            displayedOnline: signal(true),
            reconnecting: signal(false),
            accessRefreshing: signal(false),
          },
        },
        {
          provide: UpdatesService,
          useValue: {
            updateAvailable: signal(false),
            applyUpdate: vi.fn(() => Promise.resolve()),
          },
        },
        {
          provide: NotificationsService,
          useValue: notifications,
        },
        { provide: ThemeService, useValue: { theme: signal("light") } },
        {
          provide: WorkspaceService,
          useValue: workspaceService,
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppShellComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { api, browserPush, authUser, notifications, socket, joinBoard, joinWorkspace, workspaceService };
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function search(value: string) {
    component.boardSearch.set(value);
    fixture.detectChanges();
  }

  function navContextLabels(): string[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(".nav-context-item"))
      .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "");
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { value: 1200, writable: true, configurable: true });
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    Object.defineProperty(window.navigator, "maxTouchPoints", { value: 0, configurable: true });
  });

  it("labels non-production API environments and hides production", async () => {
    await render(undefined, { user: { kaneraEnvironment: "development" } });
    expect((fixture.nativeElement as HTMLElement).querySelector(".dev-banner")?.textContent).toContain("Development");

    TestBed.resetTestingModule();
    await render(undefined, { user: { kaneraEnvironment: "staging" } });
    expect((fixture.nativeElement as HTMLElement).querySelector(".dev-banner")?.textContent).toContain("Staging");

    TestBed.resetTestingModule();
    await render(undefined, { user: { kaneraEnvironment: "production" } });
    expect((fixture.nativeElement as HTMLElement).querySelector(".dev-banner")).toBeNull();
  });

  it("opens global search from the find content button and omits the dedicated search nav item", async () => {
    await render();
    const open = vi.spyOn(component.search, "open");

    const dedicatedSearch = (fixture.nativeElement as HTMLElement).querySelector(".search-trigger");
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".board-search");

    expect(dedicatedSearch).toBeNull();
    expect(button?.textContent).toContain("Find content");
    expect(button?.textContent).toContain("⌘K");

    button?.click();

    expect(open).toHaveBeenCalledOnce();
  });

  it("shows Ctrl K for Windows users", async () => {
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", configurable: true });
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });

    await render();

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".board-search");
    expect(button?.textContent).toContain("Ctrl K");
    expect(button?.textContent).not.toContain("⌘K");
  });

  it("hides the shortcut hint for mobile users", async () => {
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile", configurable: true });
    Object.defineProperty(window.navigator, "platform", { value: "iPhone", configurable: true });

    await render();

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".board-search");
    expect(button?.textContent).toContain("Find content");
    expect(button?.querySelector(".search-kbd")).toBeNull();
  });

  it("filters boards case-insensitively and hides non-board workspace links while searching", async () => {
    await render();

    search("road");

    expect(text()).toContain("Roadmap");
    expect(text()).not.toContain("Hiring Plan");
    expect(text()).not.toContain("My Cards");
    expect(text()).not.toContain("Team Cards");
    expect(text()).not.toContain("Notes");
  });

  it("hides workspaces without matching boards", async () => {
    await render({
      groups: [
        group({ workspace: workspace({ id: "workspace-1", name: "Delivery" }) }),
        group({
          workspace: workspace({ id: "workspace-2", name: "Finance" }),
          boards: [board({ id: "board-3", workspaceId: "workspace-2", name: "Budget", position: "1000.0000000000" })],
        }),
      ],
      guestGroups: [],
      dueSoon: [], overdueChecklistItems: 0,
    });

    search("budget");

    expect(text()).toContain("Finance");
    expect(text()).toContain("Budget");
    expect(text()).not.toContain("Delivery");
    expect(text()).not.toContain("Roadmap");
  });

  it("renders guest boards in the sidebar when the user has no workspace access", async () => {
    await render({
      groups: [],
      guestGroups: [guestGroup()],
      dueSoon: [], overdueChecklistItems: 0,
    }, { user: { hasWorkspace: false } });

    const content = text();
    expect(content).toContain("Guest boards");
    expect(content).toContain("Client Delivery");
    expect(content).toContain("Client Co");
    expect(content).toContain("Shared Launch");
    expect(content).not.toContain("No workspaces yet");
    expect(content).not.toContain("No workspace access");
    expect(fixture.nativeElement.querySelector(".guest-ws-group .ws-subhead-toggle")).toBeNull();
  });

  it("renders a standalone guest board without duplicating its backing workspace", async () => {
    const standaloneWorkspace = workspace({
      id: "guest-standalone-workspace-1",
      clientId: "client-2",
      name: "Shared solo board",
      kind: "board",
      role: "guest",
    });
    await render({
      groups: [],
      guestGroups: [guestGroup({
        workspace: standaloneWorkspace,
        boards: [{
          ...board({ id: "guest-standalone-board-1", workspaceId: standaloneWorkspace.id, name: "Shared solo board" }),
          myCards: 0,
          myOverdue: 0,
        }],
      })],
      dueSoon: [], overdueChecklistItems: 0,
    }, { user: { hasWorkspace: false } });

    const standaloneGuest = fixture.nativeElement.querySelector(".guest-standalone-board-group") as HTMLElement | null;
    expect(standaloneGuest?.querySelector(".nav-label")?.textContent?.trim()).toBe("Shared solo board");
    expect(standaloneGuest?.querySelector(".guest-chip")).toBeNull();
    expect(fixture.nativeElement.querySelector(".guest-org-toggle")?.textContent).toContain("Client Co");
    expect(fixture.nativeElement.querySelector(".guest-ws-group")).toBeNull();
  });

  it("groups mixed guest navigation by host organisation and sorts containers alphabetically", async () => {
    const standard = guestGroup({
      workspace: workspace({ id: "guest-standard", clientId: "client-z", name: "Beta workspace", role: "guest" }),
      clientName: "Zeta Org",
      boardGroups: [boardGroup({ id: "guest-board-group", workspaceId: "guest-standard", title: "Delivery boards" })],
      boards: [{ ...board({ id: "standard-board", workspaceId: "guest-standard", groupId: "guest-board-group", name: "Team board" }), myCards: 0, myOverdue: 0 }],
    });
    const standaloneWorkspace = workspace({ id: "guest-solo", clientId: "client-z", name: "Solo config", kind: "board", role: "guest" });
    await render({
      groups: [],
      guestGroups: [standard, guestGroup({
        workspace: standaloneWorkspace,
        clientName: "Zeta Org",
        boards: [{ ...board({ id: "solo-board", workspaceId: standaloneWorkspace.id, name: "Launch", iconColor: "blue", standaloneGroupId: "standalone-group-a" }), myCards: 0, myOverdue: 0 }],
      }), guestGroup({
        workspace: workspace({ id: "alpha-solo", clientId: "client-a", name: "Other solo", kind: "board", role: "guest" }),
        clientName: "Alpha Org",
        boards: [{ ...board({ id: "alpha-board", workspaceId: "alpha-solo", name: "Direct", iconColor: "orange" }), myCards: 0, myOverdue: 0 }],
      })],
      standaloneBoardGroups: [{ id: "standalone-group-a", clientId: "client-z", title: "Alpha group", createdAt: new Date(), updatedAt: new Date() }],
      dueSoon: [], overdueChecklistItems: 0,
    }, { user: { hasWorkspace: false }, workspaceAccents: { "guest-standard": "teal" } });

    const orgs = [...fixture.nativeElement.querySelectorAll(".guest-org-group")] as HTMLElement[];
    expect(orgs.map((org) => org.querySelector(".guest-org-toggle")?.textContent?.trim())).toEqual(["Alpha Org", "Zeta Org"]);
    expect(orgs.every((org) => org.querySelector(".guest-org-toggle .ws-icon") === null)).toBe(true);
    expect(orgs.every((org) => org.querySelector(".guest-org-toggle")?.parentElement?.classList.contains("ws-row"))).toBe(true);
    expect(orgs.every((org) => org.querySelector(":scope > .guest-org-contents") !== null)).toBe(true);
    const zetaText = orgs[1]!.textContent ?? "";
    expect(zetaText.indexOf("Alpha group")).toBeLessThan(zetaText.indexOf("Beta workspace"));
    expect(zetaText).toContain("Launch");
    expect(zetaText).toContain("Team board");
    expect(orgs[1]!.querySelector(".guest-chip")).toBeNull();
    expect(orgs[0]!.querySelector('.guest-org-direct-boards a[href="/b/alpha-board"]')).not.toBeNull();
    expect(orgs[1]!.querySelector('.guest-container-content > a[href="/b/solo-board"] i')?.getAttribute("style")).toContain("var(--color-blue)");
    expect(orgs[1]!.querySelector('.nested-board-group a[href="/b/standard-board"] i')?.getAttribute("style")).toContain("var(--color-teal)");
    expect(orgs[1]!.querySelector(".nested-board-group")).not.toBeNull();
  });

  it("regroups standalone boards idempotently from group metadata then full board updates", async () => {
    const soloWorkspace = workspace({ id: "solo-workspace", kind: "board", name: "Solo", role: "admin" });
    const soloBoard = board({ id: "solo-board", workspaceId: soloWorkspace.id, name: "Zulu" });
    const { socket } = await render({ groups: [group({ workspace: soloWorkspace, boards: [soloBoard], members: [] })], guestGroups: [], standaloneBoardGroups: [], dueSoon: [], overdueChecklistItems: 0 });
    expect(component.ownUngroupedStandaloneBoards().map((item) => item.board.id)).toEqual([soloBoard.id]);

    const metadata = { id: "solo-group", clientId: soloWorkspace.clientId, title: "Alpha", createdAt: new Date(), updatedAt: new Date() };
    socket.emitServer("standaloneBoardGroup:upserted", { group: metadata });
    socket.emitServer("standaloneBoardGroup:upserted", { group: metadata });
    socket.emitServer("board:updated", { board: { ...soloBoard, standaloneGroupId: metadata.id } });
    fixture.detectChanges();

    expect(component.standaloneBoardGroups()).toHaveLength(1);
    expect(component.ownStandaloneBoardGroups().map((group) => [group.title, group.boards.map((item) => item.board.id)])).toEqual([["Alpha", [soloBoard.id]]]);
    expect(component.ownUngroupedStandaloneBoards()).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).querySelector('a[href="/b/solo-board/settings"]')).not.toBeNull();
    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/b/solo-board"]')!;
    expect(boardLink.closest(".standalone-board-row")).not.toBeNull();
    boardLink.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 18 }));
    expect(component.navContextMenu()).toMatchObject({ label: "Zulu", url: "/b/solo-board", canMarkAllRead: true });
  });

  it("refreshes sidebar guest boards when the current user is added to a board", async () => {
    const initial: HomeResponse = {
      groups: [],
      guestGroups: [guestGroup()],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const refreshed: HomeResponse = {
      groups: [],
      guestGroups: [guestGroup({ boards: [
        { ...board({ id: "guest-board-1", workspaceId: "guest-workspace-1", name: "Shared Launch", position: "1000.0000000000" }), myCards: 0, myOverdue: 0 },
        { ...board({ id: "guest-board-2", workspaceId: "guest-workspace-1", name: "Second Board", position: "2000.0000000000" }), myCards: 0, myOverdue: 0 },
      ] })],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const { api, socket, joinBoard, workspaceService } = await render(initial, { user: { hasWorkspace: false } });
    api.get.mockImplementation((path: string) => {
      if (path === "/home/boards") return Promise.resolve(refreshed);
      return Promise.resolve({ push: { enabled: false }, pushEnabled: false });
    });

    socket.emitServer("board:member:added", {
      boardId: "guest-board-2",
      member: { boardId: "guest-board-2", userId: "user-1", role: "editor", addedAt: new Date() },
      user: { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "board" },
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(joinBoard).toHaveBeenCalledWith("guest-board-2");
    expect(text()).toContain("Second Board");
    expect(workspaceService.registerBoards).toHaveBeenCalledWith(
      "guest-workspace-1",
      expect.arrayContaining([expect.objectContaining({ id: "guest-board-2", name: "Second Board" })]),
      null,
    );
  });

  it("applies profile updates to the current session and workspace member caches", async () => {
    const { authUser, socket, workspaceService } = await render();

    socket.emitServer("user:profile:updated", {
      userId: "user-1",
      displayName: "Updated Me",
      avatarUrl: "/avatars/me-new.jpg",
    });

    expect(authUser()).toEqual(expect.objectContaining({ displayName: "Updated Me", avatarUrl: "/avatars/me-new.jpg" }));
    expect(workspaceService.updateMemberProfile).toHaveBeenCalledWith("user-1", "Updated Me", "/avatars/me-new.jpg");
  });

  it("joins and refreshes when the current user is added to a workspace", async () => {
    const initial: HomeResponse = {
      groups: [],
      guestGroups: [],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const refreshed: HomeResponse = {
      groups: [group({
        workspace: workspace({ id: "workspace-2", name: "New Workspace", role: "member" }),
        boards: [board({ id: "board-3", workspaceId: "workspace-2", name: "New Board", position: "1000.0000000000" })],
        members: [{ userId: "user-1", displayName: "Me User", avatarUrl: null, role: "member" }],
      })],
      guestGroups: [],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const { api, authUser, socket, joinWorkspace, workspaceService } = await render(initial, { user: { hasWorkspace: false } });
    api.get.mockImplementation((path: string) => {
      if (path === "/home/boards") return Promise.resolve(refreshed);
      return Promise.resolve({ push: { enabled: false }, pushEnabled: false });
    });

    socket.emitServer("workspace:member:added", {
      workspaceId: "workspace-2",
      member: {
        workspaceId: "workspace-2",
        userId: "user-1",
        role: "member",
        displayName: "Me User",
        avatarUrl: null,
        addedAt: new Date(),
      },
    });
    await fixture.whenStable();
    await vi.waitFor(() => expect(authUser()?.hasWorkspace).toBe(true));
    fixture.detectChanges();

    expect(joinWorkspace).toHaveBeenCalledWith("workspace-2");
    expect(text()).toContain("New Workspace");
    expect(text()).toContain("New Board");
    expect(workspaceService.registerBoards).toHaveBeenCalledWith(
      "workspace-2",
      expect.arrayContaining([expect.objectContaining({ id: "board-3", name: "New Board" })]),
      null,
    );
    expect(workspaceService.registerMembers).toHaveBeenCalledWith(
      "workspace-2",
      expect.arrayContaining([expect.objectContaining({ userId: "user-1", displayName: "Me User" })]),
    );
  });

  it("does not count a standalone board membership as onboarding workspace access", async () => {
    const initial: HomeResponse = { groups: [], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 };
    const refreshed: HomeResponse = {
      groups: [group({
        workspace: workspace({ id: "standalone-workspace-1", name: "Solo", kind: "board", role: "admin" }),
        boards: [board({ id: "standalone-board-1", workspaceId: "standalone-workspace-1", name: "Solo" })],
      })],
      guestGroups: [],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const { api, authUser, socket } = await render(initial, { user: { hasWorkspace: false } });
    api.get.mockImplementation((path: string) => {
      if (path === "/home/boards") return Promise.resolve(refreshed);
      return Promise.resolve({ push: { enabled: false }, pushEnabled: false });
    });

    socket.emitServer("workspace:member:added", {
      workspaceId: "standalone-workspace-1",
      member: {
        workspaceId: "standalone-workspace-1",
        userId: "user-1",
        role: "admin",
        displayName: "Me User",
        avatarUrl: null,
        addedAt: new Date(),
      },
    });
    await fixture.whenStable();
    await vi.waitFor(() => expect(component.standaloneGroups()).toHaveLength(1));

    expect(authUser()?.hasWorkspace).toBe(false);
  });

  it("keeps shared board filter options in sync with board realtime events", async () => {
    const { socket, workspaceService } = await render();

    socket.emitServer("board:created", {
      workspaceId: "workspace-1",
      board: board({ id: "board-3", name: "Automation", icon: "bolt", iconColor: "teal" }),
    });
    socket.emitServer("board:updated", {
      board: board({ id: "board-3", name: "Automation Ops", icon: "settings", iconColor: "blue" }),
    });
    socket.emitServer("board:updated", {
      board: board({ id: "board-3", name: "Automation Ops", archivedAt: new Date("2026-05-22T00:00:00.000Z") }),
    });
    socket.emitServer("board:created", {
      workspaceId: "workspace-1",
      board: board({ id: "board-4", name: "Archived Automation", archivedAt: new Date("2026-05-22T00:00:00.000Z") }),
    });
    socket.emitServer("board:deleted", { boardId: "board-3" });

    expect(workspaceService.upsertBoard).toHaveBeenCalledWith("workspace-1", {
      id: "board-3",
      name: "Automation",
      icon: "bolt",
      iconColor: "teal",
    });
    expect(workspaceService.upsertBoard).toHaveBeenCalledWith("workspace-1", {
      id: "board-3",
      name: "Automation Ops",
      icon: "settings",
      iconColor: "blue",
    });
    expect(workspaceService.upsertBoard).not.toHaveBeenCalledWith("workspace-1", expect.objectContaining({ id: "board-4" }));
    expect(workspaceService.removeBoard).toHaveBeenCalledWith("board-3");
  });

  it("keeps standalone groups split and live through board and workspace events", async () => {
    const standaloneWorkspace = workspace({
      id: "standalone-workspace-1",
      name: "Solo board",
      kind: "board",
      role: "admin",
    });
    const standaloneBoard = board({
      id: "standalone-board-1",
      workspaceId: standaloneWorkspace.id,
      name: "Solo board",
    });
    const { socket } = await render({
      groups: [
        group(),
        group({ workspace: standaloneWorkspace, boards: [standaloneBoard], members: [] }),
      ],
      guestGroups: [],
      dueSoon: [],
      overdueChecklistItems: 0,
    });

    expect(component.standardGroups().map((item) => item.workspace.id)).toEqual(["workspace-1"]);
    expect(component.standaloneGroups().map((item) => item.workspace.id)).toEqual(["standalone-workspace-1"]);
    const standaloneSection = (fixture.nativeElement as HTMLElement).querySelector(".standalone-board-group");
    expect(standaloneSection?.textContent).toContain("Solo board");
    expect(standaloneSection?.textContent).not.toContain("My Cards");
    expect(standaloneSection?.textContent).not.toContain("Notes");

    socket.emitServer("board:updated", { board: { ...standaloneBoard, name: "Solo renamed" } });
    fixture.detectChanges();
    expect(text()).toContain("Solo renamed");

    socket.emitServer("board:deleted", { workspaceId: standaloneWorkspace.id, boardId: standaloneBoard.id });
    fixture.detectChanges();
    expect(text()).not.toContain("Solo renamed");

    socket.emitServer("workspace:deleted", { workspaceId: standaloneWorkspace.id });
    fixture.detectChanges();
    expect(component.standaloneGroups()).toHaveLength(0);
  });

  it("removes a same-org board from navigation when the current user's membership is revoked", async () => {
    const { socket, workspaceService } = await render({ groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 });
    expect(text()).toContain("Roadmap");

    socket.emitServer("board:member:removed", { boardId: "board-1", userId: "user-1" });
    fixture.detectChanges();

    expect(text()).not.toContain("Roadmap");
    expect(workspaceService.removeBoard).toHaveBeenCalledWith("board-1");
  });

  it("refreshes navigation and workspace controls when my workspace role changes", async () => {
    const initial = { groups: [group({ workspace: workspace({ role: "member" }), boards: [board({ id: "board-1" })] })], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 };
    const promoted = { groups: [group({ workspace: workspace({ role: "admin" }) })], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 };
    const { api, socket } = await render(initial);
    api.get.mockResolvedValueOnce(promoted);

    socket.emitServer("workspace:member:updated", {
      workspaceId: "workspace-1",
      member: { workspaceId: "workspace-1", userId: "user-1", role: "admin", addedAt: new Date() },
    });
    await vi.waitFor(() => expect(component.groups()[0]?.boards).toHaveLength(2));

    expect(component.groups()[0]?.workspace.role).toBe("admin");
    expect(component.canManageWorkspace(component.groups()[0]!.workspace)).toBe(true);
  });

  it("rejoins when a current-user workspace add arrives for an already listed workspace", async () => {
    const existingGroup = group({ workspace: workspace({ id: "workspace-2", name: "Existing Workspace", role: "member" }) });
    const response: HomeResponse = {
      groups: [existingGroup],
      guestGroups: [],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const { api, socket, joinWorkspace } = await render(response);
    api.get.mockResolvedValueOnce(response);
    joinWorkspace.mockClear();

    socket.emitServer("workspace:member:added", {
      workspaceId: "workspace-2",
      member: {
        workspaceId: "workspace-2",
        userId: "user-1",
        role: "member",
        displayName: "Me User",
        avatarUrl: null,
        addedAt: new Date(),
      },
    });
    await fixture.whenStable();

    expect(joinWorkspace).toHaveBeenCalledWith("workspace-2");
    expect(api.get).toHaveBeenCalledWith("/home/boards");
  });

  it("shows board-limit feedback instead of opening onboarding from the sidebar", async () => {
    await render(undefined, { isOrgAdmin: true, maxBoards: 2 });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigateByUrl");

    component.newWorkspace();
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
    expect(text()).toContain("Your plan allows 2 boards");
  });

  it("finds matching guest boards from the sidebar search", async () => {
    await render({
      groups: [group()],
      guestGroups: [guestGroup()],
      dueSoon: [], overdueChecklistItems: 0,
    });

    search("shared");

    expect(text()).toContain("Shared Launch");
    expect(text()).not.toContain("Roadmap");
  });

  it("shows matching boards while workspace and board sections are collapsed", async () => {
    await render();
    component.collapsed.set({ "workspace-1": true });
    component.boardsCollapsed.set({ "workspace-1": true });
    fixture.detectChanges();

    expect(text()).not.toContain("Roadmap");

    search("road");

    expect(text()).toContain("Roadmap");
  });

  it("renders grouped boards under group titles and ungrouped boards as plain links", async () => {
    await render({
      groups: [
        group({
          boardGroups: [boardGroup({ id: "group-1", title: "Product" })],
          boards: [
            board({ id: "board-1", name: "Roadmap", groupId: "group-1", position: "1000.0000000000" }),
            board({ id: "board-2", name: "Hiring Plan", groupId: null, position: "2000.0000000000" }),
          ],
        }),
      ],
      guestGroups: [],
      dueSoon: [], overdueChecklistItems: 0,
    });

    const content = text();
    expect(content).toContain("Product");
    expect(content).toContain("Roadmap");
    expect(content).not.toContain("Ungrouped");
    expect(content).toContain("Hiring Plan");
    expect(content.indexOf("Product")).toBeLessThan(content.indexOf("Hiring Plan"));
  });

  it("uses the expanded nav board order when the sidebar is collapsed", async () => {
    await render({
      groups: [
        group({
          boardGroups: [
            boardGroup({ id: "group-1", title: "Product", position: "1000.0000000000" }),
            boardGroup({ id: "group-2", title: "Ops", position: "2000.0000000000" }),
          ],
          boards: [
            board({ id: "board-1", name: "Ungrouped early", groupId: null, position: "0500.0000000000" }),
            board({ id: "board-2", name: "Product A", groupId: "group-1", position: "1000.0000000000" }),
            board({ id: "board-3", name: "Ops A", groupId: "group-2", position: "1500.0000000000" }),
            board({ id: "board-4", name: "Product B", groupId: "group-1", position: "2000.0000000000" }),
          ],
        }),
      ],
      guestGroups: [],
      dueSoon: [], overdueChecklistItems: 0,
    });

    expect(component.collapsedBoardLinks(component.groups()[0]!).map((b) => b.name)).toEqual([
      "Product A",
      "Product B",
      "Ops A",
      "Ungrouped early",
    ]);
  });

  it("keeps search matches under their group titles", async () => {
    await render({
      groups: [
        group({
          boardGroups: [boardGroup({ id: "group-1", title: "Product" })],
          boards: [
            board({ id: "board-1", name: "Roadmap", groupId: "group-1", position: "1000.0000000000" }),
            board({ id: "board-2", name: "Hiring Plan", groupId: null, position: "2000.0000000000" }),
          ],
        }),
      ],
      guestGroups: [],
      dueSoon: [], overdueChecklistItems: 0,
    });

    search("road");

    expect(text()).toContain("Product");
    expect(text()).toContain("Roadmap");
    expect(text()).not.toContain("Ungrouped");
    expect(text()).not.toContain("Hiring Plan");
  });

  it("clears search after navigating to a board", async () => {
    await render();
    search("road");

    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/b/board-1"]');
    boardLink?.addEventListener("click", (event) => event.preventDefault(), { capture: true, once: true });
    boardLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
    fixture.detectChanges();

    expect(component.boardSearch()).toBe("");
    expect(text()).toContain("Hiring Plan");
  });

  it("shows an empty state when no board matches", async () => {
    await render();

    search("not here");

    expect(text()).toContain("No boards found");
    expect(text()).not.toContain("Roadmap");
  });

  it("shows board attention counts in the expanded sidebar", async () => {
    const { notifications } = await render({
      groups: [group({
        boards: [
          board({ id: "board-1", name: "Roadmap", iconColor: "red", position: "1000.0000000000" }),
          board({ id: "board-2", name: "Hiring Plan", position: "2000.0000000000" }),
        ],
      })],
      guestGroups: [],
      dueSoon: [], overdueChecklistItems: 0,
    });

    notifications.boardUnreadCounts.set({ "board-1": 3 });
    fixture.detectChanges();

    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/b/board-1"]');
    expect(boardLink?.textContent).toContain("Roadmap");
    expect(boardLink?.textContent).toContain("3");
    expect(boardLink?.getAttribute("aria-label")).toBe("Roadmap, 3 unread cards needing attention");
    expect(boardLink?.style.getPropertyValue("--board-attention-color")).toBe("var(--color-red)");
  });

  it("shows a board attention dot in the collapsed sidebar", async () => {
    localStorage.setItem(STORAGE_KEYS.SIDEBAR_COLLAPSED, "1");
    const { notifications } = await render();

    notifications.boardUnreadCounts.set({ "board-1": 1 });
    fixture.detectChanges();

    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/b/board-1"]');
    expect(boardLink?.querySelector(".board-attention-dot")).toBeTruthy();
    expect(boardLink?.querySelector(".board-attention-count")).toBeTruthy();
    expect(boardLink?.getAttribute("aria-label")).toBe("Roadmap, 1 unread card needing attention");
  });

  it("shows only open actions when right-clicking Home", async () => {
    await render();

    const homeLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(".nav .nav-item");
    homeLink?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 96, clientY: 44 }));
    fixture.detectChanges();

    const menu = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".nav-context-menu");
    expect(menu).toBeTruthy();
    expect(navContextLabels()).toEqual(["Open in new tab"]);
    expect(component.navContextMenu()).toEqual(expect.objectContaining({ label: "Home", url: "/", canMarkAllRead: false, isCurrentTarget: true }));
  });

  it("shows all nav context actions when right-clicking a board", async () => {
    await render();

    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/b/board-1"]');
    boardLink?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    fixture.detectChanges();

    expect(navContextLabels()).toEqual(["Open", "Open in new tab", "Mark all as read"]);
    expect(component.navContextMenu()).toEqual(expect.objectContaining({ label: "Roadmap", url: "/b/board-1", canMarkAllRead: true }));
  });

  it("hides Open when right-clicking the current nav target", async () => {
    await render();
    const router = TestBed.inject(Router);
    Object.defineProperty(router, "url", { value: "/b/board-1?cardId=card-1", configurable: true });

    const boardLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/b/board-1"]');
    boardLink?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    fixture.detectChanges();

    expect(navContextLabels()).toEqual(["Open in new tab", "Mark all as read"]);
    expect(component.navContextMenu()).toEqual(expect.objectContaining({ url: "/b/board-1", isCurrentTarget: true }));
  });

  it("shows only open actions when right-clicking workspace settings", async () => {
    await render(undefined, { isOrgAdmin: true });

    const settingsLink = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/w/workspace-1/settings"]');
    settingsLink?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    fixture.detectChanges();

    expect(navContextLabels()).toEqual(["Open", "Open in new tab"]);
    expect(component.navContextMenu()).toEqual(expect.objectContaining({ url: "/w/workspace-1/settings", canMarkAllRead: false }));
  });

  it("shows only open actions when right-clicking workspace view links", async () => {
    await render(undefined, { isOrgAdmin: true });

    for (const href of ["/w/workspace-1/u/user-1", "/w/workspace-1/team", "/w/workspace-1/notes"]) {
      const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
      link?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
      fixture.detectChanges();

      expect(navContextLabels()).toEqual(["Open", "Open in new tab"]);
      expect(component.navContextMenu()).toEqual(expect.objectContaining({ url: href, canMarkAllRead: false }));
      component.closeNavContextMenu();
      fixture.detectChanges();
    }
  });

  it("shows only open actions when right-clicking the new workspace button", async () => {
    await render(undefined, { isOrgAdmin: true });

    const newWorkspaceButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".new-ws-btn");
    newWorkspaceButton?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
    fixture.detectChanges();

    expect(navContextLabels()).toEqual(["Open", "Open in new tab"]);
    expect(component.navContextMenu()).toEqual(expect.objectContaining({ label: "New workspace", url: "/onboarding?mode=workspace", canMarkAllRead: false }));
  });

  it("opens a nav context target in the current tab", async () => {
    await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigateByUrl").mockResolvedValue(true);
    component.boardSearch.set("road");
    component.openNavContextMenu(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), {
      label: "Roadmap",
      url: "/b/board-1",
      canMarkAllRead: true,
      clearBoardSearch: true,
    });

    await component.openNavContextTarget();

    expect(navigate).toHaveBeenCalledWith("/b/board-1");
    expect(component.boardSearch()).toBe("");
    expect(component.navContextMenu()).toBeNull();
  });

  it("opens a nav context target in a new tab", async () => {
    await render();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    component.openNavContextMenu(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), {
      label: "Roadmap",
      url: "/b/board-1",
      canMarkAllRead: true,
      clearBoardSearch: true,
    });

    component.openNavContextTargetInNewTab();

    expect(open).toHaveBeenCalledWith("/b/board-1", "_blank", "noopener");
    expect(component.navContextMenu()).toBeNull();
    open.mockRestore();
  });

  it("marks notifications read from the nav context menu", async () => {
    const { notifications } = await render();
    component.openNavContextMenu(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), {
      label: "Roadmap",
      url: "/b/board-1",
      canMarkAllRead: true,
      clearBoardSearch: true,
    });

    await component.markAllNavContextRead();

    expect(notifications.markBoardNotificationsRead).toHaveBeenCalledWith("board-1");
    expect(notifications.markAllRead).not.toHaveBeenCalled();
    expect(component.navContextMenu()).toBeNull();
  });

  it("closes the nav context menu on Escape and outside clicks", async () => {
    await render();
    component.openNavContextMenu(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), {
      label: "Roadmap",
      url: "/b/board-1",
      canMarkAllRead: true,
      clearBoardSearch: true,
    });

    component.onEscape();
    expect(component.navContextMenu()).toBeNull();

    component.openNavContextMenu(new MouseEvent("contextmenu", { clientX: 120, clientY: 80 }), {
      label: "Roadmap",
      url: "/b/board-1",
      canMarkAllRead: true,
      clearBoardSearch: true,
    });
    fixture.detectChanges();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(component.navContextMenu()).toBeNull();
  });

  it("does not render the board search in the collapsed sidebar", async () => {
    localStorage.setItem(STORAGE_KEYS.SIDEBAR_COLLAPSED, "1");
    await render();

    expect((fixture.nativeElement as HTMLElement).querySelector(".board-search")).toBeNull();
  });

  it("hides the organisation logo block when the logo cannot load", async () => {
    await render(undefined, { user: { logoUrl: "/missing-logo.png" } });

    const image = (fixture.nativeElement as HTMLElement).querySelector<HTMLImageElement>(".org-logo-block img");
    expect(image).toBeTruthy();

    image!.dispatchEvent(new Event("error"));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".org-logo-block")).toBeNull();
  });

  it("shows the organisation logo block again when the logo URL changes", async () => {
    const { authUser } = await render(undefined, { user: { logoUrl: "/missing-logo.png" } });

    const image = (fixture.nativeElement as HTMLElement).querySelector<HTMLImageElement>(".org-logo-block img");
    image!.dispatchEvent(new Event("error"));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector(".org-logo-block")).toBeNull();

    authUser.update((user) => ({ ...user, logoUrl: "/new-logo.png" }));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".org-logo-block")).toBeTruthy();
  });

  it("shows Account Plan in the user popover for hosted admins", async () => {
    await render(undefined, { isOrgAdmin: true, user: { deploymentMode: "hosted", role: "admin" } });

    component.userMenuOpen.set(true);
    fixture.detectChanges();

    const link = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>(".user-popover .popover-item"))
      .find((candidate) => candidate.textContent?.trim().toLocaleLowerCase() === "account plan");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/settings/account-plan");
  });

  it("hides Account Plan in the user popover for hosted members", async () => {
    await render(undefined, { isOrgAdmin: false, user: { deploymentMode: "hosted", role: "member" } });

    component.userMenuOpen.set(true);
    fixture.detectChanges();

    expect(text().toLocaleLowerCase()).not.toContain("account plan");
  });

  it("hides Account Plan in the user popover for self-hosted admins", async () => {
    await render(undefined, { isOrgAdmin: true, user: { deploymentMode: "self_hosted", role: "admin" } });

    component.userMenuOpen.set(true);
    fixture.detectChanges();

    expect(text().toLocaleLowerCase()).not.toContain("account plan");
  });

  it("asks for browser push and enables the user preference when org push is enabled", async () => {
    const { api, browserPush } = await render(
      { groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 },
      {
        notificationSettings: { push: { enabled: true }, pushEnabled: false },
        browserPush: { unsupportedReason: signal(null) },
      },
    );

    expect(browserPush.initialise).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(browserPush.subscribe).toHaveBeenCalled());
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledWith("/notifications/settings", { pushEnabled: true }));
  });
});
