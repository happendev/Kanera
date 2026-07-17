import type { AttachmentSource, CardAttachmentRow } from "@kanera/shared/dto";
import { ATTACHMENT_SOURCES } from "@kanera/shared/dto";
import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import { cardAttachments, cards, comments, users } from "@kanera/shared/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { assertCanUploadAttachment, formatStorageBytes, getUploadEntitlements, isStorageFull, storageQuotaExceededError } from "../../lib/entitlements.js";
import { stripAttachmentReferences } from "../../lib/strip-attachment-refs.js";
import { dominantColorFromThumbnail, generateCoverImage, generateThumbnail, isProcessableImage } from "../../lib/image.js";
import { signEmbeddedMediaUrls, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey, attachmentThumbnailStorageKey, cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { emitToBoard } from "../../realtime/emit.js";
import type { StorageProvider } from "../../lib/storage/types.js";

const attachmentRowColumns = {
  id: cardAttachments.id,
  cardId: cardAttachments.cardId,
  fileName: cardAttachments.fileName,
  mimeType: cardAttachments.mimeType,
  byteSize: cardAttachments.byteSize,
  url: cardAttachments.url,
  fileKey: cardAttachments.fileKey,
  thumbnailUrl: cardAttachments.thumbnailUrl,
  thumbnailFileKey: cardAttachments.thumbnailFileKey,
  coverImageUrl: cardAttachments.coverImageUrl,
  coverImageFileKey: cardAttachments.coverImageFileKey,
  coverImageWidth: cardAttachments.coverImageWidth,
  coverImageHeight: cardAttachments.coverImageHeight,
  coverImageColor: cardAttachments.coverImageColor,
  createdAt: cardAttachments.createdAt,
  uploadedById: cardAttachments.uploadedById,
  uploadedByName: users.displayName,
  uploadedByAvatarUrl: users.avatarUrl,
  source: cardAttachments.source,
  commentId: cardAttachments.commentId,
} as const;

type AttachmentRowWithKeys = CardAttachmentRow & {
  fileKey: string;
  thumbnailFileKey: string | null;
  coverImageFileKey: string | null;
  coverImageUrl?: string | null;
};

async function selectAttachmentRow(attachmentId: string): Promise<AttachmentRowWithKeys> {
  const [row] = await db
    .select(attachmentRowColumns)
    .from(cardAttachments)
    .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
    .where(eq(cardAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw notFound();
  return row as AttachmentRowWithKeys;
}

function isAttachmentSource(value: unknown): value is AttachmentSource {
  return typeof value === "string" && (ATTACHMENT_SOURCES as readonly string[]).includes(value);
}

function assertCardActive(card: Pick<typeof cards.$inferSelect, "archivedAt">) {
  if (card.archivedAt) throw badRequest("archived cards are read-only");
}

function attachmentResponse<T extends object>(attachment: T, exposeCoverMetadata: boolean): T {
  if (exposeCoverMetadata) return attachment;
  // The app API needs derivative metadata for stable card rendering and cheap drag previews, but
  // it is an internal implementation detail rather than part of the public attachment contract.
  const response = { ...attachment } as T & {
    coverImageWidth?: unknown;
    coverImageHeight?: unknown;
    coverImageColor?: unknown;
  };
  delete response.coverImageWidth;
  delete response.coverImageHeight;
  delete response.coverImageColor;
  return response;
}

async function putAttachmentFile(storage: StorageProvider, key: string, body: Buffer, contentType: string) {
  try {
    await storage.put(key, body, contentType);
  } catch {
    throw new AppError(503, "STORAGE_UNAVAILABLE", "attachment storage unavailable");
  }
}

function fileTooLargeError(maxFileBytes: number, attemptedBytes?: number) {
  return new AppError(
    400,
    "FILE_TOO_LARGE",
    `File is too large. The maximum file size is ${formatStorageBytes(maxFileBytes)}.`,
    { limit: "fileSize", maxFileBytes, ...(attemptedBytes !== undefined ? { attemptedBytes } : {}) },
  );
}

export async function cardAttachmentRoutes(app: FastifyInstance, options: { exposeCoverMetadata?: boolean } = {}) {
  const exposeCoverMetadata = options.exposeCoverMetadata ?? true;
  app.addHook("preHandler", app.authenticate);

  app.get("/cards/:id/attachments", async (req) => {
    const { id: cardId } = req.params as { id: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id);

    const rows = await db
      .select(attachmentRowColumns)
      .from(cardAttachments)
      .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
      .where(eq(cardAttachments.cardId, cardId))
      .orderBy(desc(cardAttachments.createdAt));

    return rows.map((row) => attachmentResponse(
      {
        ...shapeAttachmentMedia(row),
        uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: row.uploadedByAvatarUrl }).uploadedByAvatarUrl,
      },
      exposeCoverMetadata,
    ));
  });

  app.post("/cards/:id/attachments", async (req, reply) => {
    const { id: cardId } = req.params as { id: string };
    const query = req.query as { source?: string; commentId?: string };
    const sourceParam = query.source;
    if (sourceParam !== undefined && !isAttachmentSource(sourceParam)) {
      throw badRequest("invalid source");
    }
    const source: AttachmentSource = sourceParam ?? "attachment";
    const commentIdParam = query.commentId ?? null;

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);

    if (commentIdParam) {
      const [c] = await db.select().from(comments).where(eq(comments.id, commentIdParam)).limit(1);
      if (!c || c.cardId !== cardId) throw badRequest("invalid commentId");
      if (c.authorId !== req.auth.sub) throw forbidden();
    }

    // Storage is host-pays: charge the org that owns the board (ctx.clientId), not the uploader's own
    // org. A guest's upload to a paid board draws down the host's quota and uses the host's per-file
    // limit. Physical storage stays under the uploader's tenant (req.auth.cid) by design — see the
    // media auth note: relocating it risks authenticated-fetch breakage for no accounting benefit.
    const uploadEntitlements = await getUploadEntitlements(db, ctx.clientId);
    // If the host org's storage pool is already full, reject before reading the upload body so a full
    // org never wastes bandwidth streaming a file that cannot be stored.
    if (isStorageFull(uploadEntitlements)) throw storageQuotaExceededError(uploadEntitlements);
    const file = await req
      .file({ limits: { fileSize: uploadEntitlements.maxFileBytes, files: 1 } })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          throw fileTooLargeError(uploadEntitlements.maxFileBytes);
        }
        return null;
      });
    if (!file) throw badRequest("no file uploaded");

    const ext = getAllowedAttachmentExtension(file.mimetype, file.filename);
    if (!ext) throw badRequest("unsupported file type");

    const buffer = await file.toBuffer().catch((err: unknown) => {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw fileTooLargeError(uploadEntitlements.maxFileBytes);
      }
      throw err;
    });
    if (buffer.byteLength > uploadEntitlements.maxFileBytes) {
      throw fileTooLargeError(uploadEntitlements.maxFileBytes, buffer.byteLength);
    }
    await assertCanUploadAttachment(db, ctx.clientId, buffer.byteLength);

    const fileKey = cardAttachmentStorageKey(cardId, ext);
    const storage = await getStorageForClient(req.auth.cid);
    await putAttachmentFile(storage, fileKey, buffer, file.mimetype);
    const url = unsignedMediaUrl(req.auth.cid, fileKey)!;

    let thumbnailUrl: string | null = null;
    let thumbnailFileKey: string | null = null;
    let coverImageUrl: string | null = null;
    let coverImageFileKey: string | null = null;
    let coverImageWidth: number | null = null;
    let coverImageHeight: number | null = null;
    let coverImageColor: string | null = null;

    if (isProcessableImage(file.mimetype)) {
      const thumb = await generateThumbnail(buffer, file.mimetype);
      thumbnailFileKey = attachmentThumbnailStorageKey(fileKey, thumb.ext);
      await putAttachmentFile(storage, thumbnailFileKey, thumb.buffer, thumb.mimeType);
      thumbnailUrl = unsignedMediaUrl(req.auth.cid, thumbnailFileKey);
      coverImageColor = thumb.dominantColor;

      if (!card.coverAttachmentId && source !== "comment") {
        const cover = await generateCoverImage(buffer, file.mimetype);
        coverImageFileKey = attachmentCoverStorageKey(fileKey, cover.ext);
        await putAttachmentFile(storage, coverImageFileKey, cover.buffer, cover.mimeType);
        coverImageUrl = unsignedMediaUrl(req.auth.cid, coverImageFileKey);
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
          uploadedById: req.auth.sub,
          fileName: file.filename,
          mimeType: file.mimetype,
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
          commentId: commentIdParam,
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
    const attachment = {
      ...shapeAttachmentMedia(attachmentRow),
      uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: attachmentRow.uploadedByAvatarUrl }).uploadedByAvatarUrl,
    };

    let coverChanged = false;
    if (!card.coverAttachmentId && file.mimetype.startsWith("image/") && source !== "comment") {
      await db
        .update(cards)
        .set({ coverAttachmentId: inserted.id, updatedAt: new Date() })
        .where(eq(cards.id, cardId));
      coverChanged = true;
    }

    emitToBoard(card.boardId, "card:attachment:created", {
      boardId: card.boardId,
      cardId,
      attachment,
    });

    if (coverChanged) {
      const [updatedCard] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
      if (updatedCard) {
        emitToBoard(card.boardId, "card:updated", { boardId: card.boardId, card: updatedCard });
      }
    }

    const activity = await recordActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "card",
      entityId: cardId,
      action: "attachment_added",
      payload: {
        cardId,
        attachmentId: inserted.id,
        fileName: file.filename,
        mimeType: file.mimetype,
        source,
        commentId: commentIdParam,
      },
    });
    emitActivityFeedItem(card.boardId, cardId, activity);

    return reply.status(201).send(attachmentResponse(attachment, exposeCoverMetadata));
  });

  app.patch("/cards/:id/cover", async (req) => {
    const { id: cardId } = req.params as { id: string };
    const { attachmentId } = req.body as { attachmentId: string | null };

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);

    const storage = await getStorageForClient(req.auth.cid);

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
        const coverUrl = unsignedMediaUrl(req.auth.cid, coverFileKey);
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

    emitToBoard(card.boardId, "card:updated", { boardId: card.boardId, card: updated! });

    await recordActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "card",
      entityId: cardId,
      action: attachmentId ? "cover_set" : "cover_removed",
      payload: { cardId },
    });

    return updated!;
  });

  app.delete("/cards/:id/attachments/:attachmentId", async (req, reply) => {
    const { id: cardId, attachmentId } = req.params as { id: string; attachmentId: string };

    const [attachment] = await db
      .select()
      .from(cardAttachments)
      .where(and(eq(cardAttachments.id, attachmentId), eq(cardAttachments.cardId, cardId)))
      .limit(1);
    if (!attachment) throw notFound();

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);

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

    const storage = await getStorageForClient(req.auth.cid);
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
          const coverUrl = unsignedMediaUrl(req.auth.cid, coverFileKey);
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
        req.log.warn({ err, nextCoverId }, "cover image generation for reassigned cover failed");
      }
    }

    emitToBoard(card.boardId, "card:attachment:deleted", {
      boardId: card.boardId,
      cardId,
      attachmentId,
    });

    // Strip inline references to this attachment's URL from the card's
    // description and from any comment bodies on this card.
    const storedAttachmentUrl = unsignedMediaUrl(req.auth.cid, attachment.fileKey)!;
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
          authorName: sql<string>`case when ${comments.authorKind} = 'system' then 'Kanera' when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
          authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
          body: comments.body,
          editedAt: comments.editedAt,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(eq(comments.id, c.id))
        .limit(1);
      if (updatedComment) {
        const reactionsMap = await fetchReactionsByComment([updatedComment.id], req.auth.cid);
        const enriched = {
          ...withSignedMedia(req.auth.cid, {
            ...updatedComment,
          body: signEmbeddedMediaUrls(updatedComment.body, req.auth.cid) ?? updatedComment.body,
          }),
          reactions: reactionsMap.get(updatedComment.id) ?? [],
        };
        emitToBoard(card.boardId, "comment:updated", {
          boardId: card.boardId,
          cardId,
          comment: enriched,
        });
        emitToBoard(card.boardId, "card:feedItem:updated", {
          boardId: card.boardId,
          cardId,
          item: { type: "comment", data: enriched },
        });
      }
    }

    if (coverChanged || descriptionChanged) {
      const [updatedCard] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
      if (updatedCard) {
        emitToBoard(card.boardId, "card:updated", { boardId: card.boardId, card: { ...updatedCard, description: signEmbeddedMediaUrls(updatedCard.description, req.auth.cid) } });
      }
    }

    const activity = await recordActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "card",
      entityId: cardId,
      action: "attachment_removed",
      payload: { cardId, attachmentId, fileName: attachment.fileName },
    });
    emitActivityFeedItem(card.boardId, cardId, activity);

    return reply.status(204).send();
  });
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
