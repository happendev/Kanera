import type { AttachmentSource } from "@kanera/shared/dto";
import { ACTIVITY_ACTION, cardAttachments, cards, comments } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { recordCoalescedActivity } from "../../lib/activity.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { putAttachmentFile } from "../../lib/attachment-upload.js";
import { touchCardActivity } from "../../lib/card-activity.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { assertCanUploadAttachment, getUploadEntitlements, isStorageFull, storageQuotaExceededError } from "../../lib/entitlements.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { generateCoverImage, generateThumbnail, isProcessableImage } from "../../lib/image.js";
import { signedAvatarUrl, unsignedMediaUrl } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey, attachmentThumbnailStorageKey, cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { emitToBoard } from "../../realtime/emit.js";
import { ATTACHMENT_MISTAKE_WINDOW_MS, emitCoalescedAttachmentActivity, selectAttachmentRow } from "./card-attachments.js";

export type CardUploadTarget = Awaited<ReturnType<typeof prepareCardUpload>>;

/**
 * Everything an upload must pass before its body is read: editor access to an active card, an
 * owned comment when attaching to one, and room in the host organisation's storage pool. Shared by
 * the multipart route and single-use upload links so both enforce identical rules.
 */
export async function prepareCardUpload(auth: AuthClaims, cardId: string, source: AttachmentSource, commentId: string | null) {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  if (!card) throw notFound();
  const ctx = await assertCardAccess(auth, card, "editor");
  assertCardActive(card);

  if (commentId) {
    const [c] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!c || c.cardId !== cardId) throw badRequest("invalid commentId");
    if (c.authorId !== auth.sub) throw forbidden();
  }

  // Storage is host-pays: charge the org that owns the board (ctx.clientId), not the uploader's own
  // org. A guest's upload to a paid board draws down the host's quota and uses the host's per-file
  // limit. Physical storage stays under the uploader's tenant (auth.cid) by design — see the
  // media auth note: relocating it risks authenticated-fetch breakage for no accounting benefit.
  const uploadEntitlements = await getUploadEntitlements(db, ctx.clientId);
  // If the host org's storage pool is already full, reject before reading the upload body so a full
  // org never wastes bandwidth streaming a file that cannot be stored.
  if (isStorageFull(uploadEntitlements)) throw storageQuotaExceededError(uploadEntitlements);
  return { card, ctx, source, commentId, uploadEntitlements };
}

/** Store an already-read file as a card attachment: derivatives, row, cover, realtime, activity. */
export async function storeCardAttachment(
  auth: AuthClaims,
  { card, ctx, source, commentId }: CardUploadTarget,
  file: { fileName: string; mimeType: string; ext: string; buffer: Buffer },
) {
  const cardId = card.id;
  const { buffer } = file;
  await assertCanUploadAttachment(db, ctx.clientId, buffer.byteLength);

  const fileKey = cardAttachmentStorageKey(cardId, file.ext);
  const storage = await getStorageForClient(auth.cid);
  await putAttachmentFile(storage, fileKey, buffer, file.mimeType);
  const url = unsignedMediaUrl(auth.cid, fileKey)!;

  let thumbnailUrl: string | null = null;
  let thumbnailFileKey: string | null = null;
  let coverImageUrl: string | null = null;
  let coverImageFileKey: string | null = null;
  let coverImageWidth: number | null = null;
  let coverImageHeight: number | null = null;
  let coverImageColor: string | null = null;

  if (isProcessableImage(file.mimeType)) {
    const thumb = await generateThumbnail(buffer, file.mimeType);
    thumbnailFileKey = attachmentThumbnailStorageKey(fileKey, thumb.ext);
    await putAttachmentFile(storage, thumbnailFileKey, thumb.buffer, thumb.mimeType);
    thumbnailUrl = unsignedMediaUrl(auth.cid, thumbnailFileKey);
    coverImageColor = thumb.dominantColor;

    if (!card.coverAttachmentId && source !== "comment") {
      const cover = await generateCoverImage(buffer, file.mimeType);
      coverImageFileKey = attachmentCoverStorageKey(fileKey, cover.ext);
      await putAttachmentFile(storage, coverImageFileKey, cover.buffer, cover.mimeType);
      coverImageUrl = unsignedMediaUrl(auth.cid, coverImageFileKey);
      coverImageWidth = cover.width;
      coverImageHeight = cover.height;
    }
  }

  let inserted: typeof cardAttachments.$inferSelect;
  try {
    const [row] = await db
      .insert(cardAttachments)
      .values({
        cardId,
        clientId: ctx.clientId,
        uploadedById: auth.sub,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: buffer.byteLength,
        fileKey,
        url,
        thumbnailUrl,
        thumbnailFileKey,
        coverImageUrl,
        coverImageFileKey,
        coverImageWidth,
        coverImageHeight,
        coverImageColor,
        source,
        commentId,
      })
      .returning();
    inserted = row!;
  } catch (err) {
    // Rollback uploaded files so they don't become orphans
    await Promise.allSettled([
      storage.delete(fileKey),
      thumbnailFileKey ? storage.delete(thumbnailFileKey) : Promise.resolve(),
      coverImageFileKey ? storage.delete(coverImageFileKey) : Promise.resolve(),
    ]);
    throw err;
  }

  const attachmentRow = await selectAttachmentRow(inserted.id);
  const { uploadedByClientId, uploadedByAvatarUrl, ...attachmentMedia } = attachmentRow;
  const attachment = {
    ...shapeAttachmentMedia(attachmentMedia),
    uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
  };

  let coverChanged = false;
  if (!card.coverAttachmentId && file.mimeType.startsWith("image/") && source !== "comment") {
    await db
      .update(cards)
      .set({ coverAttachmentId: inserted.id, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
    coverChanged = true;
  }

  // Uploads that do not become the cover are still activity on the card.
  if (!coverChanged) await touchCardActivity(cardId, auth.cid);

  await emitToBoard(card.boardId, "card:attachment:created", {
    boardId: card.boardId,
    cardId,
    attachment,
  });

  if (coverChanged) {
    const [updatedCard] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (updatedCard) {
      await emitToBoard(card.boardId, "card:updated", { boardId: card.boardId, card: updatedCard });
    }
  }

  const activity = await recordCoalescedActivity(db, {
    boardId: card.boardId,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    entityType: "card",
    entityId: cardId,
    action: ACTIVITY_ACTION.ATTACHMENT_ADDED,
    coalesceKey: `attachment:${inserted.id}`,
    coalesceActions: [ACTIVITY_ACTION.ATTACHMENT_ADDED, ACTIVITY_ACTION.ATTACHMENT_REMOVED],
    windowMs: ATTACHMENT_MISTAKE_WINDOW_MS,
    fromValue: null,
    toValue: { attachmentId: inserted.id },
    payload: {
      cardId,
      attachmentId: inserted.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      source,
      commentId,
    },
  });
  await emitCoalescedAttachmentActivity(card.boardId, cardId, activity);

  await evaluateWorkspaceAnalyticsMilestones({
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    supportSession: auth.authKind === "support" || auth.authKind === "apiKey",
  });
  return attachment;
}
