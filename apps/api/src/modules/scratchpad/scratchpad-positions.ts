import { scratchpadNotes } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { db, type TxOnly as Tx } from "../../db.js";
import { badRequest } from "../../lib/errors.js";

type DbLike = typeof db | Tx;

/** Neighbour positions for a move, over the owner's flat page list. */
export async function neighbourPositions(
  userId: string,
  clientId: string,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
  tx: DbLike = db,
): Promise<{ prev: string | null; next: string | null }> {
  const owned = and(eq(scratchpadNotes.userId, userId), eq(scratchpadNotes.clientId, clientId));
  if (afterId === null && beforeId === undefined) {
    const [first] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(owned)
      .orderBy(asc(scratchpadNotes.position))
      .limit(1);
    return { prev: null, next: first?.position ?? null };
  }
  if (afterId) {
    const [after] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, eq(scratchpadNotes.id, afterId)))
      .limit(1);
    if (!after) throw badRequest("anchor page not found");
    const [next] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, gt(scratchpadNotes.position, after.position)))
      .orderBy(asc(scratchpadNotes.position))
      .limit(1);
    return { prev: after.position, next: next?.position ?? null };
  }
  if (beforeId) {
    const [before] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, eq(scratchpadNotes.id, beforeId)))
      .limit(1);
    if (!before) throw badRequest("anchor page not found");
    const [prev] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, lt(scratchpadNotes.position, before.position)))
      .orderBy(desc(scratchpadNotes.position))
      .limit(1);
    return { prev: prev?.position ?? null, next: before.position };
  }
  // `beforeNoteId: null`, or no anchor at all — append.
  const [last] = await tx
    .select({ position: scratchpadNotes.position })
    .from(scratchpadNotes)
    .where(owned)
    .orderBy(desc(scratchpadNotes.position))
    .limit(1);
  return { prev: last?.position ?? null, next: null };
}
