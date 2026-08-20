import { cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { emitToBoard } from "../realtime/emit.js";
import { signEmbeddedMediaUrls } from "./media-keys.js";

/**
 * Child-resource changes are still card activity. Keep the card's canonical timestamp in sync and
 * fan out the refreshed card so inactivity indicators clear without waiting for a board reload.
 */
export async function touchCardActivity(cardId: string, clientId: string) {
  const [card] = await db
    .update(cards)
    .set({ updatedAt: new Date() })
    .where(eq(cards.id, cardId))
    .returning();
  if (!card) return null;

  await emitToBoard(card.boardId, "card:updated", {
    boardId: card.boardId,
    card: {
      ...card,
      description: signEmbeddedMediaUrls(card.description, clientId),
    },
  });
  return card;
}
