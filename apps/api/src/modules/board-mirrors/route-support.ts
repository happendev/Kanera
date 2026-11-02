import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { boardMirrors, lists, workspaces, type ACTIVITY_ACTION } from "@kanera/shared/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Tx } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { recordActivity } from "../../lib/activity.js";
import { resolveBoardMirrorAccess } from "../../lib/board-mirror/access.js";
import { emitMirrorMetadataToBoards } from "../../lib/board-mirror/events.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function mirrorProvider(mirrorId: string): string {
  return `mirror:${mirrorId}`;
}

export async function sortInNavigationOrder<T extends { id: string }>(auth: AuthClaims, rows: T[]): Promise<T[]> {
  // Target discovery applies stricter edit, plan, and topology filters than general navigation,
  // but the surviving boards must retain the sidebar's one canonical relative order.
  const ranks = new Map((await loadAccessibleBoards(auth)).map((board) => [board.id, board.navigationOrder]));
  return rows
    .map((row, fallbackOrder) => ({ row, fallbackOrder }))
    .sort((a, b) =>
      (ranks.get(a.row.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.row.id) ?? Number.MAX_SAFE_INTEGER)
      || a.fallbackOrder - b.fallbackOrder
    )
    .map(({ row }) => row);
}

export async function emitMirrorEntityToBoards(
  event: typeof SERVER_EVENTS.BOARD_MIRROR_CREATED | typeof SERVER_EVENTS.BOARD_MIRROR_UPDATED,
  mirror: dto.BoardMirrorRow,
) {
  // A mirror has two equally live board contexts. Publish a durable board-scoped event for each so
  // either open board refreshes its header and management dialog, including across API processes.
  await emitMirrorMetadataToBoards(mirror, event, { mirror });
}

export async function emitMirrorDeletedToBoards(mirror: Pick<dto.BoardMirrorRow, "id" | "sourceBoardId" | "targetBoardId" | "sourceWorkspaceId" | "targetWorkspaceId">) {
  const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
  await emitMirrorMetadataToBoards(mirror, SERVER_EVENTS.BOARD_MIRROR_DELETED, payload);
}

export async function assertNoMirrorChain(sourceBoardId: string, targetBoardId: string, tx: Tx = db, excludeMirrorId?: string) {
  const [chain] = await tx
    .select({ id: boardMirrors.id })
    .from(boardMirrors)
    .where(and(
      excludeMirrorId ? sql`${boardMirrors.id} <> ${excludeMirrorId}` : undefined,
      or(
        // Board roles belong to the durable relationship, not its current switches. Otherwise a
        // paused A -> B mirror could admit B -> A and leave a loop waiting to be re-enabled.
        eq(boardMirrors.sourceBoardId, targetBoardId),
        eq(boardMirrors.targetBoardId, sourceBoardId),
      ),
    ))
    .limit(1);
  if (chain) throw conflict("a board cannot be both a mirror source and a mirror target");
}

export async function lockMirrorTopology(tx: Tx, sourceBoardId: string, targetBoardId: string) {
  // Topology validation spans multiple rows, so uniqueness cannot serialize reciprocal creates.
  // Lock both board identities in a stable order for the transaction: concurrent A->B and B->A
  // attempts then observe one another's committed topology instead of both passing a stale check.
  for (const boardId of [sourceBoardId, targetBoardId].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${boardId}, 0::bigint))`);
  }
}

export async function normalizeListMappings(
  input: dto.BoardMirrorListInput[],
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  database: Tx = db,
) {
  const sourceIds = input.map((row) => row.sourceListId);
  if (new Set(sourceIds).size !== sourceIds.length) throw badRequest("source lists must be unique");

  const sourceRows = await database
    .select({ id: lists.id, archivedAt: lists.archivedAt })
    .from(lists)
    .where(and(eq(lists.workspaceId, sourceWorkspaceId), inArray(lists.id, sourceIds)));
  if (sourceRows.length !== sourceIds.length) throw badRequest("one or more source lists are not in the source workspace");
  if (sourceRows.some((row) => row.archivedAt)) throw badRequest("archived source lists cannot be mirrored");

  const sameWorkspace = sourceWorkspaceId === targetWorkspaceId;
  const mappings = input.map((row) => ({
    sourceListId: row.sourceListId,
    // Lists are workspace-scoped, so a same-workspace mirror is always identity-mapped. Ignoring an
    // explicit different id keeps API callers aligned with the UI's hidden target-list selector.
    targetListId: sameWorkspace ? row.sourceListId : (row.targetListId ?? ""),
  }));
  if (mappings.some((row) => !row.targetListId)) throw badRequest("targetListId is required for cross-workspace mirrors");

  const targetIds = [...new Set(mappings.map((row) => row.targetListId))];
  const targetRows = await database
    .select({ id: lists.id, archivedAt: lists.archivedAt })
    .from(lists)
    .where(and(eq(lists.workspaceId, targetWorkspaceId), inArray(lists.id, targetIds)));
  if (targetRows.length !== targetIds.length) throw badRequest("one or more target lists are not in the target workspace");
  if (targetRows.some((row) => row.archivedAt)) throw badRequest("archived target lists cannot be selected");
  return mappings;
}

export type MirrorListMappings = Awaited<ReturnType<typeof normalizeListMappings>>;

export async function recordMirrorActivities(
  tx: Tx,
  input: {
    action: typeof ACTIVITY_ACTION.MIRROR_CREATED | typeof ACTIVITY_ACTION.MIRROR_UPDATED | typeof ACTIVITY_ACTION.MIRROR_DELETED | typeof ACTIVITY_ACTION.MIRROR_DISABLED | typeof ACTIVITY_ACTION.MIRROR_ENABLED;
    mirrorId: string;
    sourceBoardId: string;
    sourceWorkspaceId: string;
    targetBoardId: string;
    targetWorkspaceId: string;
    actorId: string;
    payload?: Record<string, unknown>;
  },
) {
  const organisationRows = await tx
    .select({ id: workspaces.id, clientId: workspaces.clientId })
    .from(workspaces)
    .where(inArray(workspaces.id, [...new Set([input.sourceWorkspaceId, input.targetWorkspaceId])]))
    .limit(2);
  const sourceClientId = organisationRows.find((workspace) => workspace.id === input.sourceWorkspaceId)?.clientId;
  const targetClientId = organisationRows.find((workspace) => workspace.id === input.targetWorkspaceId)?.clientId;
  const visibilityPayload = { sourceClientId, targetClientId };
  // A transaction is backed by one pg client, so keep the two audit writes sequential.
  await recordActivity(tx, {
      boardId: input.sourceBoardId,
      workspaceId: input.sourceWorkspaceId,
      actorId: input.actorId,
      entityType: "board",
      entityId: input.sourceBoardId,
      action: input.action,
      payload: { mirrorId: input.mirrorId, targetBoardId: input.targetBoardId, ...visibilityPayload, ...input.payload },
    });
  await recordActivity(tx, {
      boardId: input.targetBoardId,
      workspaceId: input.targetWorkspaceId,
      actorId: input.actorId,
      entityType: "board",
      entityId: input.targetBoardId,
      action: input.action,
      payload: { mirrorId: input.mirrorId, sourceBoardId: input.sourceBoardId, ...visibilityPayload, ...input.payload },
    });
}

export async function loadManagedMirror(mirrorId: string, boardId: string) {
  const [mirror] = await db
    .select()
    .from(boardMirrors)
    .where(and(
      eq(boardMirrors.id, mirrorId),
      or(eq(boardMirrors.sourceBoardId, boardId), eq(boardMirrors.targetBoardId, boardId)),
    ))
    .limit(1);
  if (!mirror) throw notFound("board mirror not found");
  return mirror;
}

export type ManagedMirror = Awaited<ReturnType<typeof loadManagedMirror>>;

export async function assertMirrorCapability(
  claims: AuthClaims,
  mirror: ManagedMirror,
  capability: "source" | "target" | "either",
) {
  const access = await resolveBoardMirrorAccess(claims, mirror);
  const allowed = capability === "source"
    ? access.manageSource
    : capability === "target"
      ? access.manageTarget
      : access.manageSource || access.manageTarget;
  if (!allowed) throw forbidden();
  return access;
}
