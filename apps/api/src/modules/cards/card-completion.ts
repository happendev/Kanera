import { cards, lists } from "@kanera/shared/schema";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assignedCardVisibility, type assertBoardAccess, type assertCardAccess } from "../../lib/access.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { applyCardCompletion, lockCompletionBatch, type CardCompletionWrite } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Completes or reopens every active card in one list on one board that is not already in the
 * requested state. Returns no writes, without opening a transaction, when nothing needs changing.
 */
export async function setListCardsCompletion({ auth, ctx, boardId, listId, completed }: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  listId: string;
  completed: boolean;
}): Promise<CardCompletionWrite[]> {
  const [list] = await db.select().from(lists).where(eq(lists.id, listId)).limit(1);
  if (!list) throw notFound();
  if (list.workspaceId !== ctx.workspaceId) throw badRequest("target list not in board workspace");

  const targetCards = await db
    .select()
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(
      eq(cards.listId, listId),
      eq(cards.boardId, boardId),
      eq(lists.workspaceId, ctx.workspaceId),
      ctx.assignedItemsOnly ? assignedCardVisibility(auth.sub) : undefined,
      isNull(cards.archivedAt),
      completed ? isNull(cards.completedAt) : isNotNull(cards.completedAt),
    ));

  if (targetCards.length === 0) return [];

  const completedAt = completed ? new Date() : null;
  return db.transaction(async (tx) => {
    // Lock the batch and its dependents before the first per-card write (see lockCardsForWrite).
    await lockCompletionBatch(tx, ctx.workspaceId, targetCards.map((row) => row.card.id), completed);
    const rows: CardCompletionWrite[] = [];
    for (const row of targetCards) {
      rows.push(await applyCardCompletion(tx, {
        card: row.card,
        completed,
        completedAt,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        actorId: auth.sub,
      }));
    }
    return rows;
  });
}

/** Completes or reopens one card; the caller has already returned early when it is in that state. */
export async function setCardCompletion({ auth, card, ctx, completed }: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  completed: boolean;
}): Promise<CardCompletionWrite> {
  const completedAt = completed ? new Date() : null;
  return db.transaction((tx) => applyCardCompletion(tx, {
    card,
    completed,
    completedAt,
    workspaceId: ctx.workspaceId,
    clientId: ctx.clientId,
    actorId: auth.sub,
  }));
}
