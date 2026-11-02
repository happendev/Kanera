import { scratchpadNoteAttachments, scratchpadNotes } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { loadOwnedForUpdate } from "./route-support.js";

/** Hard-deletes a page with its attachment rows, then best-effort removes their stored objects. */
export async function deleteScratchpadNote({ auth, id }: { auth: AuthClaims; id: string }): Promise<void> {
  const { attachments, clientId } = await db.transaction(async (tx) => {
    // Lock the page while collecting keys and hard-deleting its rows. Without one transaction, an
    // upload could commit between the key query and note delete: its row would cascade away, but its
    // physical object key would be lost forever.
    const note = await loadOwnedForUpdate(id, auth, tx);
    const attachments = await tx
      .select({ fileKey: scratchpadNoteAttachments.fileKey })
      .from(scratchpadNoteAttachments)
      .where(eq(scratchpadNoteAttachments.scratchpadNoteId, id));

    // Be explicit about the hard delete rather than relying only on the FK cascade. This keeps the
    // attachment lifecycle obvious here and leaves no rows contributing to storage quota.
    await tx
      .delete(scratchpadNoteAttachments)
      .where(eq(scratchpadNoteAttachments.scratchpadNoteId, id));
    await tx.delete(scratchpadNotes).where(eq(scratchpadNotes.id, id));
    return { attachments, clientId: note.clientId };
  });

  // Best-effort after the committed row deletion, matching the other attachment paths: a storage
  // outage may leave an unreachable provider object, but must not resurrect the note or its rows.
  const storage = await getStorageForClient(clientId);
  await Promise.all(attachments.map((row) => storage.delete(row.fileKey).catch(() => undefined)));
}
