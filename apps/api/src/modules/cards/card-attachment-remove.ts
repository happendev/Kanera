import { ACTIVITY_ACTION, cardAttachments, cards, comments, users } from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { recordCoalescedActivity } from "../../lib/activity.js";
import { touchCardActivity } from "../../lib/card-activity.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { commentAuthorColumns } from "../../lib/comment-rows.js";
import { dominantColorFromThumbnail, generateCoverImage, isProcessableImage } from "../../lib/image.js";
import { signedAvatarUrl, signEmbeddedMediaUrls, unsignedMediaUrl } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey } from "../../lib/storage/keys.js";
import { stripAttachmentReferences } from "../../lib/strip-attachment-refs.js";
import { emitToBoard } from "../../realtime/emit.js";
import { ATTACHMENT_MISTAKE_WINDOW_MS, emitCoalescedAttachmentActivity } from "./card-attachments.js";

/**
 * Removes one card attachment with every side effect a manual delete has: cover reassignment, file
 * cleanup, stripping inline references from the description and comments, the coalesced activity
 * row, and the realtime echoes. Shared by the card route and the organisation storage cleanup so a
 * bulk purge leaves cards in exactly the state a one-by-one delete would.
 */
export async function removeCardAttachment(params: {
  card: typeof cards.$inferSelect;
  attachment: typeof cardAttachments.$inferSelect;
  workspaceId: string;
  actorId: string;
  mediaClientId: string;
  // Structural subset of a Fastify/pino logger so callers can pass `req.log` as a plain value.
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<void> {
  const { card, attachment, workspaceId, actorId, mediaClientId, log } = params;
  const cardId = card.id;
  const attachmentId = attachment.id;
  // Reassign cover BEFORE deleting the attachment row so coverAttachmentId
  // never points at a deleted row.
  let coverChanged = false;
  let nextCoverId: string | null = null;
  if (card.coverAttachmentId === attachmentId) {
    nextCoverId = await pickNextImageCover(cardId, attachmentId);
    await db
      .update(cards)
      .set({ coverAttachmentId: nextCoverId, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
    coverChanged = true;
  }

  // Delete DB row first, then clean up files (best-effort).
  // This way the row is gone even if storage delete fails — no dangling data.
  await db.delete(cardAttachments).where(eq(cardAttachments.id, attachmentId));

  const storage = await getStorageForClient(mediaClientId);
  await Promise.allSettled([
    storage.delete(attachment.fileKey),
    attachment.thumbnailFileKey ? storage.delete(attachment.thumbnailFileKey) : Promise.resolve(),
    attachment.coverImageFileKey ? storage.delete(attachment.coverImageFileKey) : Promise.resolve(),
  ]);

  // Generate cover image for the newly assigned cover if it doesn't have one
  if (coverChanged && nextCoverId) {
    try {
      const [nextCover] = await db
        .select()
        .from(cardAttachments)
        .where(eq(cardAttachments.id, nextCoverId))
        .limit(1);
      if (nextCover && !nextCover.coverImageFileKey && isProcessableImage(nextCover.mimeType)) {
        const buf = await storage.get(nextCover.fileKey);
        const cover = await generateCoverImage(buf, nextCover.mimeType);
        const coverFileKey = attachmentCoverStorageKey(nextCover.fileKey, cover.ext);
        await storage.put(coverFileKey, cover.buffer, cover.mimeType);
        const coverUrl = unsignedMediaUrl(mediaClientId, coverFileKey);
        await db
          .update(cardAttachments)
          .set({
            coverImageUrl: coverUrl,
            coverImageFileKey: coverFileKey,
            coverImageWidth: cover.width,
            coverImageHeight: cover.height,
            coverImageColor: nextCover.thumbnailFileKey
              ? await dominantColorFromThumbnail(await storage.get(nextCover.thumbnailFileKey))
              : nextCover.coverImageColor,
          })
          .where(eq(cardAttachments.id, nextCoverId));
      }
    } catch (err) {
      log.warn({ err, nextCoverId }, "cover image generation for reassigned cover failed");
    }
  }

  await emitToBoard(card.boardId, "card:attachment:deleted", {
    boardId: card.boardId,
    cardId,
    attachmentId,
  });

  // Strip inline references to this attachment's URL from the card's
  // description and from any comment bodies on this card.
  const storedAttachmentUrl = unsignedMediaUrl(mediaClientId, attachment.fileKey)!;
  const descStrip = stripAttachmentReferences(card.description, storedAttachmentUrl);
  const descriptionChanged = descStrip.changed;
  if (descStrip.changed) {
    await db
      .update(cards)
      .set({ description: descStrip.body, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
  }

  const cardComments = await db
    .select({ id: comments.id, body: comments.body })
    .from(comments)
    .where(eq(comments.cardId, cardId));
  for (const c of cardComments) {
    const stripped = stripAttachmentReferences(c.body, storedAttachmentUrl);
    if (!stripped.changed) continue;
    const newBody = stripped.body && stripped.body.trim().length > 0 ? stripped.body : "";
    if (newBody.length === 0) {
      // Leave a placeholder so we don't violate the NOT NULL / min(1) DTO
      await db
        .update(comments)
        .set({ body: "(attachment removed)", editedAt: new Date() })
        .where(eq(comments.id, c.id));
    } else {
      await db
        .update(comments)
        .set({ body: newBody, editedAt: new Date() })
        .where(eq(comments.id, c.id));
    }
    const [updatedComment] = await db
      .select({
        id: comments.id,
        cardId: comments.cardId,
        authorId: comments.authorId,
        authorKind: comments.authorKind,
        apiKeyId: comments.apiKeyId,
        apiKeyName: comments.apiKeyName,
        agentName: comments.agentName,
        ...commentAuthorColumns,
        authorClientId: users.clientId,
        body: comments.body,
        editedAt: comments.editedAt,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, c.id))
      .limit(1);
    if (updatedComment) {
      const reactionsMap = await fetchReactionsByComment([updatedComment.id]);
      const { authorClientId, authorAvatarUrl, ...comment } = updatedComment;
      const enriched = {
        ...comment,
        authorAvatarUrl: signedAvatarUrl(authorClientId, authorAvatarUrl),
        body: signEmbeddedMediaUrls(comment.body, mediaClientId) ?? comment.body,
        reactions: reactionsMap.get(updatedComment.id) ?? [],
      };
      await emitToBoard(card.boardId, "comment:updated", {
        boardId: card.boardId,
        cardId,
        comment: enriched,
      });
      await emitToBoard(card.boardId, "card:feedItem:updated", {
        boardId: card.boardId,
        cardId,
        item: { type: "comment", data: enriched },
      });
    }
  }

  if (coverChanged || descriptionChanged) {
    const [updatedCard] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (updatedCard) {
      await emitToBoard(card.boardId, "card:updated", { boardId: card.boardId, card: { ...updatedCard, description: signEmbeddedMediaUrls(updatedCard.description, mediaClientId) } });
    }
  } else {
    // A plain attachment deletion does not otherwise mutate the card row.
    await touchCardActivity(cardId, mediaClientId);
  }

  const activity = await recordCoalescedActivity(db, {
    boardId: card.boardId,
    workspaceId,
    actorId,
    entityType: "card",
    entityId: cardId,
    action: ACTIVITY_ACTION.ATTACHMENT_REMOVED,
    coalesceKey: `attachment:${attachmentId}`,
    coalesceActions: [ACTIVITY_ACTION.ATTACHMENT_ADDED, ACTIVITY_ACTION.ATTACHMENT_REMOVED],
    windowMs: ATTACHMENT_MISTAKE_WINDOW_MS,
    fromValue: { attachmentId },
    toValue: null,
    payload: { cardId, attachmentId, fileName: attachment.fileName },
  });
  await emitCoalescedAttachmentActivity(card.boardId, cardId, activity);
}

async function pickNextImageCover(cardId: string, excludeId?: string): Promise<string | null> {
  const rows = await db
    .select({ id: cardAttachments.id, mimeType: cardAttachments.mimeType })
    .from(cardAttachments)
    .where(eq(cardAttachments.cardId, cardId))
    .orderBy(asc(cardAttachments.createdAt));
  for (const row of rows) {
    if (row.id === excludeId) continue;
    if (row.mimeType.startsWith("image/")) return row.id;
  }
  return null;
}
