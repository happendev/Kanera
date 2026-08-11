import { Dialog } from "@angular/cdk/dialog";
import { NgOptimizedImage } from "@angular/common";
import type { OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal } from "@angular/core";
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import type { NotificationSettingsResponse } from "@kanera/shared/dto";
import type { ServerToClientEvents } from "@kanera/shared/events";
import type { Board, BoardGroup, StandaloneBoardGroup } from "@kanera/shared/schema";
import type { Subscription } from "rxjs";
import { filter } from "rxjs/operators";
import { ApiClient } from "../../core/api/api.client";
import { AuthService, authenticatedLandingPath } from "../../core/auth/auth.service";
import { STORAGE_KEYS, organisationStorageKey } from "../../core/browser/browser-contracts";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { ScratchpadPanelComponent } from "../scratchpad/scratchpad-panel.component";
import { ScratchpadService } from "../scratchpad/scratchpad.service";
import { OfflineCacheService, type GuestHomeGroup, type HomeGroup, type HomeResponse } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { GlobalSearchService } from "../../core/search/global-search.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { DisconnectPromptComponent } from "../../shared/disconnect-prompt.component";
import { LogoComponent } from "../../shared/logo.component";
import { PanelStackService } from "../../shared/panel-stack.service";
import { SupportSessionBannerComponent } from "../../shared/support-session-banner.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { UpdatePromptComponent } from "../../shared/update-prompt.component";
import { UpgradePromptService } from "../../shared/upgrade-prompt.service";
import { NotificationsPanelComponent } from "../notifications/notifications-panel.component";
import { MyPrioritiesPanelComponent } from "../priorities/my-priorities-panel.component";
import { GlobalSearchOverlayComponent } from "../search/global-search-overlay.component";
import { StandaloneBoardCreateDialogComponent } from "../standalone-board/standalone-board-create.dialog";
import { CreateOrganisationDialogComponent, JoinOrganisationDialogComponent, type CreateOrganisationResult } from "./organisation-action.dialog";

function sortBoards<T extends { position: string }>(boards: T[]): T[] {
  return [...boards].sort((a, b) => Number(a.position) - Number(b.position));
}

function sortBoardGroups<T extends { position: string }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => Number(a.position) - Number(b.position));
}

type SidebarBoardGroup = {
  id: string;
  title: string;
  boards: ShellBoard[];
};

type ShellBoard = Board & { disabledByPlan?: boolean };
type StandaloneBoardNavItem = { board: ShellBoard; homeGroup: HomeGroup | GuestHomeGroup };
type GuestContainer =
  | { kind: "workspace"; id: string; name: string; workspace: GuestHomeGroup }
  | { kind: "standaloneGroup"; id: string; name: string; boards: StandaloneBoardNavItem[] };
type GuestOrganisation = {
  clientId: string;
  clientName: string;
  containers: GuestContainer[];
  ungroupedStandaloneBoards: StandaloneBoardNavItem[];
};

type NavContextMenu = {
  label: string;
  url: string;
  canMarkAllRead: boolean;
  clearBoardSearch: boolean;
  isCurrentTarget: boolean;
  x: number;
  y: number;
};

type SidebarSwipe = {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollTop: number;
  startWidth: number;
  currentWidth: number;
  startedCollapsed: boolean;
  horizontal: boolean;
  vertical: boolean;
};

@Component({
  selector: "k-app-shell",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgOptimizedImage, LogoComponent, AvatarComponent, AnchoredPanelDirective, MyPrioritiesPanelComponent, NotificationsPanelComponent, ScratchpadPanelComponent, UpdatePromptComponent, DisconnectPromptComponent, GlobalSearchOverlayComponent, TooltipDirective, SupportSessionBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.scss",
  host: {
    "[style.--sidebar-swipe-width]": "sidebarSwipeWidth() === null ? null : sidebarSwipeWidth() + 'px'",
    // The dock is a real third grid column, so the shell — which owns the grid — has to know about
    // it. Suppressed on mobile, where the panel leaves the grid and becomes a bottom sheet.
    "[class.scratchpad-docked]": "scratchpad.open() && !isScratchpadSheet()",
    "[class.scratchpad-resizing]": "scratchpadResizing()",
    "[style.--scratchpad-width.px]": "scratchpad.width()",
    // How far the fixed top-right trigger buttons (bell, Up next, scratchpad) must move left to stay
    // over the page instead of floating on top of the dock's own header. Published here because all
    // three live in sibling components that position against the viewport, and the shell is the only
    // place that knows the dock's current width. 0 whenever the dock is closed or in sheet mode.
    "[style.--scratchpad-dock-offset.px]": "scratchpad.open() && !isScratchpadSheet() ? scratchpad.width() : 0",
  },
})
export class AppShellComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly browserPush = inject(BrowserPushService);
  private readonly dialog = inject(Dialog);
  private readonly notifications = inject(NotificationsService);
  private readonly myPriorities = inject(MyPrioritiesService);
  protected readonly scratchpad = inject(ScratchpadService);
  protected readonly scratchpadResizing = signal(false);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly panelStack = inject(PanelStackService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly upgradePrompt = inject(UpgradePromptService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly search = inject(GlobalSearchService);
  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.onEscape();
    this.onGlobalKeydown(event);
  };
  private readonly handleHostClick = (event: MouseEvent) => {
    if (!this.suppressSidebarClick) return;
    this.suppressSidebarClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private readonly handleHostPointerDown = (event: PointerEvent) => this.onSidebarPointerDown(event);
  private readonly handleHostPointerMove = (event: PointerEvent) => this.onSidebarPointerMove(event);
  private readonly handleHostPointerUp = (event: PointerEvent) => this.onSidebarPointerUp(event);
  private readonly handleHostPointerCancel = (event: PointerEvent) => this.onSidebarPointerCancel(event);

  readonly environmentBannerLabel = computed(() => {
    const environmentName = this.user()?.kaneraEnvironment;
    if (!environmentName || environmentName === "production") return null;
    return environmentName[0]!.toLocaleUpperCase() + environmentName.slice(1);
  });
  readonly groups = signal<HomeGroup[]>([]);
  // Old offline shells have no kind; treating that as standard keeps their existing presentation.
  readonly standardGroups = computed(() => this.groups().filter((group) => (group.workspace as { kind?: string }).kind !== "board"));
  readonly standaloneGroups = computed(() => this.groups().filter((group) => (group.workspace as { kind?: string }).kind === "board"));
  readonly guestGroups = signal<GuestHomeGroup[]>([]);
  readonly standaloneBoardGroups = signal<StandaloneBoardGroup[]>([]);
  readonly ownStandaloneBoardGroups = computed(() => this.standaloneNavigationGroups(this.standaloneGroups()));
  readonly ownUngroupedStandaloneBoards = computed(() => this.standaloneNavigationUngrouped(this.standaloneGroups()));
  readonly ownCollapsedStandaloneBoards = computed(() => [
    ...this.ownStandaloneBoardGroups().flatMap((group) => group.boards),
    ...this.ownUngroupedStandaloneBoards(),
  ]);
  readonly guestOrganisations = computed<GuestOrganisation[]>(() => {
    const metadata = new Map(this.standaloneBoardGroups().map((group) => [group.id, group]));
    const organisations = new Map<string, { clientName: string; standard: GuestHomeGroup[]; standalone: StandaloneBoardNavItem[] }>();
    for (const workspace of this.guestGroups()) {
      const entry = organisations.get(workspace.workspace.clientId) ?? { clientName: workspace.clientName, standard: [], standalone: [] };
      if (workspace.workspace.kind === "board") {
        for (const board of this.filteredBoards(workspace)) entry.standalone.push({ board, homeGroup: workspace });
      } else if (this.shouldShowGuestGroup(workspace)) {
        entry.standard.push(workspace);
      }
      organisations.set(workspace.workspace.clientId, entry);
    }
    return [...organisations.entries()].map(([clientId, entry]) => {
      const byGroup = new Map<string, StandaloneBoardNavItem[]>();
      const ungroupedStandaloneBoards: StandaloneBoardNavItem[] = [];
      for (const item of entry.standalone) {
        const groupId = item.board.standaloneGroupId;
        if (!groupId || !metadata.has(groupId)) ungroupedStandaloneBoards.push(item);
        else byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), item]);
      }
      const containers: GuestContainer[] = [
        ...entry.standard.map((workspace): GuestContainer => ({ kind: "workspace", id: workspace.workspace.id, name: workspace.workspace.name, workspace })),
        ...[...byGroup].map(([id, boards]): GuestContainer => ({ kind: "standaloneGroup", id, name: metadata.get(id)!.title, boards: boards.sort((a, b) => a.board.name.localeCompare(b.board.name)) })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      return { clientId, clientName: entry.clientName, containers, ungroupedStandaloneBoards: ungroupedStandaloneBoards.sort((a, b) => a.board.name.localeCompare(b.board.name)) };
    }).filter((org) => org.containers.length > 0 || org.ungroupedStandaloneBoards.length > 0)
      .sort((a, b) => a.clientName.localeCompare(b.clientName));
  });
  readonly usingOfflineShell = signal(false);
  readonly user = this.auth.user;
  readonly userMenuTooltip = computed(() => {
    const user = this.user();
    return user ? `${user.displayName} · ${user.email}` : "";
  });
  readonly isOrgAdmin = this.auth.isOrgAdmin;
  readonly isHosted = computed(() => this.user()?.deploymentMode === "hosted");
  readonly organisations = computed(() => this.user()?.organisations ?? []);
  readonly activeClientId = computed(() => this.user()?.activeClientId ?? this.user()?.clientId ?? null);
  readonly activeOrganisation = computed(() => this.organisations().find((organisation) => organisation.clientId === this.activeClientId()) ?? null);
  readonly switchingOrganisationId = signal<string | null>(null);
  readonly docsUrl = "https://www.kanera.app/docs";
  // Tracks which workspaces are collapsed in the nav. Default empty (all expanded); persisted to localStorage.
  readonly collapsed = signal<Record<string, boolean>>(this.readCollapsed());
  // Tracks which workspaces have their boards section collapsed.
  // Default is empty (all expanded); value is persisted to localStorage.
  readonly boardsCollapsed = signal<Record<string, boolean>>(this.readBoardsCollapsed());
  readonly boardGroupsCollapsed = signal<Record<string, boolean>>(this.readBoardGroupsCollapsed());
  readonly workspaceCount = computed(() => this.standardGroups().length);
  readonly ownBoardCount = computed(() =>
    this.groups().reduce((sum, group) => sum + group.boards.filter((board) => !this.isPlanDisabled(board)).length, 0),
  );
  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.ownBoardCount() >= max;
  });
  readonly canCreateWorkspace = computed(() => true);
  readonly workspaceCreateAttempted = signal(false);
  readonly standaloneBoardCreateAttempted = signal(false);
  readonly workspaceCreateLimitMessage = computed(() => {
    if (!this.workspaceCreateAttempted() || !this.boardLimitReached()) return null;
    const max = this.auth.maxBoards();
    return max === null
      ? "Your plan's board limit has been reached."
      : `Your plan allows ${max} board${max === 1 ? "" : "s"}. Upgrade to add another workspace.`;
  });
  readonly standaloneBoardCreateLimitMessage = computed(() => {
    if (!this.standaloneBoardCreateAttempted() || !this.boardLimitReached()) return null;
    const max = this.auth.maxBoards();
    return max === null
      ? "Your plan's board limit has been reached."
      : `Your plan allows ${max} board${max === 1 ? "" : "s"}. Upgrade to add another board.`;
  });
  readonly hasNavBoards = computed(() => this.groups().length > 0 || this.guestGroups().length > 0);
  readonly searchShortcutLabel = signal<string | null>(this.readSearchShortcutLabel());
  readonly boardUnreadCounts = this.notifications.boardUnreadCounts;
  readonly notificationsOnline = this.notifications.online;
  readonly userMenuOpen = signal(false);
  readonly organisationMenuOpen = signal(false);
  readonly navContextMenu = signal<NavContextMenu | null>(null);
  // Wider than the 260px sidebar and left-aligned to it, so the menu visibly overhangs the nav
  // column instead of blending into it.
  readonly userMenuPlacement = { side: "top", align: "start", width: 320, maxHeight: 560 } as const;
  // Opens beside its row, and `side: "right"` flips to the left of the account menu on its own when a
  // narrow viewport leaves no room. minHeight is the real flyout height so a short list never flips
  // for nothing.
  readonly organisationMenuPlacement = { side: "right", align: "start", width: 268, maxHeight: 420, minHeight: 180, gap: 4 } as const;
  readonly navMenuPlacement = { width: 190, maxHeight: 220, minHeight: 110 } as const;
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
  private static readonly SIDEBAR_WIDTH = 260;
  private static readonly SIDEBAR_WIDTH_COLLAPSED = 60;
  private static readonly SIDEBAR_WIDTH_COLLAPSED_MOBILE = 52;
  private static readonly SIDEBAR_SWIPE_INTENT_PX = 10;
  readonly sidebarCollapsed = signal<boolean>(this.readInitialCollapsed());
  readonly isMobile = signal<boolean>(window.innerWidth <= AppShellComponent.MOBILE_BREAKPOINT);
  /**
   * Below 900px there is no room for a third column, so the scratchpad becomes a bottom sheet and the
   * shell must stop reserving a grid column for it. Deliberately the *auto-collapse* breakpoint and
   * not `isMobile` (640): between 640 and 900 the sidebar is already force-collapsed and the content
   * column is tight, and carving a 320px dock out of it would leave the board unusable.
   * `ScratchpadPanelComponent` matches the same width, so the two can never disagree about shape.
   */
  readonly isScratchpadSheet = signal<boolean>(window.innerWidth <= AppShellComponent.AUTO_COLLAPSE_BREAKPOINT);
  readonly sidebarSwipeWidth = signal<number | null>(null);
  readonly sidebarSwipeProgress = computed(() => {
    const width = this.sidebarSwipeWidth();
    if (width === null) return null;
    const collapsedWidth = this.sidebarCollapsedWidth();
    return (width - collapsedWidth) / (AppShellComponent.SIDEBAR_WIDTH - collapsedWidth);
  });
  readonly sidebarSwipeSettling = signal(false);
  private sidebarSwipe: SidebarSwipe | null = null;
  private suppressSidebarClick = false;
  private sidebarClickReset: ReturnType<typeof setTimeout> | null = null;
  private sidebarSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private shellRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onResize = () => {
    this.isMobile.set(window.innerWidth <= AppShellComponent.MOBILE_BREAKPOINT);
    this.isScratchpadSheet.set(window.innerWidth <= AppShellComponent.AUTO_COLLAPSE_BREAKPOINT);
    if (window.innerWidth < AppShellComponent.AUTO_COLLAPSE_BREAKPOINT) {
      this.sidebarCollapsed.set(true);
    } else {
      this.sidebarCollapsed.set(localStorage.getItem(this.orgStorageKey(STORAGE_KEYS.SIDEBAR_COLLAPSED)) === "1");
    }
  };

  private detach: (() => void) | null = null;
  private boardRoomDetaches: (() => void)[] = [];
  private workspaceRoomDetaches: (() => void)[] = [];
  private routerSub: Subscription | null = null;

  private readInitialCollapsed(): boolean {
    if (window.innerWidth < AppShellComponent.AUTO_COLLAPSE_BREAKPOINT) return true;
    return localStorage.getItem(this.orgStorageKey(STORAGE_KEYS.SIDEBAR_COLLAPSED)) === "1";
  }

  private orgStorageKey(key: Parameters<typeof organisationStorageKey>[0]): string {
    return organisationStorageKey(key, this.user()?.activeClientId ?? this.user()?.clientId);
  }

  private readSearchShortcutLabel(): string | null {
    const userAgent = window.navigator.userAgent;
    const isAppleTouch = /Macintosh/i.test(userAgent) && window.navigator.maxTouchPoints > 1;
    const isMobileAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(userAgent) || isAppleTouch;
    if (isMobileAgent) return null;
    return /Macintosh|Mac OS X/i.test(userAgent) ? "⌘K" : "Ctrl K";
  }

  private readBoardsCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(this.orgStorageKey(STORAGE_KEYS.BOARDS_COLLAPSED));
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  private readBoardGroupsCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(this.orgStorageKey(STORAGE_KEYS.BOARD_GROUPS_COLLAPSED));
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  private readCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(this.orgStorageKey(STORAGE_KEYS.WORKSPACES_COLLAPSED));
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }

  toggleSidebar() {
    this.clearSidebarSettle();
    const next = !this.sidebarCollapsed();
    this.setSidebarCollapsed(next);
  }

  onSidebarPointerDown(event: PointerEvent) {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    // Anchored menus are rendered inside the sidebar's DOM tree even though they float over it.
    // Claiming their pointer stream for the drawer gesture makes touch taps target the shell instead
    // of the menu item, so links such as Profile and Organisation settings never navigate.
    if (event.target instanceof Element && event.target.closest(".k-anchored-panel")) return;
    const hostLeft = this.host.nativeElement.getBoundingClientRect().left;
    const interactiveWidth = this.sidebarSwipeWidth()
      ?? (this.sidebarCollapsed() ? this.sidebarCollapsedWidth() : AppShellComponent.SIDEBAR_WIDTH);
    // Listen in capture phase so nested controls cannot create dead zones, but only claim touches
    // that start within the visible sidebar column; board and page swipes remain independent.
    if (event.clientX < hostLeft || event.clientX > hostLeft + interactiveWidth) return;
    // A new touch takes control immediately, even if the previous release is still snapping.
    this.clearSidebarSettle();
    const startedCollapsed = this.sidebarCollapsed();
    const startWidth = startedCollapsed ? this.sidebarCollapsedWidth() : AppShellComponent.SIDEBAR_WIDTH;
    this.sidebarSwipe = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollTop: this.host.nativeElement.querySelector<HTMLElement>(".nav")?.scrollTop ?? 0,
      startWidth,
      currentWidth: startWidth,
      startedCollapsed,
      horizontal: false,
      vertical: false,
    };
    this.host.nativeElement.setPointerCapture?.(event.pointerId);
  }

  onSidebarPointerMove(event: PointerEvent) {
    const swipe = this.sidebarSwipe;
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;
    const horizontalDistance = Math.abs(deltaX);
    const verticalDistance = Math.abs(deltaY);

    if (!swipe.horizontal && !swipe.vertical) {
      if (Math.max(horizontalDistance, verticalDistance) < AppShellComponent.SIDEBAR_SWIPE_INTENT_PX) return;
      if (verticalDistance >= horizontalDistance) {
        swipe.vertical = true;
      } else {
        swipe.horizontal = true;
        this.sidebarSwipeSettling.set(false);
        this.sidebarSwipeWidth.set(swipe.startWidth);
        // `.sidebar.swiping` sets `transform` + `will-change: transform`, which makes the sidebar a
        // containing block for its `position: fixed` descendants. An open `.nav-context-menu` would
        // then be dragged along with the drawer instead of staying under the touch that opened it
        // (measured at exactly the drawer's translation). A menu open during a drawer drag is
        // meaningless anyway, so close it rather than trying to re-anchor it mid-gesture.
        this.panelStack.closeAll();
        // Pointer capture keeps the stream anchored to the stable shell while expanded controls
        // replace the collapsed links beneath it, so the drawer can always show its real state.
        if (swipe.startedCollapsed) this.sidebarCollapsed.set(false);
      }
      // A moved touch must never activate the control beneath its starting point.
      this.suppressSidebarClick = true;
    }

    if (swipe.vertical) {
      const nav = this.host.nativeElement.querySelector<HTMLElement>(".nav");
      if (nav) nav.scrollTop = swipe.startScrollTop - deltaY;
    } else if (swipe.horizontal) {
      const collapsedWidth = this.sidebarCollapsedWidth();
      swipe.currentWidth = Math.min(
        AppShellComponent.SIDEBAR_WIDTH,
        Math.max(collapsedWidth, swipe.startWidth + deltaX),
      );
      this.sidebarSwipeWidth.set(swipe.currentWidth);
    }
    if (event.cancelable) event.preventDefault();
  }

  onSidebarPointerUp(event: PointerEvent) {
    const swipe = this.sidebarSwipe;
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    if (swipe.horizontal) {
      const midpoint = (this.sidebarCollapsedWidth() + AppShellComponent.SIDEBAR_WIDTH) / 2;
      this.settleSidebarSwipe(swipe.currentWidth >= midpoint);
    }
    const moved = swipe.horizontal || swipe.vertical;
    if (!moved) {
      this.finishSidebarSwipe();
      return;
    }
    if (event.cancelable) event.preventDefault();
    this.finishSidebarSwipe();
    this.scheduleSidebarClickReset();
  }

  onSidebarPointerCancel(event: PointerEvent) {
    if (!this.sidebarSwipe || event.pointerId !== this.sidebarSwipe.pointerId) return;
    const swipe = this.sidebarSwipe;
    if (swipe.horizontal) this.settleSidebarSwipe(!swipe.startedCollapsed);
    this.finishSidebarSwipe();
    if (swipe.horizontal || swipe.vertical) this.scheduleSidebarClickReset();
  }

  private setSidebarCollapsed(collapsed: boolean) {
    this.sidebarCollapsed.set(collapsed);
    localStorage.setItem(this.orgStorageKey(STORAGE_KEYS.SIDEBAR_COLLAPSED), collapsed ? "1" : "0");
  }

  private finishSidebarSwipe() {
    const pointerId = this.sidebarSwipe?.pointerId;
    if (pointerId !== undefined && this.host.nativeElement.hasPointerCapture?.(pointerId)) {
      this.host.nativeElement.releasePointerCapture(pointerId);
    }
    this.sidebarSwipe = null;
  }

  private settleSidebarSwipe(open: boolean) {
    const targetWidth = open ? AppShellComponent.SIDEBAR_WIDTH : this.sidebarCollapsedWidth();
    this.setSidebarCollapsed(!open);
    this.sidebarSwipeSettling.set(true);
    this.sidebarSwipeWidth.set(targetWidth);
    this.sidebarSettleTimer = setTimeout(() => this.clearSidebarSettle(), 180);
  }

  private clearSidebarSettle() {
    if (this.sidebarSettleTimer !== null) clearTimeout(this.sidebarSettleTimer);
    this.sidebarSettleTimer = null;
    this.sidebarSwipeSettling.set(false);
    this.sidebarSwipeWidth.set(null);
  }

  private sidebarCollapsedWidth(): number {
    return this.isMobile()
      ? AppShellComponent.SIDEBAR_WIDTH_COLLAPSED_MOBILE
      : AppShellComponent.SIDEBAR_WIDTH_COLLAPSED;
  }

  private scheduleSidebarClickReset() {
    if (this.sidebarClickReset !== null) clearTimeout(this.sidebarClickReset);
    this.sidebarClickReset = setTimeout(() => {
      this.suppressSidebarClick = false;
      this.sidebarClickReset = null;
    });
  }

  toggleUserMenu() {
    const next = !this.userMenuOpen();
    this.userMenuOpen.set(next);
    // The submenu lives inside the account menu, so it must never survive it being closed and
    // re-opened; otherwise it renders anchored to a stale trigger.
    if (!next) this.organisationMenuOpen.set(false);
  }

  closeUserMenu() {
    if (this.userMenuOpen()) this.userMenuOpen.set(false);
    this.organisationMenuOpen.set(false);
  }

  toggleOrganisationMenu() {
    this.organisationMenuOpen.update((v) => !v);
  }

  closeOrganisationMenu() {
    this.organisationMenuOpen.set(false);
  }

  async switchOrganisation(clientId: string): Promise<void> {
    const currentClientId = this.user()?.activeClientId ?? this.user()?.clientId;
    if (clientId === currentClientId || this.switchingOrganisationId()) return;
    this.switchingOrganisationId.set(clientId);
    this.closeUserMenu();
    this.notifications.teardown();
    // Every id in the queue belongs to the organisation being left, so it must not survive the swap.
    this.myPriorities.teardown();
    // The scratchpad itself is organisation-scoped. Its teardown flushes any pending autosave first,
    // so switching orgs mid-sentence still saves the sentence before the new org's pages are loaded.
    this.scratchpad.teardown();
    this.workspaceService.clear();
    this.sockets.pauseForOrganisationSwitch();
    try {
      const user = await this.auth.switchOrg(clientId);
      // A shell owns many route-scoped stores and room references. Reloading at this boundary gives
      // every consumer one atomic active-organisation snapshot while the refresh cookie preserves
      // the chosen organisation for this tab.
      this.sockets.resumeAfterOrganisationSwitch();
      window.location.assign(authenticatedLandingPath(user));
    } catch {
      this.sockets.resumeAfterOrganisationSwitch();
      this.notifications.initialise();
      this.myPriorities.initialise();
      // The switch failed, so this shell still belongs to the original account. Teardown above
      // deliberately erased its private pages; restore the lazy connection only when the panel is
      // visible instead of leaving an open scratchpad blank until a reload.
      if (this.scratchpad.open()) this.scratchpad.initialise();
      this.switchingOrganisationId.set(null);
    }
  }

  createOrganisation(): void {
    if (this.switchingOrganisationId()) return;
    this.closeUserMenu();
    const ref = this.dialog.open<CreateOrganisationResult>(CreateOrganisationDialogComponent, {
      ariaLabel: "Create organisation",
      width: "min(440px, calc(100vw - 32px))",
      maxWidth: "100vw",
      data: { hosted: this.user()?.deploymentMode === "hosted" },
    });
    ref.closed.subscribe((session) => {
      if (!session) return;
      this.auth.setSession(session.accessToken, session.user);
      window.location.assign("/onboarding");
    });
  }

  joinOrganisation(): void {
    this.closeUserMenu();
    const ref = this.dialog.open<string>(JoinOrganisationDialogComponent, {
      ariaLabel: "Join organisation",
      width: "min(440px, calc(100vw - 32px))",
      maxWidth: "100vw",
    });
    ref.closed.subscribe((value) => {
      if (!value) return;
      let token = value;
      try {
        token = new URL(value, window.location.origin).searchParams.get("token") ?? value;
      } catch {
        // A raw token is also accepted.
      }
      void this.router.navigate(["/invite"], { queryParams: { token } });
    });
  }

  clearBoardSearch() {
    if (this.boardSearch()) this.boardSearch.set("");
  }

  hideFailedOrgLogo() {
    this.failedOrgLogoUrl.set(this.user()?.logoUrl ?? null);
  }

  closeMobileSidebar() {
    if (this.isMobile() && !this.sidebarCollapsed()) {
      this.sidebarCollapsed.set(true);
    }
  }

  onEscape() {
    this.search.close();
    this.closeUserMenu();
    this.closeNavContextMenu();
    this.closeMobileSidebar();
  }

  // ⌘K / Ctrl+K opens the global spotlight search from anywhere in the app.
  onGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.search.open();
    }
    // ⌘⇧. / Ctrl+⇧. toggles the scratchpad. Like ⌘K above, this handler has no "is the user typing?"
    // guard — and does not need one, because a modifier combo cannot be produced by ordinary typing.
    // A bare key here would fire while writing in the scratchpad itself, which would be absurd.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "." || event.key === ">")) {
      event.preventDefault();
      this.scratchpad.toggle();
    }
  }

  async ngOnInit() {
    window.addEventListener("resize", this.onResize);
    this.host.nativeElement.addEventListener("click", this.handleHostClick, true);
    this.host.nativeElement.addEventListener("pointerdown", this.handleHostPointerDown, true);
    this.host.nativeElement.addEventListener("pointermove", this.handleHostPointerMove, true);
    this.host.nativeElement.addEventListener("pointerup", this.handleHostPointerUp, true);
    this.host.nativeElement.addEventListener("pointercancel", this.handleHostPointerCancel, true);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    this.routerSub = this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.closeUserMenu();
      this.closeNavContextMenu();
      this.closeMobileSidebar();
    });
    const socket = this.sockets.connect();
    let groups: HomeGroup[];
    let guestGroups: GuestHomeGroup[];
    try {
      const response = await this.api.get<HomeResponse>("/home/boards");
      groups = response.groups;
      guestGroups = response.guestGroups ?? [];
      this.standaloneBoardGroups.set(response.standaloneBoardGroups ?? []);
      this.usingOfflineShell.set(false);
      void this.offlineCache.saveShell(this.user()!.clientId, response.groups, guestGroups, response.standaloneBoardGroups ?? []).catch(() => undefined);
    } catch (error) {
      const cached = await this.offlineCache.loadShell(this.user()!.clientId).catch(() => null);
      if (!cached) throw error;
      groups = cached.groups;
      guestGroups = cached.guestGroups ?? [];
      this.standaloneBoardGroups.set(cached.standaloneBoardGroups ?? []);
      this.usingOfflineShell.set(true);
    }
    this.groups.set(groups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards), members: g.members ?? [] })));
    this.guestGroups.set(guestGroups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards) })));
    for (const g of groups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards.filter((board) => !this.isPlanDisabled(board)), g.workspace.accentColor);
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
      "standaloneBoardGroup:upserted": ({ group }) => {
        this.standaloneBoardGroups.update((groups) => [...groups.filter((item) => item.id !== group.id), group]
          .sort((a, b) => a.title.localeCompare(b.title)));
      },
      "standaloneBoardGroup:deleted": ({ groupId }) => {
        this.standaloneBoardGroups.update((groups) => groups.filter((group) => group.id !== groupId));
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
        this.syncHasWorkspaceFromGroups();
      },
      "workspace:member:removed": ({ workspaceId, userId }) => {
        if (userId === this.user()?.id) {
          this.groups.update((groups) => groups.filter((g) => g.workspace.id !== workspaceId));
          this.workspaceService.removeWorkspace(workspaceId);
          this.syncHasWorkspaceFromGroups();
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
          // workspace room yet. Refresh before deriving hasWorkspace because hidden standalone
          // workspaces deliberately do not satisfy onboarding's product-level workspace flag.
          this.workspaceRoomDetaches.push(this.sockets.joinWorkspace(workspaceId));
          void this.refreshShellBoards().then(() => this.syncHasWorkspaceFromGroups());
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
            workspace: member.userId === this.user()?.id ? { ...g.workspace, role: member.role } : g.workspace,
            members: g.members.map((m) => (m.userId === member.userId ? { ...m, role: member.role } : m)),
          })),
        );
        this.workspaceService.upsertMember(workspaceId, {
          userId: member.userId,
          displayName: member.displayName ?? "",
          avatarUrl: member.avatarUrl ?? null,
        });
        // Promotion/demotion materializes or removes pinned board rows server-side. Reload the
        // authoritative home model so navigation and workspace-management controls change now.
        if (member.userId === this.user()?.id) void this.refreshShellBoards();
      },
      "board:created": ({ workspaceId, board }) => {
        if (board.archivedAt) return;
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
        if (board.archivedAt) {
          this.groups.update((groups) => groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== board.id) })));
          this.guestGroups.update((groups) => groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== board.id) })).filter((g) => g.boards.length > 0));
          this.workspaceService.removeBoard(board.id);
          return;
        }
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
        // A plan downgrade uses the deleted-shaped access event to close live board state, then the
        // authoritative directory returns that same board as disabled. Ordinary deletion simply
        // keeps it absent, so one refresh safely converges both cases.
        this.scheduleShellBoardsRefresh();
      },
      "board:member:removed": ({ boardId, userId }) => {
        if (userId !== this.user()?.id) return;
        this.groups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })).filter((g) => g.boards.length > 0),
        );
        this.workspaceService.removeBoard(boardId);
        void this.offlineCache.revokeBoardAccess(boardId).catch(() => undefined);
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
    const onConnect = () => {
      // Server-driven permission changes reconnect with refreshed credentials. Re-read the home
      // model so organisation/workspace promotions and demotions converge without a page reload.
      void this.refreshShellBoards().catch(() => undefined);
    };
    socket.on("connect", onConnect);
    this.detach = () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event as keyof ServerToClientEvents, handler as never);
      }
      socket.off("connect", onConnect);
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
    this.standaloneBoardGroups.set(response.standaloneBoardGroups ?? []);
    for (const g of groups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards.filter((board) => !this.isPlanDisabled(board)), g.workspace.accentColor);
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
    void this.offlineCache.saveShell(this.user()!.clientId, response.groups, response.guestGroups ?? [], response.standaloneBoardGroups ?? []).catch(() => undefined);
  }

  private scheduleShellBoardsRefresh(): void {
    // A single downgrade can archive many boards and therefore emit many access-removal events.
    // Coalesce that burst into one directory read while still converging ordinary deletes quickly.
    if (this.shellRefreshTimer !== null) clearTimeout(this.shellRefreshTimer);
    this.shellRefreshTimer = setTimeout(() => {
      this.shellRefreshTimer = null;
      void this.refreshShellBoards().catch(() => undefined);
    }, 50);
  }

  private syncHasWorkspaceFromGroups(): void {
    const hasWorkspace = this.standardGroups().length > 0;
    if (this.user()?.hasWorkspace !== hasWorkspace) {
      this.auth.updateUser((user) => ({ ...user, hasWorkspace }));
    }
  }

  ngOnDestroy() {
    // ScratchpadService is root-provided, so destroying the authenticated shell does not destroy its
    // state. Explicitly erase private pages at this account boundary to protect shared browsers and
    // prevent late autosave responses from landing in the next session.
    this.scratchpad.teardown();
    this.detach?.();
    this.routerSub?.unsubscribe();
    window.removeEventListener("resize", this.onResize);
    this.host.nativeElement.removeEventListener("click", this.handleHostClick, true);
    this.host.nativeElement.removeEventListener("pointerdown", this.handleHostPointerDown, true);
    this.host.nativeElement.removeEventListener("pointermove", this.handleHostPointerMove, true);
    this.host.nativeElement.removeEventListener("pointerup", this.handleHostPointerUp, true);
    this.host.nativeElement.removeEventListener("pointercancel", this.handleHostPointerCancel, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    if (this.sidebarClickReset !== null) clearTimeout(this.sidebarClickReset);
    if (this.sidebarSettleTimer !== null) clearTimeout(this.sidebarSettleTimer);
    if (this.shellRefreshTimer !== null) clearTimeout(this.shellRefreshTimer);
  }

  toggle(workspaceId: string) {
    this.collapsed.update((c) => {
      const next = { ...c, [workspaceId]: !c[workspaceId] };
      localStorage.setItem(this.orgStorageKey(STORAGE_KEYS.WORKSPACES_COLLAPSED), JSON.stringify(next));
      return next;
    });
  }

  toggleBoards(workspaceId: string) {
    this.boardsCollapsed.update((c) => {
      const next = { ...c, [workspaceId]: !c[workspaceId] };
      localStorage.setItem(this.orgStorageKey(STORAGE_KEYS.BOARDS_COLLAPSED), JSON.stringify(next));
      return next;
    });
  }

  toggleBoardGroup(workspaceId: string, groupId: string) {
    const key = this.boardGroupCollapseKey(workspaceId, groupId);
    this.boardGroupsCollapsed.update((c) => {
      const next = { ...c, [key]: !c[key] };
      localStorage.setItem(this.orgStorageKey(STORAGE_KEYS.BOARD_GROUPS_COLLAPSED), JSON.stringify(next));
      return next;
    });
  }

  canManageWorkspace(workspace: { role: string }): boolean {
    return this.isOrgAdmin() || workspace.role === "admin";
  }

  filteredBoards(group: HomeGroup | GuestHomeGroup): ShellBoard[] {
    const term = this.boardSearchTerm();
    if (!term) return group.boards as ShellBoard[];
    return (group.boards as ShellBoard[]).filter((board) => board.name.toLocaleLowerCase().includes(term));
  }

  filteredBoardGroups(group: HomeGroup | GuestHomeGroup): SidebarBoardGroup[] {
    const boards = this.filteredBoards(group);
    const byGroupId = new Map<string | null, ShellBoard[]>();
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

  filteredUngroupedBoards(group: HomeGroup | GuestHomeGroup): ShellBoard[] {
    return this.filteredBoards(group).filter((board) => !board.groupId);
  }

  standaloneNavigationGroups(groups: Array<HomeGroup | GuestHomeGroup>): Array<{ id: string; title: string; boards: StandaloneBoardNavItem[] }> {
    const items = groups.flatMap((homeGroup) => this.filteredBoards(homeGroup).map((board) => ({ board, homeGroup })));
    const byGroupId = new Map<string, StandaloneBoardNavItem[]>();
    for (const item of items) {
      if (item.board.standaloneGroupId) byGroupId.set(item.board.standaloneGroupId, [...(byGroupId.get(item.board.standaloneGroupId) ?? []), item]);
    }
    return this.standaloneBoardGroups()
      .map((group) => ({
        id: group.id,
        title: group.title,
        boards: (byGroupId.get(group.id) ?? []).sort((a, b) => a.board.name.localeCompare(b.board.name)),
      }))
      .filter((group) => group.boards.length > 0)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  standaloneNavigationUngrouped(groups: Array<HomeGroup | GuestHomeGroup>): StandaloneBoardNavItem[] {
    const knownIds = new Set(this.standaloneBoardGroups().map((group) => group.id));
    return groups.flatMap((homeGroup) => this.filteredBoards(homeGroup)
      .filter((board) => !board.standaloneGroupId || !knownIds.has(board.standaloneGroupId))
      .map((board) => ({ board, homeGroup })))
      .sort((a, b) => a.board.name.localeCompare(b.board.name));
  }

  guestCollapsedBoards(org: GuestOrganisation): StandaloneBoardNavItem[] {
    const workspaceBoards = org.containers.flatMap((container) => container.kind === "workspace"
      ? this.collapsedBoardLinks(container.workspace).map((board) => ({ board, homeGroup: container.workspace }))
      : container.boards);
    return [...workspaceBoards, ...org.ungroupedStandaloneBoards];
  }

  collapsedBoardLinks(group: HomeGroup | GuestHomeGroup): ShellBoard[] {
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

  isPlanDisabled(board: object): boolean {
    return (board as { disabledByPlan?: boolean }).disabledByPlan === true;
  }

  planDisabledLabel(board: Pick<Board, "name">): string {
    return `${board.name} is safely stored but disabled on Kanera Free. An organisation admin can upgrade to restore access.`;
  }

  onBoardLinkClick(event: MouseEvent, board: ShellBoard): void {
    if (this.isPlanDisabled(board)) {
      event.preventDefault();
      return;
    }
    this.clearBoardSearch();
  }

  suppressDisabledBoardEvent(event: Event): void {
    event.preventDefault();
  }

  boardAttentionLabel(board: Pick<Board, "id" | "name">): string {
    const count = this.boardAttentionCount(board.id);
    if (count === 0) return board.name;
    const itemLabel = count === 1 ? "card" : "cards";
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

  openNavContextMenu(event: MouseEvent, options: Omit<NavContextMenu, "isCurrentTarget" | "x" | "y">): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeUserMenu();
    this.navContextMenu.set({
      ...options,
      isCurrentTarget: this.navPath(options.url) === this.navPath(this.router.url),
      x: event.clientX,
      y: event.clientY,
    });
  }

  closeNavContextMenu(): void {
    this.navContextMenu.set(null);
  }

  async openNavContextTarget(): Promise<void> {
    const menu = this.navContextMenu();
    if (!menu) return;
    this.closeNavContextMenu();
    if (menu.clearBoardSearch) this.clearBoardSearch();
    await this.router.navigateByUrl(menu.url);
  }

  openNavContextTargetInNewTab(): void {
    const menu = this.navContextMenu();
    if (!menu) return;
    this.closeNavContextMenu();
    window.open(menu.url, "_blank", "noopener");
  }

  async markAllNavContextRead(): Promise<void> {
    const menu = this.navContextMenu();
    const boardId = menu?.url.match(/^\/b\/([^/?#]+)/)?.[1];
    if (!menu?.canMarkAllRead || !boardId || !this.notificationsOnline()) return;
    this.closeNavContextMenu();
    await this.notifications.markBoardNotificationsRead(boardId);
  }

  private navPath(url: string): string {
    const path = url.split(/[?#]/, 1)[0] || "/";
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  }

  newWorkspace() {
    if (this.boardLimitReached()) {
      this.workspaceCreateAttempted.set(true);
      void this.upgradePrompt.open({ reason: "board", source: "app_shell", boardCount: this.ownBoardCount() });
      return;
    }
    this.workspaceCreateAttempted.set(false);
    void this.router.navigateByUrl("/onboarding?mode=workspace");
  }

  newStandaloneBoard() {
    if (this.boardLimitReached()) {
      this.standaloneBoardCreateAttempted.set(true);
      void this.upgradePrompt.open({ reason: "board", source: "app_shell", boardCount: this.ownBoardCount() });
      return;
    }
    this.standaloneBoardCreateAttempted.set(false);
    const ref = this.dialog.open<string>(StandaloneBoardCreateDialogComponent, {
      ariaLabel: "Create standalone board",
      width: "min(440px, calc(100vw - 32px))",
      maxWidth: "100vw",
    });
    ref.closed.subscribe((boardId) => {
      if (boardId) void this.router.navigate(["/b", boardId]);
    });
  }

  accentColorForWorkspace(workspaceId: string): string | null {
    return this.workspaceService.accentColorForWorkspace(workspaceId);
  }

  /**
   * Nav icon colour for a workspace. A workspace with no accent must render as plain
   * foreground text, not the app's green `--accent`, which would read as a deliberate
   * colour choice the user never made. `--nav-text-strong` is the sidebar's
   * theme-aware emphasis tone (near-white on dark, a softened slate on light).
   */
  workspaceIconColor(workspaceId: string): string {
    const color = this.accentColorForWorkspace(workspaceId);
    return color ? `var(--color-${color})` : "var(--nav-text-strong)";
  }

  async logout() {
    const accessToken = this.auth.getAccessToken();
    const pushCleanup = this.browserPush.unsubscribeForLogout(accessToken).catch(() => undefined);
    const logoutRequest = this.api.request("/auth/logout", { method: "POST" }).catch(() => undefined);
    const cacheCleanup = this.offlineCache.clearAll().catch(() => undefined);

    // Flush while the outgoing token still exists, then synchronously erase the root service before
    // the login screen (or another account) can render in this SPA instance.
    this.scratchpad.teardown();
    this.auth.broadcastLogout();
    this.auth.clearSession({ disableRefresh: true });
    this.sockets.disconnect();
    await this.router.navigateByUrl("/login", { replaceUrl: true });

    void Promise.allSettled([pushCleanup, logoutRequest, cacheCleanup]);
  }

  private async registerPushForEligibleBrowser() {
    try {
      const settings = await this.api.get<NotificationSettingsResponse>("/notifications/settings");
      if (!settings.push.registrationEnabled) return;
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
