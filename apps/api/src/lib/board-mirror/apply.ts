import { boardMirrorDirtyCards, boardMirrors, type BoardMirror } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db.js";
import { BoardMirrorPermanentError, convergeSourceCard } from "./converge.js";

const DIRTY_BATCH_SIZE = 50;
// ~20 hours of capped exponential backoff. Past this (or at once for a permanent error) the row
// parks: it keeps its lastError for operators and leaves the ready query. A new source signal for
// the card (enqueueDirtySignals resets attempts) or a mirror reconcile re-queues it.
export const MAX_DIRTY_ATTEMPTS = 12;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "board mirror card sync failed";
}

function dirtyRetryAt(attempts: number): Date {
  return new Date(Date.now() + Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempts - 1))));
}

export async function applyDirtyCards(
  mirrors: Map<string, BoardMirror>,
  log?: FastifyBaseLogger,
): Promise<{ processed: number; drainedFull: boolean }> {
  if (mirrors.size === 0) return { processed: 0, drainedFull: false };
  const readyRows = await db
    .select({ dirty: boardMirrorDirtyCards })
    .from(boardMirrorDirtyCards)
    .innerJoin(boardMirrors, and(
      eq(boardMirrors.id, boardMirrorDirtyCards.mirrorId),
      isNull(boardMirrors.pausedAt),
      isNull(boardMirrors.sourceDisabledAt),
      or(isNull(boardMirrors.nextRetryAt), lte(boardMirrors.nextRetryAt, new Date())),
    ))
    .where(and(
      inArray(boardMirrorDirtyCards.mirrorId, [...mirrors.keys()]),
      lt(boardMirrorDirtyCards.attempts, MAX_DIRTY_ATTEMPTS),
      or(isNull(boardMirrorDirtyCards.nextRetryAt), lte(boardMirrorDirtyCards.nextRetryAt, new Date())),
    ))
    .orderBy(asc(boardMirrorDirtyCards.updatedAt))
    .limit(DIRTY_BATCH_SIZE);
  const rows = readyRows.map((row) => row.dirty);
  let processed = 0;
  // The worker-server currently has one owner. If it ever scales horizontally, claim these rows
  // with FOR UPDATE SKIP LOCKED before allowing more than one process to apply them.
  for (const row of rows) {
    const mirror = mirrors.get(row.mirrorId);
    if (!mirror) continue;
    try {
      await convergeSourceCard(mirror, row.sourceCardId, row.facets);
      await db.delete(boardMirrorDirtyCards).where(and(eq(boardMirrorDirtyCards.mirrorId, row.mirrorId), eq(boardMirrorDirtyCards.sourceCardId, row.sourceCardId)));
      processed += 1;
    } catch (error) {
      const attempts = error instanceof BoardMirrorPermanentError ? MAX_DIRTY_ATTEMPTS : row.attempts + 1;
      const parked = attempts >= MAX_DIRTY_ATTEMPTS;
      const message = errorMessage(error);
      const context = { err: error, mirrorId: row.mirrorId, sourceCardId: row.sourceCardId, attempts };
      if (parked) log?.error(context, "board mirror card convergence parked");
      else log?.warn(context, "board mirror card convergence failed");
      await db.update(boardMirrorDirtyCards).set({ attempts, nextRetryAt: parked ? null : dirtyRetryAt(attempts), lastError: message, updatedAt: new Date() }).where(and(eq(boardMirrorDirtyCards.mirrorId, row.mirrorId), eq(boardMirrorDirtyCards.sourceCardId, row.sourceCardId)));
    }
  }
  // A full selected batch means ready work may remain even when one row failed and was rescheduled.
  // Let the scheduler immediately drain again instead of adding one poll interval of latency.
  return { processed, drainedFull: rows.length === DIRTY_BATCH_SIZE };
}
