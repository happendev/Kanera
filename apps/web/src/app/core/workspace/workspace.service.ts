import { Injectable, computed, inject, signal } from "@angular/core";
import type { List } from "@kanera/shared/schema";
import { ApiClient } from "../api/api.client";

export interface BoardSummary {
  name: string;
  icon: string | null;
  iconColor: string | null;
}

export interface WorkspaceMemberSummary {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

@Injectable({ providedIn: "root" })
export class WorkspaceService {
  private readonly api = inject(ApiClient);

  private readonly _boardToWorkspace = signal<Map<string, string>>(new Map());
  private readonly _workspaceAccentColor = signal<Map<string, string | null>>(new Map());
  // Lightweight board name/icon lookup so any view (board page, assigned work) can
  // label a card's source board without owning the full board list itself.
  private readonly _boardSummaries = signal<Map<string, BoardSummary>>(new Map());
  private readonly _workspaceMembers = signal<Map<string, WorkspaceMemberSummary[]>>(new Map());

  /**
   * The accent color token of the currently active board/workspace, updated
   * reactively by the board and workspace-settings pages. Falls back to null
   * when no board is active (e.g. on the home page).
   */
  readonly activeAccentColor = signal<string | null>(null);
  readonly notificationBoardOptions = computed(() =>
    [...this._boardSummaries().entries()]
      .map(([boardId, board]) => ({ boardId, boardName: board.name, boardIcon: board.icon, boardIconColor: board.iconColor }))
      .sort((a, b) => a.boardName.localeCompare(b.boardName) || a.boardId.localeCompare(b.boardId)),
  );
  readonly notificationUserOptions = computed(() => {
    const byId = new Map<string, WorkspaceMemberSummary>();
    for (const members of this._workspaceMembers().values()) {
      for (const member of members) {
        byId.set(member.userId, member);
      }
    }
    return [...byId.values()]
      .map((member) => ({ userId: member.userId, displayName: member.displayName, avatarUrl: member.avatarUrl }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  });

  setActiveAccentColor(color: string | null) {
    this.activeAccentColor.set(color);
  }
  private readonly _lists = signal<Map<string, List[]>>(new Map());

  registerBoards(
    workspaceId: string,
    boards: { id: string; name?: string; icon?: string | null; iconColor?: string | null }[],
    accentColor?: string | null,
  ) {
    this._boardToWorkspace.update((m) => {
      const next = new Map(m);
      for (const board of boards) next.set(board.id, workspaceId);
      return next;
    });
    // Only callers that pass a name contribute to the summary lookup; the bare
    // `{ id }` registrations from board-state on reconnect leave existing names intact.
    if (boards.some((board) => board.name !== undefined)) {
      this._boardSummaries.update((m) => {
        const next = new Map(m);
        for (const board of boards) {
          if (board.name === undefined) continue;
          next.set(board.id, { name: board.name, icon: board.icon ?? null, iconColor: board.iconColor ?? null });
        }
        return next;
      });
    }
    if (accentColor !== undefined) {
      this._workspaceAccentColor.update((m) => {
        const next = new Map(m);
        next.set(workspaceId, accentColor);
        return next;
      });
    }
  }

  upsertBoard(workspaceId: string, board: { id: string; name: string; icon?: string | null; iconColor?: string | null }) {
    this.registerBoards(workspaceId, [board]);
  }

  removeBoard(boardId: string) {
    this._boardToWorkspace.update((m) => {
      if (!m.has(boardId)) return m;
      const next = new Map(m);
      next.delete(boardId);
      return next;
    });
    this._boardSummaries.update((m) => {
      if (!m.has(boardId)) return m;
      const next = new Map(m);
      next.delete(boardId);
      return next;
    });
  }

  registerMembers(workspaceId: string, members: WorkspaceMemberSummary[]) {
    this._workspaceMembers.update((m) => {
      const next = new Map(m);
      next.set(workspaceId, members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
      })));
      return next;
    });
  }

  upsertMember(workspaceId: string, member: WorkspaceMemberSummary) {
    this._workspaceMembers.update((m) => {
      const next = new Map(m);
      const members = next.get(workspaceId) ?? [];
      next.set(workspaceId, [
        ...members.filter((row) => row.userId !== member.userId),
        { userId: member.userId, displayName: member.displayName, avatarUrl: member.avatarUrl },
      ]);
      return next;
    });
  }

  updateMemberProfile(userId: string, displayName: string, avatarUrl: string | null) {
    this._workspaceMembers.update((workspaces) => {
      let changed = false;
      const next = new Map(workspaces);
      for (const [workspaceId, members] of next) {
        if (!members.some((member) => member.userId === userId)) continue;
        changed = true;
        next.set(workspaceId, members.map((member) =>
          member.userId === userId ? { ...member, displayName, avatarUrl } : member,
        ));
      }
      return changed ? next : workspaces;
    });
  }

  removeMember(workspaceId: string, userId: string) {
    this._workspaceMembers.update((m) => {
      const members = m.get(workspaceId);
      if (!members) return m;
      const next = new Map(m);
      next.set(workspaceId, members.filter((member) => member.userId !== userId));
      return next;
    });
  }

  accentColorForBoard(boardId: string): string | null {
    const wsId = this._boardToWorkspace().get(boardId);
    return wsId ? (this._workspaceAccentColor().get(wsId) ?? null) : null;
  }

  workspaceIdForBoard(boardId: string): string | null {
    return this._boardToWorkspace().get(boardId) ?? null;
  }

  boardSummaryFor(boardId: string): BoardSummary | null {
    return this._boardSummaries().get(boardId) ?? null;
  }

  accentColorForWorkspace(workspaceId: string): string | null {
    return this._workspaceAccentColor().get(workspaceId) ?? null;
  }

  updateAccentColor(workspaceId: string, accentColor: string | null) {
    this._workspaceAccentColor.update((m) => {
      const next = new Map(m);
      next.set(workspaceId, accentColor);
      return next;
    });
  }

  removeWorkspace(workspaceId: string) {
    const removedBoardIds: string[] = [];
    this._boardToWorkspace.update((m) => {
      const next = new Map(m);
      for (const [boardId, mappedWorkspaceId] of next) {
        if (mappedWorkspaceId === workspaceId) {
          removedBoardIds.push(boardId);
          next.delete(boardId);
        }
      }
      return next;
    });
    if (removedBoardIds.length) {
      this._boardSummaries.update((m) => {
        const next = new Map(m);
        for (const boardId of removedBoardIds) next.delete(boardId);
        return next;
      });
    }
    this._workspaceAccentColor.update((m) => {
      const next = new Map(m);
      next.delete(workspaceId);
      return next;
    });
    this._workspaceMembers.update((m) => {
      const next = new Map(m);
      next.delete(workspaceId);
      return next;
    });
    this._lists.update((m) => {
      const next = new Map(m);
      next.delete(workspaceId);
      return next;
    });
  }

  async loadLists(workspaceId: string) {
    if (this._lists().has(workspaceId)) return;
    const detail = await this.api.get<{ lists: List[] }>(`/workspaces/${workspaceId}`);
    this._lists.update((m) => {
      const next = new Map(m);
      next.set(workspaceId, detail.lists.filter((l) => !l.archivedAt));
      return next;
    });
  }

  cacheLists(workspaceId: string, lists: List[]) {
    this._lists.update((m) => {
      const next = new Map(m);
      next.set(workspaceId, lists.filter((l) => !l.archivedAt));
      return next;
    });
  }

  listsForBoard(boardId: string): List[] {
    const wsId = this._boardToWorkspace().get(boardId);
    return wsId ? (this._lists().get(wsId) ?? []) : [];
  }
}
