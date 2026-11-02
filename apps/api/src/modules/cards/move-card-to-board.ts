import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, agentRuns, cardAssignees, cardAttachments, cardChecklistItems, cardChecklists, cardLabelAssignments, cards, lists, users } from "@kanera/shared/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { recordActivity, recordCoalescedActivity } from "../../lib/activity.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { attachmentRowBaseColumns } from "../../lib/attachment-rows.js";
import { EMPTY_EFFECTS, emitAutomationEffects, runCardMoveAutomations } from "../../lib/automations.js";
import { ensureBoardMembershipForUsers } from "../../lib/card-assignment.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { blockedByCounts, emitRelationNeighboursChanged, lockWorkspaceRelations } from "../../lib/card-relations.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { emitRelocatedNotifications, relocateNotificationsForCard } from "../../lib/notifications.js";
import { requestScheduleRecheckForBoards, requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitToBoard } from "../../realtime/emit.js";
import { emitCoalescedCardActivityFeedItem, sortedIds, topPositionForList } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;

/**
 * Access checks for `POST /cards/:id/move-to-board`: editor on the card's board and on the
 * destination board, both in the same workspace, and a target list in that workspace.
 */
export async function authorizeCardMoveToBoard({
  auth,
  cardId: id,
  body,
}: {
  auth: AuthClaims;
  cardId: string;
  body: dto.MoveCardToBoardBody;
}) {
  const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
  if (!source) throw notFound();
  const srcCtx = await assertCardAccess(auth, source, "editor");
  assertCardActive(source);

  if (body.boardId === source.boardId) {
    throw badRequest("target board must differ from current board");
  }
  const dstCtx = await assertBoardAccess(auth, body.boardId, "editor");
  if (dstCtx.workspaceId !== srcCtx.workspaceId) {
    throw badRequest("target board must be in the same workspace");
  }

  const targetListId = body.listId ?? source.listId;
  const [targetList] = await db.select().from(lists).where(eq(lists.id, targetListId)).limit(1);
  if (!targetList || targetList.workspaceId !== dstCtx.workspaceId) {
    throw badRequest("target list not in same workspace");
  }
  return { source, dstCtx, targetListId };
}

/**
 * Moves a card to the top of a list on another board in the same workspace. Assignees and
 * checklist owners who cannot work on the destination board are dropped, and notifications,
 * agent runs and schedules follow the card, all in one transaction with the move's activity and
 * automations.
 */
export async function moveCardToBoard({
  auth,
  source,
  dstCtx,
  targetListId,
  body,
}: {
  auth: AuthClaims;
  source: typeof cards.$inferSelect;
  dstCtx: BoardAccessContext;
  targetListId: string;
  body: dto.MoveCardToBoardBody;
}) {
  const id = source.id;
  const position = await topPositionForList(body.boardId, targetListId);
  const fromBoardId = source.boardId;
  const fromListId = source.listId;
  const prevPosition = source.position;

  const currentAssignees = await db
    .select({ userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(eq(cardAssignees.cardId, source.id));
  const currentAssigneeIds = currentAssignees.map((a) => a.userId);
  const checklistAssignments = await db
    .select({ assigneeId: cardChecklistItems.assigneeId, checklistId: cardChecklists.id, parentItemId: cardChecklists.parentItemId })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(and(eq(cardChecklists.cardId, id), isNotNull(cardChecklistItems.assigneeId)));
  // Checklist ownership is independent of card ownership. Check the union for destination
  // eligibility without promoting checklist-only owners into the card's assignee collection.
  const assignmentCandidates = [...new Set([...currentAssigneeIds, ...checklistAssignments.map((item) => item.assigneeId!)])];
  const eligibleAssigneeSet = new Set(await ensureBoardMembershipForUsers(body.boardId, assignmentCandidates));
  const eligibleAssigneeIds = currentAssigneeIds.filter((userId) => eligibleAssigneeSet.has(userId));
  // Assignment is board-scoped: anyone who is not a non-observer member of the destination board
  // must be unassigned as part of the move. Leaving them on the card would keep sending them
  // comment/due-date notifications for a card (and board) they can no longer open.
  const droppedAssigneeIds = currentAssigneeIds.filter((userId) => !eligibleAssigneeSet.has(userId));
  const droppedChecklistAssigneeIds = assignmentCandidates.filter((userId) => !eligibleAssigneeSet.has(userId));
  const droppedAssigneeNames = droppedAssigneeIds.length === 0 ? [] : (await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, droppedAssigneeIds))).map((row) => row.displayName);

  const { updated, finalCard, clearedChecklistItems, activity, relocatedNotifications, automationEffects } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, dstCtx.workspaceId);
    const [updatedCard] = await tx
      .update(cards)
      .set({ boardId: body.boardId, listId: targetListId, position, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    // The bar leaves one board's schedule and joins another's; both must re-evaluate.
    await requestScheduleRecheckForBoards(tx, [source.boardId]);
    await requestScheduleRecheckForCards(tx, [id]);
    // Worker heartbeats and stall events must follow the card into its new board room, not
    // expose run summaries to members of the board the card just left.
    await tx.update(agentRuns).set({ boardId: body.boardId, workspaceId: dstCtx.workspaceId })
      .where(eq(agentRuns.cardId, id));
    const checklistIds = tx.select({ id: cardChecklists.id }).from(cardChecklists).where(eq(cardChecklists.cardId, id));
    const clearedChecklistItems = droppedChecklistAssigneeIds.length === 0 ? [] : await tx.update(cardChecklistItems)
      .set({ assigneeId: null, updatedAt: new Date() })
      .where(and(inArray(cardChecklistItems.checklistId, checklistIds), inArray(cardChecklistItems.assigneeId, droppedChecklistAssigneeIds)))
      .returning();
    if (droppedAssigneeIds.length > 0) {
      await tx.delete(cardAssignees).where(and(eq(cardAssignees.cardId, id), inArray(cardAssignees.userId, droppedAssigneeIds)));
      await recordActivity(tx, {
        boardId: body.boardId,
        workspaceId: dstCtx.workspaceId,
        actorId: auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.ASSIGNEES_SET,
        payload: {
          assigneeIds: eligibleAssigneeIds,
          removedAssigneeNames: droppedAssigneeNames,
          fromValue: sortedIds(currentAssigneeIds),
          toValue: sortedIds(eligibleAssigneeIds),
          reason: "moved-to-board",
        },
      });
    }
    const moveActivity = await recordCoalescedActivity(tx, {
      boardId: body.boardId,
      workspaceId: dstCtx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.MOVED,
      coalesceKey: "card:board",
      coalesceAcrossBoards: true,
      preservePayloadKeys: ["fromBoardId", "fromListId", "prevPosition"],
      windowMs: 60_000,
      fromValue: { boardId: fromBoardId, listId: fromListId },
      toValue: { boardId: body.boardId, listId: targetListId },
      payload: { fromBoardId, toBoardId: body.boardId, fromListId, toListId: targetListId, prevPosition, position,
        clearedChecklistItemIds: clearedChecklistItems.map((item) => item.id) },
    });
    const relocated = await relocateNotificationsForCard(tx, {
      cardId: id,
      boardId: body.boardId,
      listId: targetListId,
      workspaceId: dstCtx.workspaceId,
      clientId: dstCtx.clientId,
    });
    const effects = fromListId === targetListId
      ? EMPTY_EFFECTS
      : await runCardMoveAutomations(tx, {
        cardId: id,
        fromListId,
        toListId: targetListId,
        boardId: body.boardId,
        workspaceId: dstCtx.workspaceId,
        clientId: dstCtx.clientId,
        triggerActorId: auth.sub,
      });
    const [finalCard] = effects.effects.length > 0
      ? await tx.select().from(cards).where(eq(cards.id, id)).limit(1)
      : [updatedCard];
    return { updated: updatedCard, finalCard: finalCard!, clearedChecklistItems, activity: moveActivity, relocatedNotifications: relocated, automationEffects: effects };
  });

  return {
    cardId: id,
    cardTitle: source.title,
    fromBoardId,
    toBoardId: body.boardId,
    targetListId,
    checklistAssignments,
    droppedAssigneeIds,
    updated,
    finalCard,
    clearedChecklistItems,
    activity,
    relocatedNotifications,
    automationEffects,
  };
}

type MoveCardToBoardResult = Awaited<ReturnType<typeof moveCardToBoard>>;

/**
 * Post-commit fanout for `moveCardToBoard`: the source board sees a deletion, the destination
 * board an arrival followed by the card's checklist, label, assignee and attachment state.
 */
export async function emitCardMovedToBoard({ auth, result }: { auth: AuthClaims; result: MoveCardToBoardResult }): Promise<void> {
  const {
    cardId: id,
    cardTitle,
    fromBoardId,
    toBoardId,
    targetListId,
    checklistAssignments,
    droppedAssigneeIds,
    updated,
    clearedChecklistItems,
    activity,
    relocatedNotifications,
    automationEffects,
  } = result;
  await emitToBoard(fromBoardId, SERVER_EVENTS.CARD_DELETED, { boardId: fromBoardId, cardId: id });
  const wireUpdated = toWireCard(updated!, auth.cid);
  // The destination board has never seen this card, so the arrival carries its open-blocker
  // count; without it viewers there would show it unblocked until they reload.
  await emitToBoard(toBoardId, SERVER_EVENTS.CARD_CREATED, { boardId: toBoardId, card: wireUpdated, blockedByCount: (await blockedByCounts(db, [id])).get(id) ?? 0 });
  // Related cards show this card's board and list in their Dependencies section.
  await emitRelationNeighboursChanged([id]);
  for (const item of clearedChecklistItems) {
    await emitToBoard(toBoardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, {
      boardId: toBoardId, cardId: id, cardTitle, listId: targetListId,
      checklistId: item.checklistId,
      checklistParentItemId: checklistAssignments.find((assignment) => assignment.checklistId === item.checklistId)?.parentItemId ?? null,
      item, prevCompletedAt: item.completedAt,
    });
  }
  await emitRelocatedNotifications(relocatedNotifications);
  await emitCoalescedCardActivityFeedItem(toBoardId, id, activity);
  await emitAutomationEffects(automationEffects);

  const [labelAssignments, assignees, attachmentRows] = await Promise.all([
    db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, id)),
    db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, id)),
    db
      .select(attachmentRowBaseColumns)
      .from(cardAttachments)
      .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
      .where(eq(cardAttachments.cardId, id)),
  ]);

  if (labelAssignments.length > 0) {
    await emitToBoard(toBoardId, SERVER_EVENTS.CARD_LABELS_SET, {
      boardId: toBoardId,
      cardId: id,
      labelIds: labelAssignments.map((l) => l.labelId),
    });
  }
  // Always broadcast when assignees were dropped, even if the final set is empty, so the
  // destination board's clients do not keep a stale assignee list from the CARD_CREATED payload.
  if (assignees.length > 0 || droppedAssigneeIds.length > 0) {
    await emitToBoard(toBoardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, {
      boardId: toBoardId,
      cardId: id,
      assigneeIds: assignees.map((a) => a.userId),
    });
  }
  for (const { uploadedByClientId, uploadedByAvatarUrl, ...att } of attachmentRows) {
    await emitToBoard(toBoardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
      boardId: toBoardId,
      cardId: id,
      attachment: {
        ...shapeAttachmentMedia(att),
        uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
      },
    });
  }
}
