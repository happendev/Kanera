import { cardPriorities, cards } from "@kanera/shared/schema";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
// How long a completed card keeps its "Up next" rank. Within the window, un-completing restores
// the card at its original position — the undo for a mis-click. Past it the entry is deleted, so a
// card genuinely finished and reopened weeks later re-enters like any other card instead of
// resurrecting a stale rank nobody remembers assigning.
const COMPLETED_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CompletedPriorityCleanupDeps {
  db: Db;
  log: FastifyBaseLogger;
}

/**
 * Purge "Up next" entries whose card has been completed for longer than the grace period.
 *
 * No realtime ping: a completed card is already invisible to every queue view (the live-queue
 * filter in card-priorities/routes.ts), so deleting its hidden row changes nothing any client is
 * rendering. Archived cards are deliberately not swept here — their rows die with the card when
 * the 30-day archived-card purge cascades, and until then un-archiving restores the rank, matching
 * how archival is undone everywhere else.
 */
export async function runCompletedPriorityCleanup(
  { db, log }: CompletedPriorityCleanupDeps,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - COMPLETED_GRACE_MS);
  // One atomic statement, with the completion re-checked inside the delete itself: a two-step
  // select-then-delete would race an un-complete happening in between and destroy the very row the
  // grace period exists to preserve.
  const deleted = await db
    .delete(cardPriorities)
    .where(inArray(
      cardPriorities.cardId,
      db
        .select({ id: cards.id })
        .from(cards)
        .where(and(isNotNull(cards.completedAt), lt(cards.completedAt, cutoff))),
    ))
    .returning({ id: cardPriorities.id });

  if (deleted.length > 0) {
    log.info({ deletedCount: deleted.length }, "purged Up next entries for long-completed cards");
  }
  return deleted.length;
}

export function startCompletedPriorityCleanupScheduler(deps: CompletedPriorityCleanupDeps): () => Promise<void> {
  return startSweepScheduler({
    name: "completed-priority-cleanup",
    task: () => runCompletedPriorityCleanup(deps),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: deps.log,
  }).stop;
}
