import type { dto } from "@kanera/shared";
import { notes, type Note } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { conflict } from "../../lib/errors.js";
import { between } from "../../lib/position.js";
import { emitRebalanceEvent, neighbourPositions, rebalanceSiblings, type SiblingKey } from "./note-positions.js";
import { emitNoteEvent, MAX_NOTE_TREE_DEPTH, noteDepth, resolveParent } from "./route-support.js";

async function descendantDepth(noteId: string): Promise<number> {
  const children = await db
    .select({ id: notes.id })
    .from(notes)
    .where(eq(notes.parentNoteId, noteId));
  if (children.length === 0) return 1;
  const childDepths = await Promise.all(children.map((child) => descendantDepth(child.id)));
  return 1 + Math.max(...childDepths);
}

export interface MoveNoteResult {
  note: Note;
  base: SiblingKey;
  newParentId: string | null;
  position: string;
  prevPosition: string;
  rebalancedPositions: { id: string; position: string }[] | null;
}

/** Reparents and/or reorders a note among its siblings, rebalancing the group when positions run out. */
export async function moveNote({ note, body }: { note: Note; body: dto.MoveNoteBody }): Promise<MoveNoteResult> {
  const id = note.id;
  let targetParent: Note | null = null;
  if (body.parentNoteId) {
    if (body.parentNoteId === id) throw conflict("cannot reparent into self");
    targetParent = await resolveParent(note.workspaceId, note.boardId, body.parentNoteId, note.scope, note.ownerId);
    // Walk ancestors to ensure we are not nesting into a descendant.
    let cursorId: string | null = body.parentNoteId;
    const visited = new Set<string>();
    while (cursorId) {
      if (visited.has(cursorId)) break;
      visited.add(cursorId);
      if (cursorId === id) throw conflict("cannot reparent into descendant");
      const [next] = await db
        .select({ parentNoteId: notes.parentNoteId })
        .from(notes)
        .where(eq(notes.id, cursorId))
        .limit(1);
      cursorId = next?.parentNoteId ?? null;
    }
  }
  const targetParentDepth = await noteDepth(targetParent);
  const subtreeDepth = await descendantDepth(id);
  if (targetParentDepth + subtreeDepth > MAX_NOTE_TREE_DEPTH) {
    throw conflict("notes can only be nested 3 levels deep");
  }

  const newParentId = body.parentNoteId;
  const base: SiblingKey = {
    workspaceId: note.workspaceId,
    boardId: note.boardId,
    scope: note.scope,
    ownerId: note.ownerId,
    parentNoteId: newParentId,
  };

  const prevPosition = note.position;
  const { position, rebalancedPositions } = await db.transaction(async (tx) => {
    // `null` is meaningful here: afterNoteId null = move to the top, beforeNoteId null = move to
    // the end. Coalescing them to undefined made every explicit edge anchor an append.
    const { prev, next } = await neighbourPositions(base, body.afterNoteId, body.beforeNoteId, tx);
    const result = between(prev, next);
    let position = result.position;

    await tx.update(notes).set({ parentNoteId: newParentId, position, updatedAt: new Date() }).where(eq(notes.id, id));

    const rebalancedPositions = result.needsRebalance ? await rebalanceSiblings(base, tx) : null;
    if (rebalancedPositions) position = rebalancedPositions.find((p) => p.id === id)?.position ?? position;
    return { position, rebalancedPositions };
  });

  return { note, base, newParentId, position, prevPosition, rebalancedPositions };
}

export async function emitMoveNote({ note, base, newParentId, position, prevPosition, rebalancedPositions }: MoveNoteResult): Promise<void> {
  if (rebalancedPositions) await emitRebalanceEvent(base, rebalancedPositions);

  emitNoteEvent(note, "note:moved", { noteId: note.id, parentNoteId: newParentId, position, prevPosition });
}
