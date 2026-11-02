import type { ScratchpadNoteAttachmentRow } from "@kanera/shared/dto";
import { scratchpadNoteAttachments, scratchpadNotes, type ScratchpadNote } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { putAttachmentFile } from "../../lib/attachment-upload.js";
import {
  assertCanUploadAttachment,
  getUploadEntitlements,
  isStorageFull,
  storageQuotaExceededError,
} from "../../lib/entitlements.js";
import { notFound } from "../../lib/errors.js";
import { unsignedMediaUrl } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { scratchpadNoteAttachmentStorageKey } from "../../lib/storage/keys.js";
import { stripAttachmentReferences } from "../../lib/strip-attachment-refs.js";
import { loadOwned, loadOwnedForUpdate } from "./route-support.js";

/**
 * Upload a file embedded in a scratchpad page (pasted screenshot, dropped image).
 *
 * Diverges from the notes upload path in one way: there is no host-pays split. A note charges the
 * org owning its workspace, which can differ from the uploader's org for cross-organisation guests.
 * A scratchpad page has no workspace and its owner is the only possible uploader, so quota,
 * accounting, and physical storage are all the requester's own org — `auth.cid` throughout.
 *
 * Runs before the multipart body is read; `storeScratchpadAttachment` finishes the upload.
 */
export async function prepareScratchpadUpload({ auth, id }: { auth: AuthClaims; id: string }) {
  await loadOwned(id, auth);

  const uploadEntitlements = await getUploadEntitlements(db, auth.cid);
  // Reject a full org before reading the body so it never wastes bandwidth on an unstorable file.
  if (isStorageFull(uploadEntitlements)) throw storageQuotaExceededError(uploadEntitlements);
  return { uploadEntitlements };
}

export async function storeScratchpadAttachment({
  auth,
  id,
  upload,
}: {
  auth: AuthClaims;
  id: string;
  upload: { fileName: string; mimeType: string; ext: string; buffer: Buffer };
}): Promise<ScratchpadNoteAttachmentRow> {
  const { buffer, ext } = upload;
  await assertCanUploadAttachment(db, auth.cid, buffer.byteLength);

  const fileKey = scratchpadNoteAttachmentStorageKey(id, ext);
  const storage = await getStorageForClient(auth.cid);
  await putAttachmentFile(storage, fileKey, buffer, upload.mimeType);
  const url = unsignedMediaUrl(auth.cid, fileKey)!;

  let inserted: typeof scratchpadNoteAttachments.$inferSelect;
  try {
    const [row] = await db
      .insert(scratchpadNoteAttachments)
      .values({
        scratchpadNoteId: id,
        clientId: auth.cid,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        byteSize: buffer.byteLength,
        fileKey,
        url,
      })
      .returning();
    inserted = row!;
  } catch (err) {
    await storage.delete(fileKey).catch(() => undefined);
    throw err;
  }

  // Deliberately no page update and no realtime event. The editor inserts the returned URL into the
  // body and the content autosave that follows carries the embed, so bumping `updatedAt` here would
  // advance the echo watermark *before* that save lands — every other session would then treat the
  // real content write as its own echo and never render the image.
  return shapeAttachmentMedia({
    id: inserted.id,
    scratchpadNoteId: inserted.scratchpadNoteId,
    fileName: inserted.fileName,
    mimeType: inserted.mimeType,
    byteSize: inserted.byteSize,
    url: inserted.url,
    createdAt: inserted.createdAt,
  });
}

/**
 * Roll back an upload that TipTap could not insert, and provide a direct cleanup path for clients.
 * If the file was already embedded, remove the reference atomically with its row so no saved page
 * can retain an invisible, broken quota consumer.
 */
export async function deleteScratchpadAttachment({
  auth,
  id,
  attachmentId,
}: {
  auth: AuthClaims;
  id: string;
  attachmentId: string;
}): Promise<{ updated: ScratchpadNote | null }> {
  const { attachment, updated } = await db.transaction(async (tx) => {
    const note = await loadOwnedForUpdate(id, auth, tx);
    const [attachment] = await tx
      .select()
      .from(scratchpadNoteAttachments)
      .where(and(
        eq(scratchpadNoteAttachments.id, attachmentId),
        eq(scratchpadNoteAttachments.scratchpadNoteId, id),
      ))
      .limit(1);
    if (!attachment) throw notFound();

    const stripped = stripAttachmentReferences(note.content, attachment.url);
    const [updated] = stripped.changed
      ? await tx
          .update(scratchpadNotes)
          .set({ content: stripped.body ?? "", updatedAt: new Date() })
          .where(eq(scratchpadNotes.id, id))
          .returning()
      : [null];
    await tx.delete(scratchpadNoteAttachments).where(eq(scratchpadNoteAttachments.id, attachmentId));
    return { attachment, updated };
  });

  const storage = await getStorageForClient(attachment.clientId);
  await storage.delete(attachment.fileKey).catch(() => undefined);

  return { updated: updated ?? null };
}
