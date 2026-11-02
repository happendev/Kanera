import type { dto } from "@kanera/shared";
import type { WireNote } from "@kanera/shared/events";
import type { Note } from "@kanera/shared/schema";
import type { AuthClaims } from "../../auth/plugin.js";
import { conflict } from "../../lib/errors.js";
import { insertNote, MAX_NOTE_TREE_DEPTH, noteDepth, resolveParent, shapeNote } from "./route-support.js";

/** Creates a note at the end of its sibling group, in a workspace (`boardId` null) or on a board. */
export async function createNote({
  auth,
  workspaceId,
  boardId,
  body,
}: {
  auth: AuthClaims;
  workspaceId: string;
  boardId: string | null;
  body: dto.CreateNoteBody;
}): Promise<{ note: Note; responseNote: WireNote }> {
  const parent = await resolveParent(workspaceId, boardId, body.parentNoteId ?? null, body.scope, auth.sub);
  if (await noteDepth(parent) >= MAX_NOTE_TREE_DEPTH) throw conflict("notes can only be nested 3 levels deep");
  const note = await insertNote({
    workspaceId,
    boardId,
    parentNoteId: parent?.id ?? null,
    scope: body.scope,
    ownerId: auth.sub,
    lastEditedById: auth.sub,
    title: body.title ?? "",
    icon: body.icon ?? null,
    // New child notes inherit the parent's color when one isn't given, so a colored
    // section keeps a consistent tint. Later recolors of the parent are not propagated.
    color: body.color ?? parent?.color ?? null,
  });
  const responseNote = await shapeNote(note, auth.cid);
  return { note, responseNote };
}
