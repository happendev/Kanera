import { boardMembers, boardMirrors, users, workspaceMembers, workspaces, type BoardMirror } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { isOrgAdmin } from "../access.js";

export interface BoardMirrorAccess {
  sourceClientId: string;
  targetClientId: string;
  participates: boolean;
  manageSource: boolean;
  manageTarget: boolean;
}

function credentialCanAdminWorkspace(claims: AuthClaims, workspaceId: string, memberRole: "member" | "admin" | null): boolean {
  if (claims.apiKeyKind === "personal" && claims.apiKeyScope === "read") return false;
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") {
    return claims.apiKeyWorkspaceId === workspaceId && claims.apiKeyScope === "admin" && memberRole === "admin";
  }
  return isOrgAdmin(claims) || memberRole === "admin";
}

/** Resolve organisation visibility and each side's independent governance authority. */
export async function resolveBoardMirrorAccess(
  claims: AuthClaims,
  mirror: Pick<BoardMirror, "sourceWorkspaceId" | "targetWorkspaceId">,
): Promise<BoardMirrorAccess> {
  const rows = await db
    .select({ id: workspaces.id, clientId: workspaces.clientId, memberRole: workspaceMembers.role })
    .from(workspaces)
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, claims.sub)))
    .where(inArray(workspaces.id, [...new Set([mirror.sourceWorkspaceId, mirror.targetWorkspaceId])]))
    .limit(2);
  const source = rows.find((row) => row.id === mirror.sourceWorkspaceId);
  const target = rows.find((row) => row.id === mirror.targetWorkspaceId);
  // Missing workspaces are possible only during destructive cascades. Treat them as non-visible;
  // deletion callers resolve their audience before removing either workspace.
  const sourceClientId = source?.clientId ?? "";
  const targetClientId = target?.clientId ?? "";
  const participates = claims.cid === sourceClientId || claims.cid === targetClientId;
  return {
    sourceClientId,
    targetClientId,
    participates,
    manageSource: claims.cid === sourceClientId && !!source && credentialCanAdminWorkspace(claims, source.id, source.memberRole),
    manageTarget: claims.cid === targetClientId && !!target && credentialCanAdminWorkspace(claims, target.id, target.memberRole),
  };
}

export async function visibleBoardMirrorIds(boardId: string, clientId: string): Promise<string[]> {
  const rows = await db
    .select({ id: boardMirrors.id })
    .from(boardMirrors)
    .where(and(
      or(eq(boardMirrors.sourceBoardId, boardId), eq(boardMirrors.targetBoardId, boardId)),
      or(
        inArray(boardMirrors.sourceWorkspaceId, db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.clientId, clientId))),
        inArray(boardMirrors.targetWorkspaceId, db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.clientId, clientId))),
      ),
    ));
  return rows.map((row) => row.id);
}

/** Mirror metadata goes only to members whose organisation owns one of the participating sides. */
export async function mirrorBoardRealtimeAudience(boardId: string, clientIds: string[]): Promise<string[]> {
  if (clientIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: boardMembers.userId })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(and(
      eq(boardMembers.boardId, boardId),
      inArray(users.clientId, [...new Set(clientIds)]),
      isNull(users.removedAt),
      isNull(users.suspendedAt),
    ));
  return rows.map((row) => row.userId);
}
