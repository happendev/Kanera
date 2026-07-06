import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import type { BoardGroup, Workspace } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { GuestHomeGroup, HomeBoardWithStats, HomeGroup, HomeResponse } from "../../core/offline/offline-cache.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { HomePage } from "./home.page";

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
    icon: null,
    accentColor: null,
    completedCardsActiveDays: 35,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    archivedAt: null,
    role: "owner",
    ...overrides,
  };
}

function board(overrides: Partial<HomeBoardWithStats> = {}): HomeBoardWithStats {
  return {
    id: "board-1",
    workspaceId: "workspace-1",
    groupId: null,
    name: "Roadmap",
    icon: null,
    iconColor: null,
    backgroundGradient: null,
    position: "1000.0000000000",
    myCards: 0,
    myOverdue: 0,
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
    members: [],
    ...overrides,
  };
}

function guestGroup(overrides: Partial<GuestHomeGroup> = {}): GuestHomeGroup {
  const ws = overrides.workspace ?? workspace({ id: "guest-workspace-1", clientId: "client-2", name: "Client Delivery", role: "guest" });
  return {
    workspace: ws,
    clientName: "Client Co",
    boardGroups: [],
    boards: [board({ id: "guest-board-1", workspaceId: ws.id, name: "Shared Launch", position: "1000.0000000000" })],
    ...overrides,
  };
}

describe("HomePage", () => {
  let fixture: ComponentFixture<HomePage>;
  let notifications: { boardUnreadCounts: ReturnType<typeof signal<Record<string, number>>> };

  async function render(
    response: HomeResponse = { groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 },
    auth: { entitlements?: unknown; isOrgAdmin?: boolean } = {},
  ) {
    notifications = { boardUnreadCounts: signal<Record<string, number>>({}) };
    const socket = new SocketStub();
    const joinBoard = vi.fn(() => vi.fn());
    const api = {
      get: vi.fn((path: string) => {
        if (path === "/home/boards") return Promise.resolve(response);
        return Promise.resolve({});
      }),
    };
    await TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        {
          provide: AuthService,
          useValue: {
            user: signal({ id: "user-1", displayName: "Me User" }),
            isOrgAdmin: signal(auth.isOrgAdmin ?? false),
            entitlements: signal(auth.entitlements ?? null),
            maxBoards: signal((auth.entitlements as { maxBoards?: number | null } | undefined)?.maxBoards ?? null),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        provideRouter([]),
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), joinWorkspace: vi.fn(() => vi.fn()), joinBoard, displayedOnline: signal(true), reconnecting: signal(false), accessRefreshing: signal(false) } },
        { provide: WorkspaceService, useValue: { registerBoards: vi.fn(), registerMembers: vi.fn(), accentColorForWorkspace: vi.fn(() => null), updateAccentColor: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { api, socket, joinBoard };
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? "";
  }

  it("renders recent boards from local storage and ignores inaccessible ids", async () => {
    localStorage.setItem(STORAGE_KEYS.RECENT_BOARDS, JSON.stringify(["missing-board", "board-2", "board-1"]));

    await render();

    const content = text();
    expect(content).toContain("Recently viewed");
    expect(content).toContain("Hiring Plan");
    expect(content).toContain("Roadmap");
    expect(content).not.toContain("missing-board");
    expect(content.indexOf("Hiring Plan")).toBeLessThan(content.indexOf("Roadmap"));
  });

  it("uses unread notification counts for recent, workspace, and guest board attention", async () => {
    localStorage.setItem(STORAGE_KEYS.RECENT_BOARDS, JSON.stringify(["guest-board-1", "board-1"]));
    await render({ groups: [group()], guestGroups: [guestGroup()], dueSoon: [], overdueChecklistItems: 0 });

    notifications.boardUnreadCounts.set({ "board-1": 3, "guest-board-1": 1 });
    fixture.detectChanges();

    const content = text();
    expect(content).toContain("3 unread");
    expect(content).toContain("1 unread");
    expect(content).not.toContain("new");
    expect((fixture.nativeElement as HTMLElement).querySelectorAll(".unread-dot").length).toBe(2);
  });

  it("refreshes guest boards when the current user is added to a board", async () => {
    const initial: HomeResponse = { groups: [], guestGroups: [guestGroup()], dueSoon: [], overdueChecklistItems: 0 };
    const refreshed: HomeResponse = {
      groups: [],
      guestGroups: [guestGroup({ boards: [
        board({ id: "guest-board-1", workspaceId: "guest-workspace-1", name: "Shared Launch", position: "1000.0000000000" }),
        board({ id: "guest-board-2", workspaceId: "guest-workspace-1", name: "Second Board", position: "2000.0000000000" }),
      ] })],
      dueSoon: [],
      overdueChecklistItems: 0,
    };
    const { api, socket, joinBoard } = await render(initial);
    api.get.mockResolvedValueOnce(refreshed);

    socket.emitServer("board:member:added", {
      boardId: "guest-board-2",
      member: { boardId: "guest-board-2", userId: "user-1", role: "editor", addedAt: new Date() },
      user: { userId: "user-1", displayName: "Me User", avatarUrl: null, role: "editor", source: "board" },
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(joinBoard).toHaveBeenCalledWith("guest-board-2");
    expect(text()).toContain("Second Board");
  });

  it("removes a same-org board when the current user's membership is revoked", async () => {
    const { socket } = await render({ groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 });
    expect(text()).toContain("Roadmap");

    socket.emitServer("board:member:removed", { boardId: "board-1", userId: "user-1" });
    fixture.detectChanges();

    expect(text()).not.toContain("Roadmap");
  });

  it("refreshes all workspace boards when the current user's workspace role changes", async () => {
    const initial: HomeResponse = { groups: [group({ boards: [board({ id: "board-1", name: "Roadmap" })] })], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 };
    const refreshed: HomeResponse = { groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 };
    const { api, socket } = await render(initial);
    api.get.mockResolvedValueOnce(refreshed);

    socket.emitServer("workspace:member:updated", {
      workspaceId: "workspace-1",
      member: { workspaceId: "workspace-1", userId: "user-1", role: "admin", addedAt: new Date() },
    });
    await vi.waitFor(() => expect(text()).toContain("Hiring Plan"));
  });

  it("groups home boards when board groups exist", async () => {
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
    expect(content).toContain("Hiring Plan");
    expect(content).not.toContain("Ungrouped");
    expect(content.indexOf("Product")).toBeLessThan(content.indexOf("Roadmap"));
    expect(content.indexOf("Roadmap")).toBeLessThan(content.indexOf("Hiring Plan"));
  });

  it("keeps home boards flat when no board groups exist", async () => {
    await render();

    expect(text()).toContain("Roadmap");
    expect(text()).toContain("Hiring Plan");
    expect((fixture.nativeElement as HTMLElement).querySelector(".home-board-group-title")).toBeNull();
  });

  it("shows the trial banner with days left when the org is on a trial", async () => {
    const trialEndsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await render({ groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 }, { entitlements: { tier: "trial", trialEndsAt }, isOrgAdmin: true });

    const content = text();
    expect((fixture.nativeElement as HTMLElement).querySelector(".trial-banner")).not.toBeNull();
    expect(content).toContain("free 30-day trial");
    expect(content).toContain("Delivery workspace");
    expect(content).toContain("5 days left");
    expect((fixture.nativeElement as HTMLElement).querySelector(".trial-banner-action")?.getAttribute("href")).toBe("/settings/account-plan");
  });

  it("hides the trial banner for non-trial orgs", async () => {
    await render({ groups: [group()], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 }, { entitlements: { tier: "paid", trialEndsAt: null } });

    expect((fixture.nativeElement as HTMLElement).querySelector(".trial-banner")).toBeNull();
  });

  it("shows board-limit feedback instead of opening onboarding from the empty workspace state", async () => {
    await render(
      { groups: [], guestGroups: [], dueSoon: [], overdueChecklistItems: 0 },
      { entitlements: { maxBoards: 0 }, isOrgAdmin: true },
    );
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigateByUrl");

    fixture.componentInstance.newWorkspace();
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
    expect(text()).toContain("Your plan allows 0 boards");
  });
});
