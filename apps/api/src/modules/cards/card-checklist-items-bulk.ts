import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardChecklistItems, cardChecklists, cards, users, type ActivityEvent } from "@kanera/shared/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { assertBatchCardVisibility, type assertBoardAccess, type assertCardAccess } from "../../lib/access.js";
import {
  recordActivity,
  recordCoalescedActivity,
  type CoalescedActivityResult,
} from "../../lib/activity.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { clearOverdueChecklistItemNotifications } from "../../lib/notifications.js";
import { between } from "../../lib/position.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { ensureBoardMembershipForUsers } from "../../lib/card-assignment.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { emitCardActivityFeedItem, emitCoalescedCardActivityFeedItem, orderedUniqueIds } from "./route-support.js";

type Card = typeof cards.$inferSelect;
type CardAccess = Awaited<ReturnType<typeof assertCardAccess>>;
type BoardAccess = Awaited<ReturnType<typeof assertBoardAccess>>;
type Checklist = typeof cardChecklists.$inferSelect;
type ChecklistItem = typeof cardChecklistItems.$inferSelect;
type DescriptionUpdate = dto.BulkSetChecklistItemDescriptionsBody["updates"][number];

/**
 * Loads every addressed item with its checklist and card, and rejects the whole batch when any
 * (board, card, checklist, item) tuple does not line up.
 */
export async function loadChecklistItemDescriptionTargets(boardId: string, updates: readonly DescriptionUpdate[]) {
  const currentRows = await db
    .select({ item: cardChecklistItems, checklist: cardChecklists, card: cards })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
    .where(inArray(cardChecklistItems.id, updates.map((update) => update.itemId)));
  const currentByItemId = new Map(currentRows.map((row) => [row.item.id, row]));

  // Validate the entire tuple set before writing anything. IDs alone are insufficient because a
  // stale model context could otherwise apply a description to an item that moved to another card.
  for (const update of updates) {
    const current = currentByItemId.get(update.itemId);
    if (
      !current ||
      current.card.boardId !== boardId ||
      current.card.id !== update.cardId ||
      current.checklist.id !== update.checklistId
    ) {
      throw badRequest("one or more checklist item ids do not match the supplied board, card, or checklist");
    }
    if (current.checklist.parentItemId) {
      throw badRequest("nested checklist items do not support descriptions");
    }
  }
  return currentByItemId;
}

export async function setChecklistItemDescriptions(params: {
  actorId: string;
  boardId: string;
  workspaceId: string;
  updates: readonly DescriptionUpdate[];
  currentByItemId: Awaited<ReturnType<typeof loadChecklistItemDescriptionTargets>>;
}) {
  const { actorId, boardId, workspaceId, updates: requested, currentByItemId } = params;
  const changingUpdates = requested.filter((update) =>
    currentByItemId.get(update.itemId)!.item.description !== update.description
  );
  const unchangedItemIds = requested
    .filter((update) => currentByItemId.get(update.itemId)!.item.description === update.description)
    .map((update) => update.itemId);
  if (changingUpdates.length === 0) return { boardId, updates: [], unchangedItemIds };

  const updates = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, changingUpdates.map((update) => update.cardId));
    const rows: Array<{
      card: Card;
      checklist: Checklist;
      previous: ChecklistItem;
      item: ChecklistItem;
      activity: CoalescedActivityResult;
    }> = [];
    const now = new Date();
    for (const update of changingUpdates) {
      const current = currentByItemId.get(update.itemId)!;
      const [item] = await tx
        .update(cardChecklistItems)
        .set({ description: update.description, updatedAt: now })
        .where(and(eq(cardChecklistItems.id, update.itemId), eq(cardChecklistItems.checklistId, update.checklistId)))
        .returning();
      if (!item) throw badRequest("a checklist item changed while applying the batch; retry with fresh content");
      const activity = await recordCoalescedActivity(tx, {
        boardId,
        workspaceId,
        actorId,
        entityType: "card",
        entityId: update.cardId,
        action: ACTIVITY_ACTION.CHECKLIST_ITEM_DESCRIPTION_SET,
        coalesceKey: `checklistItem:${update.itemId}:description`,
        windowMs: 60_000,
        fromValue: current.item.description,
        toValue: update.description,
        payload: {
          checklistId: update.checklistId,
          checklistTitle: current.checklist.title,
          itemId: update.itemId,
          itemText: current.item.text,
          fromValue: current.item.description,
          toValue: update.description,
          bulk: true,
        },
      });
      rows.push({ card: current.card, checklist: current.checklist, previous: current.item, item, activity });
    }
    await tx
      .update(cards)
      .set({ updatedAt: now })
      .where(inArray(cards.id, orderedUniqueIds(changingUpdates.map((update) => update.cardId))));
    return rows;
  });
  return { boardId, updates, unchangedItemIds };
}

export async function emitChecklistItemDescriptions(result: Awaited<ReturnType<typeof setChecklistItemDescriptions>>) {
  const { boardId } = result;
  // The write is atomic, but consumers still need full per-item events to update cached card
  // detail accurately. Emit only after commit so no client observes a rolled-back description.
  for (const update of result.updates) {
    // A migration may touch hundreds of items. Preserve the audit feed without generating one
    // notification per migrated comment for every card assignee.
    await emitCoalescedCardActivityFeedItem(boardId, update.card.id, update.activity, { notify: false });
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, {
      boardId,
      cardId: update.card.id,
      cardTitle: update.card.title,
      listId: update.card.listId,
      checklistId: update.checklist.id,
      checklistParentItemId: update.checklist.parentItemId,
      item: update.item,
      prevCompletedAt: update.previous.completedAt,
    });
  }
}

/**
 * Resolves and authorizes every card/checklist pair of a board-level bulk create. Board editor
 * access is asserted by the caller.
 */
export async function loadBulkChecklistItemTargets(
  auth: AuthClaims,
  boardAccess: BoardAccess,
  boardId: string,
  items: dto.BulkCreateChecklistItemsBody["items"],
) {
  const cardIds = [...new Set(items.map((entry) => entry.cardId))];
  const checklistIds = [...new Set(items.map((entry) => entry.checklistId))];
  const [cardRows, checklistRows] = await Promise.all([
    db.select().from(cards).where(inArray(cards.id, cardIds)),
    db.select().from(cardChecklists).where(inArray(cardChecklists.id, checklistIds)),
  ]);
  const cardsById = new Map(cardRows.map((card) => [card.id, card]));
  const checklistsById = new Map(checklistRows.map((checklist) => [checklist.id, checklist]));

  // Resolve all card/checklist pairs before assigning positions. Besides making the write atomic,
  // this prevents a checklist id from another card or board being used as a cross-tenant target.
  for (const cardId of cardIds) {
    const card = cardsById.get(cardId);
    if (!card || card.boardId !== boardId) throw notFound("one or more cards were not found on this board");
    assertCardActive(card);
  }
  // Board editor access is asserted once above and every card is confirmed to be on that board,
  // so only the assigned-items-only rule is still per-card — one probe for the whole batch.
  await assertBatchCardVisibility(auth, boardAccess, cardIds);
  for (const entry of items) {
    const checklist = checklistsById.get(entry.checklistId);
    if (!checklist || checklist.cardId !== entry.cardId) throw notFound("one or more checklists were not found on their cards");
    if (checklist.parentItemId && entry.description != null) {
      throw badRequest("items in nested checklists do not support descriptions");
    }
  }
  return { cardIds, checklistIds, cardsById, checklistsById };
}

export async function createBulkChecklistItems(params: {
  actorId: string;
  boardId: string;
  workspaceId: string;
  items: dto.BulkCreateChecklistItemsBody["items"];
  targets: Awaited<ReturnType<typeof loadBulkChecklistItemTargets>>;
}) {
  const { actorId, boardId, workspaceId, targets } = params;
  const { cardIds, checklistIds } = targets;
  const { items, activities, inserts } = await db.transaction(async (tx) => {
    // Cards precede checklist/item locks in every writer. Lock the whole batch first, then each
    // checklist before reading its tail so single and batch appends share the position guard.
    await lockCardsForWrite(tx, cardIds);
    const lockedChecklists = await tx
      .select({ id: cardChecklists.id })
      .from(cardChecklists)
      .where(inArray(cardChecklists.id, checklistIds))
      .orderBy(asc(cardChecklists.id))
      .for("update");
    if (lockedChecklists.length !== checklistIds.length) {
      throw badRequest("a checklist changed while preparing the batch; retry with fresh content");
    }
    const currentItems = await tx
      .select({ checklistId: cardChecklistItems.checklistId, position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(inArray(cardChecklistItems.checklistId, checklistIds));
    const lastPositionByChecklist = new Map<string, string>();
    for (const item of currentItems) {
      const current = lastPositionByChecklist.get(item.checklistId);
      if (!current || Number(item.position) > Number(current)) lastPositionByChecklist.set(item.checklistId, item.position);
    }
    const inserts = params.items.map((entry) => {
      const position = between(lastPositionByChecklist.get(entry.checklistId) ?? null, null).position;
      lastPositionByChecklist.set(entry.checklistId, position);
      return { id: randomUUID(), ...entry, position, description: entry.description ?? null };
    });
    const inserted = await tx.insert(cardChecklistItems).values(inserts.map(({ cardId: _cardId, ...item }) => item)).returning();
    const insertedById = new Map(inserted.map((item) => [item.id, item]));
    await tx.update(cards).set({ updatedAt: new Date() }).where(inArray(cards.id, cardIds));
    const activities: ActivityEvent[] = [];
    for (const entry of inserts) {
      activities.push(await recordActivity(tx, {
        boardId,
        workspaceId,
        actorId,
        entityType: "card",
        entityId: entry.cardId,
        action: ACTIVITY_ACTION.CHECKLIST_ITEM_CREATED,
        payload: { checklistId: entry.checklistId, itemId: entry.id, text: entry.text, bulk: true },
      }));
    }
    return { items: inserts.map((entry) => insertedById.get(entry.id)!), activities, inserts };
  });
  return { boardId, targets, items, activities, inserts };
}

export async function emitBulkCreatedChecklistItems(result: Awaited<ReturnType<typeof createBulkChecklistItems>>) {
  const { boardId, items, activities, inserts } = result;
  const { cardsById, checklistsById } = result.targets;
  for (let index = 0; index < inserts.length; index += 1) {
    const entry = inserts[index]!;
    const card = cardsById.get(entry.cardId)!;
    const checklist = checklistsById.get(entry.checklistId)!;
    // Keep the audit/feed event but suppress up to 200 watcher notifications from one batch.
    await emitCardActivityFeedItem(boardId, entry.cardId, activities[index]!, { notify: false });
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, {
      boardId,
      cardId: entry.cardId,
      cardTitle: card.title,
      listId: card.listId,
      checklistId: entry.checklistId,
      checklistParentItemId: checklist.parentItemId,
      item: items[index]!,
    });
  }
}

export async function bulkUpdateChecklistItems(params: {
  actorId: string;
  card: Card;
  ctx: CardAccess;
  checklist: Checklist;
  body: dto.BulkUpdateChecklistItemsBody;
}) {
  const { actorId, card, ctx, checklist, body } = params;
  const id = card.id;
  const checklistId = checklist.id;
  const unchanged = { card, checklist, items: [] as ChecklistItem[], targetItems: [] as ChecklistItem[], assigneeActivity: null, dueDateActivity: null };
  if (checklist.parentItemId) throw badRequest("nested checklist items do not support assignees or due dates");

  const currentItems = await db
    .select()
    .from(cardChecklistItems)
    .where(eq(cardChecklistItems.checklistId, checklistId))
    .orderBy(asc(cardChecklistItems.position));
  if (currentItems.length === 0) return unchanged;

  const hasAssigneeUpdate = body.assigneeId !== undefined;
  const nextAssigneeId = hasAssigneeUpdate ? body.assigneeId : undefined;
  let nextAssigneeName: string | null = null;
  if (nextAssigneeId) {
    const eligibleIds = await ensureBoardMembershipForUsers(card.boardId, [nextAssigneeId]);
    if (!eligibleIds.includes(nextAssigneeId)) throw badRequest("assignee is not an assignable member");
    const [assignee] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, nextAssigneeId))
      .limit(1);
    nextAssigneeName = assignee?.displayName ?? null;
  }

  const hasDueDateUpdate = body.dueDateLocalDate !== undefined;
  const dueDateLocalDate = hasDueDateUpdate ? body.dueDateLocalDate : undefined;
  const dueDateSlot = dueDateLocalDate === undefined
    ? undefined
    : dueDateLocalDate
      ? (body.dueDateSlot ?? "anyTime")
      : null;
  const dueDateTimezone = dueDateLocalDate === undefined
    ? undefined
    : dueDateLocalDate
      ? ((await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, actorId)).limit(1))[0]?.timezone ?? "UTC")
      : null;

  const targetItems = currentItems.filter((item) => {
    const assigneeChanged = hasAssigneeUpdate && item.assigneeId !== nextAssigneeId;
    const dueDateChanged = hasDueDateUpdate && (item.dueDateLocalDate !== dueDateLocalDate || item.dueDateSlot !== dueDateSlot);
    return assigneeChanged || dueDateChanged;
  });
  if (targetItems.length === 0) return unchanged;

  const targetItemIds = targetItems.map((item) => item.id);
  const { items, assigneeActivity, dueDateActivity } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, [id]);
    const items = await tx
      .update(cardChecklistItems)
      .set({
        ...(hasAssigneeUpdate && { assigneeId: nextAssigneeId ?? null }),
        ...(dueDateLocalDate !== undefined && { dueDateLocalDate }),
        ...(dueDateSlot !== undefined && { dueDateSlot }),
        ...(dueDateTimezone !== undefined && { dueDateTimezone }),
        updatedAt: new Date(),
      })
      .where(inArray(cardChecklistItems.id, targetItemIds))
      .returning();
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));

    if (dueDateLocalDate === null) {
      await clearOverdueChecklistItemNotifications(tx, targetItemIds);
    }

    let assigneeActivity: CoalescedActivityResult | null = null;
    let dueDateActivity: CoalescedActivityResult | null = null;
    if (hasAssigneeUpdate) {
      // Bulk assignment is represented as one feed row; realtime still emits each item
      // below so board state stays item-accurate without spamming the activity log.
      assigneeActivity = await recordCoalescedActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_ITEM_ASSIGNEE_SET,
        coalesceKey: `checklist:${checklistId}:items:assignee`,
        windowMs: 60_000,
        fromValue: null,
        toValue: nextAssigneeId ?? null,
        payload: {
          checklistId,
          checklistTitle: checklist.title,
          bulk: true,
          itemCount: targetItems.length,
          assigneeId: nextAssigneeId ?? null,
          assigneeName: nextAssigneeName,
          toValue: nextAssigneeId ?? null,
        },
      });
    }
    if (hasDueDateUpdate) {
      dueDateActivity = await recordCoalescedActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_ITEM_DUE_DATE_SET,
        coalesceKey: `checklist:${checklistId}:items:dueDate`,
        windowMs: 60_000,
        fromValue: null,
        toValue: dueDateLocalDate ?? null,
        payload: {
          checklistId,
          checklistTitle: checklist.title,
          bulk: true,
          itemCount: targetItems.length,
          dueDateLocalDate: dueDateLocalDate ?? null,
          dueDateSlot: dueDateSlot ?? null,
          dueDateTimezone: dueDateTimezone ?? null,
          toValue: dueDateLocalDate ?? null,
        },
      });
    }
    return { items, assigneeActivity, dueDateActivity };
  });
  return { card, checklist, items, targetItems, assigneeActivity, dueDateActivity };
}

export async function emitBulkChecklistItemUpdate(result: Awaited<ReturnType<typeof bulkUpdateChecklistItems>>) {
  const { card, checklist, items, targetItems, assigneeActivity, dueDateActivity } = result;
  const id = card.id;
  if (assigneeActivity) await emitCoalescedCardActivityFeedItem(card.boardId, id, assigneeActivity, { notify: false });
  if (dueDateActivity) await emitCoalescedCardActivityFeedItem(card.boardId, id, dueDateActivity, { notify: false });
  const itemsById = new Map(items.map((item) => [item.id, item]));
  for (const current of targetItems) {
    const item = itemsById.get(current.id);
    if (!item) continue;
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, item, prevCompletedAt: current.completedAt });
  }
}
