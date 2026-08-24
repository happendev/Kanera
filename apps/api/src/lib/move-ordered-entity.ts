import { eq } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, type Db } from "../db.js";
import { recordActivity, type ActivityInput } from "./activity.js";
import { between } from "./position.js";
import type { RebalancedPosition } from "./rebalance.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface MoveOrderedEntityResult {
  /** The committed position, already reconciled against a rebalance if one ran. */
  position: string;
  /** Non-null only when a rebalance ran; emit `*:rebalanced` with it before `*:moved`. */
  rebalancedPositions: RebalancedPosition[] | null;
}

/**
 * The shared write half of every "reorder one row in a positioned list" route.
 *
 * Reordering a label, custom field, field option, checklist template, board, board group, or
 * automation is the same five steps each time — resolve a position between the neighbours, write
 * it, renumber the siblings if the gap collapsed, reconcile the row's own position against that
 * renumbering, and record the audit row. Copying those steps per entity is what let two of them
 * drift: checklist templates recorded no activity at all, and field options recorded theirs
 * against the pre-rebalance position.
 *
 * All of it runs in one transaction so the recorded position always describes the committed
 * order. Reconciling `position` against `rebalancedPositions` before the activity write is
 * load-bearing for the same reason — a rebalance renumbers the row we just moved, so the value
 * captured before it is already stale.
 *
 * Emitting stays with the caller: the event names, payload keys, and audiences differ per entity
 * (workspace, workspace admins, board audience). Callers must emit `*:rebalanced` before
 * `*:moved` so clients replay normalised positions before applying the move.
 */
export async function moveOrderedEntity(options: {
  table: PgTable;
  idColumn: AnyPgColumn;
  id: string;
  /** Resolved neighbours, from `neighbourPositions`. */
  neighbours: { prev: string | null; next: string | null };
  /** Renumber the siblings sharing this row's scope. Must accept the enclosing transaction. */
  rebalance: (tx: Tx) => Promise<RebalancedPosition[]>;
  /** Built from the final position, so the audit row cannot record a pre-rebalance value. */
  activity: (position: string) => ActivityInput;
}): Promise<MoveOrderedEntityResult> {
  const { table, idColumn, id, neighbours, rebalance, activity } = options;
  const result = between(neighbours.prev, neighbours.next);

  return db.transaction(async (tx) => {
    let position = result.position;
    await tx.update(table).set({ position, updatedAt: new Date() }).where(eq(idColumn, id));

    const rebalancedPositions = result.needsRebalance ? await rebalance(tx) : null;
    position = rebalancedPositions?.find((row) => row.id === id)?.position ?? position;

    await recordActivity(tx, activity(position));
    return { position, rebalancedPositions };
  });
}
