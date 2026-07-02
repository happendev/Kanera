import { requestContext } from "@fastify/request-context";
import {
  boardMembers,
  boards,
  workspaceMembers,
  workspaces,
  type ClientRole,
  type MemberRole,
} from "@kanera/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { forbidden, notFound } from "./errors.js";

// Prepared once per process; plan is cached per connection in the pg pool.
const boardAccessQuery = db
  .select({
    boardRole: boardMembers.role,
    workspaceRole: workspaceMembers.role,
    boardId: boards.id,
    workspaceId: boards.workspaceId,
    clientId: workspaces.clientId,
    visibility: boards.visibility,
  })
  .from(boards)
  .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
  .leftJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, sql.placeholder("userId"))))
  .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, sql.placeholder("userId"))))
  .where(eq(boards.id, sql.placeholder("boardId")))
  .limit(1)
  .prepare("boardAccess");

const workspaceAccessQuery = db
  .select({ workspaceId: workspaces.id, clientId: workspaces.clientId, role: workspaceMembers.role })
  .from(workspaces)
  .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, sql.placeholder("userId"))))
  .where(eq(workspaces.id, sql.placeholder("workspaceId")))
  .limit(1)
  .prepare("workspaceAccess");

export type Role = MemberRole;
const RANK: Record<Role, number> = { observer: 0, editor: 1, admin: 2, owner: 3 };
const ORG_RANK: Record<ClientRole, number> = { member: 0, admin: 1, owner: 2 };
const API_KEY_ROLE: Record<"read" | "write" | "admin", Role> = {
  read: "observer",
  write: "editor",
  admin: "admin",
};

function assertRank(role: Role | null | undefined, minRole: Role) {
  if (!role || RANK[role] < RANK[minRole]) throw forbidden();
}

export function isOrgAdmin(claims: AuthClaims): boolean {
  if (claims.authKind === "apiKey") return false;
  return ORG_RANK[claims.role] >= ORG_RANK.admin;
}

export function assertOrgRole(claims: AuthClaims, minRole: ClientRole) {
  if (claims.authKind === "apiKey") throw forbidden();
  if (ORG_RANK[claims.role] < ORG_RANK[minRole]) throw forbidden();
}

export async function assertWorkspaceAccess(
  claims: AuthClaims,
  workspaceId: string,
  minRole: Role = "observer",
) {
  const [row] = await workspaceAccessQuery.execute({ workspaceId, userId: claims.sub });
  if (!row) throw notFound("workspace not found");

  if (claims.authKind === "apiKey") {
    if (claims.apiKeyWorkspaceId !== row.workspaceId) throw forbidden();
    assertRank(row.role, "observer");
    const apiRole = API_KEY_ROLE[claims.apiKeyScope ?? "read"];
    assertRank(apiRole, minRole);
    requestContext.set("workspaceId", row.workspaceId);
    return { workspaceId: row.workspaceId, clientId: row.clientId, role: apiRole };
  }

  if (isOrgAdmin(claims) && row.clientId === claims.cid) {
    requestContext.set("workspaceId", row.workspaceId);
    return { workspaceId: row.workspaceId, clientId: row.clientId, role: "owner" as Role };
  }

  // Defense-in-depth: a workspace member must belong to the same org as the workspace.
  // Workspace membership creation already enforces the one-org-per-user invariant, but assert
  // it here too so a future bug that crosses orgs can't silently become cross-tenant access.
  if (row.clientId !== claims.cid) throw forbidden();
  assertRank(row.role, minRole);
  requestContext.set("workspaceId", row.workspaceId);
  return { workspaceId: row.workspaceId, clientId: row.clientId, role: row.role! };
}

export async function assertBoardAccess(
  claims: AuthClaims,
  boardId: string,
  minRole: Role = "observer",
) {
  const [row] = await boardAccessQuery.execute({ boardId, userId: claims.sub });

  if (!row) throw notFound("board not found");

  if (claims.authKind === "apiKey") {
    if (claims.apiKeyWorkspaceId !== row.workspaceId) throw forbidden();
    assertRank(row.workspaceRole, "observer");
    const apiRole = API_KEY_ROLE[claims.apiKeyScope ?? "read"];
    assertRank(apiRole, minRole);
    requestContext.set("workspaceId", row.workspaceId);
    return { boardId: row.boardId, workspaceId: row.workspaceId, clientId: row.clientId, role: apiRole, source: "workspace" as const, canAccessWorkspace: true };
  }

  if (isOrgAdmin(claims) && row.clientId === claims.cid) {
    requestContext.set("workspaceId", row.workspaceId);
    return { boardId: row.boardId, workspaceId: row.workspaceId, clientId: row.clientId, role: "owner" as Role, source: "workspace" as const, canAccessWorkspace: true };
  }

  // For workspace-visible boards, fall back to explicit board role so cross-org
  // guests (who have boardRole but no workspaceRole) can still access.
  const source: "board" | "workspace" = row.visibility === "private" || !row.workspaceRole ? "board" : "workspace";
  const role = source === "board" ? row.boardRole : row.workspaceRole;
  // Cross-org board guests are intentional: they hold a boardRole without a workspaceRole, so we
  // do NOT require same-org for "board"-sourced access. But access granted via workspace
  // membership must stay within the same org (one-org-per-user invariant) — enforce it there.
  if (source === "workspace" && row.clientId !== claims.cid) throw forbidden();
  assertRank(role, minRole);

  requestContext.set("workspaceId", row.workspaceId);
  return {
    boardId: row.boardId,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    role: role!,
    source,
    // A private-board member can still be a normal workspace member. Keep that distinct from
    // cross-org guests so clients do not probe workspace-scoped endpoints the guest cannot use.
    canAccessWorkspace: row.clientId === claims.cid && !!row.workspaceRole,
  };
}
