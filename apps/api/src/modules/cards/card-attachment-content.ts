import { cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { parseMediaReference } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { parseRangeHeader } from "../media/routes.js";
import { selectAttachmentRow } from "./card-attachments.js";

type AttachmentContentVariant = "original" | "cover" | "thumbnail";

export function parseAttachmentContentVariant(variant: string): AttachmentContentVariant {
  if (variant !== "original" && variant !== "cover" && variant !== "thumbnail") throw badRequest("variant must be original, cover, or thumbnail");
  return variant;
}

/**
 * Loads the stored object behind `GET /cards/:id/attachments/:attachmentId/content` after the
 * card read check, honouring an optional Range header. The route turns the result into headers.
 */
export async function loadCardAttachmentContent({
  auth,
  cardId,
  attachmentId,
  variant,
  rangeHeader,
}: {
  auth: AuthClaims;
  cardId: string;
  attachmentId: string;
  variant: AttachmentContentVariant;
  rangeHeader: string | undefined;
}) {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  if (!card) throw notFound();
  await assertCardAccess(auth, card);
  const row = await selectAttachmentRow(attachmentId);
  if (row.cardId !== cardId) throw notFound();

  const fileKey = variant === "original" ? row.fileKey : variant === "cover" ? row.coverImageFileKey : row.thumbnailFileKey;
  if (!fileKey) throw notFound(`this attachment has no ${variant} image`);
  // The file lives in the uploader's tenant storage at upload time, which the stored media path
  // records; the uploader may since have moved organisation, so their current client id is wrong.
  const owner = parseMediaReference(row.url);
  if (!owner) throw notFound();
  const storage = await getStorageForClient(owner.clientId);
  const range = parseRangeHeader(rangeHeader);
  let object;
  try {
    object = await storage.getObject(fileKey, range ?? undefined);
  } catch {
    throw notFound();
  }
  return { contentType: variant === "original" ? row.mimeType : "image/jpeg", range, object };
}
