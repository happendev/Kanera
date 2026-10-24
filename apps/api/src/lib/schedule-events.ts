import type { ScheduleTransition } from "@kanera/shared/dto";
import { compactWireCard, SERVER_EVENTS } from "@kanera/shared/events";
import { dayNumber, workingDaysBetween } from "@kanera/shared/schedule";
import { boards, boardScheduleState, cards, cardScheduleState, eventOutbox, scheduleRecheckQueue, workspaces, type Card } from "@kanera/shared/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx, TxOnly } from "../db.js";
import { loadBoardScheduleScope, scheduleOf, summarizeSchedule } from "./schedule-graph.js";
import { toWireCard } from "./wire-card.js";
import { loadWorkspaceFeatures } from "./workspace-features.js";

/**
 * Schedule events: the bridge between writes that can move a bar and the `schedule.*` MCP events
 * plus the `scheduling_conflict_appears` / `critical_path_slips` automation triggers.
 *
 * Writes never evaluate the schedule themselves (a bulk due-date change would otherwise run the
 * engine once per card, and a chain of edits would announce every intermediate state). They only
 * upsert the affected boards into `schedule_recheck_queue`, inside their own transaction so a
 * rolled-back write requests nothing. The worker drains the queue (see `runScheduleRecheckSweep` in
 * automations.ts): it recomputes each board, diffs the verdict against the latch tables and reports
 * only the boundaries, so one event per card is the most a burst of edits can produce.
 */

/** Queues a recheck of these boards. Safe to call with duplicates and inside any transaction. */
export async function requestScheduleRecheckForBoards(tx: Tx, boardIds: readonly string[]): Promise<void> {
  const unique = [...new Set(boardIds)];
  if (unique.length === 0) return;
  await tx.insert(scheduleRecheckQueue)
    .values(unique.map((boardId) => ({ boardId, requestedAt: new Date() })))
    .onConflictDoUpdate({ target: scheduleRecheckQueue.boardId, set: { requestedAt: new Date() } });
}

/** Recheck the whole connected component: dates affect transitive earliest starts and slack.
 * Call before deleting relations/cards. Start from closed cards too so completing a blocker still
 * invalidates its former chain; UNION deduplicates cycles without a depth or card-count cutoff.
 */
export async function requestScheduleRecheckForCards(tx: Tx, cardIds: readonly string[]): Promise<void> {
  const unique = [...new Set(cardIds)];
  if (!unique.length) return;
  const rows = await tx.execute<{ boardId: string }>(sql`
    with recursive affected(id) as (
      select id from card where id in (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)})
      union
      select neighbour.id from affected a
      join card_relation r on r.kind = 'blocks' and (r.source_card_id = a.id or r.target_card_id = a.id)
      join card neighbour on neighbour.id = case when r.source_card_id = a.id then r.target_card_id else r.source_card_id end
      where neighbour.completed_at is null and neighbour.archived_at is null
    )
    select distinct c.board_id as "boardId" from affected a join card c on c.id = a.id
  `);
  await requestScheduleRecheckForBoards(tx, rows.rows.map((row) => row.boardId));
}

async function clearScheduleLatches(tx: Tx, boardIds: readonly string[]): Promise<void> {
  if (!boardIds.length) return;
  await tx.delete(cardScheduleState).where(inArray(cardScheduleState.cardId,
    tx.select({ id: cards.id }).from(cards).where(inArray(cards.boardId, [...boardIds]))));
  await tx.delete(boardScheduleState).where(inArray(boardScheduleState.boardId, [...boardIds]));
}

/**
 * Switching dependencies or the timeline changes every verdict at once (edges vanish or return,
 * schedules stop or start), which is a settings change, not news: no card's plan moved. Drop the
 * affected boards' latches and queue them, so the next sweep seeds silently, exactly as it does for
 * a board evaluated for the first time, and only later edits produce schedule events.
 */
export async function resetScheduleLatches(tx: Tx, scope: { clientId: string } | { workspaceId: string }): Promise<void> {
  const rows = await tx.select({ id: boards.id }).from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where("clientId" in scope ? eq(workspaces.clientId, scope.clientId) : eq(workspaces.id, scope.workspaceId));
  const boardIds = rows.map((row) => row.id);
  await clearScheduleLatches(tx, boardIds);
  await requestScheduleRecheckForBoards(tx, boardIds);
}

export interface ScheduleRecheckRequest {
  boardId: string;
  workspaceId: string;
  clientId: string;
  requestedAt: Date;
}

/** Oldest requests first. Boards deleted since cascade out of the queue, so every row resolves. */
export async function pendingScheduleRechecks(tx: Tx, limit: number): Promise<ScheduleRecheckRequest[]> {
  return tx.select({ boardId: scheduleRecheckQueue.boardId, workspaceId: boards.workspaceId, clientId: workspaces.clientId, requestedAt: scheduleRecheckQueue.requestedAt })
    .from(scheduleRecheckQueue)
    .innerJoin(boards, eq(boards.id, scheduleRecheckQueue.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .orderBy(asc(scheduleRecheckQueue.requestedAt), asc(scheduleRecheckQueue.boardId))
    .limit(limit);
}

/**
 * Answers one request. A write that arrived while the board was being evaluated bumped
 * `requestedAt`, so the row stays queued and the next sweep sees the newer state too.
 */
export async function finishScheduleRecheck(tx: Tx, request: ScheduleRecheckRequest): Promise<void> {
  await tx.delete(scheduleRecheckQueue).where(and(eq(scheduleRecheckQueue.boardId, request.boardId), eq(scheduleRecheckQueue.requestedAt, request.requestedAt)));
}

export interface ScheduleBoundary {
  card: Card;
  transition: ScheduleTransition;
  /** The worst conflict's blocker, for the automation comment placeholders; conflict_detected only. */
  blocker?: Pick<Card, "id" | "key" | "title" | "boardId">;
}

export interface BoardScheduleEvaluation {
  boundaries: ScheduleBoundary[];
  /** Persists the new verdict as the latch. Call after the boundaries have been acted on, in the same transaction. */
  commit: () => Promise<void>;
}

/**
 * Recomputes one board's schedule and diffs it against the latch.
 *
 * Only the board's own open cards are compared and latched: the neighbouring cards a chain pulls
 * in belong to their own boards, which were queued alongside this one (requestScheduleRecheckForCards)
 * and report their own boundaries. A board with no `board_schedule_state` row has never been
 * evaluated: it is seeded without boundaries, so the first sweep after a deploy stays silent rather
 * than announcing every pre-existing conflict. Cards that left the open set drop their rows.
 */
export async function evaluateBoardSchedule(tx: TxOnly, boardId: string): Promise<BoardScheduleEvaluation> {
  // A board whose workspace has the timeline switched off has no schedule to report. Its latch is
  // dropped rather than diffed, so switching the timeline back on re-seeds silently instead of
  // announcing every conflict that already existed (see resetScheduleLatches).
  const [owner] = await tx.select({ workspaceId: boards.workspaceId }).from(boards).where(eq(boards.id, boardId)).limit(1);
  if (owner && !(await loadWorkspaceFeatures(owner.workspaceId, tx)).timeline) {
    await clearScheduleLatches(tx, [boardId]);
    return { boundaries: [], commit: async () => {} };
  }
  const scope = await loadBoardScheduleScope(tx, boardId);
  const schedule = scheduleOf(scope);
  const ownIds = [...scope.inScope];
  const summary = summarizeSchedule(schedule, ownIds);
  const [previousBoard] = await tx.select().from(boardScheduleState).where(eq(boardScheduleState.boardId, boardId)).limit(1);
  // Every latched card of the board, open or not, so rows of cards that completed, archived or
  // left the board since the last evaluation can be dropped below.
  const previousCards = new Map((await tx.select({ state: cardScheduleState }).from(cardScheduleState)
    .innerJoin(cards, eq(cards.id, cardScheduleState.cardId))
    .where(eq(cards.boardId, boardId))).map(({ state }) => [state.cardId, state]));
  const ownCards = ownIds.length ? await tx.select().from(cards).where(inArray(cards.id, ownIds)) : [];
  const cardById = new Map(ownCards.map((card) => [card.id, card]));

  const boundaries: ScheduleBoundary[] = [];
  if (previousBoard) {
    const boardSlipped = summary.projectedFinish !== null && (previousBoard.projectedFinish === null || summary.projectedFinish > previousBoard.projectedFinish);
    for (const id of ownIds) {
      const verdict = schedule.cards.get(id);
      const card = cardById.get(id);
      if (!verdict || !card) continue;
      const previous = previousCards.get(id);
      const hadConflict = (previous?.conflictBlockerIds.length ?? 0) > 0;
      if (!hadConflict && verdict.conflicts.length > 0) {
        // The worst conflict names the blocker: the one the card would have to move furthest for.
        const worst = verdict.conflicts.reduce((best, conflict) => (conflict.days > best.days ? conflict : best));
        const blocker = await blockerSummary(tx, worst.blockerId);
        boundaries.push({ card, transition: { name: "schedule.conflict_detected", blockerCardId: worst.blockerId, days: worst.days }, blocker });
      } else if (hadConflict && verdict.conflicts.length === 0) {
        boundaries.push({ card, transition: { name: "schedule.conflict_resolved" } });
      }
      // A slip is a critical card whose own bar moved later and dragged the board's finish with it.
      // Both conditions are needed: a card can move later inside its slack without changing the
      // finish, and the finish can move because a new card appeared, which is not a slip of this one.
      if (boardSlipped && verdict.critical && previous?.plannedEnd && verdict.plannedEnd && verdict.plannedEnd > previous.plannedEnd && previousBoard.projectedFinish) {
        boundaries.push({
          card,
          transition: {
            name: "schedule.critical_path_slipped",
            previousProjectedFinish: previousBoard.projectedFinish,
            projectedFinish: summary.projectedFinish!,
            days: workingDaysBetween(dayNumber(previousBoard.projectedFinish) + 1, dayNumber(summary.projectedFinish!)),
            slipDays: summary.slipDays,
          },
        });
      }
    }
  }

  const commit = async () => {
    const now = new Date();
    const stale = [...previousCards.keys()].filter((id) => !scope.inScope.has(id));
    if (stale.length) await tx.delete(cardScheduleState).where(inArray(cardScheduleState.cardId, stale));
    const rows = ownIds.flatMap((id) => {
      const verdict = schedule.cards.get(id);
      if (!verdict) return [];
      return [{ cardId: id, conflictBlockerIds: verdict.conflicts.map((conflict) => conflict.blockerId), critical: verdict.critical, plannedEnd: verdict.plannedEnd, updatedAt: now }];
    });
    if (rows.length) {
      await tx.insert(cardScheduleState).values(rows).onConflictDoUpdate({
        target: cardScheduleState.cardId,
        set: { conflictBlockerIds: sql`excluded.conflict_blocker_ids`, critical: sql`excluded.critical`, plannedEnd: sql`excluded.planned_end`, updatedAt: now },
      });
    }
    await tx.insert(boardScheduleState).values({ boardId, projectedFinish: summary.projectedFinish, latestDue: summary.latestDue, updatedAt: now }).onConflictDoUpdate({
      target: boardScheduleState.boardId,
      set: { projectedFinish: summary.projectedFinish, latestDue: summary.latestDue, updatedAt: now },
    });
  };
  return { boundaries, commit };
}

async function blockerSummary(tx: TxOnly, cardId: string): Promise<Pick<Card, "id" | "key" | "title" | "boardId"> | undefined> {
  const [row] = await tx.select({ id: cards.id, key: cards.key, title: cards.title, boardId: cards.boardId }).from(cards).where(eq(cards.id, cardId)).limit(1);
  return row;
}

/**
 * Persists a boundary for integrations the way `recordDependencyTransition` does: a `card:updated`
 * outbox row stamped with the transition, already marked dispatched to browsers (they learnt about
 * the underlying write from its own emits), so the outbox drain turns it into webhook and MCP
 * deliveries only. The actor is the system: no credential made this change, the engine found it.
 */
export async function recordScheduleBoundary(tx: TxOnly, boundary: ScheduleBoundary, workspaceId: string, clientId: string): Promise<void> {
  await tx.insert(eventOutbox).values({
    scope: "board", scopeId: boundary.card.boardId, boardId: boundary.card.boardId, workspaceId,
    eventType: SERVER_EVENTS.CARD_UPDATED,
    payload: { boardId: boundary.card.boardId, card: compactWireCard(toWireCard(boundary.card, clientId)), scheduleTransition: boundary.transition },
    actor: { kind: "system", userId: null, apiKeyId: null, agentGrantId: null },
    realtimeDispatched: true,
  });
}

