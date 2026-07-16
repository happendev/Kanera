import { boardMirrorDirtyCards, boardMirrors, type BoardMirror } from "@kanera/shared/schema";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db.js";
import { convergeSourceCard } from "./converge.js";

const DIRTY_BATCH_SIZE = 50;

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
  const readyRows = await db
    .select({ dirty: boardMirrorDirtyCards })
    .from(boardMirrorDirtyCards)
    .innerJoin(boardMirrors, and(
      eq(boardMirrors.id, boardMirrorDirtyCards.mirrorId),
      isNull(boardMirrors.pausedAt),
      isNull(boardMirrors.sourceDisabledAt),
      or(isNull(boardMirrors.nextRetryAt), lte(boardMirrors.nextRetryAt, new Date())),
    ))
    .where(or(isNull(boardMirrorDirtyCards.nextRetryAt), lte(boardMirrorDirtyCards.nextRetryAt, new Date())))
    .orderBy(asc(boardMirrorDirtyCards.updatedAt))
    .limit(DIRTY_BATCH_SIZE);
  const rows = readyRows.map((row) => row.dirty);
  let processed = 0;
  // The worker-server currently has one owner. If it ever scales horizontally, claim these rows
  // with FOR UPDATE SKIP LOCKED before allowing more than one process to apply them.
  for (const row of rows) {
    const mirror = mirrors.get(row.mirrorId)
      ?? (await db.select().from(boardMirrors).where(and(
        eq(boardMirrors.id, row.mirrorId),
        isNull(boardMirrors.pausedAt),
        isNull(boardMirrors.sourceDisabledAt),
        or(isNull(boardMirrors.nextRetryAt), lte(boardMirrors.nextRetryAt, new Date())),
      )).limit(1))[0];
    if (!mirror) continue;
    try {
      await convergeSourceCard(mirror, row.sourceCardId, row.facets);
      await db.delete(boardMirrorDirtyCards).where(and(eq(boardMirrorDirtyCards.mirrorId, row.mirrorId), eq(boardMirrorDirtyCards.sourceCardId, row.sourceCardId)));
      processed += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = errorMessage(error);
      log?.warn({ err: error, mirrorId: row.mirrorId, sourceCardId: row.sourceCardId, attempts }, "board mirror card convergence failed");
      await db.update(boardMirrorDirtyCards).set({ attempts, nextRetryAt: dirtyRetryAt(attempts), lastError: message, updatedAt: new Date() }).where(and(eq(boardMirrorDirtyCards.mirrorId, row.mirrorId), eq(boardMirrorDirtyCards.sourceCardId, row.sourceCardId)));
    }
  }
  // A full selected batch means ready work may remain even when one row failed and was rescheduled.
  // Let the scheduler immediately drain again instead of adding one poll interval of latency.
  return { processed, drainedFull: rows.length === DIRTY_BATCH_SIZE };
}
