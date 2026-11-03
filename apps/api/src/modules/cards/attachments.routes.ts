import type { AttachmentSource } from "@kanera/shared/dto";
import { ATTACHMENT_SOURCES } from "@kanera/shared/dto";
import { cardAttachments, cards } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { readAttachmentUpload } from "../../lib/read-attachment-upload.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { attachmentResponse, listCardAttachments } from "./card-attachments.js";
import { loadCardAttachmentContent, parseAttachmentContentVariant } from "./card-attachment-content.js";
import { removeCardAttachment } from "./card-attachment-remove.js";
import { prepareCardUpload, storeCardAttachment } from "./card-attachment-store.js";
import { setCardCover } from "./card-cover.js";

export { attachmentResponse } from "./card-attachments.js";
export { removeCardAttachment } from "./card-attachment-remove.js";
export { prepareCardUpload, storeCardAttachment, type CardUploadTarget } from "./card-attachment-store.js";

function isAttachmentSource(value: unknown): value is AttachmentSource {
  return typeof value === "string" && (ATTACHMENT_SOURCES as readonly string[]).includes(value);
}

export async function cardAttachmentRoutes(app: FastifyInstance, options: { exposeCoverMetadata?: boolean } = {}) {
  const exposeCoverMetadata = options.exposeCoverMetadata ?? true;
  app.addHook("preHandler", app.authenticate);

  app.get("/cards/:id/attachments", async (req) => {
    const { id: cardId } = req.params as { id: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card);

    const rows = await listCardAttachments(cardId);
    return rows.map((row) => attachmentResponse(row, exposeCoverMetadata));
  });

  /**
   * The file bytes behind an attachment, for API-key clients that cannot use signed media URLs
   * (the media route refuses bearer API keys, and on the public API it is limited per client IP,
   * which every hosted MCP user would share). Access is checked live on each read like any other
   * card read. `variant` selects the JPEG derivatives Kanera generates for raster images: `cover`
   * (up to 1200px) and `thumbnail` (400px) let an agent look at a large photo cheaply.
   */
  app.get("/cards/:id/attachments/:attachmentId/content", async (req, reply) => {
    const { id: cardId, attachmentId } = req.params as { id: string; attachmentId: string };
    const { variant: variantParam = "original" } = req.query as { variant?: string };
    const variant = parseAttachmentContentVariant(variantParam);
    const { contentType, range, object } = await loadCardAttachmentContent({
      auth: req.auth,
      cardId,
      attachmentId,
      variant,
      rangeHeader: req.headers.range,
    });
    reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Type", contentType)
      // Same active-content neutralisation as the media route: uploads are attacker-controlled.
      .header("Content-Security-Policy", "default-src 'none'; sandbox; style-src 'unsafe-inline'")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "attachment")
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(object.contentLength));
    if (range && object.totalLength !== undefined) {
      const end = range.start + object.contentLength - 1;
      reply.status(206).header("Content-Range", `bytes ${range.start}-${end}/${object.totalLength}`);
    }
    return reply.send(object.body);
  });

  app.post("/cards/:id/attachments", async (req, reply) => {
    const { id: cardId } = req.params as { id: string };
    const query = req.query as { source?: string; commentId?: string };
    const sourceParam = query.source;
    if (sourceParam !== undefined && !isAttachmentSource(sourceParam)) {
      throw badRequest("invalid source");
    }
    const target = await prepareCardUpload(req.auth, cardId, sourceParam ?? "attachment", query.commentId ?? null);
    const { file, ext, buffer } = await readAttachmentUpload(req, target.uploadEntitlements.maxFileBytes);
    const attachment = await storeCardAttachment(req.auth, target, { fileName: file.filename, mimeType: file.mimetype, ext, buffer });
    return reply.status(201).send(attachmentResponse(attachment, exposeCoverMetadata));
  });

  app.patch("/cards/:id/cover", async (req) => {
    const { id: cardId } = req.params as { id: string };
    const { attachmentId } = req.body as { attachmentId: string | null };
    return setCardCover({ auth: req.auth, cardId, attachmentId });
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
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    await removeCardAttachment({
      card,
      attachment,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      mediaClientId: req.auth.cid,
      log: req.log,
    });

    return reply.status(204).send();
  });
}
