import { dto } from "@kanera/shared";
import { cardAttachmentReactions, cardAttachments, cards, users } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertCardAccess } from "../../lib/access.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { notifyReactionAdded, withdrawReactionNotification } from "../../lib/reaction-notifications.js";
import { emitToBoard } from "../../realtime/emit.js";

async function loadReactableAttachment(attachmentId: string) {
  const [row] = await db
    .select({ attachment: cardAttachments, card: cards })
    .from(cardAttachments)
    .innerJoin(cards, eq(cards.id, cardAttachments.cardId))
    .where(eq(cardAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * Lightweight acknowledgement on an uploaded file ("nice screenshot"), mirroring comment reactions:
 * editors only, never on your own upload, and the uploader is notified the way a comment's author
 * is (see reaction-notifications.ts). App API only; the web activity feed is the sole consumer.
 */
export async function cardAttachmentReactionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/attachments/:id/reactions", async (req, reply) => {
    const { id: attachmentId } = req.params as { id: string };
    const body = dto.addReactionBody.parse(req.body);

    const { attachment, card } = await loadReactableAttachment(attachmentId);
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    if (attachment.uploadedById === req.auth.sub) throw badRequest("cannot react to your own attachment");

    const inserted = await db
      .insert(cardAttachmentReactions)
      .values({ attachmentId, userId: req.auth.sub, reactionType: body.type })
      .onConflictDoNothing({
        target: [cardAttachmentReactions.attachmentId, cardAttachmentReactions.userId, cardAttachmentReactions.reactionType],
      })
      .returning({ id: cardAttachmentReactions.id });

    if (inserted.length > 0) {
      const [user] = await db
        .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, homeClientId: users.clientId })
        .from(users)
        .where(eq(users.id, req.auth.sub))
        .limit(1);
      if (user) {
        await emitToBoard(card.boardId, "card:attachment:reaction:added", {
          boardId: card.boardId,
          cardId: card.id,
          attachmentId,
          type: body.type,
          user: {
            id: user.id,
            displayName: user.displayName,
            avatarUrl: withSignedMedia(user.homeClientId, { avatarUrl: user.avatarUrl }).avatarUrl,
          },
        });
      }
      await notifyReactionAdded({
        actorId: req.auth.sub,
        card,
        target: { kind: "attachment", attachmentId, recipientId: attachment.uploadedById, fileName: attachment.fileName },
        type: body.type,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
      }).catch((err: unknown) => req.log.warn({ err, attachmentId }, "failed to notify attachment reaction"));
    }
    return reply.status(204).send();
  });

  app.delete("/attachments/:id/reactions/:type", async (req, reply) => {
    const { id: attachmentId, type: typeParam } = req.params as { id: string; type: string };
    const type = dto.reactionTypeSchema.parse(typeParam);

    const { attachment, card } = await loadReactableAttachment(attachmentId);
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    const removed = await db
      .delete(cardAttachmentReactions)
      .where(and(
        eq(cardAttachmentReactions.attachmentId, attachmentId),
        eq(cardAttachmentReactions.userId, req.auth.sub),
        eq(cardAttachmentReactions.reactionType, type),
      ))
      .returning({ id: cardAttachmentReactions.id });

    if (removed.length > 0) {
      await emitToBoard(card.boardId, "card:attachment:reaction:removed", {
        boardId: card.boardId,
        cardId: card.id,
        attachmentId,
        type,
        userId: req.auth.sub,
      });
      await withdrawReactionNotification({
        actorId: req.auth.sub,
        cardId: card.id,
        target: { kind: "attachment", attachmentId, recipientId: attachment.uploadedById, fileName: attachment.fileName },
      }).catch((err: unknown) => req.log.warn({ err, attachmentId }, "failed to withdraw attachment reaction notification"));
    }
    return reply.status(204).send();
  });
}
