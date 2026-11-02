import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { scratchpadNotes, type ScratchpadNote } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { between } from "../../lib/position.js";
import { rebalanceScratchpadNotes } from "../../lib/rebalance.js";
// `emitToUserDurable`, not the fire-and-forget `emitToUser`: awaiting the durable write means the
// response is only sent once the event is recorded, so a process that dies immediately after
// responding still leaves the user's other sessions a row to converge from. It also makes the
// rebalance-before-move ordering below a real ordering rather than two racing background writes.
// Failures are caught and logged inside the helper, so awaiting cannot fail the request.
import { emitToUserDurable } from "../../realtime/emit.js";
import { neighbourPositions } from "./scratchpad-positions.js";

/** Reorders a page within the owner's flat tab list, rebalancing positions when they run out of room. */
export async function moveScratchpadNote({
  auth,
  note,
  body,
}: {
  auth: AuthClaims;
  note: ScratchpadNote;
  body: dto.MoveScratchpadNoteBody;
}) {
  const id = note.id;
  const prevPosition = note.position;
  const { position, rebalancedPositions } = await db.transaction(async (tx) => {
    const { prev, next } = await neighbourPositions(
      auth.sub,
      auth.cid,
      body.afterNoteId ?? undefined,
      body.beforeNoteId ?? undefined,
      tx,
    );
    const result = between(prev, next);
    let position = result.position;
    await tx
      .update(scratchpadNotes)
      .set({ position })
      .where(eq(scratchpadNotes.id, id));

    // Reordering tabs is not a document edit, so `updatedAt` is intentionally left alone above: a
    // drag must not make every neighbouring page look freshly written, and must not advance the
    // echo watermark of a page whose text nobody touched.
    const rebalancedPositions = result.needsRebalance
      ? await rebalanceScratchpadNotes(auth.sub, auth.cid, tx)
      : null;
    if (rebalancedPositions) position = rebalancedPositions.find((row) => row.id === id)?.position ?? position;
    return { position, rebalancedPositions };
  });

  return { id, prevPosition, position, rebalancedPositions, response: { id, position } };
}

type MoveScratchpadNoteResult = Awaited<ReturnType<typeof moveScratchpadNote>>;

/** Post-commit fanout for `moveScratchpadNote`, in the order the owner's other sessions rely on. */
export async function emitScratchpadNoteMoved({ auth, result }: { auth: AuthClaims; result: MoveScratchpadNoteResult }): Promise<void> {
  const { id, prevPosition, position, rebalancedPositions } = result;
  // Rebalance before moved, per the repo-wide ordering rule: a client that applied `moved` first
  // would place the page against positions the rebalance is about to renumber, landing it in the
  // wrong slot until the next full fetch.
  if (rebalancedPositions) {
    await emitToUserDurable(auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_REBALANCED, {
      clientId: auth.cid,
      positions: rebalancedPositions,
    });
  }
  await emitToUserDurable(auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_MOVED, {
    clientId: auth.cid,
    noteId: id,
    position,
    prevPosition,
  });
}
