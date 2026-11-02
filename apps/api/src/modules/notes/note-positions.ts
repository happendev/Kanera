import { notes, type Note } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db, type TxOnly as Tx } from "../../db.js";
import { positionAtIndex } from "../../lib/position.js";
import { emitToBoard, emitToUser, emitToWorkspace } from "../../realtime/emit.js";

export type SiblingKey = Pick<Note, "workspaceId" | "boardId" | "scope" | "ownerId" | "parentNoteId">;
export type DbLike = typeof db | Tx;

export function siblingFilter(key: SiblingKey) {
  const ownerCondition = key.scope === "personal" ? eq(notes.ownerId, key.ownerId) : sql`true`;
  return and(
    eq(notes.workspaceId, key.workspaceId),
    key.boardId === null ? isNull(notes.boardId) : eq(notes.boardId, key.boardId),
    eq(notes.scope, key.scope),
    key.parentNoteId === null ? isNull(notes.parentNoteId) : eq(notes.parentNoteId, key.parentNoteId),
    ownerCondition,
  );
}

export async function neighbourPositions(
  base: SiblingKey,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
  tx: DbLike = db,
): Promise<{ prev: string | null; next: string | null }> {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(siblingFilter(base))
      .orderBy(asc(notes.position))
      .limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(siblingFilter(base))
      .orderBy(desc(notes.position))
      .limit(1);
    prev = last?.position ?? null;
  } else if (afterId) {
    const [after] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), eq(notes.id, afterId)))
      .limit(1);
    if (!after) return { prev: null, next: null };
    const [nextRow] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), gt(notes.position, after.position)))
      .orderBy(asc(notes.position))
      .limit(1);
    prev = after.position;
    next = nextRow?.position ?? null;
  } else if (beforeId) {
    const [before] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), eq(notes.id, beforeId)))
      .limit(1);
    if (!before) return { prev: null, next: null };
    const [prevRow] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), lt(notes.position, before.position)))
      .orderBy(desc(notes.position))
      .limit(1);
    next = before.position;
    prev = prevRow?.position ?? null;
  } else {
    const [last] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(siblingFilter(base))
      .orderBy(desc(notes.position))
      .limit(1);
    prev = last?.position ?? null;
  }
  return { prev, next };
}

export async function rebalanceSiblings(base: SiblingKey, tx: DbLike = db): Promise<{ id: string; position: string }[]> {
  const rows = await tx
    .select({ id: notes.id, position: notes.position })
    .from(notes)
    .where(siblingFilter(base))
    .orderBy(asc(notes.position));
  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);
  await Promise.all(
    updates.map((row) =>
      // Rebalancing is an ordering implementation detail, not a document edit. Keeping edit
      // attribution untouched prevents neighbouring notes from appearing newly edited.
      tx.update(notes).set({ position: row.position }).where(eq(notes.id, row.id)),
    ),
  );
  return updates.map(({ id, position }) => ({ id, position }));
}

export function emitRebalanceEvent(
  base: SiblingKey,
  positions: { id: string; position: string }[],
) {
  const payload = {
    scope: base.scope,
    workspaceId: base.workspaceId,
    boardId: base.boardId,
    parentNoteId: base.parentNoteId,
    ownerId: base.ownerId,
    positions,
  };
  if (base.scope === "personal") {
    emitToUser(base.ownerId, "note:rebalanced", payload);
  } else if (base.boardId) {
    return emitToBoard(base.boardId, "note:rebalanced", payload);
  } else {
    return emitToWorkspace(base.workspaceId, "note:rebalanced", payload);
  }
  return Promise.resolve(null);
}
