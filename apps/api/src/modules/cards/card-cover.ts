import { cardAttachments, cards } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { notFound } from "../../lib/errors.js";
import { dominantColorFromThumbnail, generateCoverImage, isProcessableImage } from "../../lib/image.js";
import { unsignedMediaUrl } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey } from "../../lib/storage/keys.js";
import { emitToBoard } from "../../realtime/emit.js";

/** `PATCH /cards/:id/cover`: set or clear the card cover, generating the cover derivative on demand. */
export async function setCardCover({ auth, cardId, attachmentId }: { auth: AuthClaims; cardId: string; attachmentId: string | null }) {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  if (!card) throw notFound();
  const ctx = await assertCardAccess(auth, card, "editor");
  assertCardActive(card);

  const storage = await getStorageForClient(auth.cid);

  if (attachmentId !== null) {
    const [attachment] = await db
      .select()
      .from(cardAttachments)
      .where(and(eq(cardAttachments.id, attachmentId), eq(cardAttachments.cardId, cardId)))
      .limit(1);
    if (!attachment) throw notFound();

    if (isProcessableImage(attachment.mimeType) && attachment.coverImageFileKey && attachment.thumbnailFileKey) {
      // Re-selecting an existing cover refreshes older colours from the actual thumbnail too;
      // this avoids keeping values previously calculated from the large derivative.
      await db
        .update(cardAttachments)
        .set({ coverImageColor: await dominantColorFromThumbnail(await storage.get(attachment.thumbnailFileKey)) })
        .where(eq(cardAttachments.id, attachmentId));
    } else if (!attachment.coverImageFileKey && isProcessableImage(attachment.mimeType)) {
      const originalBuffer = await storage.get(attachment.fileKey);
      const cover = await generateCoverImage(originalBuffer, attachment.mimeType);
      const coverFileKey = attachmentCoverStorageKey(attachment.fileKey, cover.ext);
      await storage.put(coverFileKey, cover.buffer, cover.mimeType);
      const coverUrl = unsignedMediaUrl(auth.cid, coverFileKey);
      try {
        await db
          .update(cardAttachments)
          .set({
            coverImageUrl: coverUrl,
            coverImageFileKey: coverFileKey,
            coverImageWidth: cover.width,
            coverImageHeight: cover.height,
            coverImageColor: attachment.thumbnailFileKey
              ? await dominantColorFromThumbnail(await storage.get(attachment.thumbnailFileKey))
              : attachment.coverImageColor,
          })
          .where(eq(cardAttachments.id, attachmentId));
      } catch (err) {
        await storage.delete(coverFileKey).catch(() => { });
        throw err;
      }
    }
  }

  // Remove cover image from the old cover attachment (if any) after the new
  // one is ready, so we don't lose data if generation fails above.
  if (card.coverAttachmentId && card.coverAttachmentId !== attachmentId) {
    const [oldCover] = await db
      .select()
      .from(cardAttachments)
      .where(eq(cardAttachments.id, card.coverAttachmentId))
      .limit(1);
    if (oldCover?.coverImageFileKey) {
      // Clear DB metadata first so the key isn't lost if storage delete fails
      await db
        .update(cardAttachments)
        .set({
          coverImageUrl: null,
          coverImageFileKey: null,
          coverImageWidth: null,
          coverImageHeight: null,
          coverImageColor: null,
        })
        .where(eq(cardAttachments.id, oldCover.id));
      await storage.delete(oldCover.coverImageFileKey).catch(() => { });
    }
  }

  const [updated] = await db
    .update(cards)
    .set({ coverAttachmentId: attachmentId, updatedAt: new Date() })
    .where(eq(cards.id, cardId))
    .returning();

  await emitToBoard(card.boardId, "card:updated", { boardId: card.boardId, card: updated! });

  await recordActivity(db, {
    boardId: card.boardId,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    entityType: "card",
    entityId: cardId,
    action: attachmentId ? "cover_set" : "cover_removed",
    payload: { cardId },
  });

  return updated!;
}
