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
  const joinBoard = vi.fn(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [BoardMembersMenu],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: ConfirmService, useValue: { open: vi.fn() } },
        { provide: SocketService, useValue: { connect: () => socket, joinBoard, joinWorkspace: () => vi.fn() } },
      ],
    });
  });

  it("does not take ownership of a board room already managed by the board page", async () => {
    api.get.mockResolvedValue([]);
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("canManage", true);
    fixture.componentRef.setInput("boardRoomManaged", true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(joinBoard).not.toHaveBeenCalled();
    fixture.destroy();
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

  it("splits members and guests by the board owner org for guest viewers", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner-org");
    fixture.componentRef.setInput("currentUserId", "guest-viewer");
    fixture.componentRef.setInput("members", [
      { ...member("host-member", "owner-org"), displayName: "Host Member" },
      { ...member("guest-viewer", "guest-org"), displayName: "Guest Viewer" },
      { ...member("other-guest", "guest-org"), displayName: "Other Guest" },
    ]);
    fixture.detectChanges();
    const sections = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".bmp-section")];

    expect(sections[0]?.textContent).toContain("Host Member");
    expect(sections[0]?.textContent).not.toContain("Guest Viewer");
    expect(sections[1]?.textContent).toContain("Guest Viewer");
    expect(sections[1]?.textContent).toContain("Other Guest");
    expect(sections[1]?.textContent).not.toContain("Host Member");
  });

  it("keeps all rows under members until the board owner org is known", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("members", [member("member", "owner"), member("guest", "guest-org")]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain("member");
    expect(host.textContent).toContain("guest");
    expect(host.textContent).not.toContain("Guests are managed in workspace settings.");
    expect(host.querySelectorAll(".bmp-section")).toHaveLength(1);
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

  it("notifies the board view after removing a member", async () => {
    const row: BoardAccessMemberRow = { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() };
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    const removed = vi.fn();
    fixture.componentInstance.memberRemoved.subscribe(removed);
    fixture.componentInstance.accessMembers.set([row]);
    TestBed.inject(ConfirmService).open = vi.fn(() => Promise.resolve(true));
    api.delete.mockResolvedValue(undefined);

    await fixture.componentInstance.removeMember(row);

    expect(fixture.componentInstance.accessMembers()).toEqual([]);
    expect(removed).toHaveBeenCalledWith("member");
  });

  it("stays mounted until removal finishes so the parent receives success", async () => {
    const row: BoardAccessMemberRow = { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() };
    let resolveConfirmation!: (confirmed: boolean) => void;
    let resolveDelete!: () => void;
    TestBed.inject(ConfirmService).open = vi.fn(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve }));
    api.delete.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve }));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    const dismissed = vi.fn();
    const removed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);
    fixture.componentInstance.memberRemoved.subscribe(removed);

    const removal = fixture.componentInstance.removeMember(row);
    fixture.componentInstance.onDocumentClick();
    expect(dismissed).not.toHaveBeenCalled();
    resolveConfirmation(true);
    await Promise.resolve();

    // This is the document phase of the confirm-button click. The API request is now running, but
    // dismissing here would destroy the output binding before the successful response arrives.
    fixture.componentInstance.onDocumentClick();
    expect(dismissed).not.toHaveBeenCalled();
    resolveDelete();
    await removal;

    expect(removed).toHaveBeenCalledWith("member");
  });

  it("notifies the board view after adding a member", async () => {
    const row: BoardAccessMemberRow = { boardId: "board-1", userId: "ben", clientId: "owner", displayName: "Ben", email: "ben@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() };
    api.get.mockImplementation((path: string) => Promise.resolve(path.includes("/boards/") ? [row] : []));
    api.post.mockResolvedValue(undefined);
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    const added = vi.fn();
    fixture.componentInstance.memberAdded.subscribe(added);
    fixture.componentInstance.addUserId.set("ben");
    fixture.componentInstance.addRole.set("editor");

    await fixture.componentInstance.addMember();

    expect(added).toHaveBeenCalledWith(expect.objectContaining({ userId: "ben", displayName: "Ben", role: "editor", source: "board" }));
  });
});
