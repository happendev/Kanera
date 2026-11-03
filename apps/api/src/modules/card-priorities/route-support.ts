import { cardAssignees, cardPriorities, cards } from "@kanera/shared/schema";
import { and, asc, countDistinct, eq, isNull, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import type { Tx } from "../../db.js";
import type { AccessibleBoard } from "../../lib/accessible-boards.js";
import { cardAccessCondition, cardDueColumns } from "../../lib/card-due-sql.js";
import { badRequest } from "../../lib/errors.js";
import { between } from "../../lib/position.js";

export type QueueEntry = { id: string; cardId: string; position: string };

export function isWorkspaceCredential(auth: AuthClaims): boolean {
  return auth.apiKeyKind === "workspace";
}

export function canWritePriorityQueues(auth: AuthClaims): boolean {
  return auth.apiKeyScope !== "read";
}

/**
 * Serialise all writes to one user's queue.
 *
 * Row locks alone cannot do this: `lockedQueue`'s FOR UPDATE locks nothing when the queue is empty,
 * so two concurrent first adds would both interpolate against an empty list and race the unique
 * index. A transaction-scoped advisory lock keyed on the target closes that gap; taking it first in
 * *every* write transaction also gives them one uniform lock order, so a create and a move on the
 * same queue can never deadlock on each other's row locks.
 */
export async function lockQueueForWrite(targetUserId: string, tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`card_priority:${targetUserId}`}, 0))`);
}

/**
 * The whole queue, locked and in canonical order — unfiltered by lifecycle or visibility.
 *
 * Anchor interpolation runs against this after anchor eligibility is checked against the live set.
 * Filtering it to the actor's visible subset is exactly where `positionForGlobalWorkLaneInsert`
 * would mislead: a manager who sees
 * 1, 2, 5 and drops "after 2" must not silently reorder the invisible 3 and 4.
 */
export async function lockedQueue(targetUserId: string, tx: Tx): Promise<QueueEntry[]> {
  return tx
    .select({ id: cardPriorities.id, cardId: cardPriorities.cardId, position: cardPriorities.position })
    .from(cardPriorities)
    .where(eq(cardPriorities.targetUserId, targetUserId))
    .for("update")
    .orderBy(asc(cardPriorities.position), asc(cardPriorities.cardId));
}

/** Narrow-table form for rank/count/visibility reads that do not need card hydration. */
export function liveBaseQueueEntryCondition(targetUserId: string) {
  return and(
    eq(cardPriorities.targetUserId, targetUserId),
    eq(cardAssignees.userId, targetUserId),
    isNull(cards.archivedAt),
    isNull(cards.completedAt),
  );
}

/** How many live entries the queue holds. The entry cap counts these, not raw rows. */
export async function liveQueueSize(targetUserId: string, tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ count: countDistinct(cardPriorities.id) })
    .from(cardPriorities)
    .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardPriorities.cardId))
    .where(liveBaseQueueEntryCondition(targetUserId));
  return row?.count ?? 0;
}

/** Live priority-entry ids whose card this actor may see. Dormant rows are never valid anchors. */
export async function visibleLiveEntryIds(
  auth: AuthClaims,
  targetUserId: string,
  accessibleBoards: AccessibleBoard[],
  tx: Tx,
): Promise<Set<string>> {
  if (accessibleBoards.length === 0) return new Set();
  const rows = await tx
    .select({ id: cardPriorities.id })
    .from(cardPriorities)
    .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardPriorities.cardId))
    .where(and(
      liveBaseQueueEntryCondition(targetUserId),
      cardAccessCondition(auth.sub, accessibleBoards, cardDueColumns),
    ));
  return new Set(rows.map((row) => row.id));
}

/**
 * Interpolate a position from the anchors the client supplied.
 *
 * The anchor must resolve to an entry the actor can see — never fall back silently, because the
 * client only ever renders anchors the server gave it. `prev`/`next` then come from the *full*
 * ordered list including invisible neighbours, so the card lands exactly where intended and hidden
 * entries keep their relative order.
 *
 * Leak analysis: because `next` may be an invisible entry's position, the returned position reveals
 * a numeric *interval* — "something exists between #2 and #5". The actor already learns that from
 * `hiddenCount` and the placeholder rows, and no card identity, title, board or workspace leaks. The
 * alternative silently reorders cards in workspaces the actor has no rights over, which is worse.
 */
export function positionForAnchors(
  entries: QueueEntry[],
  visibleIds: Set<string>,
  anchors: { afterId?: string | null; beforeId?: string | null },
): { position: string; needsRebalance: boolean } {
  const findAnchor = (id: string) => {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1 || !visibleIds.has(id)) throw badRequest("priority anchor is not visible");
    return index;
  };

  let prev: string | null = null;
  let next: string | null = null;
  if (anchors.afterId === null && anchors.beforeId === undefined) {
    next = entries[0]?.position ?? null;
  } else if (anchors.beforeId === null && anchors.afterId === undefined) {
    prev = entries.at(-1)?.position ?? null;
  } else if (anchors.afterId) {
    const index = findAnchor(anchors.afterId);
    prev = entries[index]!.position;
    next = entries[index + 1]?.position ?? null;
  } else if (anchors.beforeId) {
    const index = findAnchor(anchors.beforeId);
    next = entries[index]!.position;
    prev = entries[index - 1]?.position ?? null;
  }

  return between(prev, next);
}
