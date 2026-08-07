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
  for (const { targetUserId } of targets) {
    await emitCardPriorityInvalidated(targetUserId);
  }
}
