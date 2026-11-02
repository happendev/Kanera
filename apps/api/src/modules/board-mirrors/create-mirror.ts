import { ACTIVITY_ACTION, boardMirrorLists, boardMirrors, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertBoardAccess, assertBoardManageAccess } from "../../lib/access.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { assertBoardSyncAllowed } from "../../lib/tier-limits.js";
import { assertNoMirrorChain, lockMirrorTopology, NIL_UUID, recordMirrorActivities, type MirrorListMappings } from "./route-support.js";

/**
 * `POST /boards/:boardId/mirrors`: creates the durable source -> target relationship and its list
 * mappings under the topology lock. Returns the inserted mirror row.
 */
export async function createMirror({
  auth,
  sourceBoardId,
  targetBoardId,
  sourceCtx,
  targetCtx,
  mappings,
}: {
  auth: AuthClaims;
  sourceBoardId: string;
  targetBoardId: string;
  sourceCtx: Awaited<ReturnType<typeof assertBoardAccess>>;
  targetCtx: Awaited<ReturnType<typeof assertBoardManageAccess>>;
  mappings: MirrorListMappings;
}) {
  return db.transaction(async (tx) => {
    await lockMirrorTopology(tx, sourceBoardId, targetBoardId);
    await assertBoardSyncAllowed([sourceCtx.clientId, targetCtx.clientId], tx);
    const participatingWorkspaces = await tx
      .select({ id: workspaces.id, boardLinkingEnabled: workspaces.boardLinkingEnabled })
      .from(workspaces)
      .where(inArray(workspaces.id, [...new Set([sourceCtx.workspaceId, targetCtx.workspaceId])]));
    // Both owners opt in: a workspace that disables linking cannot be used as either side of a
    // relationship, including through a stale dialog that was opened before the setting changed.
    if (participatingWorkspaces.length === 0 || participatingWorkspaces.some((workspace) => !workspace.boardLinkingEnabled)) {
      throw badRequest("board linking is disabled for one or more participating workspaces");
    }
    const [existing] = await tx
      .select({ id: boardMirrors.id })
      .from(boardMirrors)
      .where(and(eq(boardMirrors.sourceBoardId, sourceBoardId), eq(boardMirrors.targetBoardId, targetBoardId)))
      .limit(1);
    if (existing) throw conflict("this board mirror already exists");
    await assertNoMirrorChain(sourceBoardId, targetBoardId, tx);
    const now = new Date();
    const [created] = await tx.insert(boardMirrors).values({
      sourceBoardId,
      targetBoardId,
      sourceWorkspaceId: sourceCtx.workspaceId,
      targetWorkspaceId: targetCtx.workspaceId,
      createdById: auth.sub,
      cursorEventCreatedAt: now,
      cursorEventId: NIL_UUID,
      lastSyncAt: now,
    }).returning();
    await tx.insert(boardMirrorLists).values(mappings.map((mapping) => ({ mirrorId: created!.id, ...mapping })));
    await recordMirrorActivities(tx, {
      action: ACTIVITY_ACTION.MIRROR_CREATED,
      mirrorId: created!.id,
      sourceBoardId,
      sourceWorkspaceId: sourceCtx.workspaceId,
      targetBoardId,
      targetWorkspaceId: targetCtx.workspaceId,
      actorId: auth.sub,
    });
    return created!;
  });
}
