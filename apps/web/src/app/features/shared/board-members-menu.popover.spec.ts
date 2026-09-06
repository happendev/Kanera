import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { ApiClient } from "../../core/api/api.client";
import { SocketService } from "../../core/realtime/socket.service";
import { PanelStackService } from "../../shared/panel-stack.service";
import { ToastService } from "../../shared/toast.service";
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
  isOrganisationMember: clientId.startsWith("owner"),
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
        { provide: SocketService, useValue: { activeWorkspaceIds: signal(new Set<string>()), connect: () => socket, joinBoard, joinWorkspace: () => vi.fn() } },
      ],
    });
  });

  it.each(["editor", "observer"] as const)("shows self-leave for a %s in either member section", async (role) => {
    for (const clientId of ["owner", "guest-org"]) {
      const fixture = TestBed.createComponent(BoardMembersMenu);
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.componentRef.setInput("ownerClientId", "owner");
      fixture.componentRef.setInput("currentUserId", "self");
      const self = { ...member("self", clientId), role };
      fixture.componentRef.setInput("members", [self, member("other", clientId)]);
      await fixture.whenStable();
      expect((fixture.nativeElement as HTMLElement).querySelectorAll(".bmp-leave")).toHaveLength(1);
      expect(fixture.componentInstance.canLeave(member("other", clientId))).toBe(false);
      expect(fixture.componentInstance.canLeave({ ...self, pinned: true })).toBe(false);
      fixture.componentRef.setInput("canManage", true);
      expect(fixture.componentInstance.canLeave(self)).toBe(false);
      fixture.destroy();
    }
  });

  it("keeps membership on cancellation, unsaved rejection, and API failure; emits success once", async () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("currentUserId", "self");
    const self = member("self", "owner");
    const component = fixture.componentInstance;
    const confirm = vi.mocked(TestBed.inject(ConfirmService).open);
    const unsaved = vi.spyOn(TestBed.inject(UnsavedWorkService), "confirmNavigation");
    const removed = vi.fn();
    component.memberRemoved.subscribe(removed);
    confirm.mockResolvedValue(false);
    await component.leaveMembership(self);
    expect(api.delete).not.toHaveBeenCalled();
    expect(unsaved).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    unsaved.mockReturnValue(false);
    await component.leaveMembership(self);
    expect(api.delete).not.toHaveBeenCalled();
    unsaved.mockReturnValue(true);
    api.delete.mockRejectedValueOnce(new Error("Cannot leave"));
    await component.leaveMembership(self);
    expect(component.error()).toBe("Cannot leave");
    expect(removed).not.toHaveBeenCalled();
    let resolve!: () => void;
    api.delete.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const pending = component.leaveMembership(self);
    await Promise.resolve();
    expect(component.busy()).toBe(true);
    await component.leaveMembership(self);
    expect(api.delete).toHaveBeenCalledTimes(2);
    resolve();
    await pending;
    expect(removed).toHaveBeenCalledExactlyOnceWith("self");
    expect(component.busy()).toBe(false);
    expect(component.confirmingRemoval()).toBe(false);
  });

  it("does not take ownership of a board room already managed by the board page", async () => {
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? { scope: "workspace", members: [] }
      : []));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("canManage", true);
    fixture.componentRef.setInput("boardRoomManaged", true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(joinBoard).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it("splits same-org members from read-only guests without showing an irrelevant management hint", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("members", [member("member", "owner"), member("guest", "guest-org")]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain("Members");
    expect(host.textContent).toContain("Guests");
    expect(host.textContent).not.toContain("Guests are managed in workspace settings.");
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
    expect(sections[1]?.textContent).not.toContain("Guests are managed in workspace settings.");
  });

  it("uses host membership truth when a member's home organisation differs from the board owner", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("ownerClientId", "owner-org");
    fixture.componentRef.setInput("members", [
      { ...member("converted-member", "personal-home"), displayName: "Converted Member", isOrganisationMember: true },
      { ...member("guest", "guest-home"), displayName: "Actual Guest", isOrganisationMember: false },
    ]);
    fixture.detectChanges();
    const sections = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".bmp-section")];

    expect(sections[0]?.textContent).toContain("Converted Member");
    expect(sections[0]?.textContent).not.toContain("Actual Guest");
    expect(sections[1]?.textContent).toContain("Actual Guest");
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
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? { scope: "workspace", members: [{ userId: "candidate", clientId: "owner", displayName: "Candidate", email: "candidate@example.com", avatarUrl: null }] }
      : rows));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.accessMembers.set(rows);
    fixture.componentInstance.roster.set([{
      userId: "candidate",
      displayName: "Candidate",
      email: "candidate@example.com",
      avatarUrl: null,
      clientId: "owner",
    }]);
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-add")).not.toBeNull();
    expect(host.querySelector(".bmp-member-select")?.textContent).toContain("Select a workspace member");
    expect(host.querySelectorAll(".bmp-role-select")).toHaveLength(2);
    expect(host.querySelectorAll(".bmp-remove")).toHaveLength(2);
  });

  it("renders inherited admins without role or removal controls", async () => {
    const inheritedAdmin: BoardAccessMemberRow = {
      boardId: "standalone-board-1",
      userId: "org-admin",
      clientId: "owner",
      displayName: "Organisation Admin",
      email: "admin@example.com",
      avatarUrl: null,
      role: "editor",
      pinned: true,
      isOrganisationMember: true,
      addedAt: new Date(),
    };
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? { scope: "organisation", members: [] }
      : [inheritedAdmin]));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "standalone-board-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.accessMembers.set([inheritedAdmin]);
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-role-admin")?.textContent).toContain("Admin");
    expect(host.querySelector(".bmp-role-select")).toBeNull();
    expect(host.querySelector(".bmp-remove")).toBeNull();
  });

  it("explains when every workspace member is already on the board", async () => {
    const rows: BoardAccessMemberRow[] = [
      { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() },
    ];
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? { scope: "workspace", members: rows }
      : rows));
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

  it("labels standalone board candidates as organisation members", async () => {
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? {
          scope: "organisation",
          members: [{ userId: "candidate", clientId: "owner", displayName: "Candidate", email: "candidate@example.com", avatarUrl: null }],
        }
      : []));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "standalone-board-1");
    fixture.componentRef.setInput("workspaceId", "hidden-workspace-1");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.candidates()).toHaveLength(1));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector("option")?.textContent).toContain("Select an organisation member");
    expect(host.textContent).not.toContain("workspace member");
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
    api.delete.mockResolvedValue(undefined);
    const toasts = TestBed.inject(ToastService);

    await fixture.componentInstance.removeMember(row);

    // The row hides immediately but nothing is told until the undo window closes: the board page
    // must not drop a member the user may still restore.
    expect(fixture.componentInstance.accessMembers()).toEqual([]);
    expect(api.delete).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();

    toasts.flushPending();
    await Promise.resolve();
    expect(api.delete).toHaveBeenCalledWith("/boards/board-1/members/member");
    expect(removed).toHaveBeenCalledWith("member");
  });

  it("puts the member back when the removal is undone", async () => {
    const row: BoardAccessMemberRow = { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() };
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentInstance.accessMembers.set([row]);
    const toasts = TestBed.inject(ToastService);

    await fixture.componentInstance.removeMember(row);
    toasts.messages()[0]!.action!.run();
    await Promise.resolve();

    expect(fixture.componentInstance.accessMembers()).toEqual([row]);
    expect(api.delete).not.toHaveBeenCalled();
    expect(toasts.messages()).toEqual([]);
  });

  it("stays mounted until leaving finishes so the parent receives success", async () => {
    // Leaving is the one membership change that still confirms (an admin must re-add you), so it is
    // the flow that exercises the popover's dismissal veto.
    const row = member("member", "owner");
    let resolveConfirmation!: (confirmed: boolean) => void;
    let resolveDelete!: () => void;
    TestBed.inject(ConfirmService).open = vi.fn(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve }));
    vi.spyOn(TestBed.inject(UnsavedWorkService), "confirmNavigation").mockReturnValue(true);
    api.delete.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve }));
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? { scope: "workspace", members: [] }
      : []));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("currentUserId", "member");
    // Render, so the panel directive has registered itself as a stack layer and the outside clicks
    // below are actually arbitrated rather than hitting an empty stack.
    await fixture.whenStable();
    const dismissed = vi.fn();
    const removed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);
    fixture.componentInstance.memberRemoved.subscribe(removed);

    // Dismissal now runs through the shared panel stack, so drive it the way a real outside click
    // does. The popover's `canDismiss` veto is what has to keep it mounted.
    const stack = TestBed.inject(PanelStackService);
    const outside = document.createElement("button");
    const outsideClick = () =>
      stack.handlePointer({
        type: "click",
        target: outside,
        // TestBed mounts a standalone component directly under body, making body its synthetic
        // default anchor. A detached target models a real click outside the component's app wrapper.
        composedPath: () => [outside],
        stopPropagation: () => undefined,
      } as unknown as Event);

    const removal = fixture.componentInstance.leaveMembership(row);
    outsideClick();
    expect(dismissed).not.toHaveBeenCalled();
    expect(stack.depth).toBe(1);
    resolveConfirmation(true);
    await Promise.resolve();

    // This is the document phase of the confirm-button click. The API request is now running, but
    // dismissing here would destroy the output binding before the successful response arrives.
    outsideClick();
    expect(dismissed).not.toHaveBeenCalled();
    expect(stack.depth).toBe(1);
    resolveDelete();
    await removal;

    expect(removed).toHaveBeenCalledWith("member");
    expect(stack.depth).toBe(1);
    expect(fixture.componentInstance.confirmingRemoval()).toBe(false);

    // With the confirmation over, the veto lifts and the popover dismisses normally.
    outsideClick();
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it("notifies the board view after adding a member", async () => {
    const row: BoardAccessMemberRow = { boardId: "board-1", userId: "ben", clientId: "owner", displayName: "Ben", email: "ben@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() };
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/member-candidates")
      ? { scope: "workspace", members: [row] }
      : [row]));
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
