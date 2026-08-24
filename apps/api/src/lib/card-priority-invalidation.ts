import { cardPriorities } from "@kanera/shared/schema";
import { inArray } from "drizzle-orm";
import { db } from "../db.js";
import { emitCardPriorityInvalidated } from "../realtime/emit.js";

/**
 * Ping every audience watching a queue that holds one of these cards.
 *
 * Completing, archiving, or re-assigning a card removes it from (or restores it to) the live
 * "Up next" queue — and undoing that restores it — but those writes never touch `card_priorities`
 * rows, so the queue's own mutation routes cannot see them. Call this after any commit that flips a
 * card's completedAt/archivedAt or changes its assignees so open panels and rank pills refetch
 * immediately instead of waiting for a reconnect or refocus. A cheap indexed no-op for cards nobody
 * has queued.
 */
export async function invalidateQueuesForCards(cardIds: string[]): Promise<void> {
  const ids = [...new Set(cardIds.filter(Boolean))];
  if (ids.length === 0) return;
  const targets = await db
    .selectDistinct({ targetUserId: cardPriorities.targetUserId })
    .from(cardPriorities)
    .where(inArray(cardPriorities.cardId, ids));
  // One audience's ping does not depend on another's, and each one costs a membership query plus two
  // queries per workspace plus a queue snapshot. Serialising them made a 100-card bulk completion
  // pay that chain once per distinct queue owner. Ordering across audiences carries no meaning here
  // (these are content-free "refetch" pings to separate users), so nothing observable is reordered.
  await Promise.all(targets.map(({ targetUserId }) => emitCardPriorityInvalidated(targetUserId)));
}
