import { internalLinks, notes, type Note } from "@kanera/shared/schema";
import { and, eq, or } from "drizzle-orm";
import { db } from "../../db.js";
import { collectNoteTreeFiles, deleteNoteFiles } from "../../lib/attachment-cleanup.js";
import type { LinkFanout } from "../../lib/internal-links.js";

/** Deletes a note with its child pages and attachment files, and unlinks it from cards and notes. */
export async function deleteNote({ note }: { note: Note }): Promise<{ linkFanout: LinkFanout }> {
  const id = note.id;
  // Child pages and attachment rows cascade with the note, so read the file keys first.
  const files = await collectNoteTreeFiles(id);
  const linkFanout = await db.transaction(async (tx): Promise<LinkFanout> => {
    const removed = await tx.delete(internalLinks).where(or(
      and(eq(internalLinks.sourceType, "note"), eq(internalLinks.sourceId, id)),
      and(eq(internalLinks.targetType, "note"), eq(internalLinks.targetId, id)),
    )).returning({ sourceType: internalLinks.sourceType, sourceId: internalLinks.sourceId, targetType: internalLinks.targetType, targetId: internalLinks.targetId });
    await tx.delete(notes).where(eq(notes.id, id));
    // The far end of each removed link (a card or note linking this one, or one it linked) no
    // longer lists it, and chips pointing at it no longer resolve.
    const ends = removed.map((link) => link.sourceType === "note" && link.sourceId === id
      ? { type: link.targetType, id: link.targetId }
      : { type: link.sourceType, id: link.sourceId });
    return {
      cardIds: ends.filter((end) => end.type === "card").map((end) => end.id),
      noteIds: ends.filter((end) => end.type === "note").map((end) => end.id),
    };
  });
  await deleteNoteFiles(files);
  return { linkFanout };
}
