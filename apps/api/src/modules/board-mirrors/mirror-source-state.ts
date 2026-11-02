import { ACTIVITY_ACTION, boardMirrors } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertNoMirrorChain, lockMirrorTopology, NIL_UUID, recordMirrorActivities, type ManagedMirror } from "./route-support.js";

/** `POST /boards/:boardId/mirrors/:mirrorId/source-disable`: the source side stops feeding the mirror. */
export async function disableMirrorSource({ auth, mirror }: { auth: AuthClaims; mirror: ManagedMirror }): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(boardMirrors).set({ sourceDisabledAt: now, sourceDisabledById: auth.sub, updatedAt: now }).where(eq(boardMirrors.id, mirror.id));
    await recordMirrorActivities(tx, { action: ACTIVITY_ACTION.MIRROR_DISABLED, mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, sourceWorkspaceId: mirror.sourceWorkspaceId, targetBoardId: mirror.targetBoardId, targetWorkspaceId: mirror.targetWorkspaceId, actorId: auth.sub });
  });
}

/**
 * `POST /boards/:boardId/mirrors/:mirrorId/source-enable`: the source side resumes from a fresh
 * cursor after re-validating the topology under the lock.
 */
export async function enableMirrorSource({ auth, mirror }: { auth: AuthClaims; mirror: ManagedMirror }): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockMirrorTopology(tx, mirror.sourceBoardId, mirror.targetBoardId);
    await assertNoMirrorChain(mirror.sourceBoardId, mirror.targetBoardId, tx, mirror.id);
    await tx.update(boardMirrors).set({ sourceDisabledAt: null, sourceDisabledById: null, cursorEventCreatedAt: now, cursorEventId: NIL_UUID, reconcileRequestedAt: now, updatedAt: now }).where(eq(boardMirrors.id, mirror.id));
    await recordMirrorActivities(tx, { action: ACTIVITY_ACTION.MIRROR_ENABLED, mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, sourceWorkspaceId: mirror.sourceWorkspaceId, targetBoardId: mirror.targetBoardId, targetWorkspaceId: mirror.targetWorkspaceId, actorId: auth.sub });
  });
}
