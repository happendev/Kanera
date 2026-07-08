import {
  ACTIVITY_ACTION,
  boardMembers,
  boardWatchers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardMentions,
  cards,
  cardWatchers,
  users,
  type ActivityEvent,
} from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import { recordActivity } from "./activity.js";
import { clearNotificationsForRevokedAccess } from "./notifications.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type BoardParticipationCleanup = {
  removedBoardIds: string[];
  assigneeUpdates: { boardId: string; cardId: string; assigneeIds: string[] }[];
  checklistItemUpdates: {
    boardId: string;
    cardId: string;
    cardTitle: string;
    listId: string;
    checklistId: string;
    item: typeof cardChecklistItems.$inferSelect;
  }[];
  activities: { boardId: string; cardId: string; activity: ActivityEvent }[];
};

/**
 * Revoke a user's live participation in a set of boards in one transaction.
 *
 * Membership, watchers, mentions, assignments, checklist ownership, notifications, audit rows,
 * and the realtime payloads derived from those writes must move together. Keeping that policy here
 * prevents board, guest, workspace, and account removal routes from drifting apart.
 */
export async function cleanupUserBoardParticipation(
  tx: Tx,
  params: {
    userId: string;
    boardIds: string[];
    actorId: string | null;
    actorKind?: "system";
    clearNotifications?: boolean;
  },
): Promise<BoardParticipationCleanup> {
  const boardIds = [...new Set(params.boardIds.filter(Boolean))];
  const empty: BoardParticipationCleanup = {
    removedBoardIds: [],
    assigneeUpdates: [],
    checklistItemUpdates: [],
    activities: [],
  };
  if (boardIds.length === 0) return empty;

  // A node-postgres transaction owns one client; keep its queries sequential rather than issuing
  // concurrent client.query calls (deprecated in pg 8 and rejected by pg 9).
  const removedMemberships = await tx
    .delete(boardMembers)
    .where(and(eq(boardMembers.userId, params.userId), inArray(boardMembers.boardId, boardIds)))
    .returning({ boardId: boardMembers.boardId });
  const boardCards = await tx
    .select({
      id: cards.id,
      boardId: cards.boardId,
      workspaceId: boards.workspaceId,
      title: cards.title,
      listId: cards.listId,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(inArray(cards.boardId, boardIds));
  const removedUser = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, params.userId)).limit(1);

  await tx.delete(boardWatchers).where(and(eq(boardWatchers.userId, params.userId), inArray(boardWatchers.boardId, boardIds)));
  if (params.clearNotifications !== false) {
    await clearNotificationsForRevokedAccess(tx, { userId: params.userId, boardIds });
  }

  const cardIds = boardCards.map((card) => card.id);
  if (cardIds.length === 0) {
    return { ...empty, removedBoardIds: removedMemberships.map((row) => row.boardId) };
  }

  const affectedAssigneeRows = await tx
    .select({ cardId: cardAssignees.cardId })
    .from(cardAssignees)
    .where(and(eq(cardAssignees.userId, params.userId), inArray(cardAssignees.cardId, cardIds)));
  const assignedChecklistItems = await tx
    .select({
      item: cardChecklistItems,
      checklistId: cardChecklistItems.checklistId,
      checklistTitle: cardChecklists.title,
      cardId: cardChecklists.cardId,
    })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(and(eq(cardChecklistItems.assigneeId, params.userId), inArray(cardChecklists.cardId, cardIds)));
  const affectedCardIds = [...new Set(affectedAssigneeRows.map((row) => row.cardId))];

  await tx.delete(cardAssignees).where(and(eq(cardAssignees.userId, params.userId), inArray(cardAssignees.cardId, cardIds)));
  await tx.delete(cardWatchers).where(and(eq(cardWatchers.userId, params.userId), inArray(cardWatchers.cardId, cardIds)));
  await tx.delete(cardMentions).where(and(eq(cardMentions.userId, params.userId), inArray(cardMentions.cardId, cardIds)));

  const updatedChecklistItems = assignedChecklistItems.length === 0
    ? []
    : await tx
      .update(cardChecklistItems)
      .set({ assigneeId: null, updatedAt: new Date() })
      .where(inArray(cardChecklistItems.id, assignedChecklistItems.map((row) => row.item.id)))
      .returning();

  const remainingAssignees = affectedCardIds.length === 0
    ? []
    : await tx
      .select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId, displayName: users.displayName })
      .from(cardAssignees)
      .innerJoin(users, eq(users.id, cardAssignees.userId))
      .where(inArray(cardAssignees.cardId, affectedCardIds));
  const remainingByCardId = new Map<string, { userId: string; displayName: string }[]>();
  for (const row of remainingAssignees) {
    const rows = remainingByCardId.get(row.cardId) ?? [];
    rows.push({ userId: row.userId, displayName: row.displayName });
    remainingByCardId.set(row.cardId, rows);
  }

  const cardById = new Map(boardCards.map((card) => [card.id, card]));
  const checklistMetadataById = new Map(assignedChecklistItems.map((row) => [row.item.id, row]));
  const assigneeUpdates: BoardParticipationCleanup["assigneeUpdates"] = [];
  const checklistItemUpdates: BoardParticipationCleanup["checklistItemUpdates"] = [];
  const activities: BoardParticipationCleanup["activities"] = [];
  const removedDisplayName = removedUser[0]?.displayName ?? "Removed member";

  for (const cardId of affectedCardIds) {
    const card = cardById.get(cardId);
    if (!card) continue;
    const remaining = remainingByCardId.get(cardId) ?? [];
    const assigneeIds = remaining.map((row) => row.userId);
    assigneeUpdates.push({ boardId: card.boardId, cardId, assigneeIds });
    const assigneeNamesById = Object.fromEntries([
      [params.userId, removedDisplayName],
      ...remaining.map((row) => [row.userId, row.displayName] as const),
    ]);
    const activity = await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId: card.workspaceId,
      actorId: params.actorId,
      ...(params.actorKind ? { actorKind: params.actorKind } : {}),
      entityType: "card",
      entityId: cardId,
      action: ACTIVITY_ACTION.ASSIGNEES_SET,
      payload: {
        assigneeIds,
        addedAssigneeNames: [],
        removedAssigneeNames: [removedDisplayName],
        assigneeNamesById,
        fromValue: [...assigneeIds, params.userId].sort(),
        toValue: [...assigneeIds].sort(),
        accessRevoked: true,
      },
    });
    activities.push({ boardId: card.boardId, cardId, activity });
  }

  for (const item of updatedChecklistItems) {
    const metadata = checklistMetadataById.get(item.id);
    const card = metadata ? cardById.get(metadata.cardId) : undefined;
    if (!metadata || !card) continue;
    checklistItemUpdates.push({
      boardId: card.boardId,
      cardId: card.id,
      cardTitle: card.title,
      listId: card.listId,
      checklistId: metadata.checklistId,
      item,
    });
    const activity = await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId: card.workspaceId,
      actorId: params.actorId,
      ...(params.actorKind ? { actorKind: params.actorKind } : {}),
      entityType: "card",
      entityId: card.id,
      action: ACTIVITY_ACTION.CHECKLIST_ITEM_ASSIGNEE_SET,
      payload: {
        checklistId: metadata.checklistId,
        checklistTitle: metadata.checklistTitle,
        itemId: item.id,
        itemText: item.text,
        assigneeId: null,
        assigneeName: null,
        previousAssigneeId: params.userId,
        previousAssigneeName: removedDisplayName,
        fromValue: params.userId,
        toValue: null,
        accessRevoked: true,
      },
    });
    activities.push({ boardId: card.boardId, cardId: card.id, activity });
  }

  return {
    removedBoardIds: removedMemberships.map((row) => row.boardId),
    assigneeUpdates,
    checklistItemUpdates,
    activities,
  };
}
