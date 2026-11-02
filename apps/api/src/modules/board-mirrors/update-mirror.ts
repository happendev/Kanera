import type { dto } from "@kanera/shared";
import { ACTIVITY_ACTION, boardMirrorLists, boardMirrors } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertNoMirrorChain, lockMirrorTopology, NIL_UUID, recordMirrorActivities, type ManagedMirror, type MirrorListMappings } from "./route-support.js";

/**
 * `PATCH /boards/:boardId/mirrors/:mirrorId`: applies a pause/resume and/or replaces the list
 * mappings. Resuming re-validates the topology under the lock, since a paused relationship may
 * have admitted a reverse mirror in the meantime.
 */
export async function updateMirror({
  auth,
  mirror,
  body,
  mappings,
}: {
  auth: AuthClaims;
  mirror: ManagedMirror;
  body: dto.UpdateBoardMirrorBody;
  mappings: MirrorListMappings | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    if (body.paused === false && mirror.pausedAt) {
      await lockMirrorTopology(tx, mirror.sourceBoardId, mirror.targetBoardId);
      await assertNoMirrorChain(mirror.sourceBoardId, mirror.targetBoardId, tx, mirror.id);
    }
    await tx.update(boardMirrors).set({
      ...(body.paused === true && !mirror.pausedAt && { pausedAt: now }),
      ...(body.paused === false && mirror.pausedAt && {
        pausedAt: null,
        cursorEventCreatedAt: now,
        cursorEventId: NIL_UUID,
        reconcileRequestedAt: now,
      }),
      updatedAt: now,
    }).where(eq(boardMirrors.id, mirror.id));
    if (mappings) {
      await tx.delete(boardMirrorLists).where(eq(boardMirrorLists.mirrorId, mirror.id));
      await tx.insert(boardMirrorLists).values(mappings.map((mapping) => ({ mirrorId: mirror.id, ...mapping })));
    }
    await recordMirrorActivities(tx, {
      action: ACTIVITY_ACTION.MIRROR_UPDATED,
      mirrorId: mirror.id,
      sourceBoardId: mirror.sourceBoardId,
      sourceWorkspaceId: mirror.sourceWorkspaceId,
      targetBoardId: mirror.targetBoardId,
      targetWorkspaceId: mirror.targetWorkspaceId,
      actorId: auth.sub,
      payload: { ...(body.paused !== undefined && { paused: body.paused }), ...(mappings && { listsReplaced: true }) },
    });
  });
}
