import { boardMirrorDirtyCards, boardMirrors, eventOutbox, type BoardMirror, type BoardMirrorFacet } from "@kanera/shared/schema";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { boardSyncEligibleWorkspaceIds } from "../tier-limits.js";
import { applyDirtyCards } from "./apply.js";
import { reconcileMirror } from "./converge.js";
import { dispatchMirrorEvent } from "./dispatch.js";

const TAIL_BATCH_SIZE = 100;
const GAP_SAFETY_MARGIN_MS = 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "board mirror drain failed";
}

function mirrorRetryAt(failures: number): Date {
  return new Date(Date.now() + Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, failures - 1))));
}

async function assertStructuralLoopPrevention(mirror: BoardMirror) {
  const [invalid] = await db.select({ id: boardMirrors.id }).from(boardMirrors).where(and(
    eq(boardMirrors.sourceBoardId, mirror.targetBoardId),
    isNull(boardMirrors.pausedAt),
    isNull(boardMirrors.sourceDisabledAt),
  )).limit(1);
  if (invalid) throw new Error("board mirror loop invariant violated: target board is an enabled source");
}

async function enqueueDirtySignals(mirror: BoardMirror) {
  return db.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(eventOutbox)
      .where(and(
        eq(eventOutbox.boardId, mirror.sourceBoardId),
        or(
          gt(eventOutbox.createdAt, mirror.cursorEventCreatedAt),
          and(eq(eventOutbox.createdAt, mirror.cursorEventCreatedAt), gt(eventOutbox.id, mirror.cursorEventId)),
        ),
      ))
      .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id))
      .limit(TAIL_BATCH_SIZE);

    const facetsByCard = new Map<string, Set<BoardMirrorFacet>>();
    for (const event of events) {
      const signal = dispatchMirrorEvent(event);
      if (!signal) continue;
      const facets = facetsByCard.get(signal.sourceCardId) ?? new Set<BoardMirrorFacet>();
      for (const facet of signal.facets) facets.add(facet);
      facetsByCard.set(signal.sourceCardId, facets);
    }
    for (const [sourceCardId, facets] of facetsByCard) {
      await tx.insert(boardMirrorDirtyCards).values({ mirrorId: mirror.id, sourceCardId, facets: [...facets] }).onConflictDoUpdate({
        target: [boardMirrorDirtyCards.mirrorId, boardMirrorDirtyCards.sourceCardId],
        set: {
          // A card can receive several facet signals before apply; array-union makes tail retries
          // idempotent without losing an earlier dirty facet.
          facets: sql`array(select distinct unnest(${boardMirrorDirtyCards.facets} || excluded.facets))`,
          attempts: 0,
          nextRetryAt: null,
          lastError: null,
          updatedAt: new Date(),
        },
      });
    }
    const last = events.at(-1);
    await tx.update(boardMirrors).set({
      ...(last && { cursorEventCreatedAt: last.createdAt, cursorEventId: last.id }),
      lastSyncAt: new Date(),
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(boardMirrors.id, mirror.id));
    return { read: events.length, drainedFull: events.length === TAIL_BATCH_SIZE };
  });
}

async function drainMirror(mirror: BoardMirror) {
  await assertStructuralLoopPrevention(mirror);
  const purgeFloorWithMargin = new Date(Date.now() - env.REALTIME_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000 - GAP_SAFETY_MARGIN_MS);
  const gapStart = mirror.lastSyncAt ?? mirror.createdAt;
  if (mirror.reconcileRequestedAt || gapStart < purgeFloorWithMargin) {
    await reconcileMirror(mirror, gapStart);
    await db.update(boardMirrors).set({ reconcileRequestedAt: null, lastSyncAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(boardMirrors.id, mirror.id));
  }
  return enqueueDirtySignals(mirror);
}

export interface ProcessBoardMirrorsResult {
  mirrors: number;
  tailedEvents: number;
  appliedCards: number;
  drainedFull: boolean;
}

export async function processBoardMirrors(options: { log?: FastifyBaseLogger } = {}): Promise<ProcessBoardMirrorsResult> {
  const manuallyActive = await db.select().from(boardMirrors).where(and(
    isNull(boardMirrors.pausedAt),
    isNull(boardMirrors.sourceDisabledAt),
    or(isNull(boardMirrors.nextRetryAt), lte(boardMirrors.nextRetryAt, new Date())),
  ));
  const eligibleWorkspaceIds = await boardSyncEligibleWorkspaceIds(manuallyActive.flatMap((mirror) => [mirror.sourceWorkspaceId, mirror.targetWorkspaceId]));
  // Membership is deliberately absent from this decision: the relationship belongs to the boards,
  // but both owning organisations must still have Pro. Leaving the cursor untouched lets an upgrade
  // catch up on retained outbox events without conflating a plan block with either manual switch.
  const active = manuallyActive.filter((mirror) => eligibleWorkspaceIds.has(mirror.sourceWorkspaceId) && eligibleWorkspaceIds.has(mirror.targetWorkspaceId));
  let tailedEvents = 0;
  let drainedFull = false;
  const activeById = new Map(active.map((mirror) => [mirror.id, mirror]));
  for (const mirror of active) {
    try {
      const result = await drainMirror(mirror);
      tailedEvents += result.read;
      drainedFull ||= result.drainedFull;
    } catch (error) {
      const failures = mirror.consecutiveFailures + 1;
      options.log?.error({ err: error, mirrorId: mirror.id }, "board mirror drain failed");
      await db.update(boardMirrors).set({ consecutiveFailures: failures, nextRetryAt: mirrorRetryAt(failures), lastError: errorMessage(error), updatedAt: new Date() }).where(eq(boardMirrors.id, mirror.id));
    }
  }
  const dirtyResult = await applyDirtyCards(activeById, options.log);
  return {
    mirrors: active.length,
    tailedEvents,
    appliedCards: dirtyResult.processed,
    drainedFull: drainedFull || dirtyResult.drainedFull,
  };
}
