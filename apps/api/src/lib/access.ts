import { requestContext } from "@fastify/request-context";
import {
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cards,
  clientMembers,
  clients,
  workspaceMembers,
  workspaces,
  type BoardRole,
  type Card,
  type ClientBillingStatus,
  type ClientRole,
  type WorkspaceRole,
} from "@kanera/shared/schema";
import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { isPaidTier } from "./entitlements.js";
import { forbidden, notFound, wrongOrg } from "./errors.js";

// Prepared once per process; plan is cached per connection in the pg pool.
const boardAccessQuery = db
  .select({
    boardRole: boardMembers.role,
    assignedItemsOnly: boardMembers.assignedItemsOnly,
    workspaceRole: workspaceMembers.role,
    boardId: boards.id,
    boardArchivedAt: boards.archivedAt,
    workspaceId: boards.workspaceId,
    clientId: workspaces.clientId,
    orgName: clients.name,
    clientBillingStatus: clients.billingStatus,
    clientSuspendedAt: clients.suspendedAt,
    clientDeletedAt: clients.deletedAt,
    currentOrgRole: clientMembers.clientRole,
    currentOrgSuspendedAt: clientMembers.suspendedAt,
    currentOrgRemovedAt: clientMembers.removedAt,
  })
  .from(boards)
  .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
  .innerJoin(clients, eq(clients.id, workspaces.clientId))
  .leftJoin(clientMembers, and(
    eq(clientMembers.clientId, workspaces.clientId),
    eq(clientMembers.userId, sql.placeholder("userId")),
  ))
  .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, sql.placeholder("userId"))))
  .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, sql.placeholder("userId"))))
  .where(eq(boards.id, sql.placeholder("boardId")))
  .limit(1)
  .prepare("boardAccess");

const workspaceAccessQuery = db
  .select({
    workspaceId: workspaces.id,
    clientId: workspaces.clientId,
    orgName: clients.name,
    clientBillingStatus: clients.billingStatus,
    clientSuspendedAt: clients.suspendedAt,
    clientDeletedAt: clients.deletedAt,
    role: workspaceMembers.role,
    currentOrgRole: clientMembers.clientRole,
    currentOrgSuspendedAt: clientMembers.suspendedAt,
    currentOrgRemovedAt: clientMembers.removedAt,
  })
  .from(workspaces)
  .innerJoin(clients, eq(clients.id, workspaces.clientId))
  .leftJoin(clientMembers, and(
    eq(clientMembers.clientId, workspaces.clientId),
    eq(clientMembers.userId, sql.placeholder("userId")),
  ))
  .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, sql.placeholder("userId"))))
  .where(eq(workspaces.id, sql.placeholder("workspaceId")))
  .limit(1)
  .prepare("workspaceAccess");

// Roles are two-tier per scope. Workspace: `member` (0) has no workspace-scoped mutation rights and
// exists only to be added to boards; `admin` (1) manages everything workspace-scoped. Board:
// `observer` (0) is read-only, `editor` (1) can mutate board content. Board-admin power is not a
// board role — it comes from being a workspace admin (see isWorkspaceAdmin on the board context).
const WORKSPACE_RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1 };
const BOARD_RANK: Record<BoardRole, number> = { observer: 0, editor: 1 };
const ORG_RANK: Record<ClientRole, number> = { member: 0, admin: 1, owner: 2 };

// API-key scope maps to a role per scope. Workspace: only an `admin` scope can perform
// workspace-scoped writes; read/write are plain members. Board: read is read-only, write/admin edit.
const API_KEY_WORKSPACE_ROLE: Record<"read" | "write" | "admin", WorkspaceRole> = {
  read: "member",
  write: "member",
  admin: "admin",
};
const API_KEY_BOARD_ROLE: Record<"read" | "write" | "admin", BoardRole> = {
  read: "observer",
  write: "editor",
  admin: "editor",
};

function assertWorkspaceRank(role: WorkspaceRole | null | undefined, minRole: WorkspaceRole) {
  if (!role || WORKSPACE_RANK[role] < WORKSPACE_RANK[minRole]) throw forbidden();
}

function assertBoardRank(role: BoardRole | null | undefined, minRole: BoardRole) {
  if (!role || BOARD_RANK[role] < BOARD_RANK[minRole]) throw forbidden();
}

export function isOrgAdmin(claims: AuthClaims): boolean {
  // Personal credentials act as their owner. Workspace keys remain deliberately unable to borrow
  // their creator's organisation-wide authority beyond the workspace and scope pinned to the key.
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") return false;
  return ORG_RANK[claims.role] >= ORG_RANK.admin;
}

// Whether an org role ranks as admin independent of credential kind. This remains useful when a
// query needs role ranking without granting a workspace key its creator's organisation authority.
export function orgRoleRanksAdmin(role: ClientRole): boolean {
  return ORG_RANK[role] >= ORG_RANK.admin;
}

export function assertOrgRole(claims: AuthClaims, minRole: ClientRole) {
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") throw forbidden();
  if (claims.apiKeyKind === "personal" && claims.apiKeyScope === "read" && ORG_RANK[minRole] > ORG_RANK.member) throw forbidden();
  if (ORG_RANK[claims.role] < ORG_RANK[minRole]) throw forbidden();
}

function assertOrganisationContext(
  claims: AuthClaims,
  row: {
    clientId: string;
    orgName: string;
    currentOrgRole: ClientRole | null;
    currentOrgSuspendedAt: Date | null;
    currentOrgRemovedAt: Date | null;
    clientBillingStatus: ClientBillingStatus;
    clientSuspendedAt: Date | null;
    clientDeletedAt: Date | null;
  },
) {
  // A board row deliberately survives plan suspension so it can be restored later. Membership
  // existence and membership activity must therefore be distinguished: only no membership at all
  // is true guest access, while a suspended/removed member is denied before board grants are read.
  if (row.currentOrgRole && (row.currentOrgSuspendedAt || row.currentOrgRemovedAt)) throw forbidden();
  if (row.clientSuspendedAt || row.clientDeletedAt) throw forbidden();
  if (claims.authKind === "apiKey" && env.KANERA_DEPLOYMENT_MODE === "hosted" && !isPaidTier(row.clientBillingStatus)) {
    throw forbidden();
  }

  if (claims.apiKeyKind === "personal") {
    // Personal credentials are identity-wide. Rebase the per-request context to the resource owner
    // so downstream storage, media, activity, and entitlement code uses the target organisation.
    // A true board guest has no organisation role and must never inherit admin power from the
    // credential's default organisation.
    claims.cid = row.clientId;
    claims.role = row.currentOrgRole ?? "member";
    requestContext.set("clientId", row.clientId);
    return;
  }
  if (row.clientId !== claims.cid && row.currentOrgRole) {
    // Interactive app users can switch and retry. The only API credentials reaching this branch
    // are workspace credentials; identity-wide personal credentials were rebased above.
    if (claims.authKind === "apiKey") throw forbidden();
    throw wrongOrg(row.clientId, row.orgName);
  }
}

export async function assertWorkspaceAccess(
  claims: AuthClaims,
  workspaceId: string,
  minRole: WorkspaceRole = "member",
) {
  const [row] = await workspaceAccessQuery.execute({ workspaceId, userId: claims.sub });
  if (!row) throw notFound("workspace not found");
  assertOrganisationContext(claims, row);

  // Workspace keys are pinned + scope-mapped. Personal keys are handled by the normal-user paths
  // below (keyed off claims.sub) and inherit the owner's current workspace permissions.
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") {
    if (claims.apiKeyWorkspaceId !== row.workspaceId) throw forbidden();
    // The key's owning user must still be a workspace member of the key's workspace.
    assertWorkspaceRank(row.role, "member");
    const apiRole = API_KEY_WORKSPACE_ROLE[claims.apiKeyScope ?? "read"];
    assertWorkspaceRank(apiRole, minRole);
    requestContext.set("workspaceId", row.workspaceId);
    return { workspaceId: row.workspaceId, clientId: row.clientId, role: apiRole };
  }

  const isPersonalKey = claims.apiKeyKind === "personal";
  // Interactive OAuth can be read-only. Legacy personal API keys have no explicit scope and retain
  // their owner's full effective permissions.
  if (isPersonalKey && claims.apiKeyScope === "read" && WORKSPACE_RANK[minRole] > WORKSPACE_RANK.member) throw forbidden();

  if (row.currentOrgRole === "owner" || row.currentOrgRole === "admin") {
    requestContext.set("workspaceId", row.workspaceId);
    return { workspaceId: row.workspaceId, clientId: row.clientId, role: "admin" as WorkspaceRole };
  }

  assertWorkspaceRank(row.role, minRole);
  requestContext.set("workspaceId", row.workspaceId);
  return { workspaceId: row.workspaceId, clientId: row.clientId, role: row.role! };
}

export async function assertBoardAccess(
  claims: AuthClaims,
  boardId: string,
  minRole: BoardRole = "observer",
) {
  const [row] = await boardAccessQuery.execute({ boardId, userId: claims.sub });

  if (!row) throw notFound("board not found");
  assertOrganisationContext(claims, row);
  // Plan-downgraded boards are hidden from the product surface and must not remain reachable by
  // direct URL/API calls. They can become visible again only through the plan restoration flow.
  if (row.boardArchivedAt) throw notFound("board not found");

  // Workspace keys are pinned + scope-mapped. Personal keys fall through to the normal-user paths
  // below (keyed off claims.sub) so they inherit the owner's real per-board editor/observer role.
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") {
    if (claims.apiKeyWorkspaceId !== row.workspaceId) throw forbidden();
    assertWorkspaceRank(row.workspaceRole, "member");
    if (claims.apiKeyScope === "read" && BOARD_RANK[minRole] > BOARD_RANK.observer) {
      throw forbidden("write-capable credential required");
    }
    const apiRole = API_KEY_BOARD_ROLE[claims.apiKeyScope ?? "read"];
    assertBoardRank(apiRole, minRole);
    requestContext.set("workspaceId", row.workspaceId);
    // An admin-scoped key acts with workspace-admin authority for board-management routes.
    return { boardId: row.boardId, workspaceId: row.workspaceId, clientId: row.clientId, role: apiRole, source: "workspace" as const, canAccessWorkspace: true, isWorkspaceAdmin: claims.apiKeyScope === "admin", assignedItemsOnly: false };
  }

  // A read-only OAuth grant cannot mutate board content or perform board management. Personal API
  // keys without an explicit scope and write-scoped OAuth grants inherit the owner's permissions.
  const isPersonalKey = claims.apiKeyKind === "personal";
  if (isPersonalKey && claims.apiKeyScope === "read" && BOARD_RANK[minRole] > BOARD_RANK.observer) {
    throw forbidden("write-capable credential required");
  }

  if (row.currentOrgRole === "owner" || row.currentOrgRole === "admin") {
    requestContext.set("workspaceId", row.workspaceId);
    // Org owners/admins manage every board in every workspace owned by their organisation. Keep
    // this effective permission true even when they have no workspace_members row of their own.
    return { boardId: row.boardId, workspaceId: row.workspaceId, clientId: row.clientId, role: "editor" as BoardRole, source: "workspace" as const, canAccessWorkspace: true, isWorkspaceAdmin: !(isPersonalKey && claims.apiKeyScope === "read"), assignedItemsOnly: false };
  }

  // Explicit board membership is the sole content-access model for normal users: a `board_member`
  // row grants access at its role (editor/observer), and no row means no access. Workspace admins
  // are materialized as pinned editor rows on every board (board-membership.ts), so their content
  // access flows through the row too; their board-admin authority is surfaced via isWorkspaceAdmin.
  assertBoardRank(row.boardRole, minRole);

  requestContext.set("workspaceId", row.workspaceId);
  return {
    boardId: row.boardId,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    role: row.boardRole!,
    source: "board" as const,
    // Same-org members can reach workspace-scoped endpoints; cross-org guests (no workspaceRole)
    // cannot. Clients use this to avoid probing workspace routes a guest would be forbidden from.
    canAccessWorkspace: row.clientId === claims.cid && !!row.workspaceRole,
    // Board-management actions require the owner's workspace-admin grant. A read-only OAuth grant
    // is capped even when its owner is an administrator.
    isWorkspaceAdmin: row.clientId === claims.cid && row.workspaceRole === "admin" && !(isPersonalKey && claims.apiKeyScope === "read"),
    assignedItemsOnly: row.assignedItemsOnly ?? false,
  };
}

/** SQL predicate shared by every card collection so restricted access cannot drift by endpoint. */
export function assignedCardVisibility(userId: string, cardId: SQLWrapper = cards.id) {
  return sql<boolean>`(
    exists (select 1 from ${cardAssignees}
      where ${cardAssignees.cardId} = ${cardId} and ${cardAssignees.userId} = ${userId})
    or exists (select 1 from ${cardChecklistItems}
      inner join ${cardChecklists} on ${cardChecklists.id} = ${cardChecklistItems.checklistId}
      where ${cardChecklists.cardId} = ${cardId} and ${cardChecklistItems.assigneeId} = ${userId})
  )`;
}

/**
 * Accepts an already-loaded card so callers holding the row do not pay for a second read of it.
 * Detail reads and comment routes select the whole card first, then called this with only its id,
 * which re-read `board_id` purely to feed `assertBoardAccess` — an extra round-trip before the
 * six-table board join even starts.
 */
export async function assertCardAccess(
  claims: AuthClaims,
  card: string | Pick<Card, "id" | "boardId">,
  minRole: BoardRole = "observer",
) {
  let cardId: string;
  let boardId: string;
  if (typeof card === "string") {
    cardId = card;
    const [row] = await db.select({ boardId: cards.boardId }).from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!row) throw notFound("card not found");
    boardId = row.boardId;
  } else {
    cardId = card.id;
    boardId = card.boardId;
  }
  const ctx = await assertBoardAccess(claims, boardId, minRole);
  if (ctx.assignedItemsOnly) {
    const [visible] = await db.select({ id: cards.id }).from(cards)
      .where(and(eq(cards.id, cardId), assignedCardVisibility(claims.sub)))
      .limit(1);
    if (!visible) throw forbidden();
  }
  return { ...ctx, cardId };
}

/**
 * Per-card visibility for a batch whose board access is already established for the whole request.
 *
 * Bulk endpoints assert board access once, verify every card belongs to that board, and then used to
 * call `assertCardAccess` per item — re-reading the card and re-running the board join for a decision
 * already made for the batch. The only genuinely per-card rule is the assigned-items-only
 * restriction, and one `inArray` probe settles it for the whole batch instead of two queries per
 * card. Callers must still have checked `card.boardId === boardId` themselves: this deliberately
 * does not re-establish which board the cards are on.
 */
export async function assertBatchCardVisibility(
  claims: AuthClaims,
  ctx: { assignedItemsOnly: boolean },
  cardIds: readonly string[],
): Promise<void> {
  if (!ctx.assignedItemsOnly) return;
  const unique = [...new Set(cardIds)];
  if (unique.length === 0) return;
  const visible = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(inArray(cards.id, unique), assignedCardVisibility(claims.sub)));
  if (visible.length !== unique.length) throw forbidden();
}

/**
 * Assert the caller may perform board-management actions (rename/delete a board, manage its
 * membership). These are workspace-admin actions, not board-role actions. Returns the same context
 * as assertBoardAccess. Throws forbidden() for board members who are not workspace admins.
 */
export async function assertBoardManageAccess(claims: AuthClaims, boardId: string) {
  const ctx = await assertBoardAccess(claims, boardId);
  if (!ctx.isWorkspaceAdmin) throw forbidden();
  return ctx;
}
