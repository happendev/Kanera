import type { dto } from "@kanera/shared";
import type { WireNote } from "@kanera/shared/events";
import { notes, type Note } from "@kanera/shared/schema";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { EMPTY_LINK_FANOUT, emitInternalLinksChanged, linkNeighbours, mergeLinkFanout, replaceInternalLinksForSource, type LinkFanout } from "../../lib/internal-links.js";
import { stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { buildNoteLock, isLockedByOther, isLockHeldBy } from "./note-locks.js";
import { emitNoteEvent, loadOrFail, shapeNote } from "./route-support.js";

function sameInstant(a: Date | string, b: Date | string): boolean {
  const base = new Date(a).getTime();
  const value = new Date(b).getTime();
  return value >= base && value < base + 1;
}

function sameWireTimestamp(column: typeof notes.updatedAt, value: string) {
  const base = new Date(value);
  return sql`${column} >= ${base} and ${column} < ${new Date(base.getTime() + 1)}`;
}

export interface UpdateNoteResult {
  /** The note as loaded before the edit, for the rename check in `emitUpdateNote`. */
  note: Note;
  updated: Note;
  responseNote: WireNote;
  body: dto.UpdateNoteBody;
  shouldReleaseLock: boolean;
  linkFanout: LinkFanout;
}

/**
 * Applies a partial edit guarded by the caller's `baseUpdatedAt` and the team-note edit lock, and
 * rewrites the note's outgoing internal links when its content changed.
 */
export async function updateNote({
  auth,
  note,
  body,
}: {
  auth: AuthClaims;
  note: Note;
  body: dto.UpdateNoteBody;
}): Promise<UpdateNoteResult> {
  const id = note.id;
  const now = new Date();
  if (note.scope === "team" && isLockedByOther(note, auth.sub)) {
    throw new AppError(409, "NOTE_LOCKED", "note is being edited by another user", {
      lock: await buildNoteLock(note),
    });
  }

  if (body.baseUpdatedAt && !sameInstant(body.baseUpdatedAt, note.updatedAt)) {
    throw new AppError(409, "NOTE_STALE", "note has changed since editing started", {
      note: await shapeNote(note, auth.cid),
    });
  }

  const content =
    body.content !== undefined ? stripSignedEmbeddedMediaUrls(body.content, auth.cid) ?? "" : undefined;
  const shouldReleaseLock = note.scope === "team"
    && isLockHeldBy(note, auth.sub)
    && (body.title !== undefined || content !== undefined);
  const writeGuards = [
    eq(notes.id, id),
    ...(body.baseUpdatedAt ? [sameWireTimestamp(notes.updatedAt, body.baseUpdatedAt)] : []),
    ...(note.scope === "team"
      ? [
        or(
          isNull(notes.editingUserId),
          eq(notes.editingUserId, auth.sub),
          lt(notes.editingExpiresAt, now),
        ),
      ]
      : []),
  ];

  let linkFanout: LinkFanout = EMPTY_LINK_FANOUT;
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(notes)
      .set({
        ...(body.title !== undefined && { title: body.title }),
        ...(content !== undefined && { content }),
        ...(body.icon !== undefined && { icon: body.icon }),
        // color is metadata like icon — it is intentionally absent from shouldReleaseLock,
        // so tinting a team note never releases another user's edit lock.
        ...(body.color !== undefined && { color: body.color }),
        ...(shouldReleaseLock && { editingUserId: null, editingExpiresAt: null }),
        lastEditedById: auth.sub,
        lastEditedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(...writeGuards))
      .returning();

    if (rows[0] && content !== undefined) {
      linkFanout = await replaceInternalLinksForSource({
        tx,
        claims: auth,
        workspaceId: note.workspaceId,
        sourceType: "note",
        sourceId: id,
        markdown: content,
      });
    }
    return rows;
  });

  if (!updated) {
    const latest = await loadOrFail(id);
    if (latest.scope === "team" && isLockedByOther(latest, auth.sub)) {
      throw new AppError(409, "NOTE_LOCKED", "note is being edited by another user", {
        lock: await buildNoteLock(latest),
      });
    }
    throw new AppError(409, "NOTE_STALE", "note has changed since editing started", {
      note: await shapeNote(latest, auth.cid),
    });
  }

  const responseNote = await shapeNote(updated, auth.cid);
  return { note, updated, responseNote, body, shouldReleaseLock, linkFanout };
}

export async function emitUpdateNote({ note, updated, responseNote, body, shouldReleaseLock, linkFanout }: UpdateNoteResult): Promise<void> {
  const id = note.id;
  emitNoteEvent(updated, "note:updated", { note: responseNote });
  if (shouldReleaseLock) emitNoteEvent(updated, "note:unlocked", { noteId: id });
  // Cards and notes this note started or stopped linking list it in their linked items/backlinks.
  // Title, icon and color are shown there and in link chips, so a rename reaches every neighbour.
  const renamed = (body.title !== undefined && body.title !== note.title)
    || (body.icon !== undefined && body.icon !== note.icon)
    || (body.color !== undefined && body.color !== note.color);
  await emitInternalLinksChanged(renamed
    ? mergeLinkFanout(linkFanout, await linkNeighbours(note.workspaceId, "note", id))
    : linkFanout);
}
