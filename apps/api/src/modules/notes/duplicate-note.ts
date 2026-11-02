import { randomUUID } from "node:crypto";
import type { dto } from "@kanera/shared";
import type { WireNote } from "@kanera/shared/events";
import { noteAttachments, type Note } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { rewriteCopiedMediaUrls } from "../../lib/copied-media-urls.js";
import { assertCanUploadAttachment } from "../../lib/entitlements.js";
import { conflict } from "../../lib/errors.js";
import { EMPTY_LINK_FANOUT, replaceInternalLinksForSource, type LinkFanout } from "../../lib/internal-links.js";
import { parseMediaReference, unsignedMediaUrl } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { noteAttachmentStorageKey } from "../../lib/storage/keys.js";
import { insertNote, MAX_NOTE_TREE_DEPTH, noteDepth, resolveParent, shapeNote } from "./route-support.js";

function duplicateTitle(title: string): string {
  const base = title.trim() || "Untitled";
  const suffix = " copy";
  return base.length + suffix.length <= 200
    ? `${base}${suffix}`
    : `${base.slice(0, 200 - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Copies one note (not its descendants) next to or under the requested parent, copying its
 * attachment files so the two notes never share storage.
 */
export async function duplicateNote({
  auth,
  source,
  ownerClientId,
  body,
}: {
  auth: AuthClaims;
  source: Note;
  /** The host org that owns the note's workspace (from `authoriseWrite`); the copies are charged to it. */
  ownerClientId: string;
  body: dto.DuplicateNoteBody;
}): Promise<{ duplicate: Note; responseNote: WireNote; linkFanout: LinkFanout }> {
  const id = source.id;
  const parentNoteId = body.parentNoteId === undefined ? source.parentNoteId : body.parentNoteId;
  const parent = await resolveParent(
    source.workspaceId,
    source.boardId,
    parentNoteId,
    source.scope,
    source.ownerId,
  );
  if (await noteDepth(parent) >= MAX_NOTE_TREE_DEPTH) {
    throw conflict("notes can only be nested 3 levels deep");
  }

  // Duplicate one document, not its descendants. Its attachments are copied so the duplicate owns
  // its files: deleting either note, or one of its attachments, must not break the other's images.
  // Copies follow the upload rules: charged to the host org, stored under the duplicator's tenant.
  const sourceAttachments = await db.select().from(noteAttachments).where(eq(noteAttachments.noteId, id));
  const copyBytes = sourceAttachments.reduce((sum, row) => sum + row.byteSize, 0);
  if (copyBytes > 0) await assertCanUploadAttachment(db, ownerClientId, copyBytes);
  const newNoteId = randomUUID();
  const dstStorage = await getStorageForClient(auth.cid);
  const copiedFiles: Array<{ src: typeof noteAttachments.$inferSelect; fileKey: string; url: string }> = [];
  try {
    for (const row of sourceAttachments) {
      const srcStorage = await getStorageForClient(parseMediaReference(row.url)?.clientId ?? row.clientId);
      const ext = row.fileKey.includes(".") ? row.fileKey.slice(row.fileKey.lastIndexOf(".") + 1) : "";
      const fileKey = noteAttachmentStorageKey(newNoteId, ext);
      await dstStorage.put(fileKey, await srcStorage.get(row.fileKey), row.mimeType);
      copiedFiles.push({ src: row, fileKey, url: unsignedMediaUrl(auth.cid, fileKey)! });
    }
  } catch (err) {
    await Promise.allSettled(copiedFiles.map((file) => dstStorage.delete(file.fileKey)));
    throw err;
  }
  const mediaUrls = new Map(copiedFiles.map((file) => [file.src.url, file.url]));

  // Embedded/internal links in the copied Markdown are rebuilt for the new source so backlinks
  // remain accurate.
  let linkFanout: LinkFanout = EMPTY_LINK_FANOUT;
  const duplicate = await db.transaction(async (tx) => {
    const inserted = await insertNote({
      id: newNoteId,
      workspaceId: source.workspaceId,
      boardId: source.boardId,
      parentNoteId,
      scope: source.scope,
      ownerId: source.ownerId,
      lastEditedById: auth.sub,
      title: body.title ?? duplicateTitle(source.title),
      content: rewriteCopiedMediaUrls(source.content, mediaUrls),
      icon: source.icon,
      color: source.color,
    }, tx);
    if (copiedFiles.length > 0) {
      await tx.insert(noteAttachments).values(copiedFiles.map((file) => ({
        noteId: inserted.id,
        clientId: ownerClientId,
        uploadedById: auth.sub,
        fileName: file.src.fileName,
        mimeType: file.src.mimeType,
        byteSize: file.src.byteSize,
        fileKey: file.fileKey,
        url: file.url,
        source: file.src.source,
      })));
    }
    linkFanout = await replaceInternalLinksForSource({
      tx,
      claims: auth,
      workspaceId: inserted.workspaceId,
      sourceType: "note",
      sourceId: inserted.id,
      markdown: inserted.content,
    });
    return inserted;
  }).catch(async (err: unknown) => {
    await Promise.allSettled(copiedFiles.map((file) => dstStorage.delete(file.fileKey)));
    throw err;
  });
  const responseNote = await shapeNote(duplicate, auth.cid);
  return { duplicate, responseNote, linkFanout };
}
