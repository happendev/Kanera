import type { dto } from "@kanera/shared";
import { comments, type cards } from "@kanera/shared/schema";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import type { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { enqueueCommentAddedEmails, enqueueCommentMentionedNotifications } from "../../lib/assignee-email-notifications.js";
import { touchCardActivity } from "../../lib/card-activity.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import type { Mailer } from "../../lib/mailer.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { queueNotificationFanout } from "../../lib/notifications.js";
import { emitToBoard } from "../../realtime/emit.js";
import { selectCommentRow, selectCommentRows } from "./comment-queries.js";
import { commentAttribution, linkAttachmentsToComment } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;
type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;

/**
 * `POST /cards/:id/comments`: inserts the comment and its mentions, links any attachments, then
 * records activity. `commentBody` is the media-stripped body the route already validated.
 */
export async function createComment({
  auth,
  card,
  ctx,
  body,
  commentBody,
}: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  body: dto.CreateCommentBody;
  commentBody: string;
}) {
  const cardId = card.id;
  const { comment, mentionedUserIds } = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [cardId]);
    const attribution = commentAttribution(auth);
    const [comment] = await tx
      .insert(comments)
      .values({ cardId, authorId: auth.sub, ...attribution, body: commentBody })
      .returning();

    const mentionedUserIds = await replaceCardMentions({
      tx,
      boardId: card.boardId,
      cardId,
      commentId: comment!.id,
      source: "comment",
      markdown: commentBody,
    });

    return { comment: comment!, mentionedUserIds };
  });

  if (body.attachmentIds && body.attachmentIds.length > 0) {
    await linkAttachmentsToComment({
      clientId: auth.cid,
      attachmentIds: body.attachmentIds,
      cardId,
      boardId: card.boardId,
      commentId: comment.id,
      userId: auth.sub,
    });
  }

  const selectedCommentRow = await selectCommentRow(comment.id, auth.cid);
  await touchCardActivity(cardId, auth.cid);

  const commentCreatedActivity = await recordActivity(db, {
    boardId: card.boardId,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    entityType: "comment",
    entityId: comment.id,
    action: "created",
    payload: { cardId },
  });
  return { cardId, boardId: card.boardId, workspaceId: ctx.workspaceId, commentBody, mentionedUserIds, commentCreatedActivity, selectedCommentRow };
}

type CreateCommentResult = Awaited<ReturnType<typeof createComment>>;

/** Post-commit notifications and fanout for `createComment`. */
export async function emitCommentCreated({ auth, mailer, result }: { auth: AuthClaims; mailer: Mailer; result: CreateCommentResult }): Promise<void> {
  const { cardId, boardId, workspaceId, commentBody, mentionedUserIds, commentCreatedActivity, selectedCommentRow } = result;
  await enqueueCommentAddedEmails({
    tx: db,
    mailer,
    webOrigin: env.WEB_ORIGIN,
    cardId,
    actorId: auth.sub,
    commentBody,
    excludeUserIds: mentionedUserIds,
  });
  await enqueueCommentMentionedNotifications({
    tx: db,
    mailer,
    webOrigin: env.WEB_ORIGIN,
    cardId,
    actorId: auth.sub,
    recipientUserIds: mentionedUserIds,
    commentBody,
  });
  queueNotificationFanout(commentCreatedActivity, { kind: "created" });
  await emitToBoard(boardId, "comment:created", {
    boardId,
    cardId,
    comment: selectedCommentRow,
  });
  await emitToBoard(boardId, "card:feedItem:created", {
    boardId,
    cardId,
    item: { type: "comment", data: selectedCommentRow },
  });
  await evaluateWorkspaceAnalyticsMilestones({
    workspaceId,
    actorId: auth.sub,
    supportSession: auth.authKind === "support" || auth.authKind === "apiKey",
  });
}

/**
 * `POST /boards/:boardId/comments/bulk/create`: every target has been validated by the route;
 * `entries` carry media-stripped bodies in request order.
 */
export async function bulkCreateComments({
  auth,
  boardId,
  boardAccess,
  cardIds,
  entries,
}: {
  auth: AuthClaims;
  boardId: string;
  boardAccess: BoardAccessContext;
  cardIds: string[];
  entries: Array<{ cardId: string; body: string }>;
}) {
  const created = await db.transaction(async (tx) => {
    // Comments are written in request order; two batches crossing the same cards in opposite
    // orders would otherwise deadlock on the per-card revision bump (see lockCardsForWrite).
    await lockCardsForWrite(tx, cardIds);
    const attribution = commentAttribution(auth);
    const results: Array<{
      id: string;
      cardId: string;
      body: string;
      mentionedUserIds: string[];
      activity: Awaited<ReturnType<typeof recordActivity>>;
    }> = [];
    for (const entry of entries) {
      const [comment] = await tx
        .insert(comments)
        .values({ cardId: entry.cardId, authorId: auth.sub, ...attribution, body: entry.body })
        .returning({ id: comments.id });
      const mentionedUserIds = await replaceCardMentions({
        tx,
        boardId,
        cardId: entry.cardId,
        commentId: comment!.id,
        source: "comment",
        markdown: entry.body,
      });
      const activity = await recordActivity(tx, {
        boardId,
        workspaceId: boardAccess.workspaceId,
        actorId: auth.sub,
        entityType: "comment",
        entityId: comment!.id,
        action: "created",
        payload: { cardId: entry.cardId, bulk: true },
      });
      results.push({ id: comment!.id, cardId: entry.cardId, body: entry.body, mentionedUserIds, activity });
    }
    return results;
  });

  const selectedRows = await selectCommentRows(created.map((entry) => entry.id), auth.cid);
  for (const cardId of cardIds) await touchCardActivity(cardId, auth.cid);
  return { boardId, created, selectedRows };
}

type BulkCreateCommentsResult = Awaited<ReturnType<typeof bulkCreateComments>>;

/** Per-comment notifications and fanout for `bulkCreateComments`, in request order. */
export async function emitBulkCommentsCreated({ auth, mailer, result }: { auth: AuthClaims; mailer: Mailer; result: BulkCreateCommentsResult }): Promise<void> {
  const { boardId, created, selectedRows } = result;
  for (let index = 0; index < created.length; index += 1) {
    const entry = created[index]!;
    const selectedComment = selectedRows[index]!;
    await enqueueCommentAddedEmails({
      tx: db,
      mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: entry.cardId,
      actorId: auth.sub,
      commentBody: entry.body,
      excludeUserIds: entry.mentionedUserIds,
    });
    await enqueueCommentMentionedNotifications({
      tx: db,
      mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: entry.cardId,
      actorId: auth.sub,
      recipientUserIds: entry.mentionedUserIds,
      commentBody: entry.body,
    });
    void queueNotificationFanout(entry.activity, { kind: "created" });
    await emitToBoard(boardId, "comment:created", { boardId, cardId: entry.cardId, comment: selectedComment });
    await emitToBoard(boardId, "card:feedItem:created", {
      boardId,
      cardId: entry.cardId,
      item: { type: "comment", data: selectedComment },
    });
  }
}
