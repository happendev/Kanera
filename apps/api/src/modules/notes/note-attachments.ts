import { NOTE_ATTACHMENT_SOURCES, type NoteAttachmentRow, type NoteAttachmentSource } from "@kanera/shared/dto";
import { noteAttachments, notes, users, type Note } from "@kanera/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { putAttachmentFile } from "../../lib/attachment-upload.js";
import { assertCanUploadAttachment, getUploadEntitlements, isStorageFull, storageQuotaExceededError } from "../../lib/entitlements.js";
import { notFound } from "../../lib/errors.js";
import { signedAvatarUrl, unsignedMediaUrl } from "../../lib/media-keys.js";
import type { readAttachmentUpload } from "../../lib/read-attachment-upload.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { noteAttachmentStorageKey } from "../../lib/storage/keys.js";
import { stripAttachmentReferences } from "../../lib/strip-attachment-refs.js";
import { emitNoteEvent, shapeNote } from "./route-support.js";

const noteAttachmentRowColumns = {
  id: noteAttachments.id,
  noteId: noteAttachments.noteId,
  fileName: noteAttachments.fileName,
  mimeType: noteAttachments.mimeType,
  byteSize: noteAttachments.byteSize,
  url: noteAttachments.url,
  fileKey: noteAttachments.fileKey,
  createdAt: noteAttachments.createdAt,
  uploadedById: noteAttachments.uploadedById,
  uploadedByName: users.displayName,
  uploadedByAvatarUrl: users.avatarUrl,
  uploadedByClientId: users.clientId,
  source: noteAttachments.source,
} as const;

type NoteAttachmentRowWithKeys = NoteAttachmentRow & { fileKey: string; uploadedByClientId: string };

export function isNoteAttachmentSource(value: unknown): value is NoteAttachmentSource {
  return typeof value === "string" && (NOTE_ATTACHMENT_SOURCES as readonly string[]).includes(value);
}

async function selectNoteAttachmentRow(attachmentId: string): Promise<NoteAttachmentRowWithKeys> {
  const [row] = await db
    .select(noteAttachmentRowColumns)
    .from(noteAttachments)
    .innerJoin(users, eq(users.id, noteAttachments.uploadedById))
    .where(eq(noteAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw notFound();
  return row as NoteAttachmentRowWithKeys;
}

export async function listNoteAttachments(noteId: string) {
  const rows = await db
    .select(noteAttachmentRowColumns)
    .from(noteAttachments)
    .innerJoin(users, eq(users.id, noteAttachments.uploadedById))
    .where(eq(noteAttachments.noteId, noteId))
    .orderBy(desc(noteAttachments.createdAt));

  return rows.map(({ uploadedByClientId, uploadedByAvatarUrl, ...row }) => ({
    ...shapeAttachmentMedia(row),
    uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
  }));
}

/**
 * Stores an uploaded file against a note and marks the note edited. `readUpload` streams the
 * multipart body (it is only invoked once the host org's storage preflight has passed) so the
 * route keeps the Fastify request to itself.
 */
export async function addNoteAttachment({
  auth,
  note,
  ownerClientId,
  source,
  readUpload,
}: {
  auth: AuthClaims;
  note: Note;
  /** The host org that owns the note's workspace (from `authoriseWrite`). */
  ownerClientId: string;
  source: NoteAttachmentSource;
  readUpload: (maxFileBytes: number) => ReturnType<typeof readAttachmentUpload>;
}) {
  const id = note.id;
  // Host-pays: charge the org that owns the note's workspace, not the uploader's own org. Physical
  // storage stays under the uploader's tenant (req.auth.cid) — accounting only moves to the host.
  const uploadEntitlements = await getUploadEntitlements(db, ownerClientId);
  // If the host org's storage pool is already full, reject before reading the upload body so a full
  // org never wastes bandwidth streaming a file that cannot be stored.
  if (isStorageFull(uploadEntitlements)) throw storageQuotaExceededError(uploadEntitlements);
  const { file, ext, buffer } = await readUpload(uploadEntitlements.maxFileBytes);
  await assertCanUploadAttachment(db, ownerClientId, buffer.byteLength);

  const fileKey = noteAttachmentStorageKey(id, ext);
  const storage = await getStorageForClient(auth.cid);
  await putAttachmentFile(storage, fileKey, buffer, file.mimetype);
  const url = unsignedMediaUrl(auth.cid, fileKey)!;

  let inserted: typeof noteAttachments.$inferSelect;
  let editedNote: Note;
  try {
    ({ inserted, editedNote } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(noteAttachments)
        .values({
          noteId: id,
          clientId: ownerClientId,
          uploadedById: auth.sub,
          fileName: file.filename,
          mimeType: file.mimetype,
          byteSize: buffer.byteLength,
          fileKey,
          url,
          source,
        })
        .returning();
      const now = new Date();
      const [updated] = await tx
        .update(notes)
        .set({
          lastEditedById: auth.sub,
          lastEditedAt: now,
        })
        .where(eq(notes.id, id))
        .returning();
      return { inserted: row!, editedNote: updated! };
    }));
  } catch (err) {
    await storage.delete(fileKey).catch(() => undefined);
    throw err;
  }

  const attachmentRow = await selectNoteAttachmentRow(inserted.id);
  const { uploadedByClientId, uploadedByAvatarUrl, ...attachmentMedia } = attachmentRow;
  const attachment = {
    ...shapeAttachmentMedia(attachmentMedia),
    uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
  };
  const responseNote = await shapeNote(editedNote, auth.cid);
  return { editedNote, responseNote, attachment };
}

/** Deletes one attachment of a note by id (404 when it belongs to another note). */
export async function deleteNoteAttachment({ auth, note, attachmentId }: { auth: AuthClaims; note: Note; attachmentId: string }): Promise<void> {
  const [attachment] = await db
    .select()
    .from(noteAttachments)
    .where(and(eq(noteAttachments.id, attachmentId), eq(noteAttachments.noteId, note.id)))
    .limit(1);
  if (!attachment) throw notFound();

  await removeNoteAttachment({ note, attachment, actorId: auth.sub, mediaClientId: auth.cid });
}

/**
 * Removes one note attachment: the row, its file, and inline references in the note body, then
 * echoes the edited note. Shared by the note route and the organisation storage cleanup.
 */
export async function removeNoteAttachment(params: {
  note: Note;
  attachment: typeof noteAttachments.$inferSelect;
  actorId: string;
  mediaClientId: string;
}): Promise<void> {
  const { note, attachment, actorId, mediaClientId } = params;
  await db.delete(noteAttachments).where(eq(noteAttachments.id, attachment.id));

  const storage = await getStorageForClient(mediaClientId);
  await storage.delete(attachment.fileKey).catch(() => undefined);

  const storedAttachmentUrl = unsignedMediaUrl(mediaClientId, attachment.fileKey)!;
  const stripped = stripAttachmentReferences(note.content, storedAttachmentUrl);
  const now = new Date();
  const [updatedNote] = await db
    .update(notes)
    .set({
      ...(stripped.changed && { content: stripped.body ?? "" }),
      lastEditedById: actorId,
      lastEditedAt: now,
      updatedAt: now,
    })
    .where(eq(notes.id, note.id))
    .returning();
  const responseNote = await shapeNote(updatedNote!, mediaClientId);

  emitNoteEvent(updatedNote!, "note:updated", { note: responseNote });
  emitNoteEvent(updatedNote!, "note:attachment:deleted", {
    note: responseNote,
    attachmentId: attachment.id,
  });
}
