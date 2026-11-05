import { inProgressClockOf, SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cards, lists } from "@kanera/shared/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Tx } from "../../db.js";
import type { assertBoardAccess } from "../../lib/access.js";
import { recordCoalescedActivity, type CoalescedActivityResult } from "../../lib/activity.js";
import { emitAutomationEffects, runCardMoveAutomations } from "../../lib/automations.js";
import { emitRelationNeighboursChanged, lockWorkspaceRelations } from "../../lib/card-relations.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { between } from "../../lib/position.js";
import { emitToBoard } from "../../realtime/emit.js";
import { emitCoalescedCardActivityFeedItem } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type Card = typeof cards.$inferSelect;

type BulkCardMove = {
  previous: Card;
  card: Card;
  finalCard: Card;
  activity: CoalescedActivityResult;
  automationEffects: Awaited<ReturnType<typeof runCardMoveAutomations>>;
};

async function bottomPositionsForCards(
  listId: string,
  count: number,
  tx: Tx = db,
): Promise<string[]> {
  if (count <= 0) return [];
  const [last] = await tx
    .select({ position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, listId), isNull(cards.archivedAt)))
    .orderBy(desc(cards.position))
    .limit(1);
  const positions: string[] = [];
  let prev = last?.position ?? null;
  for (let i = 0; i < count; i += 1) {
    const { position } = between(prev, null);
    positions.push(position);
    prev = position;
  }
  return positions;
}

/**
 * Appends the given cards, all leaving other lists, to the bottom of `listId` in the order given,
 * running list-entry automations per card.
 */
export async function moveBulkCards({
  auth,
  ctx,
  boardId,
  cards: movingCards,
  listId,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  cards: Card[];
  listId: string;
}): Promise<BulkCardMove[]> {
  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, movingCards.map((card) => card.id));
    await tx.select({ id: lists.id }).from(lists).where(eq(lists.id, listId)).for("update").limit(1);
    const positions = await bottomPositionsForCards(listId, movingCards.length, tx);
    const rows: BulkCardMove[] = [];
    for (const [index, current] of movingCards.entries()) {
      const position = positions[index]!;
      const [card] = await tx
        .update(cards)
        .set({ listId, position, updatedAt: new Date() })
        .where(eq(cards.id, current.id))
        .returning();
      const activity = await recordCoalescedActivity(tx, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: auth.sub,
        entityType: "card",
        entityId: current.id,
        action: ACTIVITY_ACTION.MOVED,
        // Share single-move undo detection so reversing a bulk move (or vice versa)
        // removes its feed entry and notifications while forward moves stay separate.
        coalesceKey: "card:list",
        coalesceRevertsOnly: true,
        windowMs: 60_000,
        preservePayloadKeys: ["fromListId", "prevPosition"],
        fromValue: current.listId,
        toValue: listId,
        payload: { fromListId: current.listId, toListId: listId, prevPosition: current.position, position },
      });
      const automationEffects = await runCardMoveAutomations(tx, {
        cardId: current.id,
        fromListId: current.listId,
        toListId: listId,
        boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        triggerActorId: auth.sub,
      });
      // Keep the initial move for ordered realtime replay, but return the committed result to
      // callers: a list-entry automation may move or complete the card again in this transaction.
      const [finalCard] = automationEffects.effects.length > 0
        ? await tx.select().from(cards).where(eq(cards.id, current.id)).limit(1)
        : [card];
      rows.push({ previous: current, card: card!, finalCard: finalCard!, activity, automationEffects });
    }
    return rows;
  });
}

/** Post-commit fanout for `moveBulkCards`: per card, the move, its feed item, then its automations. */
export async function emitBulkCardMoves(moves: readonly BulkCardMove[], opts: { boardId: string; listId: string }): Promise<void> {
  const { boardId } = opts;
  for (const move of moves) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_MOVED, {
      boardId,
      cardId: move.card.id,
      fromListId: move.previous.listId,
      toListId: opts.listId,
      position: move.card.position,
      prevPosition: move.previous.position,
      ...inProgressClockOf(move.card),
    });
    await emitCoalescedCardActivityFeedItem(boardId, move.card.id, move.activity);
    await emitAutomationEffects(move.automationEffects);
  }
  await emitRelationNeighboursChanged(moves.map((move) => move.card.id));
}
