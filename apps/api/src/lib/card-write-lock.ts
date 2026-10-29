import { cards } from "@kanera/shared/schema";
import { asc, inArray } from "drizzle-orm";
import type { TxOnly } from "../db.js";

/**
 * Lock every card a transaction is about to write, in id order, before its first child-row write.
 *
 * The detail-child triggers update the owning card row, so a transaction that writes comments,
 * activity or checklist rows for several cards takes those row locks one statement at a time, in
 * request order; two batches crossing the same cards in opposite orders deadlock (sorting inside
 * one trigger invocation orders nothing across statements). Taking the whole set up front in one
 * order removes that: the triggers then only touch rows this transaction already holds.
 *
 * Paths that take the workspace graph lock keep taking it first; call this after it, never before.
 * Single-card writers must use the same card-before-child order as batches. A plain database
 * handle is deliberately excluded: its lock would expire before the following write.
 */
export async function lockCardsForWrite(tx: TxOnly, cardIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(cardIds)].sort();
  if (!ids.length) return;
  // ORDER BY is applied before the locking clause, so the rows are locked in id order.
  await tx.select({ id: cards.id }).from(cards).where(inArray(cards.id, ids)).orderBy(asc(cards.id)).for("update");
}
