import type { dto } from "@kanera/shared";
import { SERVER_EVENTS, type WireCardChecklist } from "@kanera/shared/events";
import { ACTIVITY_ACTION, activityEvents, cardChecklistItems, cardChecklists, cards } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Tx } from "../../db.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import type { assertCardAccess } from "../../lib/access.js";
import {
  emitActivityFeedItemDeleted,
  recordActivity,
  recordCoalescedActivity,
} from "../../lib/activity.js";
import { emitAutomationEffects } from "../../lib/automations.js";
import { applyChecklistTemplates } from "../../lib/checklist-templates.js";
import { loadChecklistsForCard } from "../../lib/checklist-rows.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { between, positionAtIndex } from "../../lib/position.js";
import {
  insertChecklistItemTrees,
  recordItemCreationActivities,
} from "./checklist-tree.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { emitCardActivityFeedItem, loadEditableCard, loadChecklistForCard, prepareNewChecklistItems, runCompletionAutomationsForNewItems, emitCreatedItemTrees } from "./route-support.js";

type Card = typeof cards.$inferSelect;
type CardAccess = Awaited<ReturnType<typeof assertCardAccess>>;
type Checklist = typeof cardChecklists.$inferSelect;

const CHECKLIST_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

async function neighbourChecklistPositions(
  cardId: string,
  parentItemId: string | null,
  afterId?: string | null,
  beforeId?: string | null,
  tx: Tx = db,
) {
  const siblingScope = parentItemId === null
    ? and(eq(cardChecklists.cardId, cardId), isNull(cardChecklists.parentItemId))
    : and(eq(cardChecklists.cardId, cardId), eq(cardChecklists.parentItemId, parentItemId));
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(siblingScope)
      .orderBy(asc(cardChecklists.position))
      .limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(siblingScope)
      .orderBy(desc(cardChecklists.position))
      .limit(1);
    prev = last?.position ?? null;
  } else if (afterId) {
    const [after] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, afterId), siblingScope))
      .limit(1);
    if (!after) throw badRequest("afterChecklistId not found");
    const [nextRow] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(siblingScope, gt(cardChecklists.position, after.position)))
      .orderBy(asc(cardChecklists.position))
      .limit(1);
    prev = after.position;
    next = nextRow?.position ?? null;
  } else if (beforeId) {
    const [before] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, beforeId), siblingScope))
      .limit(1);
    if (!before) throw badRequest("beforeChecklistId not found");
    const [prevRow] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(siblingScope, lt(cardChecklists.position, before.position)))
      .orderBy(desc(cardChecklists.position))
      .limit(1);
    next = before.position;
    prev = prevRow?.position ?? null;
  }
  return { prev, next };
}

async function rebalanceChecklists(cardId: string, parentItemId: string | null, tx: Tx = db) {
  const siblingScope = parentItemId === null
    ? and(eq(cardChecklists.cardId, cardId), isNull(cardChecklists.parentItemId))
    : and(eq(cardChecklists.cardId, cardId), eq(cardChecklists.parentItemId, parentItemId));
  const rows = await tx
    .select({ id: cardChecklists.id })
    .from(cardChecklists)
    .where(siblingScope)
    .orderBy(asc(cardChecklists.position));
  const positions = rows.map((row, index) => ({ id: row.id, position: positionAtIndex(index) }));
  await Promise.all(positions.map((row) =>
    tx.update(cardChecklists).set({ position: row.position, updatedAt: new Date() }).where(eq(cardChecklists.id, row.id)),
  ));
  return positions;
}

/**
 * Authorization for checklist-addressed writes: the card must exist, the caller must be an editor,
 * the card must be active, and the checklist must belong to that card.
 */
export async function loadEditableChecklist(auth: AuthClaims, id: string, checklistId: string) {
  const { card, ctx } = await loadEditableCard(auth, id);
  assertCardActive(card);
  const checklist = await loadChecklistForCard(id, checklistId);
  if (!checklist) throw notFound("checklist not found");
  return { card, ctx, checklist };
}

export async function createChecklist(params: { actorId: string; card: Card; ctx: CardAccess; body: dto.CreateChecklistBody }) {
  const { actorId, card, ctx, body } = params;
  const id = card.id;
  const parentItemId = body.parentItemId ?? null;
  if (parentItemId) {
    const [parentItem] = await db
      .select({ id: cardChecklistItems.id })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .where(and(
        eq(cardChecklistItems.id, parentItemId),
        eq(cardChecklists.cardId, id),
        isNull(cardChecklists.parentItemId),
      ))
      .limit(1);
    // Only top-level items own detail checklists. This keeps the delete graph and UI depth
    // strictly card -> checklist -> item -> sub-checklist -> sub-item.
    if (!parentItem) throw badRequest("parentItemId must identify a top-level item on this card");
  }
  const items = body.items ?? [];
  // Validate every referenced assignee before writing so a bad entry deep in the tree fails the
  // whole request with its path instead of leaving a half-created plan.
  const newItems = await prepareNewChecklistItems(card.boardId, ctx.workspaceId, actorId, items, (index) => ["items", index]);
  const siblingScope = parentItemId === null
    ? and(eq(cardChecklists.cardId, id), isNull(cardChecklists.parentItemId))
    : and(eq(cardChecklists.cardId, id), eq(cardChecklists.parentItemId, parentItemId));
  const [last] = await db
    .select({ position: cardChecklists.position })
    .from(cardChecklists)
    .where(siblingScope)
    .orderBy(desc(cardChecklists.position))
    .limit(1);
  const position = between(last?.position ?? null, null).position;

  const { checklist, trees, activity, itemActivities, automationEffects } = await db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, [id]);
    const now = new Date();
    const [checklist] = await tx
      .insert(cardChecklists)
      .values({ cardId: id, parentItemId, title: body.title, position })
      .returning();
    const trees = await insertChecklistItemTrees(tx, items, {
      cardId: id,
      checklistId: checklist!.id,
      positions: items.map((_, index) => positionAtIndex(index)),
      actorId,
      timezone: newItems.timezone,
      now,
    });
    await tx.update(cards).set({ updatedAt: now }).where(eq(cards.id, id));
    const activity = await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_CREATED,
      payload: { checklistId: checklist!.id, parentItemId, title: checklist!.title, ...(items.length > 0 && { itemCount: items.length }) },
    });
    // The checklist:created row already announces the initial items, so per-item created rows
    // are skipped; assignment and due-date rows are still written so the feed and the assignee
    // notification match a step-by-step build of the same plan.
    const itemActivities = await recordItemCreationActivities(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      cardId: id,
      actorId,
      checklist: checklist!,
      trees,
      assigneeNames: newItems.assigneeNames,
      recordCreated: false,
    });
    const automationEffects = await runCompletionAutomationsForNewItems(tx, card, ctx, actorId, parentItemId, items);
    return { checklist: checklist!, trees, activity, itemActivities, automationEffects };
  });

  const created: WireCardChecklist = { ...checklist, items: trees.map((tree) => tree.item) };
  return { card, created, trees, activity, itemActivities, automationEffects };
}

export async function emitCreatedChecklist(result: Awaited<ReturnType<typeof createChecklist>>) {
  const { card, created, trees, activity, itemActivities, automationEffects } = result;
  const id = card.id;
  await emitCardActivityFeedItem(card.boardId, id, activity);
  // The parent checklist event carries its items, so clients have each owning item before the
  // sub-checklist events that reference it by parentItemId arrive.
  await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId: card.boardId, cardId: id, checklist: created });
  await emitCreatedItemTrees(card, created, trees, itemActivities, { emitItems: false });
  await emitAutomationEffects(automationEffects);
}

export async function applyChecklistTemplatesToCard(params: { actorId: string; card: Card; ctx: CardAccess; templateIds: readonly string[] }) {
  const { actorId, card, ctx } = params;
  const id = card.id;
  const requestedTemplateIds = Array.from(new Set(params.templateIds));
  const applied = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [id]);
    const applied = await applyChecklistTemplates(tx, {
      cardId: id,
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      templateIds: requestedTemplateIds,
    });
    if (applied.length > 0) {
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    }
    return applied;
  });

  const appliedTemplateIds = new Set(applied.map((result) => result.templateId));
  return {
    card,
    applied,
    skippedTemplateIds: requestedTemplateIds.filter((templateId) => !appliedTemplateIds.has(templateId)),
  };
}

export async function emitAppliedChecklistTemplates(result: Awaited<ReturnType<typeof applyChecklistTemplatesToCard>>) {
  const { card } = result;
  for (const applied of result.applied) {
    await emitCardActivityFeedItem(card.boardId, card.id, applied.activity);
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, {
      boardId: card.boardId,
      cardId: card.id,
      checklist: applied.checklist,
    });
  }
}

export async function renameChecklist(params: { actorId: string; card: Card; ctx: CardAccess; current: Checklist; title: string }) {
  const { actorId, card, ctx, current, title } = params;
  const id = card.id;
  const checklistId = current.id;
  // Return the same checklist response shape without extending a rename burst on a retry.
  if (title === current.title) return { checklist: (await loadChecklistsForCard(id)).find((entry) => entry.id === checklistId)!, activity: null };

  return db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [id]);
    const [updated] = await tx
      .update(cardChecklists)
      .set({ title, updatedAt: new Date() })
      .where(eq(cardChecklists.id, checklistId))
      .returning();
    if (!updated) throw notFound("checklist not found");
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    const activity = await recordCoalescedActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_RENAMED,
      coalesceKey: `checklist:${checklistId}:title`,
      windowMs: 60_000,
      fromValue: current.title,
      toValue: title,
      payload: { checklistId, fromValue: current.title, toValue: title },
    });
    return { checklist: { ...updated!, items: (await loadChecklistsForCard(id, tx)).find((c) => c.id === checklistId)?.items ?? [] }, activity };
  });
}

export async function deleteChecklist(params: { actorId: string; card: Card; ctx: CardAccess; current: Checklist }) {
  const { actorId, card, ctx, current } = params;
  const id = card.id;
  const checklistId = current.id;
  const result = await db.transaction(async (tx) => {
    // Deleting an empty checklist is structural cleanup, not meaningful card activity. Capture
    // this before the cascade removes its items so only destructive deletions reach the feed and
    // notification fanout; the realtime deletion event is still emitted below for client sync.
    // Read the direct items before the cascade so the realtime event can carry the badge counts a
    // viewer without cached detail needs to subtract.
    await lockCardsForWrite(tx, [id]);
    const directItems = await tx
      .select({ completedAt: cardChecklistItems.completedAt })
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId));
    const hadItems = directItems.length > 0;
    const completedItemCount = directItems.filter((item) => item.completedAt).length;
    await tx.delete(cardChecklists).where(eq(cardChecklists.id, checklistId));
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    const mistakeCutoff = new Date(Date.now() - CHECKLIST_MISTAKE_WINDOW_MS);
    const [recentCreate] = await tx
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.boardId, card.boardId),
        eq(activityEvents.workspaceId, ctx.workspaceId),
        eq(activityEvents.actorId, actorId),
        eq(activityEvents.entityType, "card"),
        eq(activityEvents.entityId, id),
        eq(activityEvents.action, ACTIVITY_ACTION.CHECKLIST_CREATED),
        eq(activityEvents.feedVisible, true),
        gte(activityEvents.createdAt, mistakeCutoff),
        sql`${activityEvents.payload}->>'checklistId' = ${checklistId}`,
      ))
      .orderBy(desc(activityEvents.createdAt))
      .limit(1);

    if (recentCreate) {
      const [hiddenCreate] = await tx
        .update(activityEvents)
        .set({ feedVisible: false, updatedAt: new Date() })
        .where(eq(activityEvents.id, recentCreate.id))
        .returning();
      return { hiddenCreate: hiddenCreate!, deletedActivity: null, itemCount: directItems.length, completedItemCount };
    }

    if (!hadItems) return { hiddenCreate: null, deletedActivity: null, itemCount: 0, completedItemCount };

    const deletedActivity = await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CHECKLIST_DELETED,
      payload: { checklistId, title: current.title },
    });
    return { hiddenCreate: null, deletedActivity, itemCount: directItems.length, completedItemCount };
  });
  return { card, checklist: current, ...result };
}

export async function emitDeletedChecklist(result: Awaited<ReturnType<typeof deleteChecklist>>) {
  const { card, checklist } = result;
  const id = card.id;
  if (result.hiddenCreate) {
    await emitActivityFeedItemDeleted(card.boardId, id, result.hiddenCreate.id);
  } else if (result.deletedActivity) {
    await emitCardActivityFeedItem(card.boardId, id, result.deletedActivity);
  }
  await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_DELETED, {
    boardId: card.boardId,
    cardId: id,
    checklistId: checklist.id,
    checklistParentItemId: checklist.parentItemId,
    itemCount: result.itemCount,
    completedItemCount: result.completedItemCount,
  });
}

export async function moveChecklist(params: { card: Card; current: Checklist; body: dto.MoveChecklistBody }) {
  const { card, current, body } = params;
  const id = card.id;
  const checklistId = current.id;
  const prevPosition = current.position;

  const { position, rebalancedPositions } = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [id]);
    const { prev, next } = await neighbourChecklistPositions(id, current.parentItemId, body.afterChecklistId, body.beforeChecklistId, tx);
    const result = between(prev, next);
    let position = result.position;
    await tx.update(cardChecklists).set({ position, updatedAt: new Date() }).where(eq(cardChecklists.id, checklistId));
    await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    const rebalancedPositions = result.needsRebalance ? await rebalanceChecklists(id, current.parentItemId, tx) : null;
    if (rebalancedPositions) position = rebalancedPositions.find((p) => p.id === checklistId)?.position ?? position;
    return { position, rebalancedPositions };
  });
  return { card, checklistId, position, prevPosition, rebalancedPositions };
}

export async function emitChecklistMove(result: Awaited<ReturnType<typeof moveChecklist>>) {
  const { card, checklistId, position, prevPosition, rebalancedPositions } = result;
  const id = card.id;
  if (rebalancedPositions) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_REBALANCED, { boardId: card.boardId, cardId: id, positions: rebalancedPositions });
  await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_MOVED, { boardId: card.boardId, cardId: id, checklistId, position, prevPosition });
}
