import { boardMembers, boardMirrors, boards, cards, clientMembers } from "@kanera/shared/schema";
import { and, eq, notExists, or } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { collectBoardNoteFiles, deleteAttachmentFiles, deleteNoteFiles } from "../../lib/attachment-cleanup.js";
import { emitAutomationEffects, runCardUnblockedAutomations } from "../../lib/automations.js";
import { emitMirrorMetadataToBoards } from "../../lib/board-mirror/events.js";
import { captureBlockedDependents, emitBlockedByCountChanged, emitRelationNeighboursChanged, lockWorkspaceRelations, relationNeighbourIds } from "../../lib/card-relations.js";
import { recordBlockersCleared } from "../../lib/dependency-notifications.js";
import { deleteExternalLinks } from "../../lib/external-links.js";
import { clearNotificationsForScope } from "../../lib/notifications.js";
import { prunePaidGuestSeatIfBelowLimit } from "../../lib/paid-guest-seats.js";
import { reactivatePlanArchivedBoardsIfRoom } from "../../lib/plan-conversion.js";
import { requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { emitToBoardAudience } from "../../realtime/emit.js";
import type { BoardAccessContext } from "./route-support.js";

type DeletedBoard = Awaited<ReturnType<typeof deleteBoard>>;

/**
 * Deletes a board that belongs to an ordinary (non-standalone) workspace. Unlike most use cases this
 * emits before it returns: mirror teardown and `board:deleted` must be announced while the board row
 * still exists, so the durable board scopes can resolve their workspaces.
 */
export async function deleteBoard({
  auth,
  ctx,
  boardId: id,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
}) {
  const boardCards = await db.select({ id: cards.id }).from(cards).where(eq(cards.boardId, id));
  const removedMirrors = await db.select().from(boardMirrors).where(or(eq(boardMirrors.sourceBoardId, id), eq(boardMirrors.targetBoardId, id)));
  const externalMemberRows = await db
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(
      eq(boardMembers.boardId, id),
      notExists(db.select({ userId: clientMembers.userId }).from(clientMembers).where(and(
        eq(clientMembers.clientId, ctx.clientId),
        eq(clientMembers.userId, boardMembers.userId),
      ))),
    ));
  const storage = await getStorageForClient(auth.cid);
  await deleteAttachmentFiles(storage, boardCards.map((c) => c.id));
  // Board notes cascade with the board; capture their file keys now and delete the bytes after.
  const noteFiles = await collectBoardNoteFiles(id);

  for (const mirror of removedMirrors) {
    await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: `mirror:${mirror.id}` });
    await db.delete(boardMirrors).where(eq(boardMirrors.id, mirror.id));
    const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
    // Deleting either participant ends the relationship for the surviving board too. Emit before
    // deleting this board so both durable board scopes can still resolve their workspaces.
    await emitMirrorMetadataToBoards(mirror, "boardMirror:deleted", payload);
  }

  await emitToBoardAudience(id, "board:deleted", { workspaceId: ctx.workspaceId, boardId: id }, { workspaceId: ctx.workspaceId });
  // Cards on other boards blocked by this board's cards lose those blockers in the cascade. The
  // card set and the snapshot are both read under the graph lock inside the transaction, while
  // the relation rows still exist, so a card moved onto the board while this request waited for
  // the lock is seen too; their badge is re-announced afterwards.
  const { handoffs, effects, survivingDependents, neighbours } = await db.transaction(async (tx) => {
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    const boardCardIds = new Set((await tx.select({ id: cards.id }).from(cards).where(eq(cards.boardId, id))).map((c) => c.id));
    const before = await captureBlockedDependents(tx, ctx.workspaceId, [...boardCardIds]);
    const survivingDependents = [...new Set(before.map((row) => row.dependentId))].filter((cardId) => !boardCardIds.has(cardId));
    // Every surviving related card loses a row from its Dependencies section.
    const neighbours = await relationNeighbourIds(tx, [...boardCardIds]);
    // Boards chained into this one lose blockers in the cascade; the queue row for this board
    // itself cascades away with it, which is right: there is nothing left to evaluate.
    await requestScheduleRecheckForCards(tx, [...boardCardIds]);
    await clearNotificationsForScope(tx, { boardId: id });
    await tx.delete(boards).where(eq(boards.id, id));
    const handoffs = await recordBlockersCleared(tx, { before, actorId: auth.sub });
    const effects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId: ctx.workspaceId, clientId: auth.cid, triggerActorId: auth.sub });
    return { handoffs, effects, survivingDependents, neighbours };
  });
  return { clientId: ctx.clientId, cid: auth.cid, handoffs, effects, survivingDependents, neighbours, noteFiles, externalMemberRows };
}

/** Post-commit fanout and cleanup; the route sends dependency hand-off notifications first. */
export async function emitBoardDeleted({ clientId, cid, effects, survivingDependents, neighbours, noteFiles, externalMemberRows }: DeletedBoard) {
  await emitAutomationEffects(effects);
  await emitBlockedByCountChanged(survivingDependents, cid);
  await emitRelationNeighboursChanged([], neighbours.filter((cardId) => !survivingDependents.includes(cardId)));
  await deleteNoteFiles(noteFiles);
  // Freeing the guest's pooled seat reduces the *used* count but not the purchased seat_limit (the
  // bill is unchanged): reducing capacity is a separate explicit admin action. The freed seat is now
  // available for the admin to assign to someone else.
  for (const row of externalMemberRows) {
    await prunePaidGuestSeatIfBelowLimit({ hostClientId: clientId, userId: row.userId });
  }
  const reactivatedBoards = await reactivatePlanArchivedBoardsIfRoom(clientId);
  for (const board of reactivatedBoards) {
    await emitToBoardAudience(board.id, "board:created", { workspaceId: board.workspaceId, board }, { workspaceId: board.workspaceId });
  }
}
