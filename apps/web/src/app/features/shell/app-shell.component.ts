import { NgOptimizedImage } from "@angular/common";
import type { OnDestroy, OnInit} from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal } from "@angular/core";
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import type { NotificationSettingsResponse } from "@kanera/shared/dto";
import type { ServerToClientEvents } from "@kanera/shared/events";
import type { Board, BoardGroup } from "@kanera/shared/schema";
import type { Subscription } from "rxjs";
import { filter } from "rxjs/operators";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService, type GuestHomeGroup, type HomeGroup, type HomeResponse, type HomeWorkspaceMember } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { GlobalSearchService } from "../../core/search/global-search.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { DisconnectPromptComponent } from "../../shared/disconnect-prompt.component";
import { LogoComponent } from "../../shared/logo.component";
import { RoleChangePromptComponent } from "../../shared/role-change-prompt.component";
import { SupportSessionBannerComponent } from "../../shared/support-session-banner.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { UpdatePromptComponent } from "../../shared/update-prompt.component";
import { NotificationsPanelComponent } from "../notifications/notifications-panel.component";
import { GlobalSearchOverlayComponent } from "../search/global-search-overlay.component";

function sortBoards<T extends { position: string }>(boards: T[]): T[] {
  return [...boards].sort((a, b) => Number(a.position) - Number(b.position));
}

function sortBoardGroups<T extends { position: string }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => Number(a.position) - Number(b.position));
}

type SidebarBoardGroup = {
  id: string;
  title: string;
  boards: Board[];
};

@Component({
  selector: "k-app-shell",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgOptimizedImage, LogoComponent, AvatarComponent, NotificationsPanelComponent, UpdatePromptComponent, DisconnectPromptComponent, RoleChangePromptComponent, GlobalSearchOverlayComponent, TooltipDirective, SupportSessionBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.scss",
})
export class AppShellComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly browserPush = inject(BrowserPushService);
  private readonly notifications = inject(NotificationsService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly search = inject(GlobalSearchService);

  readonly environmentBannerLabel = computed(() => {
    const environmentName = this.user()?.kaneraEnvironment;
    if (!environmentName || environmentName === "production") return null;
    return environmentName[0]!.toLocaleUpperCase() + environmentName.slice(1);
  });
  readonly groups = signal<HomeGroup[]>([]);
  readonly guestGroups = signal<GuestHomeGroup[]>([]);
  readonly usingOfflineShell = signal(false);
  readonly user = this.auth.user;
  readonly isOrgAdmin = this.auth.isOrgAdmin;
  readonly isHosted = computed(() => this.user()?.deploymentMode === "hosted");
  // Tracks which workspaces are collapsed in the nav. Default empty (all expanded); persisted to localStorage.
  readonly collapsed = signal<Record<string, boolean>>(this.readCollapsed());
  // Tracks which workspaces have their boards section collapsed.
  // Default is empty (all expanded); value is persisted to localStorage.
  readonly boardsCollapsed = signal<Record<string, boolean>>(this.readBoardsCollapsed());
  readonly boardGroupsCollapsed = signal<Record<string, boolean>>(this.readBoardGroupsCollapsed());
  readonly workspaceCount = computed(() => this.groups().length);
  readonly ownBoardCount = computed(() => this.groups().reduce((sum, group) => sum + group.boards.length, 0));
  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.ownBoardCount() >= max;
  });
  readonly canCreateWorkspace = computed(() => true);
  readonly workspaceCreateAttempted = signal(false);
  readonly workspaceCreateLimitMessage = computed(() => {
    if (!this.workspaceCreateAttempted() || !this.boardLimitReached()) return null;
    const max = this.auth.maxBoards();
    return max === null
      ? "Your plan's board limit has been reached."
      : `Your plan allows ${max} board${max === 1 ? "" : "s"}. Upgrade to add another workspace.`;
  });
  readonly hasNavBoards = computed(() => this.groups().length > 0 || this.guestGroups().length > 0);
  readonly searchShortcutLabel = signal<string | null>(this.readSearchShortcutLabel());
  readonly boardUnreadCounts = this.notifications.boardUnreadCounts;
  readonly userMenuOpen = signal(false);
  readonly boardSearch = signal("");
  private readonly failedOrgLogoUrl = signal<string | null>(null);
  readonly boardSearchTerm = computed(() => this.boardSearch().trim().toLocaleLowerCase());
  readonly visibleOrgLogoUrl = computed(() => {
    const logoUrl = this.user()?.logoUrl ?? null;
    if (!logoUrl || logoUrl === this.failedOrgLogoUrl()) return null;
    // A restored auth payload can hold a signed logo URL past its expiry;
    // suppress it rather than render a 404 until the live `/me` fetch refreshes it.
    return visibleSignedMediaUrl(logoUrl);
  });
  readonly hasBoardSearchMatches = computed(() => {
    const term = this.boardSearchTerm();
    return !term || [...this.groups(), ...this.guestGroups()].some((group) => group.boards.some((board) => board.name.toLocaleLowerCase().includes(term)));
  });

  private static readonly AUTO_COLLAPSE_BREAKPOINT = 900;
  private static readonly MOBILE_BREAKPOINT = 640;
  readonly sidebarCollapsed = signal<boolean>(this.readInitialCollapsed());
  readonly isMobile = signal<boolean>(window.innerWidth <= AppShellComponent.MOBILE_BREAKPOINT);
  private readonly onResize = () => {
    this.isMobile.set(window.innerWidth <= AppShellComponent.MOBILE_BREAKPOINT);
    if (window.innerWidth < AppShellComponent.AUTO_COLLAPSE_BREAKPOINT) {
      this.sidebarCollapsed.set(true);
    } else {
      this.sidebarCollapsed.set(localStorage.getItem(STORAGE_KEYS.SIDEBAR_COLLAPSED) === "1");
    }
  };

  private detach: (() => void) | null = null;
  private boardRoomDetaches: (() => void)[] = [];
  private workspaceRoomDetaches: (() => void)[] = [];
  private routerSub: Subscription | null = null;

  private readInitialCollapsed(): boolean {
    if (window.innerWidth < AppShellComponent.AUTO_COLLAPSE_BREAKPOINT) return true;
    return localStorage.getItem(STORAGE_KEYS.SIDEBAR_COLLAPSED) === "1";
  }

  private readSearchShortcutLabel(): string | null {
    const userAgent = window.navigator.userAgent;
    const platform = window.navigator.platform;
    const isAppleTouch = platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
    const isMobileAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(userAgent) || isAppleTouch;
    if (isMobileAgent) return null;
    return /Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent) ? "⌘K" : "Ctrl K";
  }

  private readBoardsCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.BOARDS_COLLAPSED);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  private readBoardGroupsCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.BOARD_GROUPS_COLLAPSED);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  private readCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.WORKSPACES_COLLAPSED);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  toggleSidebar() {
    const next = !this.sidebarCollapsed();
    this.sidebarCollapsed.set(next);
    localStorage.setItem(STORAGE_KEYS.SIDEBAR_COLLAPSED, next ? "1" : "0");
  }

  toggleUserMenu() {
    this.userMenuOpen.update((v) => !v);
  }

  closeUserMenu() {
    if (this.userMenuOpen()) this.userMenuOpen.set(false);
  }

  clearBoardSearch() {
    if (this.boardSearch()) this.boardSearch.set("");
  }

  hideFailedOrgLogo() {
    this.failedOrgLogoUrl.set(this.user()?.logoUrl ?? null);
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent) {
    if (!this.userMenuOpen()) return;
    const target = event.target as Node | null;
    const block = this.host.nativeElement.querySelector<HTMLElement>(".user-block");
    if (block && target && !block.contains(target)) {
      this.userMenuOpen.set(false);
    }
  }

  closeMobileSidebar() {
    if (this.isMobile() && !this.sidebarCollapsed()) {
      this.sidebarCollapsed.set(true);
    }
  }

  @HostListener("document:keydown.escape")
  onEscape() {
    this.search.close();
    this.closeUserMenu();
    this.closeMobileSidebar();
  }

  // ⌘K / Ctrl+K opens the global spotlight search from anywhere in the app.
  @HostListener("document:keydown", ["$event"])
  onGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.search.open();
    }
  }

  async ngOnInit() {
    window.addEventListener("resize", this.onResize);
    this.routerSub = this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.closeUserMenu();
      this.closeMobileSidebar();
    });
    const socket = this.sockets.connect();
    let groups: HomeGroup[];
    let guestGroups: GuestHomeGroup[];
    try {
      const response = await this.api.get<HomeResponse>("/home/boards");
      groups = response.groups;
      guestGroups = response.guestGroups ?? [];
      this.usingOfflineShell.set(false);
      void this.offlineCache.saveShell(response.groups, guestGroups).catch(() => undefined);
    } catch (error) {
      const cached = await this.offlineCache.loadShell().catch(() => null);
      if (!cached) throw error;
      groups = cached.groups;
      guestGroups = cached.guestGroups ?? [];
      this.usingOfflineShell.set(true);
    }
    this.groups.set(groups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards), members: g.members ?? [] })));
    this.guestGroups.set(guestGroups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards) })));
    for (const g of groups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards, g.workspace.accentColor);
      this.workspaceService.registerMembers(g.workspace.id, g.members ?? []);
      void this.workspaceService.loadLists(g.workspace.id);
    }
    for (const g of guestGroups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards, g.workspace.accentColor);
    }
    const leaveWorkspaces = groups.map((g) => this.sockets.joinWorkspace(g.workspace.id));
    void this.registerPushForEligibleBrowser();
    const handlers: Partial<ServerToClientEvents> = {
      "client:updated": ({ name, logoUrl }) => {
        this.auth.updateUser((u) => ({ ...u, orgName: name, logoUrl }));
      },
      "user:profile:updated": ({ userId, displayName, avatarUrl }) => {
        if (userId === this.user()?.id) this.auth.updateUser((user) => ({ ...user, displayName, avatarUrl }));
        this.groups.update((groups) => groups.map((group) => ({
          ...group,
          members: group.members.map((member) => member.userId === userId ? { ...member, displayName, avatarUrl } : member),
        })));
        this.workspaceService.updateMemberProfile(userId, displayName, avatarUrl);
      },
      "workspace:updated": ({ workspace }) => {
        this.groups.update((groups) =>
          groups.map((g) => (g.workspace.id === workspace.id ? { ...g, workspace: { ...g.workspace, ...workspace } } : g)),
        );
        this.workspaceService.updateAccentColor(workspace.id, workspace.accentColor ?? null);
      },
      "workspace:deleted": ({ workspaceId }) => {
        this.groups.update((groups) => groups.filter((g) => g.workspace.id !== workspaceId));
        this.workspaceService.removeWorkspace(workspaceId);
      },
      "workspace:member:removed": ({ workspaceId, userId }) => {
        if (userId === this.user()?.id) {
          this.groups.update((groups) => groups.filter((g) => g.workspace.id !== workspaceId));
          this.workspaceService.removeWorkspace(workspaceId);
          return;
        }
        this.groups.update((groups) =>
          groups.map((g) => (g.workspace.id !== workspaceId ? g : { ...g, members: g.members.filter((m) => m.userId !== userId) })),
        );
        this.workspaceService.removeMember(workspaceId, userId);
      },
      "workspace:member:added": ({ workspaceId, member }) => {
        if (member.userId === this.user()?.id) {
          // Newly added members are notified through their user room because they were not in this
          // workspace room yet. Join it now so subsequent workspace/board events arrive live.
          this.workspaceRoomDetaches.push(this.sockets.joinWorkspace(workspaceId));
          void this.refreshShellBoards();
          return;
        }
        this.groups.update((groups) =>
          groups.map((g) => {
            if (g.workspace.id !== workspaceId) return g;
            if (g.members.some((m) => m.userId === member.userId)) return g;
            return {
              ...g,
              members: [
                ...g.members,
                {
                  userId: member.userId,
                  displayName: member.displayName ?? "",
                  avatarUrl: member.avatarUrl ?? null,
                  role: member.role,
                },
              ],
            };
          }),
        );
        this.workspaceService.upsertMember(workspaceId, {
          userId: member.userId,
          displayName: member.displayName ?? "",
          avatarUrl: member.avatarUrl ?? null,
        });
      },
      "workspace:member:updated": ({ workspaceId, member }) => {
        this.groups.update((groups) =>
          groups.map((g) => (g.workspace.id !== workspaceId ? g : {
            ...g,
            members: g.members.map((m) => (m.userId === member.userId ? { ...m, role: member.role } : m)),
          })),
        );
        this.workspaceService.upsertMember(workspaceId, {
          userId: member.userId,
          displayName: member.displayName ?? "",
          avatarUrl: member.avatarUrl ?? null,
        });
      },
      "board:created": ({ workspaceId, board }) => {
        this.groups.update((groups) =>
          groups.map((g) => {
            if (g.workspace.id !== workspaceId || g.boards.some((b) => b.id === board.id)) return g;
            return { ...g, boards: sortBoards([...g.boards, board as unknown as Board]) };
          }),
        );
        this.workspaceService.upsertBoard(workspaceId, {
          id: board.id,
          name: board.name,
          icon: board.icon,
          iconColor: board.iconColor,
        });
      },
      "board:updated": ({ board }) => {
        this.groups.update((groups) =>
          groups.map((g) => ({
            ...g,
            boards: sortBoards(g.boards.map((b) => (b.id === board.id ? board as unknown as Board : b))),
          })),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => ({
            ...g,
            boards: sortBoards(g.boards.map((b) => (b.id === board.id ? { ...b, ...board } : b))),
          })),
        );
        this.workspaceService.upsertBoard(board.workspaceId, {
          id: board.id,
          name: board.name,
          icon: board.icon,
          iconColor: board.iconColor,
        });
      },
      "board:moved": ({ workspaceId, boardId, position }) => {
        this.groups.update((groups) =>
          groups.map((g) =>
            g.workspace.id === workspaceId
              ? { ...g, boards: sortBoards(g.boards.map((b) => (b.id === boardId ? { ...b, position } : b))) }
              : g,
          ),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) =>
            g.workspace.id === workspaceId
              ? { ...g, boards: sortBoards(g.boards.map((b) => (b.id === boardId ? { ...b, position } : b))) }
              : g,
          ),
        );
      },
      "board:rebalanced": ({ workspaceId, positions }) => {
        const applyRebalance = <T extends { id: string; position: string }>(boards: T[]) => {
          const positionsById = new Map(positions.map((p) => [p.id, p.position]));
          return sortBoards(boards.map((b) => {
            const position = positionsById.get(b.id);
            return position ? { ...b, position } : b;
          }));
        };
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId ? { ...g, boards: applyRebalance(g.boards) } : g),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId ? { ...g, boards: applyRebalance(g.boards) } : g),
        );
      },
      "board:deleted": ({ boardId }) => {
        this.groups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })).filter((g) => g.boards.length > 0),
        );
        this.workspaceService.removeBoard(boardId);
      },
      "board:member:removed": ({ boardId, userId }) => {
        if (userId !== this.user()?.id) return;
        this.guestGroups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })).filter((g) => g.boards.length > 0),
        );
        this.workspaceService.removeBoard(boardId);
      },
      "board:member:added": ({ boardId, member }) => {
        if (member.userId !== this.user()?.id) return;
        // A newly added guest was not in this board room when the socket connected, so the API
        // sends this event directly to their user room. Join the board and refresh the sidebar.
        this.boardRoomDetaches.push(this.sockets.joinBoard(boardId));
        void this.refreshShellBoards();
      },
      "boardGroup:created": ({ workspaceId, group }) =>
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups([...(g.boardGroups ?? []).filter((bg) => bg.id !== group.id), group as unknown as BoardGroup]) }
            : g),
        ),
      "boardGroup:updated": ({ workspaceId, group }) =>
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups((g.boardGroups ?? []).map((bg) => bg.id === group.id ? group as unknown as BoardGroup : bg)) }
            : g),
        ),
      "boardGroup:moved": ({ workspaceId, groupId, position }) =>
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups((g.boardGroups ?? []).map((bg) => bg.id === groupId ? { ...bg, position } : bg)) }
            : g),
        ),
      "boardGroup:rebalanced": ({ workspaceId, positions }) =>
        this.groups.update((groups) =>
          groups.map((g) => {
            if (g.workspace.id !== workspaceId) return g;
            const positionsById = new Map(positions.map((p) => [p.id, p.position]));
            return {
              ...g,
              boardGroups: sortBoardGroups((g.boardGroups ?? []).map((bg) => {
                const position = positionsById.get(bg.id);
                return position ? { ...bg, position } : bg;
              })),
            };
          }),
        ),
      "boardGroup:deleted": ({ workspaceId, groupId }) =>
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? {
              ...g,
              boardGroups: (g.boardGroups ?? []).filter((bg) => bg.id !== groupId),
              boards: g.boards.map((b) => b.groupId === groupId ? { ...b, groupId: null } : b),
            }
            : g),
        ),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event as keyof ServerToClientEvents, handler as never);
    }
    this.detach = () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event as keyof ServerToClientEvents, handler as never);
      }
      for (const leave of leaveWorkspaces) leave();
      for (const leave of this.boardRoomDetaches) leave();
      for (const leave of this.workspaceRoomDetaches) leave();
      this.boardRoomDetaches = [];
      this.workspaceRoomDetaches = [];
    };
  }

  private applyHomeResponse(response: HomeResponse): void {
    const groups = response.groups;
    const guestGroups = response.guestGroups ?? [];
    this.groups.set(groups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards), members: g.members ?? [] })));
    this.guestGroups.set(guestGroups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards) })));
    for (const g of groups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards, g.workspace.accentColor);
      this.workspaceService.registerMembers(g.workspace.id, g.members ?? []);
      void this.workspaceService.loadLists(g.workspace.id);
    }
    for (const g of guestGroups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards, g.workspace.accentColor);
    }
  }

  private async refreshShellBoards(): Promise<void> {
    const response = await this.api.get<HomeResponse>("/home/boards");
    this.usingOfflineShell.set(false);
    this.applyHomeResponse(response);
    void this.offlineCache.saveShell(response.groups, response.guestGroups ?? []).catch(() => undefined);
  }

  ngOnDestroy() {
    this.detach?.();
    this.routerSub?.unsubscribe();
    window.removeEventListener("resize", this.onResize);
  }

  toggle(workspaceId: string) {
    this.collapsed.update((c) => {
      const next = { ...c, [workspaceId]: !c[workspaceId] };
      localStorage.setItem(STORAGE_KEYS.WORKSPACES_COLLAPSED, JSON.stringify(next));
      return next;
    });
  }

  toggleBoards(workspaceId: string) {
    this.boardsCollapsed.update((c) => {
      const next = { ...c, [workspaceId]: !c[workspaceId] };
      localStorage.setItem(STORAGE_KEYS.BOARDS_COLLAPSED, JSON.stringify(next));
      return next;
    });
  }

  toggleBoardGroup(workspaceId: string, groupId: string) {
    const key = this.boardGroupCollapseKey(workspaceId, groupId);
    this.boardGroupsCollapsed.update((c) => {
      const next = { ...c, [key]: !c[key] };
      localStorage.setItem(STORAGE_KEYS.BOARD_GROUPS_COLLAPSED, JSON.stringify(next));
      return next;
    });
  }

  canManageWorkspace(workspace: { role: string }): boolean {
    return this.isOrgAdmin() || workspace.role === "owner" || workspace.role === "admin";
  }

  // Observers cannot access the assigned-work feature at all; everyone else sees at
  // least their own "Me" view.
  canSeeOwnUserView(workspace: { role: string }): boolean {
    return workspace.role !== "observer";
  }

  // Workspace owners/admins (and org admins) can pivot into any team member's work.
  canSeeOtherUserViews(workspace: { role: string }): boolean {
    return this.canManageWorkspace(workspace);
  }

  // Order members so that the viewer themself appears first, then the rest alphabetically.
  sortedMembers(members: HomeWorkspaceMember[]): HomeWorkspaceMember[] {
    const me = this.user()?.id;
    return [...members].sort((a, b) => {
      if (a.userId === me) return -1;
      if (b.userId === me) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  membersForWorkspaceSidebar(group: HomeGroup): HomeWorkspaceMember[] {
    if (!this.canSeeOwnUserView(group.workspace)) return [];
    const sorted = this.sortedMembers(group.members);
    if (this.canSeeOtherUserViews(group.workspace)) return sorted;
    // Members and observers (filtered above) only see themselves.
    const me = this.user()?.id;
    return sorted.filter((m) => m.userId === me);
  }

  // Returns the current user's own member entry if they can see their own view.
  myMember(group: HomeGroup): HomeWorkspaceMember | null {
    if (!this.canSeeOwnUserView(group.workspace)) return null;
    return group.members.find((m) => m.userId === this.user()?.id) ?? null;
  }

  // Returns all workspace members except the current user, sorted alphabetically,
  // only if the viewer has permission to see other members' views.
  otherMembers(group: HomeGroup): HomeWorkspaceMember[] {
    if (!this.canSeeOtherUserViews(group.workspace)) return [];
    const me = this.user()?.id;
    return [...group.members]
      .filter((m) => m.userId !== me)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  filteredBoards(group: HomeGroup | GuestHomeGroup): Board[] {
    const term = this.boardSearchTerm();
    if (!term) return group.boards as Board[];
    return (group.boards as Board[]).filter((board) => board.name.toLocaleLowerCase().includes(term));
  }

  filteredBoardGroups(group: HomeGroup | GuestHomeGroup): SidebarBoardGroup[] {
    const boards = this.filteredBoards(group);
    const byGroupId = new Map<string | null, Board[]>();
    for (const board of boards) {
      const groupId = board.groupId ?? null;
      byGroupId.set(groupId, [...(byGroupId.get(groupId) ?? []), board]);
    }
    const namedGroups = sortBoardGroups(group.boardGroups ?? [])
      .map((boardGroup) => ({
        id: boardGroup.id,
        title: boardGroup.title,
        boards: byGroupId.get(boardGroup.id) ?? [],
      }))
      .filter((boardGroup) => boardGroup.boards.length > 0);
    return namedGroups;
  }

  filteredUngroupedBoards(group: HomeGroup | GuestHomeGroup): Board[] {
    return this.filteredBoards(group).filter((board) => !board.groupId);
  }

  collapsedBoardLinks(group: HomeGroup | GuestHomeGroup): Board[] {
    // The icon-only sidebar has no group headings, but it should still follow
    // the same visual order as the expanded nav: grouped sections first, then
    // ungrouped boards.
    return [
      ...this.filteredBoardGroups(group).flatMap((boardGroup) => boardGroup.boards),
      ...this.filteredUngroupedBoards(group),
    ];
  }

  boardAttentionCount(boardId: string): number {
    return this.boardUnreadCounts()[boardId] ?? 0;
  }

  boardAttentionLabel(board: Pick<Board, "id" | "name">): string {
    const count = this.boardAttentionCount(board.id);
    if (count === 0) return board.name;
    const itemLabel = count === 1 ? "item" : "items";
    return `${board.name}, ${count} unread ${itemLabel} needing attention`;
  }

  boardAttentionBadge(boardId: string): string {
    const count = this.boardAttentionCount(boardId);
    return count > 99 ? "99+" : String(count);
  }

  boardAttentionColor(board: Pick<Board, "iconColor">, workspaceId: string): string | null {
    const color = board.iconColor ?? this.accentColorForWorkspace(workspaceId);
    return color ? `var(--color-${color})` : null;
  }

  isBoardGroupCollapsed(workspaceId: string, groupId: string): boolean {
    return !!this.boardGroupsCollapsed()[this.boardGroupCollapseKey(workspaceId, groupId)];
  }

  private boardGroupCollapseKey(workspaceId: string, groupId: string): string {
    return `${workspaceId}:${groupId}`;
  }

  shouldShowWorkspaceGroup(group: HomeGroup): boolean {
    return !this.boardSearchTerm() || this.filteredBoards(group).length > 0;
  }

  shouldShowGuestGroup(group: GuestHomeGroup): boolean {
    return !this.boardSearchTerm() || this.filteredBoards(group).length > 0;
  }

  isMe(member: HomeWorkspaceMember): boolean {
    return member.userId === this.user()?.id;
  }

  newWorkspace() {
    if (this.boardLimitReached()) {
      this.workspaceCreateAttempted.set(true);
      return;
    }
    this.workspaceCreateAttempted.set(false);
    void this.router.navigateByUrl("/onboarding");
  }

  accentColorForWorkspace(workspaceId: string): string | null {
    return this.workspaceService.accentColorForWorkspace(workspaceId);
  }

  async logout() {
    const accessToken = this.auth.getAccessToken();
    const pushCleanup = this.browserPush.unsubscribeForLogout(accessToken).catch(() => undefined);
    const logoutRequest = this.api.request("/auth/logout", { method: "POST" }).catch(() => undefined);
    const cacheCleanup = this.offlineCache.clearAll().catch(() => undefined);

    this.auth.broadcastLogout();
    this.auth.clearSession({ disableRefresh: true });
    this.sockets.disconnect();
    await this.router.navigateByUrl("/login", { replaceUrl: true });

    void Promise.allSettled([pushCleanup, logoutRequest, cacheCleanup]);
  }

  private async registerPushForEligibleBrowser() {
    try {
      const settings = await this.api.get<NotificationSettingsResponse>("/notifications/settings");
      if (!settings.push.enabled) return;
      await this.browserPush.initialise(true);
      if (this.browserPush.unsupportedReason() || this.browserPush.subscribed()) return;
      await this.browserPush.subscribe();
      if (!this.browserPush.subscribed()) return;
      if (!settings.pushEnabled) {
        await this.api.patch<NotificationSettingsResponse>("/notifications/settings", { pushEnabled: true });
      }
    } catch {
      // Push registration is opportunistic; settings still work from the account page.
    }
  }
}
