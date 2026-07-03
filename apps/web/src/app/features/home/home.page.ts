import type { OnDestroy, OnInit} from "@angular/core";
import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import type { ServerToClientEvents } from "@kanera/shared/events";
import type { BoardGroup, Workspace } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { GuestHomeGroup, HomeBoardWithStats, HomeDueSoonCard, HomeResponse } from "../../core/offline/offline-cache.service";
import { RecentBoardsService } from "../../core/recent-boards/recent-boards.service";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { formatDueDate } from "../board/due-date.util";

type HomeGroup = {
  workspace: Workspace & { role: string };
  boardGroups: BoardGroup[];
  boards: HomeBoardWithStats[];
  members: { userId: string; displayName: string; avatarUrl: string | null; lastOnlineAt?: string | Date | null; role: string }[];
};

function sortBoards<T extends { position: string }>(boards: T[]): T[] {
  return [...boards].sort((a, b) => Number(a.position) - Number(b.position));
}

function sortBoardGroups<T extends { position: string }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => Number(a.position) - Number(b.position));
}

type HomeBoardGroup = {
  group: BoardGroup;
  boards: HomeBoardWithStats[];
};

@Component({
  selector: "k-home",
  standalone: true,
  imports: [AvatarComponent, TooltipDirective, RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./home.page.html",
  styleUrls: ["../../shared/page-styles.scss", "./home.page.scss"],
})
export class HomePage implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(NotificationsService);
  private readonly recentBoardsService = inject(RecentBoardsService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private readonly workspaceService = inject(WorkspaceService);

  readonly groups = signal<HomeGroup[]>([]);
  readonly guestGroups = signal<GuestHomeGroup[]>([]);
  readonly localRecentBoardIds = this.recentBoardsService.boardIds;
  readonly boardUnreadCounts = this.notifications.boardUnreadCounts;
  readonly dueSoon = signal<HomeDueSoonCard[]>([]);
  readonly overdueChecklistItems = signal(0);
  readonly isOrgAdmin = this.auth.isOrgAdmin;
  readonly loaded = signal(false);
  private detach: (() => void) | null = null;
  private boardRoomDetaches: (() => void)[] = [];

  readonly displayName = computed(() => this.auth.user()?.displayName ?? "");

  // Trial status drives the home banner. tier === "trial" only ever happens in hosted mode; for
  // self-hosted / paid orgs these stay false/null and the banner is hidden.
  readonly isTrial = computed(() => this.auth.entitlements()?.tier === "trial");
  readonly trialEndsAt = computed(() => {
    const iso = this.auth.entitlements()?.trialEndsAt ?? null;
    return iso ? new Date(iso) : null;
  });
  readonly trialDaysLeft = computed(() => {
    const end = this.trialEndsAt();
    if (!end) return 0;
    return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
  });
  readonly trialWorkspaceLabel = computed(() => {
    const workspaces = this.groups();
    if (workspaces.length === 0) return "this organisation";
    if (workspaces.length === 1) return `${workspaces[0].workspace.name} workspace`;
    return `${workspaces.length} workspaces in this organisation`;
  });

  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  });

  /** Aggregate stats across all boards (own + guest) */
  readonly totalAssigned = computed(() =>
    [...this.groups(), ...this.guestGroups()].reduce((sum, g) => sum + g.boards.reduce((s, b) => s + b.myCards, 0), 0));
  readonly totalOverdue = computed(() =>
    [...this.groups(), ...this.guestGroups()].reduce((sum, g) => sum + g.boards.reduce((s, b) => s + b.myOverdue, 0), 0));
  readonly totalBoards = computed(() =>
    [...this.groups(), ...this.guestGroups()].reduce((sum, g) => sum + g.boards.length, 0));
  readonly ownBoardCount = computed(() => this.groups().reduce((sum, group) => sum + group.boards.length, 0));
  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.ownBoardCount() >= max;
  });
  readonly workspaceCreateAttempted = signal(false);
  readonly workspaceCreateLimitMessage = computed(() => {
    if (!this.workspaceCreateAttempted() || !this.boardLimitReached()) return null;
    const max = this.auth.maxBoards();
    return max === null
      ? "Your plan's board limit has been reached."
      : `Your plan allows ${max} board${max === 1 ? "" : "s"}. Upgrade to add another workspace.`;
  });

  /** Local recent boards resolved to full board objects with workspace name. */
  readonly recentBoards = computed(() => {
    const ids = this.localRecentBoardIds();
    if (ids.length === 0) return [];
    const boardMap = new Map<string, HomeBoardWithStats & { workspaceName: string }>();
    for (const group of [...this.groups(), ...this.guestGroups()]) {
      for (const board of group.boards) {
        boardMap.set(board.id, { ...board, workspaceName: group.workspace.name });
      }
    }
    return ids
      .map((id) => boardMap.get(id))
      .filter((b): b is HomeBoardWithStats & { workspaceName: string } => !!b)
      .slice(0, 3);
  });

  boardAttentionCount(boardId: string): number {
    return this.boardUnreadCounts()[boardId] ?? 0;
  }

  boardAttentionBadge(boardId: string): string {
    const count = this.boardAttentionCount(boardId);
    return count > 99 ? "99+" : String(count);
  }

  boardAttentionTitle(board: Pick<HomeBoardWithStats, "id" | "name">): string {
    const count = this.boardAttentionCount(board.id);
    const itemLabel = count === 1 ? "item" : "items";
    return `${count} unread ${itemLabel} needing attention`;
  }

  canCreateBoardIn(workspace: { role: string }): boolean {
    if (this.isOrgAdmin()) return true;
    // Board creation is a workspace-admin action; plain members cannot create boards.
    return workspace.role === "admin";
  }

  accentColorForWorkspace(workspaceId: string): string | null {
    return this.workspaceService.accentColorForWorkspace(workspaceId);
  }

  /** First N members of a workspace, for the avatar stack */
  memberAvatars(group: HomeGroup, count = 4): HomeGroup["members"] {
    return group.members.slice(0, count);
  }

  memberOverflow(group: HomeGroup, count = 4): number {
    return Math.max(0, group.members.length - count);
  }

  hasBoardGroups(group: HomeGroup | GuestHomeGroup): boolean {
    return (group.boardGroups ?? []).length > 0;
  }

  groupedBoards(group: HomeGroup | GuestHomeGroup): HomeBoardGroup[] {
    return sortBoardGroups(group.boardGroups ?? [])
      .map((boardGroup) => ({
        group: boardGroup,
        boards: group.boards.filter((board) => board.groupId === boardGroup.id),
      }))
      .filter((boardGroup) => boardGroup.boards.length > 0);
  }

  ungroupedBoards(group: HomeGroup | GuestHomeGroup): HomeBoardWithStats[] {
    return group.boards.filter((board) => !board.groupId);
  }

  async ngOnInit() {
    const response = await this.api.get<HomeResponse>("/home/boards");
    this.applyHomeResponse(response);
    this.loaded.set(true);
    const socket = this.sockets.connect();
    // Only join workspace rooms for own workspaces; the server auto-joins cross-org rooms that
    // existed when the socket connected. Newly granted guest boards are joined from the direct
    // board:member:added event below.
    const leaveWorkspaces = this.groups().map((g) => this.sockets.joinWorkspace(g.workspace.id));
    const handlers: Partial<ServerToClientEvents> = {
      "board:created": ({ workspaceId, board }) =>
        this.groups.update((groups) =>
          groups.map((g) => {
            if (g.workspace.id !== workspaceId || g.boards.some((b) => b.id === board.id)) return g;
            return { ...g, boards: sortBoards([...g.boards, { ...board, myCards: 0, myOverdue: 0 } as HomeBoardWithStats]) };
          }),
        ),
      "board:updated": ({ board }) => {
        this.groups.update((groups) =>
          groups.map((g) => ({
            ...g,
            boards: sortBoards(g.boards.map((b) => (b.id === board.id ? { ...b, ...board } : b))),
          })),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => ({
            ...g,
            boards: sortBoards(g.boards.map((b) => (b.id === board.id ? { ...b, ...board } : b))),
          })),
        );
      },
      "boardGroup:created": ({ workspaceId, group }) => {
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups([...g.boardGroups.filter((bg) => bg.id !== group.id), group as unknown as BoardGroup]) }
            : g),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups([...(g.boardGroups ?? []).filter((bg) => bg.id !== group.id), group as unknown as BoardGroup]) }
            : g),
        );
      },
      "boardGroup:updated": ({ workspaceId, group }) => {
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups(g.boardGroups.map((bg) => bg.id === group.id ? group as unknown as BoardGroup : bg)) }
            : g),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups((g.boardGroups ?? []).map((bg) => bg.id === group.id ? group as unknown as BoardGroup : bg)) }
            : g),
        );
      },
      "boardGroup:moved": ({ workspaceId, groupId, position }) => {
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups(g.boardGroups.map((bg) => bg.id === groupId ? { ...bg, position } : bg)) }
            : g),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? { ...g, boardGroups: sortBoardGroups((g.boardGroups ?? []).map((bg) => bg.id === groupId ? { ...bg, position } : bg)) }
            : g),
        );
      },
      "boardGroup:rebalanced": ({ workspaceId, positions }) => {
        const applyRebalance = <T extends { id: string; position: string }>(boardGroups: T[]) => {
          const positionsById = new Map(positions.map((p) => [p.id, p.position]));
          return sortBoardGroups(boardGroups.map((bg) => {
            const position = positionsById.get(bg.id);
            return position ? { ...bg, position } : bg;
          }));
        };
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId ? { ...g, boardGroups: applyRebalance(g.boardGroups) } : g),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId ? { ...g, boardGroups: applyRebalance(g.boardGroups ?? []) } : g),
        );
      },
      "boardGroup:deleted": ({ workspaceId, groupId }) => {
        this.groups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? {
              ...g,
              boardGroups: g.boardGroups.filter((bg) => bg.id !== groupId),
              boards: g.boards.map((board) => board.groupId === groupId ? { ...board, groupId: null } : board),
            }
            : g),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => g.workspace.id === workspaceId
            ? {
              ...g,
              boardGroups: (g.boardGroups ?? []).filter((bg) => bg.id !== groupId),
              boards: g.boards.map((board) => board.groupId === groupId ? { ...board, groupId: null } : board),
            }
            : g),
        );
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
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })),
        );
      },
      "board:member:removed": ({ boardId, userId }) => {
        if (userId !== this.auth.user()?.id) return;
        // Explicit board membership is also required for same-org members, so revoke the board
        // from both home collections rather than assuming only cross-org guests can lose access.
        this.groups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) })),
        );
        this.guestGroups.update((groups) =>
          groups.map((g) => ({ ...g, boards: g.boards.filter((b) => b.id !== boardId) }))
            .filter((g) => g.boards.length > 0),
        );
      },
      "board:member:added": ({ boardId, member }) => {
        if (member.userId !== this.auth.user()?.id) return;
        // The server sends this directly to the newly added user because they were not in the
        // board room yet. Join it now so later board events are live, then refresh the home model.
        this.boardRoomDetaches.push(this.sockets.joinBoard(boardId));
        void this.refreshHomeBoards();
      },
      "workspace:member:updated": ({ member }) => {
        if (member.userId === this.auth.user()?.id) void this.refreshHomeBoards();
      },
      "workspace:updated": ({ workspace }) => {
        this.groups.update((groups) =>
          groups.map((g) => (g.workspace.id === workspace.id ? { ...g, workspace: { ...g.workspace, ...workspace } } : g)),
        );
        this.workspaceService.updateAccentColor(workspace.id, workspace.accentColor ?? null);
      },
      "workspace:deleted": ({ workspaceId }) =>
        this.groups.update((groups) => groups.filter((g) => g.workspace.id !== workspaceId)),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event as keyof ServerToClientEvents, handler as never);
    }
    const onConnect = () => void this.refreshHomeBoards().catch(() => undefined);
    socket.on("connect", onConnect);
    this.detach = () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event as keyof ServerToClientEvents, handler as never);
      }
      socket.off("connect", onConnect);
      for (const leave of leaveWorkspaces) leave();
      for (const leave of this.boardRoomDetaches) leave();
      this.boardRoomDetaches = [];
    };
  }

  private applyHomeResponse(response: HomeResponse): void {
    const groups = response.groups.map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards) })) as HomeGroup[];
    const guestGroups = (response.guestGroups ?? []).map((g) => ({ ...g, boardGroups: sortBoardGroups(g.boardGroups ?? []), boards: sortBoards(g.boards) }));
    this.groups.set(groups);
    this.guestGroups.set(guestGroups);
    this.dueSoon.set(response.dueSoon ?? []);
    this.overdueChecklistItems.set(response.overdueChecklistItems ?? 0);
    for (const g of groups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards, g.workspace.accentColor);
      this.workspaceService.registerMembers(g.workspace.id, g.members ?? []);
    }
    // Register guest workspace boards so accent color lookup works.
    for (const g of guestGroups) {
      this.workspaceService.registerBoards(g.workspace.id, g.boards, g.workspace.accentColor);
    }
  }

  private async refreshHomeBoards(): Promise<void> {
    const response = await this.api.get<HomeResponse>("/home/boards");
    this.applyHomeResponse(response);
  }

  ngOnDestroy() {
    this.detach?.();
  }

  open(boardId: string) {
    void this.router.navigate(["/b", boardId]);
  }

  openCard(card: HomeDueSoonCard) {
    // Checklist items have no standalone route, so deep-link to the parent card.
    const cardId = card.kind === "checklistItem" ? card.cardId ?? card.id : card.id;
    void this.router.navigate(["/b", card.boardId], { queryParams: { cardId } });
  }

  dueDateText(card: HomeDueSoonCard): string {
    return formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  newWorkspace() {
    if (this.boardLimitReached()) {
      this.workspaceCreateAttempted.set(true);
      return;
    }
    this.workspaceCreateAttempted.set(false);
    void this.router.navigateByUrl("/onboarding");
  }

  manageBoards(workspaceId: string) {
    void this.router.navigate(["/w", workspaceId, "settings", "boards"]);
  }
}
