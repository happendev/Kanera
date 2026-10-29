import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { cards } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Publication carries the owning card's committed revision, never a deployment-wide counter.
 * Read after the mutation commits: a detail read at/above this revision includes that write.
 * This is conservative when another write commits before publication; it is not an ordering token
 * for individual event payloads. Non-card board events need no database lookup or revision.
 */
export async function cardDetailRevisionForEvent<E extends keyof ServerToClientEvents>(
  boardId: string, event: E, payload: Parameters<ServerToClientEvents[E]>[0],
): Promise<{ detailRevision?: string; detailRevisions?: Record<string, string> }> {
  let cardIds: string[] = [];
  if (event === SERVER_EVENTS.CARD_REBALANCED && "positions" in payload) {
    cardIds = payload.positions.map(({ id }) => id);
  } else if ("cardId" in payload && typeof payload.cardId === "string") {
    cardIds = [payload.cardId];
  } else if ("card" in payload && payload.card && "id" in payload.card) {
    cardIds = [payload.card.id];
  } else if ("attachment" in payload && payload.attachment && "cardId" in payload.attachment) {
    cardIds = [payload.attachment.cardId];
  }
  if (!cardIds.length) return {};
  const rows = await db.select({ id: cards.id, revision: cards.detailRevision }).from(cards)
    .where(and(eq(cards.boardId, boardId), inArray(cards.id, cardIds)));
  if (event === SERVER_EVENTS.CARD_REBALANCED) {
    // A board rebalance spans independent counters; comparing one card's revision with another's
    // would drop valid updates when a quieter card has a smaller number.
    return { detailRevisions: Object.fromEntries(rows.map(({ id, revision }) => [id, String(revision)])) };
  }
  return rows[0] ? { detailRevision: String(rows[0].revision) } : {};
}
