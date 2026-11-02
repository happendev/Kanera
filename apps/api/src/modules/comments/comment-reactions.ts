import type { dto } from "@kanera/shared";
import { commentReactions, comments, users, type cards } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { notFound } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { notifyReactionAdded, withdrawReactionNotification } from "../../lib/reaction-notifications.js";
import { emitToBoard } from "../../realtime/emit.js";
import type { WarnLogger } from "./route-support.js";

/** `POST /comments/:id/reactions`: idempotent insert under the card lock. */
export async function addCommentReaction({
  auth,
  comment: current,
  card,
  body,
}: {
  auth: AuthClaims;
  comment: typeof comments.$inferSelect;
  card: typeof cards.$inferSelect;
  body: dto.AddReactionBody;
}) {
  const commentId = current.id;
  const inserted = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [card.id]);
    const [comment] = await tx.select({ id: comments.id }).from(comments).where(eq(comments.id, commentId));
    if (!comment) throw notFound();
    return tx
      .insert(commentReactions)
      .values({ commentId, userId: auth.sub, reactionType: body.type })
      .onConflictDoNothing({
        target: [commentReactions.commentId, commentReactions.userId, commentReactions.reactionType],
      })
      .returning({ id: commentReactions.id });
  });
  return { inserted: inserted.length > 0, comment: current, card, type: body.type };
}

type AddCommentReactionResult = Awaited<ReturnType<typeof addCommentReaction>>;

/** Post-commit fanout and notification for `addCommentReaction`; nothing when the reaction already existed. */
export async function emitCommentReactionAdded({
  auth,
  mailer,
  log,
  result,
}: {
  auth: AuthClaims;
  mailer: Mailer;
  log: WarnLogger;
  result: AddCommentReactionResult;
}): Promise<void> {
  const { inserted, comment: current, card, type } = result;
  const commentId = current.id;
  if (!inserted) return;
  const [user] = await db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, homeClientId: users.clientId })
    .from(users)
    .where(eq(users.id, auth.sub))
    .limit(1);
  if (user) {
    await emitToBoard(card.boardId, "comment:reaction:added", {
      boardId: card.boardId,
      cardId: card.id,
      commentId,
      type,
      user: {
        id: user.id,
        displayName: user.displayName,
        avatarUrl: withSignedMedia(user.homeClientId, { avatarUrl: user.avatarUrl }).avatarUrl,
      },
    });
  }
  // Only people hear about a thumbs-up; agent, API-key and system comments have no reader to tell.
  if (current.authorKind === "user") {
    await notifyReactionAdded({
      actorId: auth.sub,
      card,
      target: { kind: "comment", commentId, recipientId: current.authorId, body: current.body },
      type,
      mailer,
      webOrigin: env.WEB_ORIGIN,
    }).catch((err: unknown) => log.warn({ err, commentId }, "failed to notify comment reaction"));
  }
}

/** `DELETE /comments/:id/reactions/:type`: removes the caller's reaction under the card lock. */
export async function removeCommentReaction({
  auth,
  comment: current,
  card,
  type,
}: {
  auth: AuthClaims;
  comment: typeof comments.$inferSelect;
  card: typeof cards.$inferSelect;
  type: dto.ReactionType;
}) {
  const commentId = current.id;
  const removed = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [card.id]);
    return tx
      .delete(commentReactions)
      .where(
        and(
          eq(commentReactions.commentId, commentId),
          eq(commentReactions.userId, auth.sub),
          eq(commentReactions.reactionType, type),
        ),
      )
      .returning({ id: commentReactions.id });
  });
  return { removed: removed.length > 0, comment: current, card, type };
}

type RemoveCommentReactionResult = Awaited<ReturnType<typeof removeCommentReaction>>;

/** Post-commit fanout and notification withdrawal for `removeCommentReaction`; nothing when no row was removed. */
export async function emitCommentReactionRemoved({
  auth,
  log,
  result,
}: {
  auth: AuthClaims;
  log: WarnLogger;
  result: RemoveCommentReactionResult;
}): Promise<void> {
  const { removed, comment: current, card, type } = result;
  const commentId = current.id;
  if (!removed) return;
  await emitToBoard(card.boardId, "comment:reaction:removed", {
    boardId: card.boardId,
    cardId: card.id,
    commentId,
    type,
    userId: auth.sub,
  });
  await withdrawReactionNotification({
    actorId: auth.sub,
    cardId: card.id,
    target: { kind: "comment", commentId, recipientId: current.authorId, body: current.body },
  }).catch((err: unknown) => log.warn({ err, commentId }, "failed to withdraw comment reaction notification"));
}
