import { ACTIVITY_ACTION, boardMirrors } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { deleteExternalLinks } from "../../lib/external-links.js";
import { mirrorProvider, recordMirrorActivities, type ManagedMirror } from "./route-support.js";

/**
 * `DELETE /boards/:boardId/mirrors/:mirrorId`: removes the durable link and its card provenance
 * links; the already-created target cards are left intact.
 */
export async function deleteMirror({ auth, mirror }: { auth: AuthClaims; mirror: ManagedMirror }): Promise<void> {
  await db.transaction(async (tx) => {
    await recordMirrorActivities(tx, { action: ACTIVITY_ACTION.MIRROR_DELETED, mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, sourceWorkspaceId: mirror.sourceWorkspaceId, targetBoardId: mirror.targetBoardId, targetWorkspaceId: mirror.targetWorkspaceId, actorId: auth.sub });
    await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: mirrorProvider(mirror.id) }, tx);
    await tx.delete(boardMirrors).where(eq(boardMirrors.id, mirror.id));
  });
}
