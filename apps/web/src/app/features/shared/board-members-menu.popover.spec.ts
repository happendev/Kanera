import { computed, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService, type AuthUser, type OrgRole } from "../../core/auth/auth.service";
import { SocketService } from "../../core/realtime/socket.service";
import { PanelStackService } from "../../shared/panel-stack.service";
import { ToastService } from "../../shared/toast.service";
import { ConfirmService } from "../../shared/confirm.service";
import { UpgradePromptService } from "../../shared/upgrade-prompt.service";
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

type Candidate = { userId: string; clientId: string; displayName: string; email: string; avatarUrl: null; isGuest?: boolean };

/** Answers the three reads the management view makes when it opens. */
function managementApi(members: unknown[], candidates: Candidate[] | unknown[] = [], scope: "workspace" | "organisation" = "workspace", invites: unknown[] = []) {
  return (path: string) => Promise.resolve(
    path.endsWith("/member-candidates") ? { scope, members: candidates }
    : path.endsWith("/invites") ? invites
    : members);
}

describe("BoardMembersMenu", () => {
  const socket = { on: vi.fn(), off: vi.fn() };
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  const joinBoard = vi.fn(() => vi.fn());
  const authUser = signal<AuthUser | null>(null);
  const upgradePrompt = { open: vi.fn() };
  const signInAs = (role: OrgRole, activeClientId = "owner") => authUser.set({ id: "self", clientId: "home", activeClientId, role, timezone: "UTC" } as AuthUser);

  beforeEach(() => {
    vi.clearAllMocks();
    authUser.set(null);
    TestBed.configureTestingModule({
      imports: [BoardMembersMenu],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: ConfirmService, useValue: { open: vi.fn() } },
        { provide: AuthService, useValue: { user: authUser, isOrgAdmin: computed(() => ["owner", "admin"].includes(authUser()?.role ?? "")), guestsAllowed: () => true } },
        { provide: UpgradePromptService, useValue: upgradePrompt },
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

  it("gives every member and guest a role control and a visible remove button", async () => {
    const rows: BoardAccessMemberRow[] = [
      { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, isOrganisationMember: true, addedAt: new Date() },
      { boardId: "board-1", userId: "guest", clientId: "guest-org", displayName: "Guest", email: "guest@example.com", avatarUrl: null, role: "observer", pinned: false, isOrganisationMember: false, addedAt: new Date() },
    ];
    api.get.mockImplementation(managementApi(rows, [{ userId: "candidate", clientId: "owner", displayName: "Candidate", email: "candidate@example.com", avatarUrl: null }]));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-search-input")?.getAttribute("placeholder")).toBe("Search or add people");
    expect(host.querySelectorAll(".bmp-access")).toHaveLength(2);
    // Removing is a visible button on every row, never hidden behind the role control.
    expect([...host.querySelectorAll(".bmp-remove")].map((button) => button.getAttribute("aria-label"))).toEqual(["Remove Member", "Remove Guest"]);
    expect(host.querySelector(".bmp-access-panel")).toBeNull();

    host.querySelector<HTMLButtonElement>(".bmp-guests .bmp-access")!.click();
    fixture.detectChanges();
    expect(host.querySelector(".bmp-guests .bmp-access")?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".bmp-access-panel")?.textContent).toContain("Assigned items only");
    expect(host.querySelector(".bmp-access-panel .bmp-remove")).toBeNull();
  });

  it("shows the board roster on first open and the cached management view on reopen while refetching", async () => {
    const rows: BoardAccessMemberRow[] = [
      { boardId: "board-1", userId: "member", clientId: "owner", displayName: "Member", email: "member@example.com", avatarUrl: null, role: "editor", pinned: false, addedAt: new Date() },
    ];
    api.get.mockImplementation(managementApi(rows, rows));
    const open = () => {
      const fixture = TestBed.createComponent(BoardMembersMenu);
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.componentRef.setInput("currentUserId", "self");
      fixture.componentRef.setInput("canManage", true);
      fixture.componentRef.setInput("members", [member("member", "owner")]);
      return fixture;
    };

    const first = open();
    first.detectChanges();
    const firstHost = first.nativeElement as HTMLElement;
    expect(firstHost.querySelector(".bmp-empty")).toBeNull();
    expect(firstHost.querySelector(".bmp-name")?.textContent).toBe("member");
    expect(firstHost.querySelector(".bmp-access")).toBeNull();
    await vi.waitFor(() => expect(first.componentInstance.loading()).toBe(false));
    first.detectChanges();
    expect(firstHost.querySelectorAll(".bmp-access")).toHaveLength(1);
    first.destroy();

    api.get.mockImplementation(() => new Promise(() => undefined));
    const second = open();
    second.detectChanges();
    const secondHost = second.nativeElement as HTMLElement;
    expect(second.componentInstance.loading()).toBe(false);
    expect(secondHost.querySelector(".bmp-name")?.textContent).toBe("Member");
    expect(secondHost.querySelectorAll(".bmp-access")).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith("/boards/board-1/members");
    second.destroy();
  });

  it("groups inherited admins apart, says why they have access, and gives them no controls", async () => {
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
      accessSource: "organisation_admin",
      addedAt: new Date(),
    };
    const workspaceAdmin: BoardAccessMemberRow = { ...inheritedAdmin, userId: "ws-admin", displayName: "Workspace Admin", accessSource: "workspace_admin" };
    api.get.mockImplementation(managementApi([inheritedAdmin, workspaceAdmin], [], "organisation"));
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "standalone-board-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("canManage", true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const admins = host.querySelector<HTMLElement>(".bmp-section");
    expect(admins?.querySelector(".bmp-section-title")?.textContent).toBe("Admins");
    expect(admins?.textContent).toContain("Organisation admin");
    expect(admins?.textContent).toContain("Workspace admin");
    expect(host.querySelectorAll(".bmp-role-admin")).toHaveLength(2);
    expect(host.querySelector(".bmp-access")).toBeNull();
    expect(host.querySelector(".bmp-remove")).toBeNull();
    // Only the admins section renders: an empty Members heading under them would read as a gap.
    expect(host.querySelectorAll(".bmp-section")).toHaveLength(1);
    expect(fixture.componentInstance.adminHint(workspaceAdmin)).toContain("workspace settings");
    expect(fixture.componentInstance.adminHint(inheritedAdmin)).toContain("organisation settings");
  });

  describe("search and add", () => {
    const ben: Candidate = { userId: "ben", clientId: "owner", displayName: "Ben Ortega", email: "ben@example.com", avatarUrl: null };
    const maya: Candidate = { userId: "maya", clientId: "guest-org", displayName: "Maya Chen", email: "maya@external.test", avatarUrl: null, isGuest: true };
    const onBoard: BoardAccessMemberRow = { boardId: "board-1", userId: "nina", clientId: "owner", displayName: "Nina Park", email: "nina@example.com", avatarUrl: null, role: "editor", pinned: false, isOrganisationMember: true, addedAt: new Date() };
    const pending = { id: "invite-1", kind: "guest", email: "sam@client.test", role: "editor", assignedItemsOnly: false, expiresAt: null, createdAt: "2026-11-18T10:00:00.000Z" };

    async function renderManager() {
      api.get.mockImplementation(managementApi([onBoard], [ben, maya, { ...onBoard, avatarUrl: null }], "workspace", [pending]));
      const fixture = TestBed.createComponent(BoardMembersMenu);
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.componentRef.setInput("workspaceId", "workspace-1");
      fixture.componentRef.setInput("ownerClientId", "owner");
      fixture.componentRef.setInput("canManage", true);
      fixture.detectChanges();
      await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
      fixture.detectChanges();
      return { fixture, host: fixture.nativeElement as HTMLElement };
    }
    const search = (fixture: ReturnType<typeof TestBed.createComponent<BoardMembersMenu>>, text: string) => { fixture.componentInstance.query.set(text); fixture.detectChanges(); };

    it("offers people not yet on the board, marking existing guests, and filters the roster", async () => {
      signInAs("member");
      const { fixture, host } = await renderManager();
      search(fixture, "a");
      const results = [...host.querySelectorAll<HTMLElement>(".bmp-result")].map((row) => row.textContent ?? "");
      expect(results).toHaveLength(2);
      expect(results.find((row) => row.includes("Maya Chen"))).toContain("Guest");
      expect(results.find((row) => row.includes("Ben Ortega"))).not.toContain("Guest");
      // Nina is already here, so she is never offered, only listed.
      expect(results.some((row) => row.includes("Nina Park"))).toBe(false);

      search(fixture, "nina");
      expect(host.querySelector(".bmp-results")).toBeNull();
      expect(host.querySelector(".bmp-list")?.textContent).toContain("Nina Park");

      search(fixture, "zzz");
      expect(host.querySelector(".bmp-results")?.textContent).toContain("No one matches. Enter an email address to invite someone.");
    });

    it("lists everyone who can be added when the empty field takes focus, without Enter picking one", async () => {
      signInAs("member");
      const { fixture, host } = await renderManager();
      expect(host.querySelector(".bmp-results"), "closed before focus").toBeNull();
      host.querySelector<HTMLInputElement>(".bmp-search-input")!.dispatchEvent(new FocusEvent("focus"));
      fixture.detectChanges();
      expect([...host.querySelectorAll(".bmp-result .bmp-name")].map((el) => el.textContent?.trim())).toEqual(["Ben Ortega", "Maya Chen"]);
      fixture.componentInstance.pickFirst();
      expect(api.post).not.toHaveBeenCalled();

      // Escape closes the list before it would close the menu.
      const dismissed = vi.fn();
      fixture.componentInstance.dismissed.subscribe(dismissed);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      fixture.detectChanges();
      expect(host.querySelector(".bmp-results"), "closed after escape").toBeNull();
      expect(dismissed).not.toHaveBeenCalled();
    });

    it("keeps the add list short in a large organisation and says how to reach everyone else", async () => {
      signInAs("member");
      const many: Candidate[] = Array.from({ length: 40 }, (_, i) => ({ userId: `p${i}`, clientId: "owner", displayName: `Person ${String(i).padStart(2, "0")}`, email: `p${i}@example.com`, avatarUrl: null }));
      api.get.mockImplementation(managementApi([onBoard], many));
      const fixture = TestBed.createComponent(BoardMembersMenu);
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.componentRef.setInput("canManage", true);
      fixture.detectChanges();
      await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
      const host = fixture.nativeElement as HTMLElement;
      fixture.componentInstance.addOpen.set(true);
      fixture.detectChanges();
      expect(host.querySelector(".bmp-results-title")?.textContent).toBe("Add to board");
      expect(host.querySelectorAll(".bmp-result")).toHaveLength(6);
      expect(host.querySelector(".bmp-result")?.textContent).toContain("Add");
      expect(host.querySelector(".bmp-more")?.textContent).toBe("Type a name or email to find 34 more people.");
      expect(host.querySelector(".bmp-results .bmp-email")).toBeNull();

      search(fixture, "person 1");
      expect(host.querySelectorAll(".bmp-result")).toHaveLength(6);
      expect(host.querySelector(".bmp-more")?.textContent).toBe("4 more people match. Keep typing to narrow it down.");
      search(fixture, "person 12");
      expect(host.querySelectorAll(".bmp-result")).toHaveLength(1);
      expect(host.querySelector(".bmp-more")).toBeNull();
    });

    it("shows an address in the add list only to tell two people with the same name apart", async () => {
      signInAs("member");
      api.get.mockImplementation(managementApi([onBoard], [ben, maya, { ...ben, userId: "ben-2", email: "ben@other.test" }]));
      const fixture = TestBed.createComponent(BoardMembersMenu);
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.componentRef.setInput("canManage", true);
      fixture.detectChanges();
      await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
      fixture.componentInstance.addOpen.set(true);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      expect([...host.querySelectorAll(".bmp-results .bmp-email")].map((el) => el.textContent)).toEqual(["ben@example.com", "ben@other.test"]);
    });

    it("never offers someone the board page already lists, even when the menu's own rows are stale", async () => {
      signInAs("member");
      const { fixture, host } = await renderManager();
      fixture.componentRef.setInput("members", [{ ...member("ben", "owner"), displayName: "Ben Ortega" }]);
      search(fixture, "a");
      expect([...host.querySelectorAll(".bmp-result")].map((row) => row.textContent)).not.toContainEqual(expect.stringContaining("Ben Ortega"));
    });

    it("treats an add that lost a race as done when a refresh shows the person on the board", async () => {
      signInAs("member");
      const { fixture } = await renderManager();
      const benOnBoard = { ...onBoard, userId: "ben", displayName: "Ben Ortega", email: "ben@example.com" };
      api.post.mockRejectedValueOnce(new ApiError(400, { message: "user is already a board member" }));
      api.get.mockImplementation(managementApi([onBoard, benOnBoard], [ben, maya], "workspace", []));
      const added = vi.fn();
      fixture.componentInstance.memberAdded.subscribe(added);
      await fixture.componentInstance.addCandidate(ben);
      expect(fixture.componentInstance.error()).toBeNull();
      expect(added).toHaveBeenCalledWith(expect.objectContaining({ userId: "ben" }));
    });

    it("offers an email invitation only for an address nobody here owns or has been sent", async () => {
      signInAs("member");
      const { fixture, host } = await renderManager();
      for (const known of ["ben@example.com", "NINA@example.com", "sam@client.test"]) {
        search(fixture, known);
        expect(fixture.componentInstance.inviteEmail()).toBeNull();
      }
      search(fixture, "New.Client@Example.com");
      expect(fixture.componentInstance.inviteEmail()).toBe("new.client@example.com");
      expect(host.querySelector(".bmp-results")?.textContent).toContain("Invite new.client@example.com as a guest");
      // Organisation invites stay with organisation admins; a workspace admin still gets the guest route.
      expect(host.querySelector(".bmp-results")?.textContent).not.toContain("to your organisation");

      signInAs("owner");
      fixture.detectChanges();
      expect(host.querySelector(".bmp-results")?.textContent).toContain("Invite new.client@example.com to your organisation");
    });

    it("previews the seat, confirms a paid one, then sends the guest invitation with the chosen access", async () => {
      signInAs("member");
      const { fixture } = await renderManager();
      const confirm = vi.mocked(TestBed.inject(ConfirmService).open);
      api.post.mockImplementation((path: string): Promise<unknown> => Promise.resolve(path.endsWith("/seat-preview") ? { paidGuestSeatRequired: true } : { status: "invited" }));
      fixture.componentInstance.addRole.set("observer");
      fixture.componentInstance.addAssignedItemsOnly.set(true);

      confirm.mockResolvedValueOnce(false);
      await fixture.componentInstance.inviteGuest("new@client.test");
      expect(api.post).toHaveBeenCalledTimes(1);

      confirm.mockResolvedValueOnce(true);
      await fixture.componentInstance.inviteGuest("new@client.test");
      expect(api.post).toHaveBeenLastCalledWith("/workspaces/workspace-1/guests/invitations", { boardId: "board-1", email: "new@client.test", role: "observer", assignedItemsOnly: true });
      expect(fixture.componentInstance.query()).toBe("");
      expect(fixture.componentInstance.addAssignedItemsOnly()).toBe(false);
    });

    it("sends a plan without guests to the upgrade prompt instead of the API", async () => {
      signInAs("member");
      const auth = TestBed.inject(AuthService) as unknown as { guestsAllowed: () => boolean };
      auth.guestsAllowed = () => false;
      const { fixture } = await renderManager();
      await fixture.componentInstance.inviteGuest("new@client.test");
      expect(api.post).not.toHaveBeenCalled();
      expect(upgradePrompt.open).toHaveBeenCalledExactlyOnceWith({ reason: "guest", source: "board_members" });
    });

    it("adds an existing guest only after the seat check", async () => {
      signInAs("member");
      const { fixture } = await renderManager();
      api.post.mockImplementation((path: string): Promise<unknown> => Promise.resolve(path.endsWith("/seat-preview") ? { paidGuestSeatRequired: false } : undefined));
      await fixture.componentInstance.addCandidate(maya);
      expect(api.post.mock.calls.map((call) => String(call[0]))).toEqual(["/workspaces/workspace-1/guests/seat-preview", "/boards/board-1/members"]);

      api.post.mockClear();
      await fixture.componentInstance.addCandidate(ben);
      expect(api.post.mock.calls.map((call) => String(call[0]))).toEqual(["/boards/board-1/members"]);
    });

    it("lists pending invites and withdraws one, restoring it if the server refuses", async () => {
      signInAs("member");
      const { fixture, host } = await renderManager();
      expect(host.querySelector(".bmp-invites")?.textContent).toContain("sam@client.test");
      expect(host.querySelector(".bmp-invites")?.textContent).toContain("Guest invite · Editor");

      api.delete.mockRejectedValueOnce(new ApiError(404, { message: "Not found" }));
      await fixture.componentInstance.revokeInvite(pending as never);
      expect(fixture.componentInstance.invites()).toHaveLength(1);
      expect(fixture.componentInstance.error()).toBe("Not found");

      api.delete.mockResolvedValueOnce(undefined);
      await fixture.componentInstance.revokeInvite(pending as never);
      expect(api.delete).toHaveBeenLastCalledWith("/boards/board-1/invites/invite-1?kind=guest");
      expect(fixture.componentInstance.invites()).toHaveLength(0);
      // Organisation invites are withdrawn by organisation admins only.
      expect(fixture.componentInstance.canRevoke({ ...pending, kind: "member" } as never)).toBe(false);
    });
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
    expect(host.querySelector(".bmp-email")?.textContent).toContain("You");
    expect(host.querySelector(".bmp-role")?.textContent).toContain("Editor");
  });

  it("shows restricted access to non-admin viewers as read-only text", () => {
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("ownerClientId", "owner");
    fixture.componentRef.setInput("members", [{ ...member("observer", "owner"), role: "observer", assignedItemsOnly: true }]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".bmp-restricted")?.textContent).toContain("Assigned items only");
    expect(host.querySelector(".bmp-role")?.textContent).toContain("Observer");
    expect(host.querySelector(".bmp-access")).toBeNull();
    // A short roster needs no search for read-only viewers.
    expect(host.querySelector(".bmp-search-input")).toBeNull();
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
    api.get.mockImplementation(managementApi([row], [row]));
    api.post.mockResolvedValue(undefined);
    const fixture = TestBed.createComponent(BoardMembersMenu);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    const added = vi.fn();
    fixture.componentInstance.memberAdded.subscribe(added);
    fixture.componentInstance.addRole.set("editor");

    await fixture.componentInstance.addCandidate({ userId: "ben", clientId: "owner", displayName: "Ben", email: "ben@example.com", avatarUrl: null });

    expect(api.post).toHaveBeenCalledExactlyOnceWith("/boards/board-1/members", { userId: "ben", role: "editor", assignedItemsOnly: false });
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ userId: "ben", displayName: "Ben", role: "editor", source: "board" }));
  });

  describe("invite by link", () => {
    // A brand-new owner's board: nobody else in the organisation, so the add form has no candidates.
    async function renderEmptyBoard() {
      api.get.mockImplementation(managementApi([], [], "organisation"));
      const fixture = TestBed.createComponent(BoardMembersMenu);
      fixture.componentRef.setInput("boardId", "board-1");
      fixture.componentRef.setInput("ownerClientId", "owner");
      fixture.componentRef.setInput("canManage", true);
      fixture.detectChanges();
      await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
      fixture.detectChanges();
      return { fixture, host: fixture.nativeElement as HTMLElement };
    }

    it("creates a member invite granting only this board with the chosen role, then shows the link", async () => {
      signInAs("owner");
      vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      api.post.mockResolvedValue({ id: "invite-1", token: "tok-123", expiresAt: "2026-11-23T10:00:00.000Z" });
      const { fixture, host } = await renderEmptyBoard();

      const invite = host.querySelector<HTMLElement>(".bmp-invite");
      expect(invite?.querySelector<HTMLSelectElement>(".bmp-invite-role")?.value).toBe("editor");
      fixture.componentInstance.inviteRole.set("observer");
      host.querySelector<HTMLButtonElement>(".bmp-invite-create")!.click();
      await vi.waitFor(() => expect(fixture.componentInstance.createdInvite()).not.toBeNull());
      fixture.detectChanges();

      expect(api.post).toHaveBeenCalledExactlyOnceWith("/clients/me/invites", {
        orgRole: "member", workspaces: [], boards: [{ boardId: "board-1", role: "observer" }], expiresInDays: 7,
      });
      expect(host.querySelector<HTMLInputElement>(".bmp-invite-url")?.value).toBe(`${location.origin}/signup?invite=tok-123`);
      expect(host.querySelector(".bmp-invite-hint")?.textContent).toContain("Anyone with this link can join this board as an observer. It expires on");
      expect(host.querySelector(".bmp-invite-copy")?.textContent).toContain("Copied");
      vi.unstubAllGlobals();
    });

    it("takes the new link off screen once it is withdrawn, and puts it back if the server refuses", async () => {
      signInAs("owner");
      vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      api.post.mockResolvedValue({ id: "invite-1", token: "tok-123", expiresAt: "2026-11-23T10:00:00.000Z" });
      const { fixture, host } = await renderEmptyBoard();
      await fixture.componentInstance.createInvite();
      fixture.detectChanges();
      expect(host.querySelector(".bmp-invite-url")).not.toBeNull();
      const linkRow = { id: "invite-1", kind: "member" as const, email: null, role: "editor" as const, assignedItemsOnly: false, expiresAt: null, createdAt: "2026-11-18T10:00:00.000Z" };

      api.delete.mockRejectedValueOnce(new ApiError(500, { message: "Server error" }));
      await fixture.componentInstance.revokeInvite(linkRow);
      fixture.detectChanges();
      expect(host.querySelector(".bmp-invite-url")).not.toBeNull();

      api.delete.mockResolvedValueOnce(undefined);
      await fixture.componentInstance.revokeInvite(linkRow);
      fixture.detectChanges();
      expect(api.delete).toHaveBeenLastCalledWith("/boards/board-1/invites/invite-1?kind=member");
      expect(host.querySelector(".bmp-invite-url")).toBeNull();
      expect(host.querySelector(".bmp-invite-create")).not.toBeNull();
      vi.unstubAllGlobals();
    });

    it("hides the action from board managers who are not organisation admins, or on another organisation's board", async () => {
      signInAs("member");
      const { fixture, host } = await renderEmptyBoard();
      expect(host.querySelector(".bmp-invite")).toBeNull();

      signInAs("admin", "other-org");
      fixture.detectChanges();
      expect(host.querySelector(".bmp-invite-create")).toBeNull();
      expect(fixture.componentInstance.canInvite()).toBe(false);
    });

    it("shows the error, and opens the upgrade prompt when the hosted member limit refuses the invite", async () => {
      signInAs("admin");
      const { fixture, host } = await renderEmptyBoard();
      api.post.mockRejectedValueOnce(new ApiError(400, { message: "board not in your organisation" }));
      await fixture.componentInstance.createInvite();
      fixture.detectChanges();
      expect(host.querySelector(".bmp-invite .bmp-error")?.textContent).toContain("board not in your organisation");
      expect(fixture.componentInstance.busy()).toBe(false);

      api.post.mockRejectedValueOnce(new ApiError(403, { code: "PLAN_LIMIT", limit: "members", current: 3, max: 3 }));
      await fixture.componentInstance.createInvite();
      expect(upgradePrompt.open).toHaveBeenCalledExactlyOnceWith({ reason: "member", source: "board_members", projectedSeats: 4 });
      expect(fixture.componentInstance.inviteError()).toBeNull();
      expect(fixture.componentInstance.createdInvite()).toBeNull();
    });
  });
});
