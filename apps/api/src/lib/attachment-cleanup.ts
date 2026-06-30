import { cardAttachments } from "@kanera/shared/schema";
import { inArray } from "drizzle-orm";
import { db } from "../db.js";
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
