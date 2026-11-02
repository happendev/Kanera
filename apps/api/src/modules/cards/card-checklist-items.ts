import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, activityEvents, cardChecklistItems, cardChecklists, cards, users } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Tx, type TxOnly } from "../../db.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import type { assertCardAccess } from "../../lib/access.js";
import {
  emitActivityFeedItemDeleted,
  recordCoalescedActivity,
  type CoalescedActivityResult,
} from "../../lib/activity.js";
import { emitAutomationEffects, runChecklistCompletionAutomations, type AutomationEffects } from "../../lib/automations.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { resolveDueDatePatch } from "../../lib/due-date.js";
import { clearOverdueChecklistItemNotifications, syncDirectNotificationForActivity } from "../../lib/notifications.js";
import { between, positionAtIndex } from "../../lib/position.js";
import {
  assertLeafItems,
  checklistValidationError,
  insertChecklistItemTrees,
  positionsBetween,
  recordItemCreationActivities,
  type IssuePath,
} from "./checklist-tree.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { ensureBoardMembershipForUsers } from "../../lib/card-assignment.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { emitCoalescedCardActivityFeedItem, loadEditableCard, actorTimezone, prepareNewChecklistItems, runCompletionAutomationsForNewItems, emitCreatedItemTrees } from "./route-support.js";

type Card = typeof cards.$inferSelect;
type CardAccess = Awaited<ReturnType<typeof assertCardAccess>>;
type Checklist = typeof cardChecklists.$inferSelect;

async function neighbourChecklistItemPositions(
  checklistId: string,
  excludeItemId: string | null,
  afterId?: string | null,
  beforeId?: string | null,
  tx: Tx = db,
) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const rows = await tx
      .select({ id: cardChecklistItems.id, position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId))
      .orderBy(asc(cardChecklistItems.position));
    next = rows.find((row) => row.id !== excludeItemId)?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const rows = await tx
      .select({ id: cardChecklistItems.id, position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId))
      .orderBy(desc(cardChecklistItems.position));
    prev = rows.find((row) => row.id !== excludeItemId)?.position ?? null;
  } else if (afterId) {
    const [after] = await tx
      .select({ position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.id, afterId), eq(cardChecklistItems.checklistId, checklistId)))
      .limit(1);
    if (!after) throw badRequest("afterItemId not found");
    const rows = await tx
      .select({ id: cardChecklistItems.id, position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.checklistId, checklistId), gt(cardChecklistItems.position, after.position)))
      .orderBy(asc(cardChecklistItems.position));
    prev = after.position;
    next = rows.find((row) => row.id !== excludeItemId)?.position ?? null;
  } else if (beforeId) {
    const [before] = await tx
      .select({ position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.id, beforeId), eq(cardChecklistItems.checklistId, checklistId)))
      .limit(1);
    if (!before) throw badRequest("beforeItemId not found");
    const rows = await tx
      .select({ id: cardChecklistItems.id, position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.checklistId, checklistId), lt(cardChecklistItems.position, before.position)))
      .orderBy(desc(cardChecklistItems.position));
    next = before.position;
    prev = rows.find((row) => row.id !== excludeItemId)?.position ?? null;
  }
  return { prev, next };
}

async function rebalanceChecklistItems(checklistId: string, tx: Tx = db) {
  const rows = await tx
    .select({ id: cardChecklistItems.id })
    .from(cardChecklistItems)
    .where(eq(cardChecklistItems.checklistId, checklistId))
    .orderBy(asc(cardChecklistItems.position));
  const positions = rows.map((row, index) => ({ id: row.id, position: positionAtIndex(index) }));
  await Promise.all(positions.map((row) =>
    tx.update(cardChecklistItems).set({ position: row.position, updatedAt: new Date() }).where(eq(cardChecklistItems.id, row.id)),
  ));
  return positions;
}

/**
 * Shared by single and batch item creation. Items (and any sub-checklists under them) are placed
 * contiguously in request order at the anchor, or appended when no anchor is given.
 */
export async function createChecklistItems(params: {
  actorId: string;
  card: Card;
  ctx: CardAccess;
  checklist: Checklist;
  items: readonly dto.NewChecklistItem[];
  anchor: { afterItemId?: string | null; beforeItemId?: string | null };
  itemPath: (index: number) => IssuePath;
  created: "perItem" | "coalesced";
}) {
  const { actorId, card, ctx, checklist, items, anchor } = params;
  const id = card.id;
  const checklistId = checklist.id;
  // Depth is a property of the target, so the leaf-only rule is enforced here rather than in the
  // body schema: items added to a sub-checklist carry only text and completion.
  if (checklist.parentItemId) assertLeafItems(items, params.itemPath);
  const newItems = await prepareNewChecklistItems(card.boardId, ctx.workspaceId, actorId, items, params.itemPath);

  const { trees, rebalanced, activities, coalescedCreated, automationEffects } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, [id]);
    // Share the checklist lock used by bulk creation so concurrent single and batch appends cannot
    // calculate the same numeric position from a stale tail row.
    const [lockedChecklist] = await tx
      .select({ id: cardChecklists.id })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
      .for("update")
      .limit(1);
    if (!lockedChecklist) throw notFound("checklist not found");
    const { prev, next } = anchor.afterItemId !== undefined || anchor.beforeItemId !== undefined
      ? await neighbourChecklistItemPositions(checklistId, null, anchor.afterItemId, anchor.beforeItemId, tx)
      : await neighbourChecklistItemPositions(checklistId, null, undefined, null, tx);
    const placement = positionsBetween(prev, next, items.length);
    const now = new Date();
    const trees = await insertChecklistItemTrees(tx, items, {
      cardId: id,
      checklistId,
      positions: placement.positions,
      actorId,
      timezone: newItems.timezone,
      now,
    });
    await tx.update(cards).set({ updatedAt: now }).where(eq(cards.id, id));
    const rebalanced = placement.needsRebalance ? await rebalanceChecklistItems(checklistId, tx) : null;
    if (rebalanced) {
      const positionById = new Map(rebalanced.map((row) => [row.id, row.position]));
      for (const tree of trees) tree.item = { ...tree.item, position: positionById.get(tree.item.id) ?? tree.item.position };
    }
    const activities = await recordItemCreationActivities(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      cardId: id,
      actorId,
      checklist,
      trees,
      assigneeNames: newItems.assigneeNames,
      recordCreated: params.created === "perItem",
    });
    // The card UI adds items one Enter at a time, so a burst of adds by one person on one
    // checklist folds into a single "added N checklist items" row instead of N feed rows.
    const coalescedCreated: CoalescedActivityResult[] = [];
    if (params.created === "coalesced") {
      for (const { item } of trees) {
        coalescedCreated.push(await recordCoalescedActivity(tx, {
          boardId: card.boardId,
          workspaceId: ctx.workspaceId,
          actorId,
          entityType: "card",
          entityId: id,
          action: ACTIVITY_ACTION.CHECKLIST_ITEM_CREATED,
          coalesceKey: `checklist:${checklistId}:items:created`,
          windowMs: 60_000,
          fromValue: null,
          toValue: item.text,
          payload: { checklistId, checklistTitle: checklist.title, itemId: item.id, text: item.text },
        }));
      }
    }
    const automationEffects = await runCompletionAutomationsForNewItems(tx, card, ctx, actorId, checklist.parentItemId, items);
    return { trees, rebalanced, activities, coalescedCreated, automationEffects };
  });
  return { card, checklist, trees, rebalanced, activities, coalescedCreated, automationEffects };
}

export async function emitCreatedChecklistItems(result: Awaited<ReturnType<typeof createChecklistItems>>) {
  const { card, checklist, trees, rebalanced, activities, coalescedCreated, automationEffects } = result;
  const id = card.id;
  // Existing rows renumbered by a dense insert are announced before the created items, matching
  // the rebalance-before-move ordering every other positioned entity follows.
  if (rebalanced) {
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, { boardId: card.boardId, cardId: id, checklistId: checklist.id, positions: rebalanced });
  }
  await emitCreatedItemTrees(card, checklist, trees, activities, { emitItems: true });
  for (const coalesced of coalescedCreated) await emitCoalescedCardActivityFeedItem(card.boardId, id, coalesced, { notify: false });
  await emitAutomationEffects(automationEffects);
}

type ChecklistItemUpdateTarget = {
  card: Card;
  ctx: CardAccess;
  checklist: Checklist;
  current: typeof cardChecklistItems.$inferSelect;
};
type PreparedChecklistItemUpdate = ChecklistItemUpdateTarget & {
  body: dto.UpdateChecklistItemBody;
  actorId: string;
  hasDueDateUpdate: boolean;
  dueDateLocalDate: string | null | undefined;
  dueDateSlot: dto.DueDateSlot | null | undefined;
  dueDateTimezone: string | null | undefined;
  nextCompletedAt: Date | null;
  nextCompletedById: string | null;
  nextText: string;
  nextDescription: string | null;
  assigneeChanged: boolean;
  nextAssigneeId: string | null;
  nextAssigneeName: string | null;
  previousAssigneeName: string | null;
};
type WrittenChecklistItemUpdate = {
  changed: boolean;
  item: typeof cardChecklistItems.$inferSelect;
  activities: CoalescedActivityResult[];
  assigneeActivity: CoalescedActivityResult | null;
  dueDateActivity: CoalescedActivityResult | null;
  automationEffects: AutomationEffects;
  hiddenChecklistCompletionId: string | null;
};

/**
 * Resolves the card, its access context, and the item's containing checklist. When checklistId is
 * omitted the server derives it from the item, but the item must still belong to the supplied
 * card, so a stale or foreign id is a 404 rather than an edit on someone else's card.
 */
export async function loadChecklistItemTarget(auth: AuthClaims, params: { id: string; checklistId?: string; itemId: string }): Promise<ChecklistItemUpdateTarget> {
  const { card, ctx } = await loadEditableCard(auth, params.id);
  assertCardActive(card);
  const [row] = await db
    .select({ item: cardChecklistItems, checklist: cardChecklists })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(and(
      eq(cardChecklistItems.id, params.itemId),
      eq(cardChecklists.cardId, params.id),
      ...(params.checklistId ? [eq(cardChecklists.id, params.checklistId)] : []),
    ))
    .limit(1);
  if (!row) {
    if (params.checklistId) {
      const [checklist] = await db.select({ id: cardChecklists.id }).from(cardChecklists)
        .where(and(eq(cardChecklists.id, params.checklistId), eq(cardChecklists.cardId, params.id))).limit(1);
      if (!checklist) throw notFound("checklist not found");
    }
    throw notFound("checklist item not found");
  }
  return { card, ctx, checklist: row.checklist, current: row.item };
}

/**
 * Everything an item update needs that can be computed and validated before the transaction:
 * leaf-only rules, assignee eligibility, and due-date derivation. `path` prefixes validation
 * errors so a batch can name the offending entry.
 */
async function prepareChecklistItemUpdate(
  target: ChecklistItemUpdateTarget,
  body: dto.UpdateChecklistItemBody,
  actorId: string,
  options: { path?: IssuePath; timezone?: () => Promise<string> } = {},
): Promise<PreparedChecklistItemUpdate> {
  const { card, checklist, current } = target;
  if (checklist.parentItemId) {
    const field = (["description", "assigneeId", "dueDateLocalDate", "dueDateSlot"] as const).find((key) => body[key] !== undefined);
    if (field) {
      if (options.path) throw checklistValidationError([...options.path, field], "sub-checklist items support only text and completed");
      throw badRequest("nested checklist items support only text and completion");
    }
  }
  // Due date derivation mirrors the card PATCH route: clearing the date also
  // clears slot + timezone, setting a date defaults the slot to "anyTime" and
  // captures the acting user's timezone so overdue is evaluated correctly.
  const hasDueDateUpdate = body.dueDateLocalDate !== undefined || body.dueDateSlot !== undefined;
  const dueDatePatch = hasDueDateUpdate
    ? resolveDueDatePatch(body, current, body.dueDateLocalDate || !current.dueDateTimezone ? await (options.timezone ?? (() => actorTimezone(actorId)))() : "UTC")
    : { kind: "unchanged" as const };
  if (dueDatePatch.kind === "rejected") {
    if (options.path) throw checklistValidationError([...options.path, "dueDateSlot"], dueDatePatch.reason);
    throw badRequest(dueDatePatch.reason);
  }
  const dueDateLocalDate = dueDatePatch.kind === "write" ? dueDatePatch.dueDateLocalDate : undefined;
  const dueDateSlot = dueDatePatch.kind === "write" ? dueDatePatch.dueDateSlot : undefined;
  const dueDateTimezone = dueDatePatch.kind === "write" ? dueDatePatch.dueDateTimezone : undefined;

  const nextCompletedAt = body.completed === undefined
    ? current.completedAt
    : body.completed
      ? current.completedAt ?? new Date()
      : null;
  const nextCompletedById = body.completed === undefined
    ? current.completedById
    : body.completed
      ? actorId
      : null;
  const nextText = body.text ?? current.text;
  const nextDescription = body.description === undefined ? current.description : body.description;
  const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== current.assigneeId;
  const nextAssigneeId = body.assigneeId === undefined ? current.assigneeId : body.assigneeId;
  let nextAssigneeName: string | null = null;
  let previousAssigneeName: string | null = null;

  if (nextAssigneeId) {
    const eligibleIds = await ensureBoardMembershipForUsers(card.boardId, [nextAssigneeId]);
    if (!eligibleIds.includes(nextAssigneeId)) {
      if (options.path) throw checklistValidationError([...options.path, "assigneeId"], "assignee is not an assignable (non-observer) member of this board");
      throw badRequest("assignee is not an assignable member");
    }
  }

  if (assigneeChanged) {
    const changedAssigneeIds = [current.assigneeId, nextAssigneeId].filter((userId): userId is string => Boolean(userId));
    if (changedAssigneeIds.length > 0) {
      const changedUsers = await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, changedAssigneeIds));
      const userNameById = new Map(changedUsers.map((user) => [user.id, user.displayName]));
      nextAssigneeName = nextAssigneeId ? userNameById.get(nextAssigneeId) ?? null : null;
      previousAssigneeName = current.assigneeId ? userNameById.get(current.assigneeId) ?? null : null;
    }
  }
  return {
    ...target,
    body,
    actorId,
    hasDueDateUpdate,
    dueDateLocalDate,
    dueDateSlot,
    dueDateTimezone,
    nextCompletedAt,
    nextCompletedById,
    nextText,
    nextDescription,
    assigneeChanged,
    nextAssigneeId,
    nextAssigneeName,
    previousAssigneeName,
  };
}

async function writeChecklistItemUpdate(tx: TxOnly, prepared: PreparedChecklistItemUpdate): Promise<WrittenChecklistItemUpdate> {
  const { card, ctx, checklist, current, body, actorId } = prepared;
  const { dueDateLocalDate, dueDateSlot, dueDateTimezone, nextText, nextAssigneeId } = prepared;
  const id = card.id;
  const checklistId = checklist.id;
  const itemId = current.id;
  const textChanged = body.text !== undefined && nextText !== current.text;
  const descriptionChanged = body.description !== undefined && (prepared.nextDescription ?? "") !== (current.description ?? "");
  const dueDateChanged = dueDateLocalDate !== undefined && (
    dueDateLocalDate !== current.dueDateLocalDate || dueDateSlot !== current.dueDateSlot || dueDateTimezone !== current.dueDateTimezone
  );
  const completionChanged = body.completed !== undefined && body.completed !== Boolean(current.completedAt);
  // Shared by single-item, item-addressed and selected-item edits. Unchanged fields in a mixed
  // patch must not inflate their own activity counts, and an entirely unchanged patch is inert.
  if (!textChanged && !descriptionChanged && !dueDateChanged && !completionChanged && !prepared.assigneeChanged) {
    return { changed: false, item: current, activities: [], assigneeActivity: null, dueDateActivity: null, automationEffects: { effects: [] }, hiddenChecklistCompletionId: null };
  }
  // Completing an item can fire checklist automations, which take the dependency graph lock. Take
  // it before the card row is touched below, in the same order as every other automation-running
  // transaction (lock, then card writes), or a concurrent completion of this card can deadlock.
  const completingItem = body.completed === true && !current.completedAt;
  if (completingItem) await lockWorkspaceRelations(tx, ctx.workspaceId);
  // Bulk descriptions and checklist cascades already hold the card before touching an item.
  // Take the same lock first for text/date/completion edits, including item-addressed routes.
  await lockCardsForWrite(tx, [id]);
  const reopeningCompletedChecklist = body.completed === false
    && Boolean(current.completedAt)
    && (await tx
      .select({ completedAt: cardChecklistItems.completedAt })
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId)))
      .every((row) => Boolean(row.completedAt));
  const [item] = await tx
    .update(cardChecklistItems)
    .set({
      // Preparation can overlap another request. PATCH must only write supplied fields or a
      // completion toggle can silently restore an older title, description, or assignee.
      ...(textChanged && { text: nextText }),
      ...(descriptionChanged && { description: prepared.nextDescription }),
      ...(body.assigneeId !== undefined && { assigneeId: nextAssigneeId }),
      ...(dueDateLocalDate !== undefined && { dueDateLocalDate }),
      ...(dueDateSlot !== undefined && { dueDateSlot }),
      ...(dueDateTimezone !== undefined && { dueDateTimezone }),
      ...(completionChanged && { completedAt: prepared.nextCompletedAt, completedById: prepared.nextCompletedById }),
      updatedAt: new Date(),
    })
    .where(eq(cardChecklistItems.id, itemId))
    .returning();
  if (!item) throw notFound("checklist item not found");
  await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));

  // Completing an item or clearing its due date drops any standing overdue
  // notification so it no longer shows as overdue.
  const dueDateRemoved = dueDateLocalDate === null;
  if (completingItem || dueDateRemoved) {
    await clearOverdueChecklistItemNotifications(tx, [itemId]);
  }

  const activities: CoalescedActivityResult[] = [];
  let assigneeActivity: CoalescedActivityResult | null = null;
  let dueDateActivity: CoalescedActivityResult | null = null;
  if (textChanged) {
    activities.push(await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_ITEM_UPDATED,
      coalesceKey: `checklistItem:${itemId}:text`,
      windowMs: 60_000,
      fromValue: current.text,
      toValue: body.text,
      payload: { checklistId, checklistTitle: checklist.title, itemId, fromValue: current.text, toValue: body.text },
    }));
  }
  if (descriptionChanged) {
    activities.push(await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_ITEM_DESCRIPTION_SET,
      coalesceKey: `checklistItem:${itemId}:description`,
      windowMs: 60_000,
      fromValue: current.description,
      toValue: body.description,
      payload: {
        checklistId,
        checklistTitle: checklist.title,
        itemId,
        itemText: nextText,
        fromValue: current.description,
        toValue: body.description,
      },
    }));
  }
  if (prepared.assigneeChanged) {
    // Checklist-item assignment is independent of card assignment: assigning an item no
    // longer adds the user to cardAssignees. The item is surfaced as a first-class work
    // item via Global Work, Home, and digest surfaces instead, and the assignee still
    // gets the direct "assigned" notification emitted below.
    assigneeActivity = await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_ITEM_ASSIGNEE_SET,
      coalesceKey: `checklistItem:${itemId}:assignee`,
      windowMs: 60_000,
      fromValue: current.assigneeId,
      toValue: nextAssigneeId,
      preservePayloadKeys: ["checklistId", "checklistTitle", "itemId", "previousAssigneeId", "previousAssigneeName"],
      payload: {
        checklistId,
        checklistTitle: checklist.title,
        itemId,
        itemText: nextText,
        assigneeId: nextAssigneeId,
        assigneeName: prepared.nextAssigneeName,
        previousAssigneeId: current.assigneeId,
        previousAssigneeName: prepared.previousAssigneeName,
        fromValue: current.assigneeId,
        toValue: nextAssigneeId,
      },
    });
  }
  if (dueDateChanged) {
    dueDateActivity = await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_ITEM_DUE_DATE_SET,
      coalesceKey: `checklistItem:${itemId}:dueDate`,
      windowMs: 60_000,
      fromValue: current.dueDateLocalDate,
      toValue: dueDateLocalDate ?? null,
      preservePayloadKeys: ["checklistId", "checklistTitle", "itemId", "itemText"],
      payload: {
        checklistId,
        checklistTitle: checklist.title,
        itemId,
        itemText: nextText,
        dueDateLocalDate: dueDateLocalDate ?? null,
        dueDateSlot: dueDateSlot ?? null,
        dueDateTimezone: dueDateTimezone ?? null,
        fromValue: current.dueDateLocalDate,
        toValue: dueDateLocalDate ?? null,
      },
    });
  }
  if (completingItem) {
    const items = await tx
      .select({ completedAt: cardChecklistItems.completedAt })
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId));
    if (items.length > 0 && items.every((row) => row.completedAt)) {
      const [parentItem] = checklist.parentItemId
        ? await tx
          .select({ text: cardChecklistItems.text })
          .from(cardChecklistItems)
          .where(eq(cardChecklistItems.id, checklist.parentItemId))
          .limit(1)
        : [];
      activities.push(await recordCoalescedActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_COMPLETED,
        coalesceKey: `checklist:${checklistId}:completed`,
        windowMs: 5 * 60_000,
        fromValue: false,
        toValue: true,
        payload: {
          checklistId,
          title: checklist.title,
          ...(checklist.parentItemId && {
            parentItemId: checklist.parentItemId,
            parentItemText: parentItem?.text ?? null,
          }),
          fromValue: false,
          toValue: true,
        },
      }));
    }
  }
  let hiddenChecklistCompletionId: string | null = null;
  if (reopeningCompletedChecklist) {
    const now = new Date();
    // Completion is checklist state, not actor state. A different user reopening the
    // checklist must retract the latest still-coalescible completion instead of leaving
    // a stale feed item (or creating a misleading "completed" activity for the reopen).
    const [recentCompletion] = await tx
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.boardId, card.boardId),
        eq(activityEvents.workspaceId, ctx.workspaceId),
        eq(activityEvents.entityType, "card"),
        eq(activityEvents.entityId, id),
        eq(activityEvents.action, ACTIVITY_ACTION.CHECKLIST_COMPLETED),
        eq(activityEvents.coalesceKey, `checklist:${checklistId}:completed`),
        eq(activityEvents.feedVisible, true),
        gte(activityEvents.coalescedUntil, now),
      ))
      .orderBy(desc(activityEvents.updatedAt))
      .limit(1);
    if (recentCompletion) {
      await tx
        .update(activityEvents)
        .set({ feedVisible: false, updatedAt: now })
        .where(eq(activityEvents.id, recentCompletion.id));
      hiddenChecklistCompletionId = recentCompletion.id;
    }
  }
  const automationEffects = completingItem
    ? await runChecklistCompletionAutomations(tx, {
      cardId: id,
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      triggerActorId: actorId,
    })
    : { effects: [] };
  return { changed: true, item: item!, activities, assigneeActivity, dueDateActivity, automationEffects, hiddenChecklistCompletionId };
}

type ChecklistItemUpdateResult = { prepared: PreparedChecklistItemUpdate; written: WrittenChecklistItemUpdate };

export async function emitChecklistItemUpdate({ prepared, written }: ChecklistItemUpdateResult) {
  if (!written.changed) return;
  const { card, checklist, current } = prepared;
  const id = card.id;
  for (const activity of written.activities) await emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
  if (written.hiddenChecklistCompletionId) await emitActivityFeedItemDeleted(card.boardId, id, written.hiddenChecklistCompletionId);
  // Feed-only: due date changes never raise a notification (overdue-only scope).
  if (written.dueDateActivity) await emitCoalescedCardActivityFeedItem(card.boardId, id, written.dueDateActivity, { notify: false });
  if (written.assigneeActivity) {
    await emitCoalescedCardActivityFeedItem(card.boardId, id, written.assigneeActivity, { notify: false });
    if (written.assigneeActivity.status !== "hidden") {
      void syncDirectNotificationForActivity({
        userId: prepared.nextAssigneeId,
        activity: written.assigneeActivity.activity,
        reason: "assigned",
      }).catch(() => undefined);
    }
  }
  await emitAutomationEffects(written.automationEffects);
  await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, item: written.item, prevCompletedAt: current.completedAt });
}

export async function updateChecklistItem(params: { actorId: string; target: ChecklistItemUpdateTarget; body: dto.UpdateChecklistItemBody }): Promise<ChecklistItemUpdateResult> {
  const prepared = await prepareChecklistItemUpdate(params.target, params.body, params.actorId);
  const written = await db.transaction((tx) => writeChecklistItemUpdate(tx, prepared));
  return { prepared, written };
}

// Selected-item updates: different changes for chosen items on one card, applied atomically. The
// whole batch is validated (existence on this card, leaf-only rules, assignee eligibility) before
// the transaction, and each entry then runs the exact single-item write so activity coalescing,
// checklist-completion feed rows, reopen retraction, and automations behave identically.
export async function updateSelectedChecklistItems(params: {
  actorId: string;
  card: Card;
  ctx: CardAccess;
  updates: dto.UpdateChecklistItemsBody["updates"];
}): Promise<ChecklistItemUpdateResult[]> {
  const { actorId, card, ctx, updates } = params;
  const id = card.id;
  const rows = await db
    .select({ item: cardChecklistItems, checklist: cardChecklists })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(and(eq(cardChecklists.cardId, id), inArray(cardChecklistItems.id, updates.map((update) => update.itemId))));
  const rowsByItemId = new Map(rows.map((row) => [row.item.id, row]));
  let timezone: Promise<string> | null = null;
  const memoTimezone = () => (timezone ??= actorTimezone(actorId));
  const prepared: PreparedChecklistItemUpdate[] = [];
  for (const [index, update] of updates.entries()) {
    const row = rowsByItemId.get(update.itemId);
    if (!row) throw checklistValidationError(["updates", index, "itemId"], "checklist item was not found on this card");
    prepared.push(await prepareChecklistItemUpdate(
      { card, ctx, checklist: row.checklist, current: row.item },
      update.changes,
      actorId,
      { path: ["updates", index, "changes"], timezone: memoTimezone },
    ));
  }
  const written = await db.transaction(async (tx) => {
    // A batch that completes any item takes the graph lock before the first item writes the card
    // row; taking it only when that item's turn comes would invert the order for the batch.
    if (prepared.some((entry) => entry.body.completed === true && !entry.current.completedAt)) await lockWorkspaceRelations(tx, ctx.workspaceId);
    const results: WrittenChecklistItemUpdate[] = [];
    for (const entry of prepared) results.push(await writeChecklistItemUpdate(tx, entry));
    return results;
  });
  return prepared.map((entry, index) => ({ prepared: entry, written: written[index]! }));
}

export async function deleteChecklistItem(params: { target: ChecklistItemUpdateTarget }) {
  const { card, current } = params.target;
  await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [card.id]);
    await tx.delete(cardChecklistItems).where(eq(cardChecklistItems.id, current.id));
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, card.id));
  });
}

export async function moveChecklistItem(params: { target: ChecklistItemUpdateTarget; body: dto.MoveChecklistItemBody }) {
  const { body } = params;
  const { card, checklist: sourceChecklist, current } = params.target;
  const id = card.id;
  const itemId = current.id;
  const checklistId = sourceChecklist.id;
  const targetChecklistId = body.checklistId ?? checklistId;
  const [targetChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, targetChecklistId), eq(cardChecklists.cardId, id))).limit(1);
  if (!targetChecklist) throw badRequest("target checklist not on this card");
  // Item moves stay inside one ownership group: top-level lists can exchange top-level items,
  // while an item's sub-lists can exchange only that item's leaf rows. This preserves one level.
  if (sourceChecklist.parentItemId !== targetChecklist.parentItemId) {
    throw badRequest("target checklist must have the same parent item");
  }
  const prevPosition = current.position;

  const { position, sourceRebalanced, targetRebalanced } = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [id]);
    const { prev, next } = await neighbourChecklistItemPositions(targetChecklistId, itemId, body.afterItemId, body.beforeItemId, tx);
    const result = between(prev, next);
    let position = result.position;
    await tx
      .update(cardChecklistItems)
      .set({ checklistId: targetChecklistId, position, updatedAt: new Date() })
      .where(eq(cardChecklistItems.id, itemId));
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    const targetRebalanced = result.needsRebalance ? await rebalanceChecklistItems(targetChecklistId, tx) : null;
    const sourceRebalanced = targetChecklistId !== checklistId ? await rebalanceChecklistItems(checklistId, tx) : null;
    if (targetRebalanced) position = targetRebalanced.find((p) => p.id === itemId)?.position ?? position;
    return { position, sourceRebalanced, targetRebalanced };
  });
  return { card, itemId, checklistId, targetChecklistId, position, prevPosition, sourceRebalanced, targetRebalanced };
}

export async function emitChecklistItemMove(result: Awaited<ReturnType<typeof moveChecklistItem>>) {
  const { card, itemId, checklistId, targetChecklistId, position, prevPosition, sourceRebalanced, targetRebalanced } = result;
  const id = card.id;
  if (sourceRebalanced) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, { boardId: card.boardId, cardId: id, checklistId, positions: sourceRebalanced });
  if (targetRebalanced) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, { boardId: card.boardId, cardId: id, checklistId: targetChecklistId, positions: targetRebalanced });
  await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED, {
    boardId: card.boardId,
    cardId: id,
    itemId,
    fromChecklistId: checklistId,
    toChecklistId: targetChecklistId,
    position,
    prevPosition,
  });
}
