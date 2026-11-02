import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardAssignees, cardChecklists, cardLabelAssignments, cards, users, type ActivityEvent } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { db, type Db, type Tx, type TxOnly } from "../../db.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { env } from "../../env.js";
import type { Mailer } from "../../lib/mailer.js";
import { assignedCardVisibility, assertCardAccess } from "../../lib/access.js";
import {
  emitActivityFeedItem,
  emitActivityFeedItemDeleted,
  emitActivityFeedItemUpdated,
  recordCoalescedActivity,
  type CoalescedActivityResult,
} from "../../lib/activity.js";
import { enqueueCardAssignedEmails } from "../../lib/assignee-email-notifications.js";
import { EMPTY_EFFECTS, emitAutomationEffects, runCardAssignedAutomations, runCardLabelSetAutomations, runCardMarkedCompleteAutomations, runCardBlockedAutomations, runCardUnblockedAutomations, runChecklistCompletionAutomations, type AutomationEffects } from "../../lib/automations.js";
import { invalidateQueuesForCards } from "../../lib/card-priority-invalidation.js";
import { positionForLaneInsert } from "../../lib/board-lane.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { clearOverdueNotificationsForCards, syncDirectNotificationForActivity } from "../../lib/notifications.js";
import { createOverdueNotificationsForCards } from "../../lib/overdue-notifications.js";
import {
  checklistValidationError,
  collectAssignees,
  hasDueDates,
  type CreatedItemTree,
  type IssuePath,
  type ItemCreationActivities,
  type NewItem as NewChecklistTreeItem,
} from "./checklist-tree.js";
import { emitToBoard } from "../../realtime/emit.js";
import { toWireCard } from "../../lib/wire-card.js";
import { requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { ensureBoardMembershipForUsers } from "../../lib/card-assignment.js";
import { clearRemindersOnCompletedCards, emitClearedCardReminders, type ClearedCardReminder } from "../../lib/card-follow.js";
import { captureUnblockedDependents, captureBlockedDependents, emitDependentsChanged, emitRelationNeighboursChanged } from "../../lib/card-relations.js";
import { notifyDependencyHandoffs, recordBlockersCleared, type DependencyHandoff } from "../../lib/dependency-notifications.js";
import type { AuthClaims } from "../../auth/plugin.js";

const CARD_ASSIGNEE_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

const CARD_LABEL_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export async function emitCardActivityFeedItem(boardId: string, cardId: string, activity: ActivityEvent, options?: { notify?: boolean }) {
  await emitActivityFeedItem(boardId, cardId, activity, options);
}

export async function emitCoalescedCardActivityFeedItem(boardId: string, cardId: string, result: CoalescedActivityResult, options?: { notify?: boolean }) {
  // Coalesced activity may update or remove an existing visible feed item
  // instead of always appending a new one.
  const previousBoardId = result.previousBoardId ?? boardId;
  const movedBoards = previousBoardId !== boardId;
  if (result.status === "created") await emitActivityFeedItem(boardId, cardId, result.activity, options);
  else if (result.status === "updated") {
    if (movedBoards) {
      await emitActivityFeedItemDeleted(previousBoardId, cardId, result.activity.id);
      await emitActivityFeedItem(boardId, cardId, result.activity, options);
    } else {
      await emitActivityFeedItemUpdated(boardId, cardId, result.activity, options);
    }
  } else await emitActivityFeedItemDeleted(previousBoardId, cardId, result.activity.id);
}

/**
 * Loads a card for a mutation: 404 when it does not exist, then the editor-role access check. Callers
 * still call `assertCardActive` themselves where archived cards must be rejected, so the two routes
 * that deliberately operate on archived cards (archive/unarchive) read the same way.
 */
export async function loadEditableCard(auth: AuthClaims, id: string) {
  const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
  if (!card) throw notFound();
  const ctx = await assertCardAccess(auth, card, "editor");
  return { card, ctx };
}

/** A checklist that belongs to the given card, or null. Both ids must match so a checklist id cannot be used across cards. */
export async function loadChecklistForCard(id: string, checklistId: string) {
  const [checklist] = await db
    .select()
    .from(cardChecklists)
    .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
    .limit(1);
  return checklist ?? null;
}

export async function actorTimezone(userId: string): Promise<string> {
  return (await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1))[0]?.timezone ?? "UTC";
}

/**
 * Pre-write checks for items created through any checklist route: every assignee must be an
 * assignable board member (reported at the first item that names them), and due dates capture the
 * acting user's timezone exactly as an item PATCH would.
 */
export async function prepareNewChecklistItems(
  boardId: string,
  workspaceId: string,
  actorId: string,
  items: readonly NewChecklistTreeItem[],
  itemPath: (index: number) => IssuePath,
): Promise<{ assigneeNames: Map<string, string | null>; timezone: string | null }> {
  const assignees = collectAssignees(items, itemPath);
  const assigneeIds = [...assignees.keys()];
  const eligible = new Set(await ensureBoardMembershipForUsers(boardId, assigneeIds));
  for (const [userId, path] of assignees) {
    if (!eligible.has(userId)) throw checklistValidationError(path, "assignee is not an assignable (non-observer) member of this board");
  }
  const assigneeNames = new Map<string, string | null>();
  if (assigneeIds.length > 0) {
    const rows = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, assigneeIds));
    for (const row of rows) assigneeNames.set(row.id, row.displayName);
  }
  return { assigneeNames, timezone: hasDueDates(items) ? await actorTimezone(actorId) : null };
}

// Items may be created already complete. When that leaves every top-level item on the card done,
// the "all checklist items complete" automation fires exactly as if the last item had been ticked.
export async function runCompletionAutomationsForNewItems(
  tx: Tx,
  card: Pick<typeof cards.$inferSelect, "id" | "boardId">,
  ctx: { workspaceId: string; clientId: string },
  actorId: string,
  checklistParentItemId: string | null,
  items: readonly NewChecklistTreeItem[],
): Promise<AutomationEffects> {
  if (checklistParentItemId !== null || !items.some((item) => item.completed)) return EMPTY_EFFECTS;
  return runChecklistCompletionAutomations(tx, {
    cardId: card.id,
    boardId: card.boardId,
    workspaceId: ctx.workspaceId,
    clientId: ctx.clientId,
    triggerActorId: actorId,
  });
}

/**
 * Post-commit fanout for created items. Item events precede the sub-checklist events that point at
 * them, and audit rows are emitted without watcher notifications so a large plan does not page
 * every watcher once per row; assignees still receive their direct "assigned" notification.
 */
export async function emitCreatedItemTrees(
  card: Pick<typeof cards.$inferSelect, "id" | "boardId" | "title" | "listId">,
  checklist: { id: string; parentItemId: string | null },
  trees: readonly CreatedItemTree[],
  activities: ItemCreationActivities,
  options: { emitItems: boolean },
) {
  for (const tree of trees) {
    if (options.emitItems) {
      await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, {
        boardId: card.boardId,
        cardId: card.id,
        cardTitle: card.title,
        listId: card.listId,
        checklistId: checklist.id,
        checklistParentItemId: checklist.parentItemId,
        item: tree.item,
      });
    }
    for (const subChecklist of tree.subChecklists) {
      await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId: card.boardId, cardId: card.id, checklist: subChecklist });
    }
  }
  for (const activity of [...activities.created, ...activities.subChecklistsCreated, ...activities.dueDates]) {
    await emitCardActivityFeedItem(card.boardId, card.id, activity, { notify: false });
  }
  for (const { activity, assigneeId } of activities.assigned) {
    await emitCardActivityFeedItem(card.boardId, card.id, activity, { notify: false });
    void syncDirectNotificationForActivity({ userId: assigneeId, activity, reason: "assigned" }).catch(() => undefined);
  }
}

export async function topPositionForList(boardId: string, listId: string, tx: Tx = db): Promise<string> {
  return (await positionForLaneInsert({ boardId, listId, afterItem: null, tx })).position;
}

export function orderedUniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

export async function loadBulkBoardCards(boardId: string, cardIds: readonly string[], assignedUserId?: string) {
  const uniqueIds = orderedUniqueIds(cardIds);
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.boardId, boardId), inArray(cards.id, uniqueIds), assignedUserId ? assignedCardVisibility(assignedUserId) : undefined));
  const byId = new Map(rows.map((card) => [card.id, card]));
  const missingIds = uniqueIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) throw badRequest("one or more card ids are not in this board");
  return uniqueIds
    .map((id) => byId.get(id))
    .filter((card): card is typeof cards.$inferSelect => Boolean(card));
}

export function activeBulkCards(rows: readonly (typeof cards.$inferSelect)[]) {
  return {
    cards: rows.filter((card) => !card.archivedAt),
    skippedCardIds: rows.filter((card) => card.archivedAt).map((card) => card.id),
  };
}

type CardAssignmentContext = {
  cardId: string;
  boardId: string;
  workspaceId: string;
  clientId: string;
  actorId: string;
  previousIds: string[];
  nextIds: string[];
  bulk?: true;
};

export type CardLabelsWrite = {
  cardId: string;
  boardId: string;
  labelIds: string[];
  activity: CoalescedActivityResult;
  automationEffects: AutomationEffects;
};

export async function applyCardLabels(
  tx: TxOnly,
  opts: CardAssignmentContext & { labelNames: string[]; labelNamesById: Record<string, string> },
): Promise<CardLabelsWrite> {
  const previousSet = new Set(opts.previousIds);
  const nextSet = new Set(opts.nextIds);
  const addedLabelIds = opts.nextIds.filter((labelId) => !previousSet.has(labelId));
  const removedLabelIds = opts.previousIds.filter((labelId) => !nextSet.has(labelId));
  const fromValue = sortedIds(opts.previousIds);
  const toValue = sortedIds(opts.nextIds);
  await tx.delete(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, opts.cardId));
  if (opts.nextIds.length > 0) await tx.insert(cardLabelAssignments).values(opts.nextIds.map((labelId) => ({ cardId: opts.cardId, labelId })));
  const activity = await recordCoalescedActivity(tx, {
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    actorId: opts.actorId,
    entityType: "card",
    entityId: opts.cardId,
    action: ACTIVITY_ACTION.LABELS_SET,
    coalesceKey: "card:labels",
    windowMs: CARD_LABEL_MISTAKE_WINDOW_MS,
    fromValue,
    toValue,
    payload: {
      labelIds: opts.nextIds,
      labelNames: opts.labelNames,
      addedLabelNames: addedLabelIds.map((labelId) => opts.labelNamesById[labelId]).filter((name): name is string => Boolean(name)),
      removedLabelNames: removedLabelIds.map((labelId) => opts.labelNamesById[labelId]).filter((name): name is string => Boolean(name)),
      labelNamesById: opts.labelNamesById,
      fromValue,
      toValue,
      ...(opts.bulk ? { bulk: true } : {}),
    },
  });
  // Only additions trigger rules; automation label effects intentionally do not cascade.
  const automationEffects = await runCardLabelSetAutomations(tx, {
    cardId: opts.cardId,
    addedLabelIds,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    triggerActorId: opts.actorId,
  });
  return { cardId: opts.cardId, boardId: opts.boardId, labelIds: opts.nextIds, activity, automationEffects };
}

export async function emitCardLabels(rows: readonly CardLabelsWrite[]): Promise<void> {
  for (const update of rows) {
    await emitToBoard(update.boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId: update.boardId, cardId: update.cardId, labelIds: update.labelIds });
    await emitCoalescedCardActivityFeedItem(update.boardId, update.cardId, update.activity);
    await emitAutomationEffects(update.automationEffects);
  }
  // Related cards show these labels in their Dependencies section.
  await emitRelationNeighboursChanged(rows.map((update) => update.cardId));
}

export type CardAssigneesWrite = {
  cardId: string;
  boardId: string;
  assigneeIds: string[];
  addedUserIds: string[];
  activity: CoalescedActivityResult;
  automationEffects: AutomationEffects;
};

export async function applyCardAssignees(
  tx: TxOnly,
  opts: CardAssignmentContext & { assigneeNamesById: Record<string, string> },
): Promise<CardAssigneesWrite> {
  const previousSet = new Set(opts.previousIds);
  const nextSet = new Set(opts.nextIds);
  const addedUserIds = opts.nextIds.filter((userId) => !previousSet.has(userId));
  const removedUserIds = opts.previousIds.filter((userId) => !nextSet.has(userId));
  const fromValue = sortedIds(opts.previousIds);
  const toValue = sortedIds(opts.nextIds);
  await tx.delete(cardAssignees).where(eq(cardAssignees.cardId, opts.cardId));
  if (opts.nextIds.length > 0) await tx.insert(cardAssignees).values(opts.nextIds.map((userId) => ({ cardId: opts.cardId, userId })));
  const activity = await recordCoalescedActivity(tx, {
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    actorId: opts.actorId,
    entityType: "card",
    entityId: opts.cardId,
    action: ACTIVITY_ACTION.ASSIGNEES_SET,
    coalesceKey: "card:assignees",
    windowMs: CARD_ASSIGNEE_MISTAKE_WINDOW_MS,
    fromValue,
    toValue,
    payload: {
      assigneeIds: opts.nextIds,
      addedAssigneeNames: addedUserIds.map((userId) => opts.assigneeNamesById[userId]).filter((name): name is string => Boolean(name)),
      removedAssigneeNames: removedUserIds.map((userId) => opts.assigneeNamesById[userId]).filter((name): name is string => Boolean(name)),
      assigneeNamesById: opts.assigneeNamesById,
      fromValue,
      toValue,
      ...(opts.bulk ? { bulk: true } : {}),
    },
  });
  // Unchanged and removed assignees must not replay assignment-triggered actions.
  const automationEffects = await runCardAssignedAutomations(tx, {
    cardId: opts.cardId,
    addedUserIds,
    boardId: opts.boardId,
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    triggerActorId: opts.actorId,
  });
  return { cardId: opts.cardId, boardId: opts.boardId, assigneeIds: opts.nextIds, addedUserIds, activity, automationEffects };
}

export async function emitCardAssignees(rows: readonly CardAssigneesWrite[], mailer: FastifyInstance["mailer"], actorId: string): Promise<void> {
  for (const update of rows) {
    await enqueueCardAssignedEmails({
      tx: db,
      mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: update.cardId,
      actorId,
      recipientUserIds: update.addedUserIds,
    });
    await emitToBoard(update.boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId: update.boardId, cardId: update.cardId, assigneeIds: update.assigneeIds });
    await emitCoalescedCardActivityFeedItem(update.boardId, update.cardId, update.activity);
    await emitAutomationEffects(update.automationEffects);
  }
  // Assignment changes alter live "Up next" visibility without touching queue rows.
  await invalidateQueuesForCards(rows.map((update) => update.cardId));
  // Related cards show these assignees in their Dependencies section.
  await emitRelationNeighboursChanged(rows.map((update) => update.cardId));
}

export type CardCompletionWrite = {
  card: typeof cards.$inferSelect;
  finalCard: typeof cards.$inferSelect;
  activity: CoalescedActivityResult;
  automationEffects: AutomationEffects;
  clearedReminders: ClearedCardReminder[];
  handoffs: DependencyHandoff[];
};

/**
 * Flip one card's completion inside a transaction, with the full side-effect tail.
 *
 * Three routes complete cards — one card, a selection, or a whole list — and every one of them
 * owes the same four things: the write, a coalescable `completion:set` audit row, the overdue
 * notification swing, and the `card_marked_complete` automations. Keeping that tail in one place
 * is not cosmetic; the whole-list route previously recorded a different action, so the same user
 * action rendered two ways in the feed depending on which control performed it.
 *
 * `fromValue` comes from the caller's pre-write row, so a burst of toggles inside the coalesce
 * window collapses to a single "A -> C" entry and a round-trip back to the original value hides
 * itself from the feed.
 */
/** Bulk completion repeats applyCardCompletion per card; its per-card locks must not interleave. */
export async function lockCompletionBatch(tx: TxOnly, workspaceId: string, cardIds: string[], completed: boolean): Promise<void> {
  const blocked = await captureBlockedDependents(tx, workspaceId, cardIds);
  const ready = completed ? [] : await captureUnblockedDependents(tx, workspaceId, cardIds);
  await lockCardsForWrite(tx, [...cardIds, ...blocked.map((row) => row.dependentId), ...ready]);
}

export async function applyCardCompletion(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  opts: {
    card: Pick<typeof cards.$inferSelect, "id" | "boardId" | "completedAt">;
    completed: boolean;
    completedAt: Date | null;
    workspaceId: string;
    clientId: string;
    actorId: string;
  },
): Promise<CardCompletionWrite> {
  const { card: current, completed, completedAt } = opts;
  const before = await captureBlockedDependents(tx, opts.workspaceId, [current.id]);
  const readyBefore = completed ? [] : await captureUnblockedDependents(tx, opts.workspaceId, [current.id]);
  // The handoff below writes activity on every dependent; hold them with this card in one order.
  await lockCardsForWrite(tx, [current.id, ...before.map((row) => row.dependentId), ...readyBefore]);
  const [card] = await tx
    .update(cards)
    .set({ completedAt, updatedAt: new Date() })
    .where(eq(cards.id, current.id))
    .returning();
  // A completed card leaves the schedule and releases its dependents; reopening holds them again.
  await requestScheduleRecheckForCards(tx, [current.id]);
  const activity = await recordCoalescedActivity(tx, {
    boardId: current.boardId,
    workspaceId: opts.workspaceId,
    actorId: opts.actorId,
    entityType: "card",
    entityId: current.id,
    action: ACTIVITY_ACTION.COMPLETION_SET,
    coalesceKey: "card:completion",
    windowMs: 60_000,
    fromValue: Boolean(current.completedAt),
    toValue: completed,
    payload: { completedAt, fromValue: Boolean(current.completedAt), toValue: completed },
  });
  if (completed) await clearOverdueNotificationsForCards(tx, [current.id]);
  else await createOverdueNotificationsForCards(tx, [current.id]);
  const clearedReminders = completed ? await clearRemindersOnCompletedCards(tx, [current.id]) : [];
  // Completing this card may clear the last blocker of cards that wait on it. The handoff is
  // recorded first so the dependent's feed reads "unblocked" before any automation it triggers.
  // Reopening it blocks those cards again; that handoff is recorded by the blocked runner.
  const handoffs: DependencyHandoff[] = completed
    ? await recordBlockersCleared(tx, { before, actorId: opts.actorId })
    : [];
  let unblockedEffects: AutomationEffects;
  if (completed) {
    unblockedEffects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId: opts.workspaceId, clientId: opts.clientId, triggerActorId: opts.actorId });
  } else {
    const run = await runCardBlockedAutomations(tx, { cardIds: readyBefore, workspaceId: opts.workspaceId, clientId: opts.clientId, triggerActorId: opts.actorId, blocker: card! });
    handoffs.push(...run.handoffs);
    unblockedEffects = run;
  }
  const markedCompleteEffects = completed
    ? await runCardMarkedCompleteAutomations(tx, {
      cardId: current.id,
      boardId: current.boardId,
      workspaceId: opts.workspaceId,
      clientId: opts.clientId,
      triggerActorId: opts.actorId,
    })
    : { effects: [] };
  const automationEffects: AutomationEffects = { effects: [...markedCompleteEffects.effects, ...unblockedEffects.effects] };
  // Automations can mutate the card further (move it, complete a parent), so the response must
  // report the row as it stands after they ran. Only re-read when something actually fired: a
  // workspace with no completion automations is the common case, and a whole-list completion
  // would otherwise pay one extra point query per card for a row it already holds.
  const [finalCard] = automationEffects.effects.length > 0
    ? await tx.select().from(cards).where(eq(cards.id, current.id)).limit(1)
    : [card];
  return { card: card!, finalCard: finalCard ?? card!, activity, automationEffects, clearedReminders, handoffs };
}

/** Post-commit fanout for `applyCardCompletion`, including the queue audiences board rooms miss. */
export async function emitCardCompletion(
  rows: readonly CardCompletionWrite[],
  opts: { clientId: string; completed: boolean; mailer: Mailer; log: FastifyBaseLogger },
): Promise<void> {
  for (const { card, activity, automationEffects, clearedReminders } of rows) {
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: card.boardId, card: toWireCard(card, opts.clientId) });
    emitClearedCardReminders(clearedReminders);
    await emitCoalescedCardActivityFeedItem(card.boardId, card.id, activity, { notify: opts.completed });
    await emitAutomationEffects(automationEffects);
  }
  // Completing or reopening a blocker flips the Blocked badge on the cards it blocks, which may be
  // on other boards and whose rows did not change.
  await emitDependentsChanged(rows.map(({ card }) => card.id), opts.clientId);
  await notifyDependencyHandoffs({ handoffs: rows.flatMap((row) => row.handoffs), mailer: opts.mailer, webOrigin: env.WEB_ORIGIN })
    .catch((err: unknown) => opts.log.warn({ err }, "failed to send blockers-cleared notifications"));
  // Completion moves cards in and out of "Up next" queues without touching their rows, so the
  // queue audiences must be pinged separately from the board rooms above.
  await invalidateQueuesForCards(rows.map(({ card }) => card.id));
}
