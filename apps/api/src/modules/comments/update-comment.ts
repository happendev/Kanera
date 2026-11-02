import type { dto } from "@kanera/shared";
import { comments, type cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { touchCardActivity } from "../../lib/card-activity.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { notFound } from "../../lib/errors.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { emitToBoard } from "../../realtime/emit.js";
import { selectCommentRow } from "./comment-queries.js";
import { linkAttachmentsToComment } from "./route-support.js";

/**
 * `PATCH /comments/:id`: rewrites the body and mentions, links any attachments and returns the
 * signed row. `commentBody` is the media-stripped body the route already validated.
 */
export async function updateComment({
  auth,
  commentId: id,
  card,
  body,
  commentBody,
}: {
  auth: AuthClaims;
  commentId: string;
  card: typeof cards.$inferSelect;
  body: dto.UpdateCommentBody;
  commentBody: string;
}) {
  const comment = await db.transaction(async (tx) => {
    // Match bulk deletion's card-before-comment order. The revision trigger also writes the
    // card, so locking just the comment first can deadlock with a batch holding its card.
    await lockCardsForWrite(tx, [card.id]);
    const [updated] = await tx
      .update(comments)
      .set({ body: commentBody, editedAt: new Date() })
      .where(eq(comments.id, id))
      .returning();
    if (!updated) throw notFound();
    await replaceCardMentions({
      tx,
      boardId: card.boardId,
      cardId: card.id,
      commentId: updated.id,
      source: "comment",
      markdown: commentBody,
    });
    return updated;
  });

  if (body.attachmentIds && body.attachmentIds.length > 0) {
    await linkAttachmentsToComment({
      clientId: auth.cid,
      attachmentIds: body.attachmentIds,
      cardId: card.id,
      boardId: card.boardId,
      commentId: comment!.id,
      userId: auth.sub,
    });
  }

  const commentRow = await selectCommentRow(comment!.id, auth.cid);
  await touchCardActivity(card.id, auth.cid);
  return { cardId: card.id, boardId: card.boardId, commentRow };
}

type UpdateCommentResult = Awaited<ReturnType<typeof updateComment>>;

export async function emitCommentUpdated(result: UpdateCommentResult): Promise<void> {
  const { cardId, boardId, commentRow } = result;
  await emitToBoard(boardId, "comment:updated", {
    boardId,
    cardId,
    comment: commentRow,
  });
  await emitToBoard(boardId, "card:feedItem:updated", {
    boardId,
    cardId,
    item: { type: "comment", data: commentRow },
  });
}
