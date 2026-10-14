import { cardAttachments, noteAttachments, notes } from "@kanera/shared/schema";
import { and, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { parseMediaReference } from "./media-keys.js";
import { getStorageForClient } from "./storage/index.js";
import type { StorageProvider } from "./storage/types.js";

/**
 * Read the physical file keys (original, thumbnail, cover) for the given card IDs.
 * Capture these *before* the DB cascade delete, since `cardAttachments` rows are removed
 * with their card and the key metadata would otherwise be gone.
 */
export async function collectAttachmentFileKeys(cardIds: string[]): Promise<string[]> {
  if (cardIds.length === 0) return [];

  const attachments = await db
    .select({
      fileKey: cardAttachments.fileKey,
      thumbnailFileKey: cardAttachments.thumbnailFileKey,
      coverImageFileKey: cardAttachments.coverImageFileKey,
    })
    .from(cardAttachments)
    .where(inArray(cardAttachments.cardId, cardIds));

  const keys: string[] = [];
  for (const a of attachments) {
    keys.push(a.fileKey);
    if (a.thumbnailFileKey) keys.push(a.thumbnailFileKey);
    if (a.coverImageFileKey) keys.push(a.coverImageFileKey);
  }
  return keys;
}

/** Best-effort delete of physical files by storage key. Failures are swallowed per key. */
export async function deleteStorageFiles(storage: StorageProvider, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await Promise.allSettled(keys.map((key) => storage.delete(key)));
}

/**
 * Delete all physical attachment files (original, thumbnail, cover) for the
 * given card IDs.  Call this *before* the DB cascade delete so the file-key
 * metadata is still available.
 */
export async function deleteAttachmentFiles(
  storage: StorageProvider,
  cardIds: string[],
): Promise<void> {
  const keys = await collectAttachmentFileKeys(cardIds);
  await deleteStorageFiles(storage, keys);
}

/** A stored note file, addressed by the tenant that physically holds it. */
export interface NoteAttachmentFile {
  clientId: string;
  key: string;
  workspaceId: string;
}

async function collectNoteFiles(where: SQL): Promise<NoteAttachmentFile[]> {
  const rows = await db
    .select({ url: noteAttachments.url, fileKey: noteAttachments.fileKey, rowClientId: noteAttachments.clientId, workspaceId: notes.workspaceId })
    .from(noteAttachments)
    .innerJoin(notes, eq(notes.id, noteAttachments.noteId))
    .where(where);
  // The row's client_id is the host org that is *charged* for the file; the bytes live under the
  // uploader's tenant, which only the media URL records (a guest uploads into their home org).
  return rows.map((row) => {
    const reference = parseMediaReference(row.url);
    return { clientId: reference?.clientId ?? row.rowClientId, key: row.fileKey, workspaceId: row.workspaceId };
  });
}

/**
 * Files attached to a note and every descendant page. Capture before deleting the note: both
 * child notes (`parent_note_id`) and attachment rows cascade, taking the file keys with them.
 */
export function collectNoteTreeFiles(noteId: string): Promise<NoteAttachmentFile[]> {
  return collectNoteFiles(sql`${noteAttachments.noteId} in (
    with recursive tree(id) as (
      select ${noteId}::uuid
      union all
      select n.id from note n join tree on n.parent_note_id = tree.id
    )
    select id from tree
  )`);
}

/** Files attached to every note on a board. Capture before the board delete cascades them away. */
export function collectBoardNoteFiles(boardId: string): Promise<NoteAttachmentFile[]> {
  return collectNoteFiles(eq(notes.boardId, boardId));
}

/** Files attached to every note in a workspace, board notes included. */
export function collectWorkspaceNoteFiles(workspaceId: string): Promise<NoteAttachmentFile[]> {
  return collectNoteFiles(eq(notes.workspaceId, workspaceId));
}

/**
 * Best-effort delete of note files whose rows are already gone. Call after the cascade commits:
 * rows first, then bytes, so a crash leaks an object rather than leaving a row pointing at nothing.
 *
 * Notes duplicated before duplication copied files share the original's files through their
 * Markdown, so a surviving note in the same workspace can still embed a file whose attachment row
 * belonged to the deleted one. Those files are kept; deleting them would break the copy's images.
 */
export async function deleteNoteFiles(files: NoteAttachmentFile[]): Promise<void> {
  if (files.length === 0) return;
  const deletable: NoteAttachmentFile[] = [];
  for (const file of files) {
    const [stillEmbedded] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.workspaceId, file.workspaceId), like(notes.content, `%${file.key}%`)))
      .limit(1);
    if (!stillEmbedded) deletable.push(file);
  }
  const keysByClient = new Map<string, string[]>();
  for (const file of deletable) keysByClient.set(file.clientId, [...(keysByClient.get(file.clientId) ?? []), file.key]);
  for (const [clientId, keys] of keysByClient) {
    await deleteStorageFiles(await getStorageForClient(clientId), keys);
  }
}
