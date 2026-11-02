import type { dto } from "@kanera/shared";
import { inProgressClockOf, SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardAssignees, cards, lists } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { emitAutomationEffects, runCardMoveAutomations } from "../../lib/automations.js";
import { emitLaneRebalanced, emitWorkspaceLaneRebalanced, positionForLaneInsert, rebalanceBoardLane } from "../../lib/board-lane.js";
import { emitRelationNeighboursChanged, lockWorkspaceRelations } from "../../lib/card-relations.js";
import { badRequest } from "../../lib/errors.js";
import { IN_PROGRESS_CLOCK_COLUMNS } from "../../lib/in-progress-clock.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertGlobalWorkSeparatorContext, positionForGlobalWorkLaneInsert } from "../global-work-separators/routes.js";
import { emitCardActivityFeedItem } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Target checks for `POST /cards/:id/move`, run after the card itself has been loaded for editing:
 * the target list must belong to the card's workspace, and a Global Work anchor must be valid for
 * the organiser and the card.
 */
export async function assertCardMoveTarget({
  auth,
  cardId: id,
  ctx,
  body,
}: {
  auth: AuthClaims;
  cardId: string;
  ctx: CardAccessContext;
  body: dto.MoveCardBody;
}): Promise<void> {
  const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
  if (!targetList || targetList.workspaceId !== ctx.workspaceId) {
    throw badRequest("target list not in same workspace");
  }

  if (body.globalWorkUserId) {
    // A personal Global Work separator is outside the source board lane. Validate both the
    // organiser's workspace context and that this card actually belongs in their merged lane.
    await assertGlobalWorkSeparatorContext({
      auth,
      workspaceId: ctx.workspaceId,
      targetUserId: body.globalWorkUserId,
      listId: body.listId,
    });
    const [assignment] = await db
      .select({ cardId: cardAssignees.cardId })
      .from(cardAssignees)
      .where(and(eq(cardAssignees.cardId, id), eq(cardAssignees.userId, body.globalWorkUserId)))
      .limit(1);
    if (!assignment) throw badRequest("card is not assigned to the Global Work user");
  }
}

/**
 * Moves a card within its board (to another list or another position in the same list), recording
 * activity and running list-entry automations in the same transaction. `noOp` is true when the move
 * changed nothing; the caller then emits nothing and returns `response` as is.
 */
export async function moveCard({
  auth,
  card: current,
  ctx,
  body,
}: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  body: dto.MoveCardBody;
}) {
  const id = current.id;
  const fromListId = current.listId;
  const prevPosition = current.position;
  const enteringNewList = fromListId !== body.listId;
  const { position, finalPosition, finalListId, clock, finalClock, rebalancedPositions, laneRebalanced, activity, completedCard, completionActivity, automationEffects, noOp } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await tx.select({ id: lists.id }).from(lists).where(eq(lists.id, body.listId)).for("update").limit(1);

    // The mover needs access to the card's own board. Anchor cards are only
    // numeric position hints; same listId keeps them in this workspace, so we
    // intentionally do not require access to every anchor's board.
    const afterItem = body.afterItem !== undefined
      ? body.afterItem
      : body.afterCardId !== undefined
        ? body.afterCardId === null ? null : { type: "card" as const, id: body.afterCardId }
        : undefined;
    const beforeItem = body.beforeItem !== undefined
      ? body.beforeItem
      : body.beforeCardId !== undefined
        ? body.beforeCardId === null ? null : { type: "card" as const, id: body.beforeCardId }
        : undefined;
    const globalWorkPlacement = body.globalWorkUserId
      ? await positionForGlobalWorkLaneInsert({
          auth,
          workspaceId: ctx.workspaceId,
          targetUserId: body.globalWorkUserId,
          listId: body.listId,
          moving: { type: "card", id },
          afterItem,
          beforeItem,
          tx,
        })
      : null;
    const laneRebalanced = globalWorkPlacement?.rebalanced ?? null;
    const result = globalWorkPlacement
      ? { position: globalWorkPlacement.position, needsRebalance: false }
      : await positionForLaneInsert({
          listId: body.listId,
          boardId: current.boardId,
          moving: { type: "card", id },
          afterItem,
          beforeItem,
          tx,
        });
    let position = result.position;

    // Treat an unchanged location as idempotent so retries and stale clients do not create
    // writes or durable realtime noise for a move that never happened.
    // A rebalance has already rewritten the stored position, so an equal number is not a no-op.
    if (!laneRebalanced && !enteringNewList && position === prevPosition) {
      return {
        position,
        finalPosition: prevPosition,
        finalListId: fromListId,
        clock: inProgressClockOf(current),
        finalClock: inProgressClockOf(current),
        rebalancedPositions: null,
        laneRebalanced: null,
        activity: null,
        completedCard: null,
        completionActivity: null,
        automationEffects: { effects: [] },
        noOp: true,
      };
    }

    // The trigger owns the time-in-progress clock; read back what it wrote for this move's event.
    const [written] = await tx
      .update(cards)
      .set({
        listId: body.listId,
        position,
        updatedAt: new Date(),
      })
      .where(eq(cards.id, id))
      .returning(IN_PROGRESS_CLOCK_COLUMNS);

    const rebalancedPositions = result.needsRebalance ? await rebalanceBoardLane(body.listId, current.boardId, tx) : null;
    if (rebalancedPositions) {
      position = rebalancedPositions.cardPositions.find((p) => p.id === id)?.position ?? position;
    }

    // Same-list moves are reorders. Keep them realtime-only so card activity
    // does not fill with redundant "Backlog -> Backlog" entries.
    const activity = enteringNewList
      ? await recordActivity(tx, {
        boardId: current.boardId,
        workspaceId: ctx.workspaceId,
        actorId: auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.MOVED,
        payload: { fromListId, toListId: body.listId, prevPosition, position },
      })
      : null;
    const automationEffects = enteringNewList
      ? await runCardMoveAutomations(tx, {
        cardId: id,
        fromListId,
        toListId: body.listId,
        boardId: current.boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        triggerActorId: auth.sub,
      })
      : { effects: [] };
    const [finalCard] = await tx.select({ listId: cards.listId, position: cards.position, ...IN_PROGRESS_CLOCK_COLUMNS }).from(cards).where(eq(cards.id, id)).limit(1);
    const clock = inProgressClockOf(written ?? current);
    return {
      position,
      finalPosition: finalCard?.position ?? position,
      finalListId: finalCard?.listId ?? body.listId,
      clock,
      // After automations, which may have moved the card again; that move emits its own event.
      finalClock: finalCard ? inProgressClockOf(finalCard) : clock,
      rebalancedPositions,
      laneRebalanced,
      activity,
      completedCard: null,
      completionActivity: null,
      automationEffects,
      noOp: false,
    };
  });

  return {
    noOp,
    cardId: id,
    boardId: current.boardId,
    workspaceId: ctx.workspaceId,
    fromListId,
    toListId: body.listId,
    prevPosition,
    position,
    clock,
    rebalancedPositions,
    laneRebalanced,
    activity,
    completedCard,
    completionActivity,
    automationEffects,
    response: { id, listId: finalListId, position: finalPosition, ...finalClock },
  };
}

type MoveCardResult = Awaited<ReturnType<typeof moveCard>>;

/** Post-commit fanout for a non-idempotent `moveCard`, in the order clients and outbox consumers rely on. */
export async function emitCardMoved({ auth, result }: { auth: AuthClaims; result: MoveCardResult }): Promise<void> {
  const {
    cardId: id,
    boardId,
    workspaceId,
    fromListId,
    toListId,
    prevPosition,
    position,
    clock,
    rebalancedPositions,
    laneRebalanced,
    activity,
    completedCard,
    completionActivity,
    automationEffects,
  } = result;
  if (laneRebalanced) await emitWorkspaceLaneRebalanced(toListId, laneRebalanced);

  if (rebalancedPositions) {
    // Rebalance must be persisted before card:moved so clients replay the normalized positions
    // before applying the move, and webhook/outbox consumers observe the same ordering.
    await emitLaneRebalanced(boardId, toListId, rebalancedPositions);
  }
  await emitToBoard(boardId, SERVER_EVENTS.CARD_MOVED, {
    boardId,
    cardId: id,
    fromListId,
    toListId,
    position,
    prevPosition,
    ...clock,
  });
  // Related cards show this card's list in their Dependencies section.
  if (fromListId !== toListId) await emitRelationNeighboursChanged([id]);
  if (activity) await emitCardActivityFeedItem(boardId, id, activity);
  if (completedCard && completionActivity) {
    const wireCard = toWireCard(completedCard, auth.cid);
    await emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: wireCard });
    await emitCardActivityFeedItem(boardId, id, completionActivity, { notify: true });
  }
  await emitAutomationEffects(automationEffects);
  if (activity) await evaluateWorkspaceAnalyticsMilestones({
    workspaceId,
    actorId: auth.sub,
    supportSession: auth.authKind === "support" || auth.authKind === "apiKey",
  });
}
