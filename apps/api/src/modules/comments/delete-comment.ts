import { cardAttachments, comments, type cards } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { touchCardActivity } from "../../lib/card-activity.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { badRequest } from "../../lib/errors.js";
import { clearNotificationsForComments } from "../../lib/notifications.js";
import { emitToBoard } from "../../realtime/emit.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;
type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;

/** `DELETE /comments/:id`: detaches attachments, deletes the row and records the activity. */
export async function deleteComment({
  auth,
  commentId: id,
  card,
  ctx,
}: {
  auth: AuthClaims;
  commentId: string;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
}) {
  await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [card.id]);
    // Detach and delete under the same card lock as bulk deletion; both child tables advance
    // the card revision, and attachments themselves stay on the card.
    await tx.update(cardAttachments).set({ commentId: null }).where(eq(cardAttachments.commentId, id));
    await tx.delete(comments).where(eq(comments.id, id));
    await clearNotificationsForComments(tx, [id]);
  });
  await touchCardActivity(card.id, auth.cid);
  await recordActivity(db, {
    boardId: card.boardId,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    entityType: "comment",
    entityId: id,
    action: "deleted",
    payload: { cardId: card.id },
  });
  return { commentId: id, cardId: card.id, boardId: card.boardId };
}

type DeleteCommentResult = Awaited<ReturnType<typeof deleteComment>>;

export async function emitCommentDeleted(result: DeleteCommentResult): Promise<void> {
  const { commentId, cardId, boardId } = result;
  await emitToBoard(boardId, "comment:deleted", {
    boardId,
    cardId,
    commentId,
  });
  await emitToBoard(boardId, "card:feedItem:deleted", {
    boardId,
    cardId,
    type: "comment",
    itemId: commentId,
  });
}

type BulkDeleteRow = { comment: typeof comments.$inferSelect; card: typeof cards.$inferSelect };

/**
 * `POST /boards/:boardId/comments/bulk/delete`: the route has validated the whole batch; `rows`
 * are the matched comment/card pairs and `byId` indexes them by comment id.
 */
export async function bulkDeleteComments({
  auth,
  boardId,
  boardAccess,
  commentIds,
  rows,
  byId,
}: {
  auth: AuthClaims;
  boardId: string;
  boardAccess: BoardAccessContext;
  commentIds: string[];
  rows: BulkDeleteRow[];
  byId: Map<string, BulkDeleteRow>;
}) {
  const deletedIds = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, rows.map((row) => row.card.id));
    await tx
      .update(cardAttachments)
      .set({ commentId: null })
      .where(inArray(cardAttachments.commentId, commentIds));
    const deleted = await tx
      .delete(comments)
      .where(inArray(comments.id, commentIds))
      .returning({ id: comments.id });
    if (deleted.length !== commentIds.length) {
      throw badRequest("a comment changed while applying the batch; retry with a fresh comment list");
    }
    await clearNotificationsForComments(tx, commentIds);
    for (const commentId of commentIds) {
      const row = byId.get(commentId)!;
      await recordActivity(tx, {
        boardId,
        workspaceId: boardAccess.workspaceId,
        actorId: auth.sub,
        entityType: "comment",
        entityId: commentId,
        action: "deleted",
        payload: { cardId: row.card.id, bulk: true },
      });
    }
    return deleted.map((row) => row.id);
  });

  for (const cardId of new Set(rows.map((row) => row.card.id))) {
    await touchCardActivity(cardId, auth.cid);
  }
  return { boardId, commentIds, byId, deletedIds };
}

type BulkDeleteCommentsResult = Awaited<ReturnType<typeof bulkDeleteComments>>;

export async function emitBulkCommentsDeleted(result: BulkDeleteCommentsResult): Promise<void> {
  const { boardId, commentIds, byId } = result;
  for (const commentId of commentIds) {
    const row = byId.get(commentId)!;
    await emitToBoard(boardId, "comment:deleted", { boardId, cardId: row.card.id, commentId });
    await emitToBoard(boardId, "card:feedItem:deleted", {
      boardId,
      cardId: row.card.id,
      type: "comment",
      itemId: commentId,
    });
  }
}
