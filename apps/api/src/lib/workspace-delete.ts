import { boardMembers, boardMirrors, boards, cards, users, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "../db.js";
import { emitToBoardAudience, emitToWorkspace } from "../realtime/emit.js";
import { emitMirrorMetadataToBoards } from "./board-mirror/events.js";
import { deleteAttachmentFiles } from "./attachment-cleanup.js";
import { deleteExternalLinks } from "./external-links.js";
import { prunePaidGuestSeatIfBelowLimit } from "./paid-guest-seats.js";
import { reactivatePlanArchivedBoardsIfRoom } from "./plan-conversion.js";
import { getStorageForClient } from "./storage/index.js";

export async function deleteWorkspaceCascade(params: { workspaceId: string; clientId: string }) {
  const workspaceBoards = await db
    .select({ id: boards.id })
    .from(boards)
    .where(eq(boards.workspaceId, params.workspaceId));
  const boardIds = workspaceBoards.map((board) => board.id);
  const removedMirrors = await db.select().from(boardMirrors).where(or(
    eq(boardMirrors.sourceWorkspaceId, params.workspaceId),
    eq(boardMirrors.targetWorkspaceId, params.workspaceId),
  ));

  let externalUserIds: string[] = [];
  if (boardIds.length > 0) {
    const [allCards, externalMembers] = await Promise.all([
      db.select({ id: cards.id }).from(cards).where(inArray(cards.boardId, boardIds)),
      db
        .selectDistinct({ userId: boardMembers.userId })
        .from(boardMembers)
        .innerJoin(users, eq(users.id, boardMembers.userId))
        .where(and(inArray(boardMembers.boardId, boardIds), ne(users.clientId, params.clientId))),
    ]);
    externalUserIds = externalMembers.map((row) => row.userId);
    const storage = await getStorageForClient(params.clientId);
    await deleteAttachmentFiles(storage, allCards.map((card) => card.id));
  }

  for (const mirror of removedMirrors) {
    await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: `mirror:${mirror.id}` });
    await db.delete(boardMirrors).where(eq(boardMirrors.id, mirror.id));
    const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
    // Cross-workspace peers must learn that the relationship disappeared even though this entire
    // workspace is about to be removed. Publish while every board scope still resolves cleanly.
    await emitMirrorMetadataToBoards(mirror, "boardMirror:deleted", payload);
  }

  // Lifecycle ordering matters to live clients: remove every visible board before removing its
  // workspace shell, then delete the row only after audiences have been resolved for fanout.
  for (const board of workspaceBoards) {
    await emitToBoardAudience(
      board.id,
      "board:deleted",
      { workspaceId: params.workspaceId, boardId: board.id },
      { workspaceId: params.workspaceId },
    );
  }
  await emitToWorkspace(params.workspaceId, "workspace:deleted", { workspaceId: params.workspaceId });
  await db.delete(workspaces).where(eq(workspaces.id, params.workspaceId));

  // Deleting a workspace can free the same guest and board capacity as deleting boards one by one.
  for (const userId of externalUserIds) {
    await prunePaidGuestSeatIfBelowLimit({ hostClientId: params.clientId, userId });
  }
  const reactivatedBoards = await reactivatePlanArchivedBoardsIfRoom(params.clientId);
  for (const board of reactivatedBoards) {
    await emitToBoardAudience(
      board.id,
      "board:created",
      { workspaceId: board.workspaceId, board },
      { workspaceId: board.workspaceId },
    );
  }
}
