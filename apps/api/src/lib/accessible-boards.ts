import type { ColorToken } from "@kanera/shared/colors";
import type { WorkScope } from "@kanera/shared/dto";
import {
  boardGroups,
  boardMembers,
  boards,
  clientMembers,
  clients,
  standaloneBoardGroups,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { isOrgAdmin } from "./access.js";
import { isPaidTier } from "./entitlements.js";

export type AccessibleBoard = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  workspaceAccentColor: string | null;
  workspaceKind: "standard" | "board";
  clientId: string;
  clientName: string;
  name: string;
  icon: string | null;
  iconColor: ColorToken | null;
  viewerRole: "editor" | "observer";
  assignedItemsOnly: boolean;
  canAccessWorkspace: boolean;
  navigationOrder: number;
};

type UnorderedAccessibleBoard = Omit<AccessibleBoard, "navigationOrder">;

type NavigationMetadata = {
  workspaceCreatedAt: Date;
  boardPosition: string;
  boardGroupId: string | null;
  boardGroupPosition: string | null;
  standaloneGroupId: string | null;
  standaloneGroupTitle: string | null;
};

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

function comparePosition(a: string | null, b: string | null): number {
  return Number(a ?? 0) - Number(b ?? 0);
}

function compareWorkspaceBoards(
  a: UnorderedAccessibleBoard,
  b: UnorderedAccessibleBoard,
  metadata: Map<string, NavigationMetadata>,
): number {
  const aMeta = metadata.get(a.id);
  const bMeta = metadata.get(b.id);
  const aGrouped = Boolean(aMeta?.boardGroupId && aMeta.boardGroupPosition !== null);
  const bGrouped = Boolean(bMeta?.boardGroupId && bMeta.boardGroupPosition !== null);
  if (aGrouped !== bGrouped) return aGrouped ? -1 : 1;
  if (aGrouped && bGrouped) {
    const groupOrder = comparePosition(aMeta?.boardGroupPosition ?? null, bMeta?.boardGroupPosition ?? null);
    if (groupOrder) return groupOrder;
    const groupIdOrder = (aMeta?.boardGroupId ?? "").localeCompare(bMeta?.boardGroupId ?? "");
    if (groupIdOrder) return groupIdOrder;
  }
  return comparePosition(aMeta?.boardPosition ?? null, bMeta?.boardPosition ?? null)
    || a.id.localeCompare(b.id);
}

async function applyNavigationOrder(
  viewerClientId: string,
  accessibleBoards: UnorderedAccessibleBoard[],
): Promise<AccessibleBoard[]> {
  if (accessibleBoards.length === 0) return [];
  const rows = await db
    .select({
      boardId: boards.id,
      workspaceCreatedAt: workspaces.createdAt,
      boardPosition: boards.position,
      boardGroupId: boards.groupId,
      boardGroupPosition: boardGroups.position,
      standaloneGroupId: boards.standaloneGroupId,
      standaloneGroupTitle: standaloneBoardGroups.title,
    })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .leftJoin(boardGroups, eq(boardGroups.id, boards.groupId))
    .leftJoin(standaloneBoardGroups, eq(standaloneBoardGroups.id, boards.standaloneGroupId))
    .where(inArray(boards.id, accessibleBoards.map((board) => board.id)));
  const metadata = new Map(rows.map((row) => [row.boardId, {
    workspaceCreatedAt: row.workspaceCreatedAt,
    boardPosition: row.boardPosition,
    boardGroupId: row.boardGroupId,
    boardGroupPosition: row.boardGroupPosition,
    standaloneGroupId: row.standaloneGroupId,
    standaloneGroupTitle: row.standaloneGroupTitle,
  } satisfies NavigationMetadata]));

  const sourceSection = (board: UnorderedAccessibleBoard): 0 | 1 | 2 => {
    if (board.clientId !== viewerClientId) return 2;
    return board.workspaceKind === "board" ? 1 : 0;
  };
  const sorted = [...accessibleBoards].sort((a, b) => {
    const sectionOrder = sourceSection(a) - sourceSection(b);
    if (sectionOrder) return sectionOrder;
    const aMeta = metadata.get(a.id);
    const bMeta = metadata.get(b.id);

    if (a.clientId === viewerClientId && a.workspaceKind === "standard") {
      const workspaceCreatedOrder =
        (aMeta?.workspaceCreatedAt.getTime() ?? 0) - (bMeta?.workspaceCreatedAt.getTime() ?? 0);
      if (workspaceCreatedOrder) return workspaceCreatedOrder;
      const workspaceOrder = a.workspaceId.localeCompare(b.workspaceId);
      return workspaceOrder || compareWorkspaceBoards(a, b, metadata);
    }

    if (a.clientId === viewerClientId) {
      const aGrouped = Boolean(aMeta?.standaloneGroupId && aMeta.standaloneGroupTitle);
      const bGrouped = Boolean(bMeta?.standaloneGroupId && bMeta.standaloneGroupTitle);
      if (aGrouped !== bGrouped) return aGrouped ? -1 : 1;
      if (aGrouped && bGrouped) {
        const groupTitleOrder = compareText(aMeta?.standaloneGroupTitle ?? "", bMeta?.standaloneGroupTitle ?? "");
        if (groupTitleOrder) return groupTitleOrder;
        const groupIdOrder = (aMeta?.standaloneGroupId ?? "").localeCompare(bMeta?.standaloneGroupId ?? "");
        if (groupIdOrder) return groupIdOrder;
      }
      return compareText(a.name, b.name) || a.id.localeCompare(b.id);
    }

    const organisationOrder = compareText(a.clientName, b.clientName) || a.clientId.localeCompare(b.clientId);
    if (organisationOrder) return organisationOrder;
    const aUngroupedStandalone = a.workspaceKind === "board"
      && !(aMeta?.standaloneGroupId && aMeta.standaloneGroupTitle);
    const bUngroupedStandalone = b.workspaceKind === "board"
      && !(bMeta?.standaloneGroupId && bMeta.standaloneGroupTitle);
    if (aUngroupedStandalone !== bUngroupedStandalone) return aUngroupedStandalone ? 1 : -1;
    if (aUngroupedStandalone && bUngroupedStandalone) {
      return compareText(a.name, b.name) || a.id.localeCompare(b.id);
    }

    // Guest navigation treats standard workspaces and standalone groups as one alphabetical
    // container list. Only metadata attached to an accessible board participates here.
    const aContainerName = a.workspaceKind === "board"
      ? aMeta?.standaloneGroupTitle ?? a.name
      : a.workspaceName;
    const bContainerName = b.workspaceKind === "board"
      ? bMeta?.standaloneGroupTitle ?? b.name
      : b.workspaceName;
    const containerOrder = compareText(aContainerName, bContainerName);
    if (containerOrder) return containerOrder;
    if (a.workspaceKind !== b.workspaceKind) return a.workspaceKind === "standard" ? -1 : 1;
    if (a.workspaceKind === "standard" && b.workspaceKind === "standard") {
      const workspaceOrder = a.workspaceId.localeCompare(b.workspaceId);
      return workspaceOrder || compareWorkspaceBoards(a, b, metadata);
    }
    const standaloneGroupOrder =
      (aMeta?.standaloneGroupId ?? "").localeCompare(bMeta?.standaloneGroupId ?? "");
    return standaloneGroupOrder || compareText(a.name, b.name) || a.id.localeCompare(b.id);
  });

  // Array order is the catalog contract consumed by Board and Portfolio. Keeping one canonical
  // rank here prevents those projections from reimplementing the sidebar's source hierarchy.
  return sorted.map((board, navigationOrder) => ({ ...board, navigationOrder }));
}

/**
 * Resolve board visibility once for cross-workspace projections. Board membership remains the
 * content boundary; organisation admins add implicit access only inside their own organisation.
 * Keeping this as a shared helper prevents Home, search-like projections, and global work queries
 * from quietly disagreeing about guests, archived sources, or assigned-items-only restrictions.
 */
export async function loadAccessibleBoards(auth: AuthClaims): Promise<AccessibleBoard[]> {
  const readOnlyCredential = auth.apiKeyKind === "personal" && auth.apiKeyScope === "read";
  const byId = new Map<string, UnorderedAccessibleBoard>();

  if (auth.authKind === "apiKey" && auth.apiKeyKind !== "personal") {
    const rows = await db
      .select({
        boardId: boards.id,
        workspaceId: boards.workspaceId,
        workspaceName: workspaces.name,
        workspaceIcon: workspaces.icon,
        workspaceAccentColor: workspaces.accentColor,
        workspaceKind: workspaces.kind,
        clientId: clients.id,
        clientName: clients.name,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardIconColor: boards.iconColor,
      })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .innerJoin(workspaceMembers, and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, auth.sub),
      ))
      .where(and(
        eq(workspaces.id, auth.apiKeyWorkspaceId!),
        isNull(workspaces.archivedAt),
        isNull(boards.archivedAt),
      ))
      .orderBy(asc(boards.position));
    return applyNavigationOrder(auth.cid, rows.map((row) => ({
      id: row.boardId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceIcon: row.workspaceIcon,
      workspaceAccentColor: row.workspaceAccentColor,
      workspaceKind: row.workspaceKind,
      clientId: row.clientId,
      clientName: row.clientName,
      name: row.boardName,
      icon: row.boardIcon,
      iconColor: row.boardIconColor,
      viewerRole: auth.apiKeyScope === "read" ? "observer" : "editor",
      assignedItemsOnly: false,
      canAccessWorkspace: true,
    })));
  }

  if (auth.apiKeyKind === "personal") {
    const rows = await db
      .select({
        boardId: boards.id,
        workspaceId: boards.workspaceId,
        workspaceName: workspaces.name,
        workspaceIcon: workspaces.icon,
        workspaceAccentColor: workspaces.accentColor,
        workspaceKind: workspaces.kind,
        clientId: clients.id,
        clientName: clients.name,
        billingStatus: clients.billingStatus,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardIconColor: boards.iconColor,
        clientRole: clientMembers.clientRole,
        clientSuspendedAt: clientMembers.suspendedAt,
        clientRemovedAt: clientMembers.removedAt,
        boardRole: boardMembers.role,
        assignedItemsOnly: boardMembers.assignedItemsOnly,
        workspaceMemberId: workspaceMembers.userId,
      })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .leftJoin(clientMembers, and(
        eq(clientMembers.clientId, workspaces.clientId),
        eq(clientMembers.userId, auth.sub),
      ))
      .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, auth.sub)))
      .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, auth.sub)))
      .where(and(
        isNull(workspaces.archivedAt),
        isNull(boards.archivedAt),
        isNull(clients.suspendedAt),
        isNull(clients.deletedAt),
        // Retained inactive memberships must block the board-member guest fallback.
        or(
          isNull(clientMembers.userId),
          and(isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt)),
        ),
        or(
          and(
            isNull(clientMembers.suspendedAt),
            isNull(clientMembers.removedAt),
            inArray(clientMembers.clientRole, ["owner", "admin"]),
          ),
          isNotNull(boardMembers.userId),
        ),
      ))
      .orderBy(asc(workspaces.createdAt), asc(boards.position));

    const eligible = rows.filter((row) =>
      env.KANERA_DEPLOYMENT_MODE !== "hosted" || isPaidTier(row.billingStatus)
    );
    return applyNavigationOrder(auth.cid, eligible.map((row) => {
      const orgAdmin = row.clientRole === "owner" || row.clientRole === "admin";
      return {
        id: row.boardId,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        workspaceIcon: row.workspaceIcon,
        workspaceAccentColor: row.workspaceAccentColor,
        workspaceKind: row.workspaceKind,
        clientId: row.clientId,
        clientName: row.clientName,
        name: row.boardName,
        icon: row.boardIcon,
        iconColor: row.boardIconColor,
        viewerRole: readOnlyCredential ? "observer" as const : orgAdmin ? "editor" as const : row.boardRole!,
        assignedItemsOnly: orgAdmin ? false : row.assignedItemsOnly ?? false,
        canAccessWorkspace: Boolean(row.clientRole && (orgAdmin || row.workspaceMemberId)),
      };
    }));
  }

  if (isOrgAdmin(auth)) {
    const rows = await db
      .select({
        boardId: boards.id,
        workspaceId: boards.workspaceId,
        workspaceName: workspaces.name,
        workspaceIcon: workspaces.icon,
        workspaceAccentColor: workspaces.accentColor,
        workspaceKind: workspaces.kind,
        clientId: clients.id,
        clientName: clients.name,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardIconColor: boards.iconColor,
      })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(
        eq(workspaces.clientId, auth.cid),
        isNull(workspaces.archivedAt),
        isNull(boards.archivedAt),
      ))
      .orderBy(asc(workspaces.createdAt), asc(boards.position));

    for (const row of rows) {
      byId.set(row.boardId, {
        id: row.boardId,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        workspaceIcon: row.workspaceIcon,
        workspaceAccentColor: row.workspaceAccentColor,
        workspaceKind: row.workspaceKind,
        clientId: row.clientId,
        clientName: row.clientName,
        name: row.boardName,
        icon: row.boardIcon,
        iconColor: row.boardIconColor,
        viewerRole: readOnlyCredential ? "observer" : "editor",
        assignedItemsOnly: false,
        canAccessWorkspace: true,
      });
    }
  }

  const explicitRows = await db
    .select({
      boardId: boards.id,
      workspaceId: boards.workspaceId,
      workspaceName: workspaces.name,
      workspaceIcon: workspaces.icon,
      workspaceAccentColor: workspaces.accentColor,
      workspaceKind: workspaces.kind,
      clientId: clients.id,
      clientName: clients.name,
      boardName: boards.name,
      boardIcon: boards.icon,
      boardIconColor: boards.iconColor,
      role: boardMembers.role,
      assignedItemsOnly: boardMembers.assignedItemsOnly,
      workspaceMemberId: workspaceMembers.userId,
    })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, workspaces.clientId),
      eq(clientMembers.userId, auth.sub),
    ))
    .leftJoin(workspaceMembers, and(
      eq(workspaceMembers.workspaceId, workspaces.id),
      eq(workspaceMembers.userId, auth.sub),
    ))
    .where(and(
      eq(boardMembers.userId, auth.sub),
      or(
        and(
          eq(workspaces.clientId, auth.cid),
          isNull(clientMembers.suspendedAt),
          isNull(clientMembers.removedAt),
        ),
        isNull(clientMembers.userId),
      ),
      isNull(workspaces.archivedAt),
      isNull(boards.archivedAt),
    ))
    .orderBy(asc(workspaces.createdAt), asc(boards.position));

  for (const row of explicitRows) {
    if (byId.has(row.boardId)) continue;
    byId.set(row.boardId, {
      id: row.boardId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceIcon: row.workspaceIcon,
      workspaceAccentColor: row.workspaceAccentColor,
      workspaceKind: row.workspaceKind,
      clientId: row.clientId,
      clientName: row.clientName,
      name: row.boardName,
      icon: row.boardIcon,
      iconColor: row.boardIconColor,
      viewerRole: readOnlyCredential ? "observer" : row.role,
      assignedItemsOnly: row.assignedItemsOnly,
      canAccessWorkspace: row.clientId === auth.cid && Boolean(row.workspaceMemberId),
    });
  }

  return applyNavigationOrder(auth.cid, [...byId.values()]);
}

export function applyWorkScope(boardsInScope: AccessibleBoard[], scope: WorkScope | undefined): AccessibleBoard[] {
  if (!scope || scope.allAccessible) return boardsInScope;
  const organisationIds = new Set(scope.organisationIds);
  const workspaceIds = new Set(scope.workspaceIds);
  const boardIds = new Set(scope.boardIds);
  return boardsInScope.filter((board) =>
    organisationIds.has(board.clientId) || workspaceIds.has(board.workspaceId) || boardIds.has(board.id)
  );
}
