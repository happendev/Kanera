import type { dto } from "@kanera/shared";
import {
  ACTIVITY_ACTION,
  ACTIVITY_ENTITY_TYPE,
  cardAssignees,
  cardPriorities,
  cardSummaryView,
  MAX_CARD_PRIORITIES_PER_USER,
  type CardPriority,
} from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Tx } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { recordActivity } from "../../lib/activity.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { rebalanceCardPriorities } from "../../lib/rebalance.js";
import {
  lockQueueForWrite,
  lockedQueue,
  liveQueueSize,
  positionForAnchors,
  visibleLiveEntryIds,
} from "./route-support.js";

/** Add a card to a user's priority queue (`POST /work/priorities/:userId/cards`). */
export async function addPriority({
  auth,
  targetUserId,
  workspaceId,
  body,
}: {
  auth: AuthClaims;
  targetUserId: string;
  /** The card's own workspace, from the write-access check. */
  workspaceId: string;
  body: dto.CreateCardPriorityBody;
}): Promise<void> {
  // The queue ranks assignments, so an unassigned card has nothing to rank (same guard the
  // Global Work personal lane applies before it will position a card for someone). And the queue
  // is *live* work: accepting a completed or archived card would create a dormant entry invisible
  // to the very client that asked for it — a 201 whose queue does not contain the card.
  const [candidate] = await db
    .select({ archivedAt: cardSummaryView.archivedAt, completedAt: cardSummaryView.completedAt })
    .from(cardSummaryView)
    .innerJoin(cardAssignees, and(
      eq(cardAssignees.cardId, cardSummaryView.id),
      eq(cardAssignees.userId, targetUserId),
    ))
    .where(eq(cardSummaryView.id, body.cardId))
    .limit(1);
  if (!candidate) throw badRequest("card is not assigned to that user");
  if (candidate.archivedAt || candidate.completedAt) {
    throw badRequest("card is completed or archived");
  }

  const accessibleBoards = await loadAccessibleBoards(auth);
  await db.transaction(async (tx) => {
    await lockQueueForWrite(targetUserId, tx);
    // The cap is checked against the *live* size, not these raw rows: a done or archived card is
    // not in the queue, so it must not hold a slot the client cannot see or clear.
    let entries = await lockedQueue(targetUserId, tx);
    // Raw rows, not the live set: a dormant duplicate would still trip the unique index, and a
    // defined 409 beats surfacing that constraint violation as an internal error.
    if (entries.some((entry) => entry.cardId === body.cardId)) {
      throw conflict("card is already in this queue");
    }
    if (await liveQueueSize(targetUserId, tx) >= MAX_CARD_PRIORITIES_PER_USER) {
      throw badRequest(`a priority queue holds at most ${MAX_CARD_PRIORITIES_PER_USER} cards`);
    }
    const visibleIds = await visibleLiveEntryIds(auth, targetUserId, accessibleBoards, tx);

    const interpolated = positionForAnchors(entries, visibleIds, body);
    let position = interpolated.position;
    // `between()` reports an exhausted gap; ~30 successive drops into the same slot get there, and
    // ignoring it silently corrupts the order (two equal positions, tiebroken by id).
    if (interpolated.needsRebalance) {
      await rebalanceCardPriorities(targetUserId, tx);
      entries = await lockedQueue(targetUserId, tx);
      position = positionForAnchors(entries, visibleIds, body).position;
    }

    const [created] = await tx
      .insert(cardPriorities)
      .values({ targetUserId, cardId: body.cardId, position, createdById: auth.sub })
      .returning();
    if (!created) throw notFound();
    await recordPriorityActivity(tx, {
      auth: auth,
      workspaceId: workspaceId,
      priorityId: created.id,
      cardId: body.cardId,
      targetUserId,
      action: ACTIVITY_ACTION.CREATED,
      payload: { position },
    });
  });
}

/**
 * Move one queue entry (`POST /card-priorities/:id/move`). Returns `true` when the move was an
 * idempotent no-op, so the route can skip the invalidation emit.
 */
export async function movePriority({
  auth,
  current,
  workspaceId,
  body,
}: {
  auth: AuthClaims;
  /** The entry as loaded before this transaction; re-read under the lock below. */
  current: CardPriority;
  /** The card's own workspace, from the write-access check. */
  workspaceId: string;
  body: dto.MoveCardPriorityBody;
}): Promise<boolean> {
  const id = current.id;
  const accessibleBoards = await loadAccessibleBoards(auth);
  const noOp = await db.transaction(async (tx) => {
    await lockQueueForWrite(current.targetUserId, tx);
    // Re-read under the lock: `current` predates this transaction, and a concurrent move may
    // have shifted or removed the row. The fresh position feeds both the no-op check and the
    // audited prevPosition, so neither can describe a queue that no longer exists.
    let locked = await lockedQueue(current.targetUserId, tx);
    let moved = locked.find((entry) => entry.id === id);
    if (!moved) throw notFound();
    let entries = locked.filter((entry) => entry.id !== id);
    const visibleIds = await visibleLiveEntryIds(auth, current.targetUserId, accessibleBoards, tx);

    const interpolated = positionForAnchors(entries, visibleIds, body);
    let position = interpolated.position;
    if (interpolated.needsRebalance) {
      await rebalanceCardPriorities(current.targetUserId, tx);
      locked = await lockedQueue(current.targetUserId, tx);
      moved = locked.find((entry) => entry.id === id);
      if (!moved) throw notFound();
      entries = locked.filter((entry) => entry.id !== id);
      position = positionForAnchors(entries, visibleIds, body).position;
    }
    // Drag jitter and client retries must not produce durable outbox rows or audit noise.
    if (position === moved.position) return true;

    await tx.update(cardPriorities).set({ position, updatedAt: new Date() }).where(eq(cardPriorities.id, id));
    await recordPriorityActivity(tx, {
      auth: auth,
      workspaceId: workspaceId,
      priorityId: id,
      cardId: current.cardId,
      targetUserId: current.targetUserId,
      action: ACTIVITY_ACTION.MOVED,
      payload: { prevPosition: moved.position, position },
    });
    return false;
  });
  return noOp;
}

/**
 * Remove one queue entry (`DELETE /card-priorities/:id`). Returns `true` when the row was already
 * gone, so the route can skip the invalidation emit.
 */
export async function removePriority({
  auth,
  current,
  workspaceId,
}: {
  auth: AuthClaims;
  /** The entry as loaded before this transaction; the delete itself is the authoritative read. */
  current: CardPriority;
  /** The card's own workspace, from the write-access check. */
  workspaceId: string;
}): Promise<boolean> {
  const id = current.id;
  const alreadyGone = await db.transaction(async (tx) => {
    await lockQueueForWrite(current.targetUserId, tx);
    // `current` predates this transaction; the delete itself is the authoritative read. A row a
    // concurrent request already removed is an idempotent success, not a second audit entry.
    const [deleted] = await tx
      .delete(cardPriorities)
      .where(eq(cardPriorities.id, id))
      .returning({ position: cardPriorities.position });
    if (!deleted) return true;
    await recordPriorityActivity(tx, {
      auth: auth,
      workspaceId: workspaceId,
      priorityId: id,
      cardId: current.cardId,
      targetUserId: current.targetUserId,
      action: ACTIVITY_ACTION.DELETED,
      payload: { position: deleted.position },
    });
    return false;
  });
  return alreadyGone;
}

/**
 * Audit a priority write without leaking it into any card or board feed.
 *
 * Two separate mechanisms are needed and both are one careless line from being wrong:
 * - `boardId: null` keeps the row out of `GET /boards/:id/activity`, which filters on
 *   `activity_event.board_id`. Using `entityType: "card"` with the card's real board would be worse
 *   still: the card feed queries `entity_type='card' AND entity_id=cardId` with no board filter, so
 *   it would publish one manager's private sequencing to every board member, cross-org guests
 *   included.
 * - The payload key is `priorityCardId`, never `cardId`. Global Work computes `lastActivityBefore` /
 *   `lastMovedBefore` by matching `payload->>'cardId'`, so naming it `cardId` would make a pure
 *   ordering gesture register as "this card was worked on" and silently drop a stale card out of a
 *   staleness report because someone dragged it.
 *
 * `workspaceId` is the card's own workspace, which is what scopes this for organisation-level audit.
 */
async function recordPriorityActivity(
  tx: Tx,
  options: {
    auth: AuthClaims;
    workspaceId: string;
    priorityId: string;
    cardId: string;
    targetUserId: string;
    action: typeof ACTIVITY_ACTION[keyof typeof ACTIVITY_ACTION];
    payload: Record<string, unknown>;
  },
) {
  await recordActivity(tx, {
    boardId: null,
    workspaceId: options.workspaceId,
    actorId: options.auth.sub,
    entityType: ACTIVITY_ENTITY_TYPE.CARD_PRIORITY,
    entityId: options.priorityId,
    action: options.action,
    payload: {
      ...options.payload,
      priorityCardId: options.cardId,
      targetUserId: options.targetUserId,
      scope: "globalWork",
    },
  });
}
