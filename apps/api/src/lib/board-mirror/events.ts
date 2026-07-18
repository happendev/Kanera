import type { ServerToClientEvents } from "@kanera/shared/events";
import { workspaces, type BoardMirror } from "@kanera/shared/schema";
import { inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { emitToFilteredBoardAudience } from "../../realtime/emit.js";
import { mirrorBoardRealtimeAudience } from "./access.js";

type MirrorMetadataEvent =
  | "boardMirror:created"
  | "boardMirror:updated"
  | "boardMirror:deleted"
  | "cardMirror:linked"
  | "cardMirror:unlinked";

/**
 * Mirror relationship metadata is confidential to the organisations owning either side. Each
 * board still receives its durable outbox row so webhook behavior and replay auditing stay intact.
 */
export async function emitMirrorMetadataToBoards<E extends MirrorMetadataEvent>(
  mirror: Pick<BoardMirror, "sourceBoardId" | "targetBoardId" | "sourceWorkspaceId" | "targetWorkspaceId">,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
) {
  const workspaceRows = await db
    .select({ id: workspaces.id, clientId: workspaces.clientId })
    .from(workspaces)
    .where(inArray(workspaces.id, [...new Set([mirror.sourceWorkspaceId, mirror.targetWorkspaceId])]))
    .limit(2);
  const clientIds = [...new Set(workspaceRows.map((workspace) => workspace.clientId))];
  await Promise.all([...new Set([mirror.sourceBoardId, mirror.targetBoardId])].map(async (boardId) => {
    const audience = await mirrorBoardRealtimeAudience(boardId, clientIds);
    await emitToFilteredBoardAudience(boardId, event, payload, audience);
  }));
}
