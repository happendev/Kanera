import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { SocketService } from "../../core/realtime/socket.service";
import { ConfirmService } from "../../shared/confirm.service";
import { BoardMembersMenu, type BoardAccessMemberRow } from "./board-members-menu.popover";
import { beforeEach, describe, expect, it, vi } from "vitest";

const member = (userId: string, clientId: string): WireBoardMemberUser => ({
  userId,
  clientId,
  displayName: userId,
  avatarUrl: null,
  lastOnlineAt: null,
  role: "editor",
  source: "board",
});

describe("BoardMembersMenu", () => {
  const socket = { on: vi.fn(), off: vi.fn() };
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [BoardMembersMenu],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: ConfirmService, useValue: { open: vi.fn() } },
        { provide: SocketService, useValue: { connect: () => socket, joinBoard: () => vi.fn(), joinWorkspace: () => vi.fn() } },
      ],
    });
  });

  it("splits same-org members from read-only guests", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("members", [member("member", "owner"), member("guest", "guest-org")]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain("Members");
    expect(host.textContent).toContain("Guests");
    expect(host.textContent).toContain("Guests are managed in workspace settings.");
    expect(host.querySelector(".bmp-add")).toBeNull();
  });

  it("shows management controls for admins for members and guests", async () => {
    const rows: BoardAccessMemberRow[] = [
      { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() },
      { boardId: "board-1", userId: "guest", clientId: "guest-org", displayName: "Guest", email: "guest@example.com", avatarUrl: null, role: "observer", pinned: false, addedAt: new Date() },
    ];
    api.get.mockImplementation((path: string) => Promise.resolve(path.includes("/boards/") ? rows : [{ userId: "candidate", displayName: "Candidate", email: "candidate@example.com" }]));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.accessMembers.set(rows);
    fixture.componentInstance.roster.set([{
      workspaceId: "workspace-1",
      userId: "candidate",
      role: "member",
      addedAt: new Date(),
      displayName: "Candidate",
      email: "candidate@example.com",
      avatarUrl: null,
    }]);
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-add")).not.toBeNull();
    expect(host.querySelectorAll(".bmp-role-select")).toHaveLength(2);
    expect(host.querySelectorAll(".bmp-remove")).toHaveLength(2);
  });

  it("explains when every workspace member is already on the board", async () => {
    const rows: BoardAccessMemberRow[] = [
      { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() },
    ];
    api.get.mockImplementation(() => Promise.resolve(rows));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.accessMembers.set(rows);
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-add")).toBeNull();
    expect(host.querySelector(".bmp-all-added")?.textContent).toContain("All workspace members are already on this board.");
  });

  it("keeps the current member's name visible beside their role", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("currentUserId", "amelia");
    fixture.componentRef.setInput("members", [{ ...member("amelia", "owner"), displayName: "Amelia Hart" }]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-name")?.textContent).toContain("Amelia Hart");
    expect(host.querySelector(".bmp-you")?.textContent).toContain("You");
    expect(host.querySelector(".bmp-role")?.textContent).toContain("Editor");
  });

  it("shows restricted access to non-admin viewers as a read-only lock", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("members", [{ ...member("observer", "owner"), role: "observer", assignedItemsOnly: true }]);
    fixture.detectChanges();

    const lock = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".bmp-access-readonly");
    expect(lock).not.toBeNull();
    expect(lock?.getAttribute("aria-label")).toBe("Assigned items only");
    expect(lock?.tabIndex).toBe(0);
    expect((fixture.nativeElement as HTMLElement).querySelector(".bmp-access-toggle")).toBeNull();
  });

  it("orders members by role and then display name", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("members", [
      { ...member("observer-z", "owner"), displayName: "Zoe", role: "observer" },
      { ...member("editor-z", "owner"), displayName: "Zara", role: "editor" },
      { ...member("editor-a", "owner"), displayName: "Amelia", role: "editor" },
      { ...member("admin", "owner"), displayName: "Marcus", role: "admin" },
    ]);
    fixture.detectChanges();
    const names = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".bmp-name")]
      .map((element) => element.textContent?.trim());

    expect(names).toEqual(["Marcus", "Amelia", "Zara", "Zoe"]);
  });
});
