import type { dto } from "@kanera/shared";
import { scratchpadNoteAttachments, scratchpadNotes, type ScratchpadNote } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { AppError, notFound } from "../../lib/errors.js";
import { stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { loadOwnedForUpdate, sameInstant, wire } from "./route-support.js";

/**
 * Autosave write. Last-write-wins on purpose.
 *
 * There is deliberately no edit lock and no `baseUpdatedAt` staleness check — both of which the
 * `notes` module has, and both of which would be actively wrong here. A scratchpad page has exactly
 * one writer, so the only "conflict" possible is that writer's own second device or second tab, and
 * answering their autosave with a 409 would interrupt them with a conflict against themselves. The
 * client instead treats the returned `updatedAt` as an echo watermark: the `scratchpadNote:updated`
 * event this emits comes back to the same user's other sessions, and each one compares that
 * timestamp against its own last-saved marker to decide whether the payload is its own echo (ignore)
 * or a genuine remote edit (apply if the local editor is clean).
 *
 * The loss window this accepts: two devices typing simultaneously, where the older write is
 * overwritten. The web client keeps the losing text in its local `EditorDrafts` entry, so nothing
 * the user typed disappears from the machine they typed it on.
 */
export async function updateScratchpadNote({
  auth,
  id,
  body,
}: {
  auth: AuthClaims;
  id: string;
  body: dto.UpdateScratchpadNoteBody;
}): Promise<ScratchpadNote> {
  // Signed media URLs are per-request and expiring, so the body is normalised back to its unsigned
  // form before storage (identical to notes/cards) and re-signed by `wire` on the way out.
  const content = body.content !== undefined
    ? stripSignedEmbeddedMediaUrls(body.content, auth.cid) ?? ""
    : undefined;

  const { updated, removedAttachments } = await db.transaction(async (tx) => {
    const current = await loadOwnedForUpdate(id, auth, tx);
    if (body.baseUpdatedAt && !sameInstant(body.baseUpdatedAt, current.updatedAt)) {
      throw new AppError(409, "SCRATCHPAD_STALE", "scratchpad page has changed since it was read", { note: wire(current) });
    }
    const attachments = content === undefined
      ? []
      : await tx
          .select({
            id: scratchpadNoteAttachments.id,
            fileKey: scratchpadNoteAttachments.fileKey,
            url: scratchpadNoteAttachments.url,
          })
          .from(scratchpadNoteAttachments)
          .where(eq(scratchpadNoteAttachments.scratchpadNoteId, id));

    // Only reclaim rows that were reachable from the previously saved body and are absent from
    // the new one. A freshly uploaded row is not yet in `current.content`; excluding it prevents an
    // older autosave that was already in flight from deleting an upload before TipTap inserts it.
    const removedAttachments = content === undefined
      ? []
      : attachments.filter((attachment) =>
          current.content.includes(attachment.url) && !content.includes(attachment.url));

    const [updated] = await tx
      .update(scratchpadNotes)
      .set({
        ...(body.title !== undefined && { title: body.title }),
        ...(content !== undefined && { content }),
        // Set explicitly: `updatedAt` is the client's echo watermark, so it must advance on every
        // accepted write even when the text is byte-identical to what was already stored.
        updatedAt: new Date(),
      })
      .where(eq(scratchpadNotes.id, id))
      .returning();
    if (!updated) throw notFound();

    if (removedAttachments.length > 0) {
      await tx
        .delete(scratchpadNoteAttachments)
        .where(inArray(scratchpadNoteAttachments.id, removedAttachments.map((row) => row.id)));
    }
    return { updated, removedAttachments };
  });

  // The DB row and body are already consistent. Physical deletion is best-effort, matching every
  // other attachment delete path: a storage outage must not resurrect a removed embed.
  if (removedAttachments.length > 0) {
    const storage = await getStorageForClient(updated.clientId);
    await Promise.all(removedAttachments.map((row) => storage.delete(row.fileKey).catch(() => undefined)));
  }

  return updated;
}
