import { dto } from "@kanera/shared";
import { cardPath } from "@kanera/shared/card-links";
import { SERVER_EVENTS, type WireCard, type WireCardChecklist, type WireCardDetail } from "@kanera/shared/events";
import { ACTIVITY_ACTION, activityEvents, boardMembers, cardAssignees, cardAttachments, cardChecklistItems, cardChecklists, cardChecklistTemplateApplications, cardCustomFieldValues, cardLabelAssignments, cardLabels, cards, cardWatchers, customFields, lists, users, type ActivityEvent } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { env } from "../../env.js";
import { assignedCardVisibility, assertBatchCardVisibility, assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import {
  emitActivityFeedItem,
  emitActivityFeedItemDeleted,
  emitActivityFeedItemUpdated,
  recordActivity,
  recordCoalescedActivity,
  type CoalescedActivityResult,
} from "../../lib/activity.js";
import { enqueueCardAssignedEmails, enqueueDueDateChangedEmails } from "../../lib/assignee-email-notifications.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { EMPTY_EFFECTS, emitAutomationEffects, runCardAssignedAutomations, runCardLabelSetAutomations, runCardMarkedCompleteAutomations, runChecklistCompletionAutomations, runListEntryAutomations, type AutomationEffects } from "../../lib/automations.js";
import { invalidateQueuesForCards } from "../../lib/card-priority-invalidation.js";
import { applyChecklistTemplates } from "../../lib/checklist-templates.js";
import { emitLaneRebalanced, positionForLaneInsert, rebalanceBoardLane } from "../../lib/board-lane.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { assertValidOptionIds, assertWorkspaceMemberIds, buildCustomFieldValueColumns, customFieldValueEquals, describeCustomFieldValue, emptyValueColumns, hasCustomFieldValue, type CustomFieldValueColumns } from "../../lib/custom-fields.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { allocateCardKeys, resolveCardKey } from "../../lib/card-keys.js";
import { externalEmbeddedMediaReferences, signedAvatarUrl, signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { clearNotificationsForCards, clearOverdueChecklistItemNotifications, clearOverdueNotificationsForCards, emitDeletedNotifications, emitRelocatedNotifications, relocateNotificationsForCard, syncDirectNotificationForActivity } from "../../lib/notifications.js";
import { createOverdueNotificationsForCards } from "../../lib/overdue-notifications.js";
import { between } from "../../lib/position.js";
import { emitToBoard } from "../../realtime/emit.js";
import { loadLinkedNotesForCard, repairInternalLinksAroundCard, replaceInternalLinksForSource } from "../../lib/internal-links.js";
import { assertGlobalWorkSeparatorContext, positionForGlobalWorkLaneInsert } from "../global-work-separators/routes.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const CHECKLIST_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const CARD_ASSIGNEE_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const CARD_LABEL_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
function assertCardActive(card: Pick<typeof cards.$inferSelect, "archivedAt">) {
  if (card.archivedAt) throw badRequest("archived cards are read-only");
}

function assertIntegrationEmbeddedMediaStoredLocally(markdown: string | null | undefined, clientId: string, authKind?: string) {
  if (authKind !== "apiKey") return;
  const externalRefs = externalEmbeddedMediaReferences(markdown, clientId);
  if (externalRefs.length > 0) {
    throw badRequest("inline media from integrations must be uploaded to Kanera before embedding");
  }
}

function shouldAutoWatchAuthoredCards(authKind: AuthClaims["authKind"]) {
  return authKind !== "apiKey";
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function emitCardActivityFeedItem(boardId: string, cardId: string, activity: ActivityEvent, options?: { notify?: boolean }) {
  await emitActivityFeedItem(boardId, cardId, activity, options);
}

async function emitCoalescedCardActivityFeedItem(boardId: string, cardId: string, result: CoalescedActivityResult, options?: { notify?: boolean }) {
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

function cardUrl(organisationKey: string, cardKey: string): string {
  return new URL(cardPath(organisationKey, cardKey), env.WEB_ORIGIN).toString();
}

function toWireCard(card: typeof cards.$inferSelect, clientId: string): WireCard {
  const { clientToken: _clientToken, ...publicCard } = card;
  return {
    ...publicCard,
    description: signEmbeddedMediaUrls(card.description, clientId),
    url: cardUrl(card.organisationKey, card.key),
  };
}

async function ensureBoardMembershipForUsers(
  boardId: string,
  workspaceId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  // Only explicit, non-observer board members can own work. Board membership is the access model,
  // so assignment never auto-adds anyone: a workspace member who is not on the board is ineligible
  // until an admin adds them. Observers can watch and be notified but cannot be card owners.
  const existingMembers = await db
    .select({ userId: boardMembers.userId, role: boardMembers.role })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), inArray(boardMembers.userId, userIds)));
  const eligible = new Set(existingMembers.filter((m) => m.role !== "observer").map((m) => m.userId));
  return userIds.filter((uid) => eligible.has(uid));
}

async function bottomPositionForList(boardId: string, listId: string): Promise<string> {
  return (await positionForLaneInsert({ boardId, listId, beforeItem: null })).position;
}

async function topPositionForList(boardId: string, listId: string, tx: Tx = db): Promise<string> {
  return (await positionForLaneInsert({ boardId, listId, afterItem: null, tx })).position;
}

function orderedUniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

// Upper bound on comments serialized per card by the bounded content-query endpoint. Chosen to
// comfortably cover normal card discussions while keeping a 200-card response bounded; cards that
// exceed it are flagged so callers page the full history via GET /cards/{id}/comments instead.
const CONTENT_QUERY_COMMENT_CAP = 250;
// Keep the aggregate query and serialized comment bodies bounded even when all 200 selected cards
// have unusually large histories. Per-card totals from the ranked query still let callers identify
// every truncated card and page it through the dedicated comments endpoint.
const CONTENT_QUERY_GLOBAL_COMMENT_CAP = 500;
const CONTENT_QUERY_COMMENT_BODY_BUDGET_BYTES = 4 * 1024 * 1024;

type ContentQueryCommentRow = {
  id: string;
  cardId: string;
  authorId: string;
  authorKind: "user" | "apiKey" | "system";
  apiKeyId: string | null;
  apiKeyName: string | null;
  authorName: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
  totalCount: number;
};

async function loadBulkBoardCards(boardId: string, cardIds: readonly string[], assignedUserId?: string) {
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

function activeBulkCards(rows: readonly (typeof cards.$inferSelect)[]) {
  return {
    cards: rows.filter((card) => !card.archivedAt),
    skippedCardIds: rows.filter((card) => card.archivedAt).map((card) => card.id),
  };
}

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

async function rebalanceChecklists(cardId: string, parentItemId: string | null, tx: Tx = db) {
  const siblingScope = parentItemId === null
    ? and(eq(cardChecklists.cardId, cardId), isNull(cardChecklists.parentItemId))
    : and(eq(cardChecklists.cardId, cardId), eq(cardChecklists.parentItemId, parentItemId));
  const rows = await tx
    .select({ id: cardChecklists.id })
    .from(cardChecklists)
    .where(siblingScope)
    .orderBy(asc(cardChecklists.position));
  const positions = rows.map((row, index) => ({ id: row.id, position: ((index + 1) * 1000).toFixed(10) }));
  await Promise.all(positions.map((row) =>
    tx.update(cardChecklists).set({ position: row.position, updatedAt: new Date() }).where(eq(cardChecklists.id, row.id)),
  ));
  return positions;
}

async function rebalanceChecklistItems(checklistId: string, tx: Tx = db) {
  const rows = await tx
    .select({ id: cardChecklistItems.id })
    .from(cardChecklistItems)
    .where(eq(cardChecklistItems.checklistId, checklistId))
    .orderBy(asc(cardChecklistItems.position));
  const positions = rows.map((row, index) => ({ id: row.id, position: ((index + 1) * 1000).toFixed(10) }));
  await Promise.all(positions.map((row) =>
    tx.update(cardChecklistItems).set({ position: row.position, updatedAt: new Date() }).where(eq(cardChecklistItems.id, row.id)),
  ));
  return positions;
}

async function loadChecklistsForCards(cardIds: readonly string[], tx: Tx = db): Promise<Map<string, WireCardChecklist[]>> {
  const [checklistRows, itemRows] = await Promise.all([
    tx.select().from(cardChecklists).where(inArray(cardChecklists.cardId, cardIds)).orderBy(asc(cardChecklists.cardId), asc(cardChecklists.position)),
    tx
      .select({
        item: cardChecklistItems,
        checklistId: cardChecklistItems.checklistId,
      })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .where(inArray(cardChecklists.cardId, cardIds))
      .orderBy(asc(cardChecklists.cardId), asc(cardChecklists.position), asc(cardChecklistItems.position)),
  ]);
  const itemsByChecklist = new Map<string, typeof cardChecklistItems.$inferSelect[]>();
  for (const row of itemRows) {
    const items = itemsByChecklist.get(row.checklistId);
    if (items) items.push(row.item);
    else itemsByChecklist.set(row.checklistId, [row.item]);
  }
  const checklistsByCard = new Map<string, WireCardChecklist[]>();
  for (const checklist of checklistRows) {
    const checklists = checklistsByCard.get(checklist.cardId) ?? [];
    checklists.push({ ...checklist, items: itemsByChecklist.get(checklist.id) ?? [] });
    checklistsByCard.set(checklist.cardId, checklists);
  }
  return checklistsByCard;
}

async function loadChecklistsForCard(cardId: string, tx: Tx = db): Promise<WireCardChecklist[]> {
  return (await loadChecklistsForCards([cardId], tx)).get(cardId) ?? [];
}

import {
  duplicateCardInto,
  emitDuplicatedCardIntoBoard,
  resolveDuplicateTargetList,
} from "./duplicate-card.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;


type CardCompletionWrite = {
  card: typeof cards.$inferSelect;
  finalCard: typeof cards.$inferSelect;
  activity: CoalescedActivityResult;
  automationEffects: AutomationEffects;
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
async function applyCardCompletion(
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
  const [card] = await tx
    .update(cards)
    .set({ completedAt, updatedAt: new Date() })
    .where(eq(cards.id, current.id))
    .returning();
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
  const automationEffects = completed
    ? await runCardMarkedCompleteAutomations(tx, {
      cardId: current.id,
      boardId: current.boardId,
      workspaceId: opts.workspaceId,
      clientId: opts.clientId,
      triggerActorId: opts.actorId,
    })
    : { effects: [] };
  // Automations can mutate the card further (move it, complete a parent), so the response must
  // report the row as it stands after they ran. Only re-read when something actually fired: a
  // workspace with no completion automations is the common case, and a whole-list completion
  // would otherwise pay one extra point query per card for a row it already holds.
  const [finalCard] = automationEffects.effects.length > 0
    ? await tx.select().from(cards).where(eq(cards.id, current.id)).limit(1)
    : [card];
  return { card: card!, finalCard: finalCard ?? card!, activity, automationEffects };
}

/** Post-commit fanout for `applyCardCompletion`, including the queue audiences board rooms miss. */
async function emitCardCompletion(
  rows: readonly CardCompletionWrite[],
  opts: { clientId: string; completed: boolean },
): Promise<void> {
  for (const { card, activity, automationEffects } of rows) {
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: card.boardId, card: toWireCard(card, opts.clientId) });
    await emitCoalescedCardActivityFeedItem(card.boardId, card.id, activity, { notify: opts.completed });
    await emitAutomationEffects(automationEffects);
  }
  // Completion moves cards in and out of "Up next" queues without touching their rows, so the
  // queue audiences must be pinged separately from the board rooms above.
  await invalidateQueuesForCards(rows.map(({ card }) => card.id));
}

export async function cardRoutes(
  app: FastifyInstance,
  options: { allowGlobalWorkLayoutMoves?: boolean } = {},
) {
  app.addHook("preHandler", app.authenticate);

  app.get("/organisations/:organisationKey/cards/by-key/:key", async (req) => {
    const { organisationKey, key } = req.params as { organisationKey: string; key: string };
    const card = await resolveCardKey(db, organisationKey, key);
    if (!card) throw notFound();
    try {
      // resolveCardKey already returned the board id, so this needs no second card read.
      await assertCardAccess(req.auth, card);
    } catch (error) {
      // Key lookup is intentionally non-disclosing: callers cannot distinguish an inaccessible
      // card from an identity that was never allocated.
      if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404)) throw notFound();
      throw error;
    }
    return { ...card, url: cardUrl(card.organisationKey, card.key) };
  });

  app.get("/cards/:id/detail", async (req): Promise<WireCardDetail> => {
    const { id } = req.params as { id: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    // The row is already in hand; passing it skips a redundant re-read of its board_id.
    const ctx = await assertCardAccess(req.auth, card);
    // Healing with the viewer's claims can reveal links the author could not record, but its
    // workspace-wide note scan must not block this read; the next open can consume the repair.
    void repairInternalLinksAroundCard(req.auth, id, ctx.workspaceId).catch((err: unknown) =>
      req.log.warn({ err, cardId: id }, "failed to repair internal links around card"),
    );

    const [customFieldValues, labelAssignments, assignees, attachments, checklists, appliedTemplateRows, linkedNotes] = await Promise.all([
      db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, id)),
      db
        .select({ labelId: cardLabelAssignments.labelId })
        .from(cardLabelAssignments)
        .where(eq(cardLabelAssignments.cardId, id)),
      db
        .select({ userId: cardAssignees.userId })
        .from(cardAssignees)
        .where(eq(cardAssignees.cardId, id)),
      db
        .select({
          id: cardAttachments.id,
          cardId: cardAttachments.cardId,
          fileName: cardAttachments.fileName,
          mimeType: cardAttachments.mimeType,
          byteSize: cardAttachments.byteSize,
          url: cardAttachments.url,
          fileKey: cardAttachments.fileKey,
          thumbnailUrl: cardAttachments.thumbnailUrl,
          thumbnailFileKey: cardAttachments.thumbnailFileKey,
          createdAt: cardAttachments.createdAt,
          uploadedById: cardAttachments.uploadedById,
          uploadedByName: users.displayName,
          uploadedByAvatarUrl: users.avatarUrl,
          uploadedByClientId: users.clientId,
          source: cardAttachments.source,
          commentId: cardAttachments.commentId,
        })
        .from(cardAttachments)
        .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
        .where(eq(cardAttachments.cardId, id))
        .orderBy(desc(cardAttachments.createdAt)),
      loadChecklistsForCard(id),
      db
        .select({ templateId: cardChecklistTemplateApplications.templateId })
        .from(cardChecklistTemplateApplications)
        .where(eq(cardChecklistTemplateApplications.cardId, id)),
      loadLinkedNotesForCard(req.auth, id, ctx.workspaceId),
    ]);

    return {
      card: toWireCard(card, req.auth.cid),
      customFieldValues,
      labelIds: labelAssignments.map((assignment) => assignment.labelId),
      assigneeIds: assignees.map((assignee) => assignee.userId),
      attachments: attachments.map(({ uploadedByClientId, uploadedByAvatarUrl, ...attachment }) => ({
        ...shapeAttachmentMedia(attachment),
        uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
      })),
      checklists,
      appliedChecklistTemplateIds: appliedTemplateRows.map((row) => row.templateId),
      linkedNotes,
    };
  });

  app.post("/boards/:boardId/cards/content/query", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.selectedCardContentQueryBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId);
    const requestedIds = orderedUniqueIds(body.cardIds);

    // Best-effort read: unlike the bulk mutations, a bounded audit/migration fetch should not fail
    // the whole batch because a single id was moved off the board or deleted since the caller last
    // read it. Ids that are not on this board (or not visible under assignedItemsOnly) are reported
    // in missingCardIds so an integration correlating by index can reconcile without a retry.
    const cardRows = await db
      .select()
      .from(cards)
      .where(and(
        eq(cards.boardId, boardId),
        inArray(cards.id, requestedIds),
        ctx.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined,
      ));
    const cardById = new Map(cardRows.map((card) => [card.id, card]));
    const selectedCards = requestedIds
      .map((id) => cardById.get(id))
      .filter((card): card is typeof cards.$inferSelect => Boolean(card));
    const missingCardIds = requestedIds.filter((id) => !cardById.has(id));
    const cardIds = selectedCards.map((card) => card.id);

    const [checklistsByCard, commentResult] = await Promise.all([
      loadChecklistsForCards(cardIds),
      cardIds.length === 0
        ? Promise.resolve({ rows: [] as ContentQueryCommentRow[] })
        : db.execute<ContentQueryCommentRow>(sql`
          with ranked_comments as (
            select
              c.id,
              c.card_id as "cardId",
              c.author_id as "authorId",
              c.author_kind as "authorKind",
              c.api_key_id as "apiKeyId",
              c.api_key_name as "apiKeyName",
              case
                when c.author_kind = 'system' then 'Kanera'
                when c.author_kind = 'apiKey' then coalesce(c.api_key_name, 'API key')
                else u.display_name
              end as "authorName",
              c.body,
              c.edited_at as "editedAt",
              c.created_at as "createdAt",
              count(*) over (partition by c.card_id)::integer as "totalCount",
              row_number() over (partition by c.card_id order by c.created_at, c.id) as comment_rank
            from comment c
            inner join "user" u on u.id = c.author_id
            where c.card_id in (${sql.join(cardIds.map((cardId) => sql`${cardId}`), sql`, `)})
          )
          select
            id, "cardId", "authorId", "authorKind", "apiKeyId", "apiKeyName", "authorName",
            body, "editedAt", "createdAt", "totalCount"
          from ranked_comments
          where comment_rank <= ${CONTENT_QUERY_COMMENT_CAP}
          order by comment_rank, "cardId", "createdAt", id
          limit ${CONTENT_QUERY_GLOBAL_COMMENT_CAP}
        `),
    ]);
    // Raw SQL bypasses Drizzle's timestamp mapper, so normalize timestamptz values before Fastify
    // serializes them and preserve the ISO timestamp contract used by the other comment endpoints.
    const commentRows = commentResult.rows.map((comment) => ({
      ...comment,
      editedAt: comment.editedAt ? new Date(String(comment.editedAt)) : null,
      createdAt: new Date(String(comment.createdAt)),
    }));
    // The SQL query enforces both per-card and aggregate row limits. The byte budget handles the
    // independent worst case where a bounded number of comments all contain maximum-size bodies.
    const commentsByCard = new Map<string, Omit<ContentQueryCommentRow, "totalCount">[]>();
    const totalCountByCard = new Map<string, number>();
    const retainedCountByCard = new Map<string, number>();
    let retainedBodyBytes = 0;
    for (const comment of commentRows) totalCountByCard.set(comment.cardId, comment.totalCount);
    for (const { totalCount: _totalCount, ...comment } of commentRows) {
      const signedBody = signEmbeddedMediaUrls(comment.body, req.auth.cid) ?? comment.body;
      const bodyBytes = Buffer.byteLength(signedBody, "utf8");
      if (retainedBodyBytes + bodyBytes > CONTENT_QUERY_COMMENT_BODY_BUDGET_BYTES) continue;
      retainedBodyBytes += bodyBytes;
      const cardComments = commentsByCard.get(comment.cardId) ?? [];
      cardComments.push({ ...comment, body: signedBody });
      commentsByCard.set(comment.cardId, cardComments);
      retainedCountByCard.set(comment.cardId, (retainedCountByCard.get(comment.cardId) ?? 0) + 1);
    }
    const truncatedCardIds = new Set<string>();
    for (const [cardId, totalCount] of totalCountByCard) {
      if ((retainedCountByCard.get(cardId) ?? 0) < totalCount) truncatedCardIds.add(cardId);
    }

    // Preserve caller card order so an integration can correlate the response without rebuilding
    // an index, while comments and checklist content remain deterministically chronological.
    return {
      cards: selectedCards.map((card) => ({
        card: toWireCard(card, req.auth.cid),
        checklists: checklistsByCard.get(card.id) ?? [],
        comments: commentsByCard.get(card.id) ?? [],
      })),
      missingCardIds,
      truncatedCardIds: Array.from(truncatedCardIds),
    };
  });

  app.post("/boards/:boardId/lists/:id/cards", async (req, reply) => {
    const { boardId, id: listId } = req.params as { boardId: string; id: string };
    const body = dto.createCardBody.parse(req.body);
    const assigneeIds = Array.from(new Set(body.assigneeIds ?? []));

    const [list] = await db.select().from(lists).where(eq(lists.id, listId)).limit(1);
    if (!list) throw notFound();
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    // Identity-wide personal credentials adopt the target organisation during access validation;
    // tenant-bound media handling must use that rebased context.
    assertIntegrationEmbeddedMediaStoredLocally(body.description, req.auth.cid, req.auth.authKind);
    const description = stripSignedEmbeddedMediaUrls(body.description ?? null, req.auth.cid);
    // Restricted editors must retain access to cards they create; make that grant atomic with the
    // card creation rather than relying on a follow-up client request.
    if (ctx.assignedItemsOnly && !assigneeIds.includes(req.auth.sub)) assigneeIds.push(req.auth.sub);
    if (list.workspaceId !== ctx.workspaceId) throw badRequest("target list not in board workspace");

    if (body.clientToken) {
      const [existing] = await db.select().from(cards).where(eq(cards.clientToken, body.clientToken)).limit(1);
      if (existing) {
        if (existing.boardId !== boardId || existing.listId !== listId || existing.createdById !== req.auth.sub) {
          throw badRequest("client token was already used for another card create");
        }
        // At-least-once delivery can replay a create whose committed response was lost. Returning
        // the first result avoids duplicating activity, automations, emails, and realtime events.
        return reply.status(201).send(toWireCard(existing, req.auth.cid));
      }
    }

    if (assigneeIds.length > 0) {
      const eligibleUserIds = await ensureBoardMembershipForUsers(boardId, ctx.workspaceId, assigneeIds);
      if (eligibleUserIds.length !== assigneeIds.length) {
        throw badRequest("one or more user ids are not assignable members");
      }
    }

    const position = body.atTop
      ? await topPositionForList(boardId, listId)
      : await bottomPositionForList(boardId, listId);

    const result = await db.transaction(async (tx) => {
      if (body.clientToken) {
        // Serialize idempotent replays before touching the workspace counter. A concurrent retry
        // observes the committed identity and consumes no second number.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${body.clientToken}, 0))`);
        const [existing] = await tx.select().from(cards).where(eq(cards.clientToken, body.clientToken)).limit(1);
        if (existing) {
          if (existing.boardId !== boardId || existing.listId !== listId || existing.createdById !== req.auth.sub) {
            throw badRequest("client token was already used for another card create");
          }
          return { kind: "replayed", card: existing } as const;
        }
      }
      const [identity] = await allocateCardKeys(tx, ctx.workspaceId, 1);
      const [card] = await tx
        .insert(cards)
        .values({
          ...identity!,
          clientToken: body.clientToken ?? null,
          listId,
          boardId,
          title: body.title,
          description,
          position,
          createdById: req.auth.sub,
        })
        // The predicate matches the partial unique index. A concurrent retry waits for the first
        // insert and then takes the replay path below without repeating any create side effects.
        .onConflictDoNothing({
          target: cards.clientToken,
          where: sql`${cards.clientToken} is not null`,
        })
        .returning();

      if (!card) {
        // Every app/public-API writer takes the advisory lock above. Rolling back here also rolls
        // back the allocated counter range if an out-of-band writer races the client token.
        throw new Error("card create identity conflicted after allocation");
      }

      if (assigneeIds.length > 0) {
        await tx.insert(cardAssignees).values(assigneeIds.map((userId) => ({ cardId: card.id, userId })));
      }

      await replaceCardMentions({
        tx,
        boardId,
        cardId: card.id,
        source: "description",
        markdown: description,
      });
      await replaceInternalLinksForSource({
        tx,
        claims: req.auth,
        workspaceId: ctx.workspaceId,
        sourceType: "card",
        sourceId: card.id,
        markdown: description,
      });

      if (shouldAutoWatchAuthoredCards(req.auth.authKind)) {
        await tx
          .insert(cardWatchers)
          .values({ cardId: card.id, userId: req.auth.sub })
          .onConflictDoNothing();
      }

      const activity = await recordActivity(tx, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: card.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: { title: card.title, listId },
      });
      // App and public API card creation share this route; keep list-entry
      // automations here so both surfaces behave the same.
      const automationEffects = await runListEntryAutomations(tx, {
        cardId: card.id,
        listId,
        boardId,
        workspaceId: ctx.workspaceId,
        clientId: req.auth.cid,
        trigger: "create",
        triggerActorId: req.auth.sub,
      });
      // Creating from Global Work assigns the card immediately, so assignment-triggered
      // automations and notifications need to see the same committed card as ordinary creation.
      const assignmentAutomationEffects: AutomationEffects = assigneeIds.length > 0
        ? await runCardAssignedAutomations(tx, {
            cardId: card.id,
            addedUserIds: assigneeIds,
            boardId,
            workspaceId: ctx.workspaceId,
            clientId: ctx.clientId,
            triggerActorId: req.auth.sub,
          })
        : { effects: [] };
      const [finalCard] = await tx.select().from(cards).where(eq(cards.id, card.id)).limit(1);
      return { kind: "created", card, finalCard: finalCard ?? card, activity, automationEffects, assignmentAutomationEffects } as const;
    });
    if (result.kind === "replayed") {
      return reply.status(201).send(toWireCard(result.card, req.auth.cid));
    }
    const { card, finalCard, activity, automationEffects, assignmentAutomationEffects } = result;
    if (assigneeIds.length > 0) {
      await enqueueCardAssignedEmails({
        tx: db,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
        cardId: card.id,
        actorId: req.auth.sub,
        recipientUserIds: assigneeIds,
      });
    }
    const wireCard = toWireCard(card, req.auth.cid);
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CREATED, { boardId, card: wireCard });
    await emitCardActivityFeedItem(boardId, card.id, activity);
    await emitAutomationEffects(automationEffects);
    if (assigneeIds.length > 0) {
      // Emit the requested assignment first because automation effects contain the final set;
      // clients use last-write-wins semantics when applying assignee snapshots.
      await emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: card.id, assigneeIds });
      await emitAutomationEffects(assignmentAutomationEffects);
    }
    // Card activity stays in Kanera's audit log. PostHog receives only the durable activation
    // milestone below, never one event per card mutation.
    await evaluateWorkspaceAnalyticsMilestones({
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      // API and MCP card creation is real customer work. Board-mirror copies use system activity
      // and never pass through this route, so they remain excluded from the milestone.
      supportSession: req.auth.authKind === "support",
    });
    return reply.status(201).send(toWireCard(finalCard, req.auth.cid));
  });

  app.post("/boards/:boardId/lists/:id/cards/completion", async (req) => {
    const { boardId, id: listId } = req.params as { boardId: string; id: string };
    const body = dto.setCardCompletionBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const [list] = await db.select().from(lists).where(eq(lists.id, listId)).limit(1);
    if (!list) throw notFound();
    if (list.workspaceId !== ctx.workspaceId) throw badRequest("target list not in board workspace");

    const targetCards = await db
      .select()
      .from(cards)
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(and(
        eq(cards.listId, listId),
        eq(lists.workspaceId, ctx.workspaceId),
        ctx.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined,
        isNull(cards.archivedAt),
        body.completed ? isNull(cards.completedAt) : isNotNull(cards.completedAt),
      ));

    if (targetCards.length === 0) return { updated: 0 };

    const completedAt = body.completed ? new Date() : null;
    const updates = await db.transaction(async (tx) => {
      const rows: CardCompletionWrite[] = [];
      for (const row of targetCards) {
        rows.push(await applyCardCompletion(tx, {
          card: row.card,
          completed: body.completed,
          completedAt,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          actorId: req.auth.sub,
        }));
      }
      return rows;
    });

    await emitCardCompletion(updates, { clientId: req.auth.cid, completed: body.completed });
    return { updated: updates.length };
  });

  app.patch("/boards/:boardId/cards/bulk/completion", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardCompletionBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const changingCards = targetCards.filter((card) => body.completed !== Boolean(card.completedAt));
    if (changingCards.length === 0) return { updated: 0, cards: [], skippedCardIds };

    const completedAt = body.completed ? new Date() : null;
    const updates = await db.transaction(async (tx) => {
      const rows: CardCompletionWrite[] = [];
      for (const current of changingCards) {
        rows.push(await applyCardCompletion(tx, {
          card: current,
          completed: body.completed,
          completedAt,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          actorId: req.auth.sub,
        }));
      }
      return rows;
    });

    await emitCardCompletion(updates, { clientId: req.auth.cid, completed: body.completed });
    return { updated: updates.length, cards: updates.map(({ finalCard }) => toWireCard(finalCard, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/due-date", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardDueDateBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const dueDateLocalDate = body.dueDateLocalDate;
    const dueDateSlot = dueDateLocalDate ? (body.dueDateSlot ?? "anyTime") : null;
    const dueDateTimezone = dueDateLocalDate
      ? ((await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, req.auth.sub)).limit(1))[0]?.timezone ?? "UTC")
      : null;
    const changingCards = targetCards.filter((card) =>
      card.dueDateLocalDate !== dueDateLocalDate ||
      card.dueDateSlot !== dueDateSlot ||
      card.dueDateTimezone !== dueDateTimezone
    );
    if (changingCards.length === 0) return { updated: 0, cards: [], skippedCardIds };

    const updates = await db.transaction(async (tx) => {
      const rows: { previous: typeof cards.$inferSelect; card: typeof cards.$inferSelect; activity: ActivityEvent }[] = [];
      for (const current of changingCards) {
        const [card] = await tx
          .update(cards)
          .set({ dueDateLocalDate, dueDateSlot, dueDateTimezone, updatedAt: new Date() })
          .where(eq(cards.id, current.id))
          .returning();
        const activity = await recordActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: current.id,
          action: ACTIVITY_ACTION.UPDATED,
          payload: { dueDateLocalDate, dueDateSlot, dueDateTimezone },
        });
        rows.push({ previous: current, card: card!, activity });
      }
      return rows;
    });

    for (const { previous, card, activity } of updates) {
      await enqueueDueDateChangedEmails({
        tx: db,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
        cardId: card.id,
        actorId: req.auth.sub,
        previousDue: {
          dueDateLocalDate: previous.dueDateLocalDate,
          dueDateSlot: previous.dueDateSlot,
          dueDateTimezone: previous.dueDateTimezone,
        },
        nextDue: {
          dueDateLocalDate: card.dueDateLocalDate,
          dueDateSlot: card.dueDateSlot,
          dueDateTimezone: card.dueDateTimezone,
        },
      });
      emitCardActivityFeedItem(boardId, card.id, activity);
      emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: toWireCard(card, req.auth.cid) });
    }
    return { updated: updates.length, cards: updates.map(({ card }) => toWireCard(card, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/labels", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkPatchCardLabelsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const validLabels = await db
      .select({ id: cardLabels.id, name: cardLabels.name })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, body.labelIds), isNull(cardLabels.archivedAt)));
    if (validLabels.length !== orderedUniqueIds(body.labelIds).length) throw badRequest("one or more label ids are invalid");
    const labelNameById = new Map(validLabels.map((label) => [label.id, label.name]));
    const labelNamesById = Object.fromEntries(validLabels.map((label) => [label.id, label.name]));
    const labelNames = body.labelIds.map((id) => labelNameById.get(id)).filter((name): name is string => Boolean(name));

    const updates = await db.transaction(async (tx) => {
      const rows: {
        cardId: string;
        labelIds: string[];
        activity: CoalescedActivityResult;
        automationEffects: Awaited<ReturnType<typeof runCardLabelSetAutomations>>;
      }[] = [];
      for (const card of targetCards) {
        const previous = await tx
          .select({ labelId: cardLabelAssignments.labelId })
          .from(cardLabelAssignments)
          .where(eq(cardLabelAssignments.cardId, card.id));
        const previousIds = previous.map((row) => row.labelId);
        const previousSet = new Set(previousIds);
        const nextIds = body.mode === "add"
          ? Array.from(new Set([...previousIds, ...body.labelIds]))
          : previousIds.filter((labelId) => !body.labelIds.includes(labelId));
        if (sortedIds(previousIds).join("\0") === sortedIds(nextIds).join("\0")) continue;
        const addedLabelIds = nextIds.filter((labelId) => !previousSet.has(labelId));
        await tx.delete(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, card.id));
        if (nextIds.length > 0) await tx.insert(cardLabelAssignments).values(nextIds.map((labelId) => ({ cardId: card.id, labelId })));
        const addedLabelNames = nextIds
          .filter((labelId) => !previousSet.has(labelId))
          .map((labelId) => labelNameById.get(labelId))
          .filter((name): name is string => Boolean(name));
        const nextSet = new Set(nextIds);
        const removedLabelNames = previousIds
          .filter((labelId) => !nextSet.has(labelId))
          .map((labelId) => labelNameById.get(labelId))
          .filter((name): name is string => Boolean(name));
        const previousSortedIds = sortedIds(previousIds);
        const nextSortedIds = sortedIds(nextIds);
        const activity = await recordCoalescedActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: card.id,
          action: ACTIVITY_ACTION.LABELS_SET,
          coalesceKey: "card:labels",
          windowMs: CARD_LABEL_MISTAKE_WINDOW_MS,
          fromValue: previousSortedIds,
          toValue: nextSortedIds,
          payload: {
            labelIds: nextIds,
            labelNames,
            addedLabelNames,
            removedLabelNames,
            labelNamesById,
            fromValue: previousSortedIds,
            toValue: nextSortedIds,
            bulk: true,
          },
        });
        const automationEffects = body.mode === "add"
          ? await runCardLabelSetAutomations(tx, {
            cardId: card.id,
            addedLabelIds,
            boardId,
            workspaceId: ctx.workspaceId,
            clientId: ctx.clientId,
            triggerActorId: req.auth.sub,
          })
          : EMPTY_EFFECTS;
        rows.push({ cardId: card.id, labelIds: nextIds, activity, automationEffects });
      }
      return rows;
    });

    for (const update of updates) {
      await emitToBoard(boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId, cardId: update.cardId, labelIds: update.labelIds });
      await emitCoalescedCardActivityFeedItem(boardId, update.cardId, update.activity);
      await emitAutomationEffects(update.automationEffects);
    }
    return { updated: updates.length, updatedCardIds: updates.map((update) => update.cardId), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/assignees", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkPatchCardAssigneesBody.parse(req.body);
    const userIds = orderedUniqueIds(body.userIds);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const eligibleUserIds = await ensureBoardMembershipForUsers(boardId, ctx.workspaceId, userIds);
    if (eligibleUserIds.length !== userIds.length) throw badRequest("one or more user ids are not assignable members");
    const changedUsers = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds));
    const userNameById = new Map(changedUsers.map((user) => [user.id, user.displayName]));
    const assigneeNamesById = Object.fromEntries(changedUsers.map((user) => [user.id, user.displayName]));

    const updates = await db.transaction(async (tx) => {
      const rows: {
        cardId: string;
        assigneeIds: string[];
        addedUserIds: string[];
        activity: CoalescedActivityResult;
        automationEffects: Awaited<ReturnType<typeof runCardAssignedAutomations>>;
      }[] = [];
      for (const card of targetCards) {
        const previous = await tx
          .select({ userId: cardAssignees.userId })
          .from(cardAssignees)
          .where(eq(cardAssignees.cardId, card.id));
        const previousIds = previous.map((row) => row.userId);
        const previousSet = new Set(previousIds);
        const nextUserIds = body.mode === "add"
          ? Array.from(new Set([...previousIds, ...userIds]))
          : previousIds.filter((userId) => !userIds.includes(userId));
        if (sortedIds(previousIds).join("\0") === sortedIds(nextUserIds).join("\0")) continue;
        const nextSet = new Set(nextUserIds);
        const addedUserIds = nextUserIds.filter((userId) => !previousSet.has(userId));
        const removedUserIds = previousIds.filter((userId) => !nextSet.has(userId));
        await tx.delete(cardAssignees).where(eq(cardAssignees.cardId, card.id));
        if (nextUserIds.length > 0) await tx.insert(cardAssignees).values(nextUserIds.map((userId) => ({ cardId: card.id, userId })));
        const activity = await recordCoalescedActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: card.id,
          action: ACTIVITY_ACTION.ASSIGNEES_SET,
          coalesceKey: "card:assignees",
          windowMs: CARD_ASSIGNEE_MISTAKE_WINDOW_MS,
          fromValue: sortedIds(previousIds),
          toValue: sortedIds(nextUserIds),
          payload: {
            assigneeIds: nextUserIds,
            addedAssigneeNames: addedUserIds.map((userId) => userNameById.get(userId)).filter((name): name is string => Boolean(name)),
            removedAssigneeNames: removedUserIds.map((userId) => userNameById.get(userId)).filter((name): name is string => Boolean(name)),
            assigneeNamesById,
            fromValue: sortedIds(previousIds),
            toValue: sortedIds(nextUserIds),
            bulk: true,
          },
        });
        const automationEffects = await runCardAssignedAutomations(tx, {
          cardId: card.id,
          addedUserIds,
          boardId,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          triggerActorId: req.auth.sub,
        });
        rows.push({ cardId: card.id, assigneeIds: nextUserIds, addedUserIds, activity, automationEffects });
      }
      return rows;
    });

    for (const update of updates) {
      await enqueueCardAssignedEmails({
        tx: db,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
        cardId: update.cardId,
        actorId: req.auth.sub,
        recipientUserIds: update.addedUserIds,
      });
      await emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: update.cardId, assigneeIds: update.assigneeIds });
      await emitCoalescedCardActivityFeedItem(boardId, update.cardId, update.activity);
      await emitAutomationEffects(update.automationEffects);
    }
    // Un-assigning drops a queued card out of the target's live "Up next" queue (and re-assigning
    // restores it) without touching card_priorities rows, so open queues must be pinged here.
    await invalidateQueuesForCards(updates.map((update) => update.cardId));
    return { updated: updates.length, updatedCardIds: updates.map((update) => update.cardId), skippedCardIds };
  });

  app.post("/boards/:boardId/cards/bulk/move", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkMoveCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
    if (!targetList || targetList.workspaceId !== ctx.workspaceId) throw badRequest("target list not in same workspace");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const movingCards = targetCards.filter((card) => card.listId !== body.listId);
    if (movingCards.length === 0) return { moved: 0, cards: [], skippedCardIds };

    const moves = await db.transaction(async (tx) => {
      await tx.select({ id: lists.id }).from(lists).where(eq(lists.id, body.listId)).for("update").limit(1);
      const positions = await bottomPositionsForCards(body.listId, movingCards.length, tx);
      const rows: {
        previous: typeof cards.$inferSelect;
        card: typeof cards.$inferSelect;
        activity: ActivityEvent;
        automationEffects: Awaited<ReturnType<typeof runListEntryAutomations>>;
      }[] = [];
      for (const [index, current] of movingCards.entries()) {
        const position = positions[index]!;
        const [card] = await tx
          .update(cards)
          .set({ listId: body.listId, position, updatedAt: new Date() })
          .where(eq(cards.id, current.id))
          .returning();
        const activity = await recordActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: current.id,
          action: ACTIVITY_ACTION.MOVED,
          payload: { fromListId: current.listId, toListId: body.listId, prevPosition: current.position, position },
        });
        const automationEffects = await runListEntryAutomations(tx, {
          cardId: current.id,
          listId: body.listId,
          boardId,
          workspaceId: ctx.workspaceId,
          clientId: req.auth.cid,
          trigger: "move",
          triggerActorId: req.auth.sub,
        });
        rows.push({ previous: current, card: card!, activity, automationEffects });
      }
      return rows;
    });

    for (const move of moves) {
      await emitToBoard(boardId, SERVER_EVENTS.CARD_MOVED, {
        boardId,
        cardId: move.card.id,
        fromListId: move.previous.listId,
        toListId: body.listId,
        position: move.card.position,
        prevPosition: move.previous.position,
      });
      await emitCardActivityFeedItem(boardId, move.card.id, move.activity);
      await emitAutomationEffects(move.automationEffects);
    }
    return { moved: moves.length, cards: moves.map(({ card }) => toWireCard(card, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/archive", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkArchiveCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const targetCards = loaded.filter((card) => !card.archivedAt);
    if (targetCards.length === 0) return { archived: 0, cards: [], skippedCardIds: [] };

    const archivedAt = new Date();
    const { rows: updates, deletedNotifications } = await db.transaction(async (tx) => {
      const rows: { card: typeof cards.$inferSelect; activity: ActivityEvent }[] = [];
      for (const current of targetCards) {
        const [card] = await tx
          .update(cards)
          .set({ archivedAt, updatedAt: archivedAt })
          .where(eq(cards.id, current.id))
          .returning();
        const activity = await recordActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: current.id,
          action: ACTIVITY_ACTION.ARCHIVED,
          payload: { title: current.title, archivedAt, bulk: true },
        });
        rows.push({ card: card!, activity });
      }
      const deletedNotifications = await clearNotificationsForCards(tx, targetCards.map((card) => card.id));
      return { rows, deletedNotifications };
    });
    emitDeletedNotifications(deletedNotifications);

    for (const { card, activity } of updates) {
      emitCardActivityFeedItem(boardId, card.id, activity);
      emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: toWireCard(card, req.auth.cid) });
    }
    // Archival removes cards from "Up next" queues without touching their rows, so the queue
    // audiences must be pinged separately from the board room above.
    await invalidateQueuesForCards(updates.map(({ card }) => card.id));
    return { archived: updates.length, cards: updates.map(({ card }) => toWireCard(card, req.auth.cid)), skippedCardIds: [] };
  });

  app.post("/boards/:boardId/cards/bulk/duplicate", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkDuplicateCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const targetBoardId = body.boardId ?? boardId;
    const dstCtx = targetBoardId === boardId ? ctx : await assertBoardAccess(req.auth, targetBoardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const created: WireCard[] = [];

    for (const source of targetCards) {
      const targetListId = await resolveDuplicateTargetList(source, dstCtx, body.listId);
      const position = await bottomPositionForList(targetBoardId, targetListId);
      const duplicated = await duplicateCardInto({
        source,
        srcCtx: ctx,
        dstCtx,
        targetBoardId,
        targetListId,
        position,
        actor: req.auth,
        bulk: true,
      });
      const wireCard = await emitDuplicatedCardIntoBoard({
        actor: req.auth,
        boardId: targetBoardId,
        card: duplicated.newCard,
        activity: duplicated.activity,
        labelIds: duplicated.labelIds,
        assigneeIds: duplicated.assigneeIds,
        customFieldValues: duplicated.customFieldValues,
        attachmentRows: duplicated.attachmentRows,
      });
      created.push(wireCard);
    }

    return reply.status(201).send({ duplicated: created.length, cards: created, skippedCardIds });
  });

  app.patch("/cards/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCardBody.parse(req.body);

    const [current] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertCardAccess(req.auth, current, "editor");
    assertCardActive(current);
    assertIntegrationEmbeddedMediaStoredLocally(body.description, req.auth.cid, req.auth.authKind);
    const description = body.description === undefined
      ? undefined
      : stripSignedEmbeddedMediaUrls(body.description, req.auth.cid);
    const hasDueDateUpdate = body.dueDateLocalDate !== undefined || body.dueDateSlot !== undefined;
    const dueDateLocalDate = hasDueDateUpdate ? (body.dueDateLocalDate ?? null) : undefined;
    const dueDateSlot = dueDateLocalDate === undefined
      ? undefined
      : dueDateLocalDate
        ? (body.dueDateSlot ?? "anyTime")
        : null;
    const dueDateTimezone = dueDateLocalDate === undefined
      ? undefined
      : dueDateLocalDate
        ? ((await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, req.auth.sub)).limit(1))[0]?.timezone ?? "UTC")
        : null;

    const activityPayload = {
      ...body,
      ...(description !== undefined && { description }),
      ...(description !== undefined && {
        // Description history is audit-facing: keep the raw markdown before and
        // after the edit so clients can show an exact diff for any update shape.
        fromValue: current.description,
        toValue: description,
      }),
      ...(dueDateLocalDate !== undefined && {
        dueDateLocalDate,
        dueDateSlot,
        dueDateTimezone,
      }),
    };
    // Description saves and card renames are often repeated while someone is drafting.
    // Keep each field in its own burst so mixed edits and due date history stay precise.
    const isDescriptionOnlyUpdate = body.description !== undefined
      && body.title === undefined
      && !hasDueDateUpdate;
    const isTitleOnlyUpdate = body.title !== undefined
      && body.description === undefined
      && !hasDueDateUpdate;
    const { card, activity } = await db.transaction(async (tx) => {
      const [card] = await tx
        .update(cards)
        .set({
          ...(body.title !== undefined && { title: body.title }),
          ...(description !== undefined && { description }),
          ...(dueDateLocalDate !== undefined && { dueDateLocalDate }),
          ...(dueDateSlot !== undefined && { dueDateSlot }),
          ...(dueDateTimezone !== undefined && { dueDateTimezone }),
          updatedAt: new Date(),
        })
        .where(eq(cards.id, id))
        .returning();

      if (body.description !== undefined) {
        await replaceCardMentions({
          tx,
          boardId: current.boardId,
          cardId: id,
          source: "description",
          markdown: description,
        });
        await replaceInternalLinksForSource({
          tx,
          claims: req.auth,
          workspaceId: ctx.workspaceId,
          sourceType: "card",
          sourceId: id,
          markdown: description,
        });
      }

      const activityInput = {
        boardId: current.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.UPDATED,
        payload: activityPayload,
      } as const;
      const activity = isDescriptionOnlyUpdate
        ? await recordCoalescedActivity(tx, {
          ...activityInput,
          coalesceKey: "card:description",
          windowMs: 120_000,
          fromValue: current.description,
          toValue: description,
        })
        : isTitleOnlyUpdate
          ? await recordCoalescedActivity(tx, {
            ...activityInput,
            coalesceKey: "card:title",
            windowMs: 120_000,
            fromValue: current.title,
            toValue: body.title,
          })
        : await recordActivity(tx, activityInput);
      return { card: card!, activity };
    });
    if (hasDueDateUpdate) {
      await enqueueDueDateChangedEmails({
        tx: db,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
        cardId: id,
        actorId: req.auth.sub,
        previousDue: {
          dueDateLocalDate: current.dueDateLocalDate,
          dueDateSlot: current.dueDateSlot,
          dueDateTimezone: current.dueDateTimezone,
        },
        nextDue: {
          dueDateLocalDate: card.dueDateLocalDate,
          dueDateSlot: card.dueDateSlot,
          dueDateTimezone: card.dueDateTimezone,
        },
      });
    }
    const wireCard = toWireCard(card, req.auth.cid);
    await emitToBoard(current.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: current.boardId, card: wireCard });
    if ("status" in activity) await emitCoalescedCardActivityFeedItem(current.boardId, id, activity);
    else await emitCardActivityFeedItem(current.boardId, id, activity);
    return wireCard;
  });

  app.patch("/cards/:id/completion", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardCompletionBody.parse(req.body);
    const [current] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertCardAccess(req.auth, current, "editor");
    assertCardActive(current);
    if (body.completed === Boolean(current.completedAt)) {
      return toWireCard(current, req.auth.cid);
    }

    const completedAt = body.completed ? new Date() : null;
    const write = await db.transaction((tx) => applyCardCompletion(tx, {
      card: current,
      completed: body.completed,
      completedAt,
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      actorId: req.auth.sub,
    }));
    const { finalCard } = write;

    await emitCardCompletion([write], { clientId: req.auth.cid, completed: body.completed });
    if (body.completed) await evaluateWorkspaceAnalyticsMilestones({
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      supportSession: req.auth.authKind === "support" || req.auth.authKind === "apiKey",
    });
    return toWireCard(finalCard, req.auth.cid);
  });

  app.post("/cards/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardBody.parse(req.body);
    if (body.globalWorkUserId && !options.allowGlobalWorkLayoutMoves) {
      // Public integrations operate on real board lanes only. The personal Global Work anchor mode
      // is enabled solely by the first-party app server that also owns its separator routes.
      throw badRequest("Global Work layout anchors are not available through this API");
    }

    const [current] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertCardAccess(req.auth, current, "editor");
    assertCardActive(current);

    const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
    if (!targetList || targetList.workspaceId !== ctx.workspaceId) {
      throw badRequest("target list not in same workspace");
    }

    if (body.globalWorkUserId) {
      // A personal Global Work separator is outside the source board lane. Validate both the
      // organiser's workspace context and that this card actually belongs in their merged lane.
      await assertGlobalWorkSeparatorContext({
        auth: req.auth,
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

    const fromListId = current.listId;
    const prevPosition = current.position;
    const enteringNewList = fromListId !== body.listId;
    const { position, finalPosition, finalListId, rebalancedPositions, activity, completedCard, completionActivity, automationEffects, noOp } = await db.transaction(async (tx) => {
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
      const result = body.globalWorkUserId
        ? {
            position: await positionForGlobalWorkLaneInsert({
              auth: req.auth,
              workspaceId: ctx.workspaceId,
              targetUserId: body.globalWorkUserId,
              listId: body.listId,
              moving: { type: "card", id },
              afterItem,
              beforeItem,
              tx,
            }),
            needsRebalance: false,
          }
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
      if (!enteringNewList && position === prevPosition) {
        return {
          position,
          finalPosition: prevPosition,
          finalListId: fromListId,
          rebalancedPositions: null,
          activity: null,
          completedCard: null,
          completionActivity: null,
          automationEffects: { effects: [] },
          noOp: true,
        };
      }

      await tx
        .update(cards)
        .set({
          listId: body.listId,
          position,
          updatedAt: new Date(),
        })
        .where(eq(cards.id, id));

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
          actorId: req.auth.sub,
          entityType: "card",
          entityId: id,
          action: ACTIVITY_ACTION.MOVED,
          payload: { fromListId, toListId: body.listId, prevPosition, position },
        })
        : null;
      const automationEffects = enteringNewList
        ? await runListEntryAutomations(tx, {
          cardId: id,
          listId: body.listId,
          boardId: current.boardId,
          workspaceId: ctx.workspaceId,
          clientId: req.auth.cid,
          trigger: "move",
          triggerActorId: req.auth.sub,
        })
        : { effects: [] };
      const [finalCard] = await tx.select({ listId: cards.listId, position: cards.position }).from(cards).where(eq(cards.id, id)).limit(1);
      return {
        position,
        finalPosition: finalCard?.position ?? position,
        finalListId: finalCard?.listId ?? body.listId,
        rebalancedPositions,
        activity,
        completedCard: null,
        completionActivity: null,
        automationEffects,
        noOp: false,
      };
    });

    if (noOp) return { id, listId: finalListId, position: finalPosition };

    if (rebalancedPositions) {
      // Rebalance must be persisted before card:moved so clients replay the normalized positions
      // before applying the move, and webhook/outbox consumers observe the same ordering.
      await emitLaneRebalanced(current.boardId, body.listId, rebalancedPositions);
    }
    await emitToBoard(current.boardId, SERVER_EVENTS.CARD_MOVED, {
      boardId: current.boardId,
      cardId: id,
      fromListId,
      toListId: body.listId,
      position,
      prevPosition,
    });
    if (activity) await emitCardActivityFeedItem(current.boardId, id, activity);
    if (completedCard && completionActivity) {
      const wireCard = toWireCard(completedCard, req.auth.cid);
      await emitToBoard(current.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: current.boardId, card: wireCard });
      await emitCardActivityFeedItem(current.boardId, id, completionActivity, { notify: true });
    }
    await emitAutomationEffects(automationEffects);
    if (activity) await evaluateWorkspaceAnalyticsMilestones({
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      supportSession: req.auth.authKind === "support" || req.auth.authKind === "apiKey",
    });
    return { id, listId: finalListId, position: finalPosition };
  });

  app.post("/cards/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.duplicateCardBody.parse(req.body ?? {});

    const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!source) throw notFound();
    const srcCtx = await assertCardAccess(req.auth, source, "editor");
    assertCardActive(source);

    const targetBoardId = body.boardId ?? source.boardId;
    let dstCtx: BoardAccessContext = srcCtx;
    if (targetBoardId !== source.boardId) {
      dstCtx = await assertBoardAccess(req.auth, targetBoardId, "editor");
    }

    const targetListId = await resolveDuplicateTargetList(source, dstCtx, body.listId);

    let position: string;
    let needsRebalance = false;
    if (targetBoardId === source.boardId && targetListId === source.listId) {
      // Duplicating in place inserts a new card directly after the source; the source itself is
      // not moving, so it must stay in the lane to serve as the `afterItem` anchor (passing
      // `moving` here would filter it out and the anchor lookup would fail).
      const result = await positionForLaneInsert({
        boardId: targetBoardId,
        listId: targetListId,
        afterItem: { type: "card", id: source.id },
      });
      position = result.position;
      needsRebalance = result.needsRebalance;
    } else if (targetBoardId !== source.boardId || body.atTop) {
      position = await topPositionForList(targetBoardId, targetListId);
    } else {
      position = await bottomPositionForList(targetBoardId, targetListId);
    }

    const duplicated = await duplicateCardInto({
      source,
      srcCtx,
      dstCtx,
      targetBoardId,
      targetListId,
      position,
      actor: req.auth,
      bulk: false,
    });

    if (needsRebalance) {
      const positions = await rebalanceBoardLane(targetListId, targetBoardId);
      await emitLaneRebalanced(targetBoardId, targetListId, positions);
    }

    const wireNewCard = await emitDuplicatedCardIntoBoard({
      actor: req.auth,
      boardId: targetBoardId,
      card: duplicated.newCard,
      activity: duplicated.activity,
      labelIds: duplicated.labelIds,
      assigneeIds: duplicated.assigneeIds,
      customFieldValues: duplicated.customFieldValues,
      attachmentRows: duplicated.attachmentRows,
    });

    return reply.status(201).send(wireNewCard);
  });

  app.post("/cards/:id/move-to-board", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardToBoardBody.parse(req.body);

    const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!source) throw notFound();
    const srcCtx = await assertCardAccess(req.auth, source, "editor");
    assertCardActive(source);

    if (body.boardId === source.boardId) {
      throw badRequest("target board must differ from current board");
    }
    const dstCtx = await assertBoardAccess(req.auth, body.boardId, "editor");
    if (dstCtx.workspaceId !== srcCtx.workspaceId) {
      throw badRequest("target board must be in the same workspace");
    }

    const targetListId = body.listId ?? source.listId;
    const [targetList] = await db.select().from(lists).where(eq(lists.id, targetListId)).limit(1);
    if (!targetList || targetList.workspaceId !== dstCtx.workspaceId) {
      throw badRequest("target list not in same workspace");
    }

    const position = await topPositionForList(body.boardId, targetListId);
    const fromBoardId = source.boardId;
    const fromListId = source.listId;
    const prevPosition = source.position;

    const currentAssignees = await db
      .select({ userId: cardAssignees.userId })
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, source.id));
    await ensureBoardMembershipForUsers(body.boardId, dstCtx.workspaceId, currentAssignees.map((a) => a.userId));

    const { updated, activity, relocatedNotifications } = await db.transaction(async (tx) => {
      const [updatedCard] = await tx
        .update(cards)
        .set({ boardId: body.boardId, listId: targetListId, position, updatedAt: new Date() })
        .where(eq(cards.id, id))
        .returning();
      const moveActivity = await recordCoalescedActivity(tx, {
        boardId: body.boardId,
        workspaceId: dstCtx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.MOVED,
        coalesceKey: "card:board",
        coalesceAcrossBoards: true,
        preservePayloadKeys: ["fromBoardId", "fromListId", "prevPosition"],
        windowMs: 60_000,
        fromValue: { boardId: fromBoardId, listId: fromListId },
        toValue: { boardId: body.boardId, listId: targetListId },
        payload: { fromBoardId, toBoardId: body.boardId, fromListId, toListId: targetListId, prevPosition, position },
      });
      const relocated = await relocateNotificationsForCard(tx, {
        cardId: id,
        boardId: body.boardId,
        listId: targetListId,
        workspaceId: dstCtx.workspaceId,
        clientId: dstCtx.clientId,
      });
      return { updated: updatedCard, activity: moveActivity, relocatedNotifications: relocated };
    });
    await emitToBoard(fromBoardId, SERVER_EVENTS.CARD_DELETED, { boardId: fromBoardId, cardId: id });
    const wireUpdated = toWireCard(updated!, req.auth.cid);
    await emitToBoard(body.boardId, SERVER_EVENTS.CARD_CREATED, { boardId: body.boardId, card: wireUpdated });
    await emitRelocatedNotifications(relocatedNotifications);
    await emitCoalescedCardActivityFeedItem(body.boardId, id, activity);

    const [labelAssignments, assignees, attachmentRows] = await Promise.all([
      db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, id)),
      db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, id)),
      db
        .select({
          id: cardAttachments.id,
          cardId: cardAttachments.cardId,
          fileName: cardAttachments.fileName,
          mimeType: cardAttachments.mimeType,
          byteSize: cardAttachments.byteSize,
          url: cardAttachments.url,
          fileKey: cardAttachments.fileKey,
          thumbnailUrl: cardAttachments.thumbnailUrl,
          thumbnailFileKey: cardAttachments.thumbnailFileKey,
          createdAt: cardAttachments.createdAt,
          uploadedById: cardAttachments.uploadedById,
          uploadedByName: users.displayName,
          uploadedByAvatarUrl: users.avatarUrl,
          uploadedByClientId: users.clientId,
          source: cardAttachments.source,
          commentId: cardAttachments.commentId,
        })
        .from(cardAttachments)
        .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
        .where(eq(cardAttachments.cardId, id)),
    ]);

    if (labelAssignments.length > 0) {
      emitToBoard(body.boardId, SERVER_EVENTS.CARD_LABELS_SET, {
        boardId: body.boardId,
        cardId: id,
        labelIds: labelAssignments.map((l) => l.labelId),
      });
    }
    if (assignees.length > 0) {
      emitToBoard(body.boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, {
        boardId: body.boardId,
        cardId: id,
        assigneeIds: assignees.map((a) => a.userId),
      });
    }
    for (const { uploadedByClientId, uploadedByAvatarUrl, ...att } of attachmentRows) {
      emitToBoard(body.boardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
        boardId: body.boardId,
        cardId: id,
        attachment: {
          ...shapeAttachmentMedia(att),
          uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
        },
      });
    }

    return wireUpdated;
  });

  // Bulk-set one custom field across many cards. Mirrors the single-card PUT/DELETE path:
  // per changed card we upsert/delete the value, then emit card:customFieldValue:set|cleared
  // (one event per card, reconciled by BoardState) plus a coalesced bulk activity entry.
  app.patch("/boards/:boardId/cards/bulk/custom-fields", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardCustomFieldBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const [field] = await db.select().from(customFields).where(eq(customFields.id, body.fieldId)).limit(1);
    if (!field || field.workspaceId !== ctx.workspaceId) throw notFound("custom field not found");

    // Mode ↔ type compatibility: add/remove tri-state operates on multi-value select/user only;
    // setAll/fillEmpty write a whole value (scalar + single-value select/user); clear applies to all.
    const isMultiValue = (field.type === "select" || field.type === "user") && field.allowMultiple;
    if ((body.mode === "add" || body.mode === "remove") && !isMultiValue)
      throw badRequest("add/remove is only valid for multi-value select or user fields");
    if ((body.mode === "setAll" || body.mode === "fillEmpty") && isMultiValue)
      throw badRequest("use add/remove for multi-value fields");

    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);

    // Validate/build the whole-value target once for setAll/fillEmpty, and validate the
    // incoming ids once for add/remove. The per-card loop below only diffs and merges.
    const multiColumnKey = field.type === "user" ? "valueUserIds" : "valueOptionIds";
    let setCols: CustomFieldValueColumns | null = null;
    if (body.mode === "setAll" || body.mode === "fillEmpty") {
      setCols = await buildCustomFieldValueColumns(field, body, { workspaceId: ctx.workspaceId });
    }
    let deltaIds: string[] = [];
    if (body.mode === "add" || body.mode === "remove") {
      deltaIds = orderedUniqueIds((field.type === "user" ? body.valueUserIds : body.valueOptionIds) ?? []);
      if (deltaIds.length === 0) throw badRequest("provide ids to add or remove");
      if (field.type === "user") await assertWorkspaceMemberIds(ctx.workspaceId, deltaIds);
      else await assertValidOptionIds(field.id, deltaIds);
    }

    const changes = await db.transaction(async (tx) => {
      const set: { value: typeof cardCustomFieldValues.$inferSelect; fromValue: string | null; toValue: string | null }[] = [];
      const cleared: { cardId: string; fromValue: string | null }[] = [];
      for (const card of targetCards) {
        const [currentValue] = await tx
          .select()
          .from(cardCustomFieldValues)
          .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
          .limit(1);

        // Resolve the next columns (or a clear) for this card.
        let nextCols: CustomFieldValueColumns | null;
        if (body.mode === "clear") {
          nextCols = null;
        } else if (body.mode === "setAll") {
          nextCols = setCols;
        } else if (body.mode === "fillEmpty") {
          // Only write cards with no existing value; leave populated cards untouched.
          if (hasCustomFieldValue(field.type, currentValue)) continue;
          nextCols = setCols;
        } else {
          // add / remove on a multi-value id array.
          const current = (currentValue?.[multiColumnKey] as string[] | null) ?? [];
          const currentSet = new Set(current);
          const deltaSet = new Set(deltaIds);
          const nextIds = body.mode === "add"
            ? [...current, ...deltaIds.filter((idv) => !currentSet.has(idv))]
            : current.filter((idv) => !deltaSet.has(idv));
          if (sortedIds(current).join("\0") === sortedIds(nextIds).join("\0")) continue;
          // Removing the last id clears the row entirely.
          nextCols = nextIds.length === 0 ? null : { ...emptyValueColumns(), [multiColumnKey]: nextIds };
        }

        const fromValue = await describeCustomFieldValue(field, currentValue, tx);

        if (nextCols === null) {
          if (!currentValue) continue; // nothing to clear
          await tx
            .delete(cardCustomFieldValues)
            .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)));
          cleared.push({ cardId: card.id, fromValue });
          continue;
        }

        // Skip no-op writes (e.g. setAll to an already-identical value).
        if (currentValue && customFieldValueEquals(field.type, currentValue, nextCols)) continue;
        const [value] = await tx
          .insert(cardCustomFieldValues)
          .values({ cardId: card.id, fieldId: field.id, ...nextCols, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId],
            set: { ...nextCols, updatedAt: new Date() },
          })
          .returning();
        const toValue = await describeCustomFieldValue(field, nextCols, tx);
        set.push({ value: value!, fromValue, toValue });
      }
      return { set, cleared };
    });

    const recordCustomFieldActivity = (cardId: string, fromValue: string | null, toValue: string | null) =>
      recordCoalescedActivity(db, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: cardId,
        action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
        coalesceKey: `customField:${field.id}`,
        windowMs: 60_000,
        fromValue,
        toValue,
        payload: { fieldId: field.id, fieldName: field.name, fieldType: field.type, fromValue, toValue, bulk: true },
      });

    for (const { value, fromValue, toValue } of changes.set) {
      emitToBoard(boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
        boardId,
        cardId: value.cardId,
        fieldId: field.id,
        valueText: value.valueText,
        valueNumber: value.valueNumber,
        valueCheckbox: value.valueCheckbox,
        valueDate: value.valueDate,
        valueUrl: value.valueUrl,
        valueOptionIds: value.valueOptionIds,
        valueUserIds: value.valueUserIds,
      });
      const activity = await recordCustomFieldActivity(value.cardId, fromValue, toValue);
      await emitCoalescedCardActivityFeedItem(boardId, value.cardId, activity);
    }
    const clearedToValue = await describeCustomFieldValue(field, null);
    for (const { cardId, fromValue } of changes.cleared) {
      emitToBoard(boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, { boardId, cardId, fieldId: field.id });
      const activity = await recordCustomFieldActivity(cardId, fromValue, clearedToValue);
      await emitCoalescedCardActivityFeedItem(boardId, cardId, activity);
    }

    return {
      values: changes.set.map((c) => c.value),
      clearedCardIds: changes.cleared.map((c) => c.cardId),
      skippedCardIds,
      updated: changes.set.length + changes.cleared.length,
    };
  });

  app.put("/cards/:id/custom-fields/:fieldId", async (req) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    const body = dto.setCustomFieldValueBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [field] = await db.select().from(customFields).where(eq(customFields.id, fieldId)).limit(1);
    if (!field || field.workspaceId !== ctx.workspaceId) throw notFound("custom field not found");
    const [currentValue] = await db
      .select()
      .from(cardCustomFieldValues)
      .where(and(eq(cardCustomFieldValues.cardId, id), eq(cardCustomFieldValues.fieldId, fieldId)))
      .limit(1);

    // Validate the value against the field type and build the all-null-plus-one columns.
    const cols = await buildCustomFieldValueColumns(field, body, { workspaceId: ctx.workspaceId });

    // Resolve human-readable strings for the activity feed (option labels / user names).
    const fromValue = await describeCustomFieldValue(field, currentValue);
    const toValue = await describeCustomFieldValue(field, cols);

    const [value] = await db
      .insert(cardCustomFieldValues)
      .values({ cardId: id, fieldId, ...cols, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId],
        set: { ...cols, updatedAt: new Date() },
      })
      .returning();
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
      boardId: card.boardId,
      cardId: id,
      fieldId,
      ...cols,
    });
    const activity = await recordCoalescedActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
      coalesceKey: `customField:${fieldId}`,
      windowMs: 60_000,
      fromValue,
      toValue,
      payload: {
        fieldId,
        fieldName: field.name,
        fieldType: field.type,
        fromValue,
        toValue,
      },
    });
    emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
    return value!;
  });

  app.patch("/boards/:boardId/checklist-items/bulk/descriptions", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetChecklistItemDescriptionsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const requestedCardIds = orderedUniqueIds(body.updates.map((update) => update.cardId));
    const selectedCards = await loadBulkBoardCards(boardId, requestedCardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    for (const card of selectedCards) assertCardActive(card);

    const currentRows = await db
      .select({ item: cardChecklistItems, checklist: cardChecklists, card: cards })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
      .where(inArray(cardChecklistItems.id, body.updates.map((update) => update.itemId)));
    const currentByItemId = new Map(currentRows.map((row) => [row.item.id, row]));

    // Validate the entire tuple set before writing anything. IDs alone are insufficient because a
    // stale model context could otherwise apply a description to an item that moved to another card.
    for (const update of body.updates) {
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

    const changingUpdates = body.updates.filter((update) =>
      currentByItemId.get(update.itemId)!.item.description !== update.description
    );
    const unchangedItemIds = body.updates
      .filter((update) => currentByItemId.get(update.itemId)!.item.description === update.description)
      .map((update) => update.itemId);
    if (changingUpdates.length === 0) return { updated: 0, items: [], unchangedItemIds };

    const updates = await db.transaction(async (tx) => {
      const rows: Array<{
        card: typeof cards.$inferSelect;
        checklist: typeof cardChecklists.$inferSelect;
        previous: typeof cardChecklistItems.$inferSelect;
        item: typeof cardChecklistItems.$inferSelect;
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
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
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

    // The write is atomic, but consumers still need full per-item events to update cached card
    // detail accurately. Emit only after commit so no client observes a rolled-back description.
    for (const update of updates) {
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
    return {
      updated: updates.length,
      items: updates.map((update) => ({ cardId: update.card.id, checklistId: update.checklist.id, item: update.item })),
      unchangedItemIds,
    };
  });

  app.post("/cards/:id/checklists", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.createChecklistBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
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

    const { checklist, activity } = await db.transaction(async (tx) => {
      const [checklist] = await tx
        .insert(cardChecklists)
        .values({ cardId: id, parentItemId, title: body.title, position })
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      const activity = await recordActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_CREATED,
        payload: { checklistId: checklist!.id, parentItemId, title: checklist!.title },
      });
      return { checklist: { ...checklist!, items: [] }, activity };
    });

    emitCardActivityFeedItem(card.boardId, id, activity);
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId: card.boardId, cardId: id, checklist });
    return reply.status(201).send(checklist);
  });

  app.post("/cards/:id/checklist-templates/apply", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.applyChecklistTemplatesBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    const requestedTemplateIds = Array.from(new Set(body.templateIds));
    const applied = await db.transaction(async (tx) => {
      const applied = await applyChecklistTemplates(tx, {
        cardId: id,
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        templateIds: requestedTemplateIds,
      });
      if (applied.length > 0) {
        await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      }
      return applied;
    });

    for (const result of applied) {
      emitCardActivityFeedItem(card.boardId, id, result.activity);
      emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, {
        boardId: card.boardId,
        cardId: id,
        checklist: result.checklist,
      });
    }

    const appliedTemplateIds = new Set(applied.map((result) => result.templateId));
    return {
      checklists: applied.map((result) => result.checklist),
      skippedTemplateIds: requestedTemplateIds.filter((templateId) => !appliedTemplateIds.has(templateId)),
    };
  });

  app.patch("/cards/:id/checklists/:checklistId", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.updateChecklistBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [current] = await db
      .select()
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
      .limit(1);
    if (!current) throw notFound("checklist not found");

    const { checklist, activity } = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(cardChecklists)
        .set({ title: body.title, updatedAt: new Date() })
        .where(eq(cardChecklists.id, checklistId))
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      const activity = await recordCoalescedActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_RENAMED,
        coalesceKey: `checklist:${checklistId}:title`,
        windowMs: 60_000,
        fromValue: current.title,
        toValue: body.title,
        payload: { checklistId, fromValue: current.title, toValue: body.title },
      });
      return { checklist: { ...updated!, items: (await loadChecklistsForCard(id, tx)).find((c) => c.id === checklistId)?.items ?? [] }, activity };
    });

    emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_UPDATED, { boardId: card.boardId, cardId: id, checklist });
    return checklist;
  });

  app.delete("/cards/:id/checklists/:checklistId", async (req, reply) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [current] = await db
      .select()
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
      .limit(1);
    if (!current) throw notFound("checklist not found");

    const result = await db.transaction(async (tx) => {
      // Deleting an empty checklist is structural cleanup, not meaningful card activity. Capture
      // this before the cascade removes its items so only destructive deletions reach the feed and
      // notification fanout; the realtime deletion event is still emitted below for client sync.
      const [firstItem] = await tx
        .select({ id: cardChecklistItems.id })
        .from(cardChecklistItems)
        .where(eq(cardChecklistItems.checklistId, checklistId))
        .limit(1);
      const hadItems = Boolean(firstItem);
      await tx.delete(cardChecklists).where(eq(cardChecklists.id, checklistId));
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      const mistakeCutoff = new Date(Date.now() - CHECKLIST_MISTAKE_WINDOW_MS);
      const [recentCreate] = await tx
        .select()
        .from(activityEvents)
        .where(and(
          eq(activityEvents.boardId, card.boardId),
          eq(activityEvents.workspaceId, ctx.workspaceId),
          eq(activityEvents.actorId, req.auth.sub),
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
        return { hiddenCreate: hiddenCreate!, deletedActivity: null };
      }

      if (!hadItems) return { hiddenCreate: null, deletedActivity: null };

      const deletedActivity = await recordActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_DELETED,
        payload: { checklistId, title: current.title },
      });
      return { hiddenCreate: null, deletedActivity };
    });

    if (result.hiddenCreate) {
      emitActivityFeedItemDeleted(card.boardId, id, result.hiddenCreate.id);
    } else if (result.deletedActivity) {
      emitCardActivityFeedItem(card.boardId, id, result.deletedActivity);
    }
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_DELETED, { boardId: card.boardId, cardId: id, checklistId });
    return reply.status(204).send();
  });

  app.post("/cards/:id/checklists/:checklistId/move", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.moveChecklistBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [current] = await db
      .select()
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
      .limit(1);
    if (!current) throw notFound("checklist not found");
    const prevPosition = current.position;

    const { position, rebalancedPositions } = await db.transaction(async (tx) => {
      const { prev, next } = await neighbourChecklistPositions(id, current.parentItemId, body.afterChecklistId, body.beforeChecklistId, tx);
      const result = between(prev, next);
      let position = result.position;
      await tx.update(cardChecklists).set({ position, updatedAt: new Date() }).where(eq(cardChecklists.id, checklistId));
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      const rebalancedPositions = result.needsRebalance ? await rebalanceChecklists(id, current.parentItemId, tx) : null;
      if (rebalancedPositions) position = rebalancedPositions.find((p) => p.id === checklistId)?.position ?? position;
      return { position, rebalancedPositions };
    });

    if (rebalancedPositions) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_REBALANCED, { boardId: card.boardId, cardId: id, positions: rebalancedPositions });
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_MOVED, { boardId: card.boardId, cardId: id, checklistId, position, prevPosition });
    return { id: checklistId, position };
  });

  app.post("/boards/:boardId/checklist-items/bulk/create", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkCreateChecklistItemsBody.parse(req.body);
    const boardAccess = await assertBoardAccess(req.auth, boardId, "editor");
    const cardIds = [...new Set(body.items.map((entry) => entry.cardId))];
    const checklistIds = [...new Set(body.items.map((entry) => entry.checklistId))];
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
    await assertBatchCardVisibility(req.auth, boardAccess, cardIds);
    for (const entry of body.items) {
      const checklist = checklistsById.get(entry.checklistId);
      if (!checklist || checklist.cardId !== entry.cardId) throw notFound("one or more checklists were not found on their cards");
      if (checklist.parentItemId && entry.description != null) {
        throw badRequest("items in nested checklists do not support descriptions");
      }
    }

    const { items, activities, inserts } = await db.transaction(async (tx) => {
      // All item creators lock the checklist row before reading its tail position. Sorting the lock
      // order prevents overlapping multi-checklist batches from deadlocking each other.
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
      const inserts = body.items.map((entry) => {
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
          workspaceId: boardAccess.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: entry.cardId,
          action: ACTIVITY_ACTION.CHECKLIST_ITEM_CREATED,
          payload: { checklistId: entry.checklistId, itemId: entry.id, text: entry.text, bulk: true },
        }));
      }
      return { items: inserts.map((entry) => insertedById.get(entry.id)!), activities, inserts };
    });

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
    return reply.status(201).send({ created: items.length, items });
  });

  app.post("/cards/:id/checklists/:checklistId/items", async (req, reply) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.createChecklistItemBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");
    const item = await db.transaction(async (tx) => {
      // Share the checklist lock used by bulk creation so concurrent single and batch appends cannot
      // calculate the same numeric position from a stale tail row.
      const [lockedChecklist] = await tx
        .select({ id: cardChecklists.id })
        .from(cardChecklists)
        .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
        .for("update")
        .limit(1);
      if (!lockedChecklist) throw notFound("checklist not found");
      const [last] = await tx
        .select({ position: cardChecklistItems.position })
        .from(cardChecklistItems)
        .where(eq(cardChecklistItems.checklistId, checklistId))
        .orderBy(desc(cardChecklistItems.position))
        .limit(1);
      const position = between(last?.position ?? null, null).position;
      const [item] = await tx
        .insert(cardChecklistItems)
        .values({ checklistId, text: body.text, position })
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      return item!;
    });

    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId, checklistParentItemId: checklist.parentItemId, item });
    return reply.status(201).send(item);
  });

  app.patch("/cards/:id/checklists/:checklistId/items/bulk", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.bulkUpdateChecklistItemsBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");
    if (checklist.parentItemId) throw badRequest("nested checklist items do not support assignees or due dates");

    const currentItems = await db
      .select()
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId))
      .orderBy(asc(cardChecklistItems.position));
    if (currentItems.length === 0) return { items: [] };

    const hasAssigneeUpdate = body.assigneeId !== undefined;
    const nextAssigneeId = hasAssigneeUpdate ? body.assigneeId : undefined;
    let nextAssigneeName: string | null = null;
    if (nextAssigneeId) {
      const eligibleIds = await ensureBoardMembershipForUsers(card.boardId, ctx.workspaceId, [nextAssigneeId]);
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
        ? ((await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, req.auth.sub)).limit(1))[0]?.timezone ?? "UTC")
        : null;

    const targetItems = currentItems.filter((item) => {
      const assigneeChanged = hasAssigneeUpdate && item.assigneeId !== nextAssigneeId;
      const dueDateChanged = hasDueDateUpdate && (item.dueDateLocalDate !== dueDateLocalDate || item.dueDateSlot !== dueDateSlot);
      return assigneeChanged || dueDateChanged;
    });
    if (targetItems.length === 0) return { items: [] };

    const targetItemIds = targetItems.map((item) => item.id);
    const { items, assigneeActivity, dueDateActivity } = await db.transaction(async (tx) => {
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
          actorId: req.auth.sub,
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
          actorId: req.auth.sub,
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

    if (assigneeActivity) emitCoalescedCardActivityFeedItem(card.boardId, id, assigneeActivity, { notify: false });
    if (dueDateActivity) emitCoalescedCardActivityFeedItem(card.boardId, id, dueDateActivity, { notify: false });
    const itemsById = new Map(items.map((item) => [item.id, item]));
    for (const current of targetItems) {
      const item = itemsById.get(current.id);
      if (!item) continue;
      emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId, checklistParentItemId: checklist.parentItemId, item, prevCompletedAt: current.completedAt });
    }
    return { items };
  });

  app.patch("/cards/:id/checklists/:checklistId/items/:itemId", async (req) => {
    const { id, checklistId, itemId } = req.params as { id: string; checklistId: string; itemId: string };
    const body = dto.updateChecklistItemBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");
    if (checklist.parentItemId && (
      body.description !== undefined ||
      body.assigneeId !== undefined ||
      body.dueDateLocalDate !== undefined ||
      body.dueDateSlot !== undefined
    )) {
      throw badRequest("nested checklist items support only text and completion");
    }
    const [current] = await db
      .select()
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.id, itemId), eq(cardChecklistItems.checklistId, checklistId)))
      .limit(1);
    if (!current) throw notFound("checklist item not found");

    // Due date derivation mirrors the card PATCH route: clearing the date also
    // clears slot + timezone, setting a date defaults the slot to "anyTime" and
    // captures the acting user's timezone so overdue is evaluated correctly.
    const hasDueDateUpdate = body.dueDateLocalDate !== undefined || body.dueDateSlot !== undefined;
    const dueDateLocalDate = hasDueDateUpdate ? (body.dueDateLocalDate ?? null) : undefined;
    const dueDateSlot = dueDateLocalDate === undefined
      ? undefined
      : dueDateLocalDate
        ? (body.dueDateSlot ?? "anyTime")
        : null;
    const dueDateTimezone = dueDateLocalDate === undefined
      ? undefined
      : dueDateLocalDate
        ? ((await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, req.auth.sub)).limit(1))[0]?.timezone ?? "UTC")
        : null;

    const nextCompletedAt = body.completed === undefined
      ? current.completedAt
      : body.completed
        ? current.completedAt ?? new Date()
        : null;
    const nextCompletedById = body.completed === undefined
      ? current.completedById
      : body.completed
        ? req.auth.sub
        : null;
    const nextText = body.text ?? current.text;
    const nextDescription = body.description === undefined ? current.description : body.description;
    const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== current.assigneeId;
    const nextAssigneeId = body.assigneeId === undefined ? current.assigneeId : body.assigneeId;
    let nextAssigneeName: string | null = null;
    let previousAssigneeName: string | null = null;

    if (nextAssigneeId) {
      const eligibleIds = await ensureBoardMembershipForUsers(card.boardId, ctx.workspaceId, [nextAssigneeId]);
      if (!eligibleIds.includes(nextAssigneeId)) throw badRequest("assignee is not an assignable member");
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
    const { item, activities, assigneeActivity, dueDateActivity, automationEffects, hiddenChecklistCompletionId } = await db.transaction(async (tx) => {
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
          text: nextText,
          description: nextDescription,
          assigneeId: nextAssigneeId,
          ...(dueDateLocalDate !== undefined && { dueDateLocalDate }),
          ...(dueDateSlot !== undefined && { dueDateSlot }),
          ...(dueDateTimezone !== undefined && { dueDateTimezone }),
          completedAt: nextCompletedAt,
          completedById: nextCompletedById,
          updatedAt: new Date(),
        })
        .where(eq(cardChecklistItems.id, itemId))
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));

      // Completing an item or clearing its due date drops any standing overdue
      // notification so it no longer shows as overdue.
      const completingItem = body.completed === true && !current.completedAt;
      const dueDateRemoved = dueDateLocalDate === null;
      if (completingItem || dueDateRemoved) {
        await clearOverdueChecklistItemNotifications(tx, [itemId]);
      }

      const activities: CoalescedActivityResult[] = [];
      let assigneeActivity: CoalescedActivityResult | null = null;
      let dueDateActivity: CoalescedActivityResult | null = null;
      if (body.text !== undefined) {
        activities.push(await recordCoalescedActivity(tx, {
          boardId: card.boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
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
      if (body.description !== undefined) {
        activities.push(await recordCoalescedActivity(tx, {
          boardId: card.boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
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
      if (assigneeChanged) {
        // Checklist-item assignment is independent of card assignment: assigning an item no
        // longer adds the user to cardAssignees. The item is surfaced as a first-class work
        // item via Global Work, Home, and digest surfaces instead, and the assignee still
        // gets the direct "assigned" notification emitted below.
        assigneeActivity = await recordCoalescedActivity(tx, {
          boardId: card.boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
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
            assigneeName: nextAssigneeName,
            previousAssigneeId: current.assigneeId,
            previousAssigneeName,
            fromValue: current.assigneeId,
            toValue: nextAssigneeId,
          },
        });
      }
      if (hasDueDateUpdate) {
        dueDateActivity = await recordCoalescedActivity(tx, {
          boardId: card.boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
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
      if (body.completed === true && !current.completedAt) {
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
            actorId: req.auth.sub,
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
      const automationEffects = body.completed === true && !current.completedAt
        ? await runChecklistCompletionAutomations(tx, {
          cardId: id,
          boardId: card.boardId,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          triggerActorId: req.auth.sub,
        })
        : { effects: [] };
      return { item: item!, activities, assigneeActivity, dueDateActivity, automationEffects, hiddenChecklistCompletionId };
    });

    for (const activity of activities) emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
    if (hiddenChecklistCompletionId) await emitActivityFeedItemDeleted(card.boardId, id, hiddenChecklistCompletionId);
    // Feed-only: due date changes never raise a notification (overdue-only scope).
    if (dueDateActivity) emitCoalescedCardActivityFeedItem(card.boardId, id, dueDateActivity, { notify: false });
    if (assigneeActivity) {
      emitCoalescedCardActivityFeedItem(card.boardId, id, assigneeActivity, { notify: false });
      if (assigneeActivity.status !== "hidden") {
        void syncDirectNotificationForActivity({
          userId: nextAssigneeId,
          activity: assigneeActivity.activity,
          reason: "assigned",
        }).catch(() => undefined);
      }
    }
    await emitAutomationEffects(automationEffects);
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId, checklistParentItemId: checklist.parentItemId, item, prevCompletedAt: current.completedAt });
    return item;
  });

  app.delete("/cards/:id/checklists/:checklistId/items/:itemId", async (req, reply) => {
    const { id, checklistId, itemId } = req.params as { id: string; checklistId: string; itemId: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");
    const [current] = await db
      .select()
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.id, itemId), eq(cardChecklistItems.checklistId, checklistId)))
      .limit(1);
    if (!current) throw notFound("checklist item not found");

    await db.transaction(async (tx) => {
      await tx.delete(cardChecklistItems).where(eq(cardChecklistItems.id, itemId));
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
    });

    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED, { boardId: card.boardId, cardId: id, checklistId, checklistParentItemId: checklist.parentItemId, itemId, completedAt: current.completedAt });
    return reply.status(204).send();
  });

  app.post("/cards/:id/checklists/:checklistId/items/:itemId/move", async (req) => {
    const { id, checklistId, itemId } = req.params as { id: string; checklistId: string; itemId: string };
    const body = dto.moveChecklistItemBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [sourceChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!sourceChecklist) throw notFound("checklist not found");
    const targetChecklistId = body.checklistId ?? checklistId;
    const [targetChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, targetChecklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!targetChecklist) throw badRequest("target checklist not on this card");
    // Item moves stay inside one ownership group: top-level lists can exchange top-level items,
    // while an item's sub-lists can exchange only that item's leaf rows. This preserves one level.
    if (sourceChecklist.parentItemId !== targetChecklist.parentItemId) {
      throw badRequest("target checklist must have the same parent item");
    }
    const [current] = await db
      .select()
      .from(cardChecklistItems)
      .where(and(eq(cardChecklistItems.id, itemId), eq(cardChecklistItems.checklistId, checklistId)))
      .limit(1);
    if (!current) throw notFound("checklist item not found");
    const prevPosition = current.position;

    const { position, sourceRebalanced, targetRebalanced } = await db.transaction(async (tx) => {
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

    if (sourceRebalanced) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, { boardId: card.boardId, cardId: id, checklistId, positions: sourceRebalanced });
    if (targetRebalanced) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, { boardId: card.boardId, cardId: id, checklistId: targetChecklistId, positions: targetRebalanced });
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED, {
      boardId: card.boardId,
      cardId: id,
      itemId,
      fromChecklistId: checklistId,
      toChecklistId: targetChecklistId,
      position,
      prevPosition,
    });
    return { id: itemId, checklistId: targetChecklistId, position };
  });

  app.patch("/cards/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardArchivedBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");

    const archivedAt = body.archived ? (card.archivedAt ?? new Date()) : null;
    if (body.archived === Boolean(card.archivedAt)) {
      return toWireCard(card, req.auth.cid);
    }

    const { updated, activity, deletedNotifications } = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(cards)
        .set({ archivedAt, updatedAt: new Date() })
        .where(eq(cards.id, id))
        .returning();

      const activity = await recordActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: body.archived ? ACTIVITY_ACTION.ARCHIVED : ACTIVITY_ACTION.UNARCHIVED,
        payload: { title: card.title, archivedAt },
      });
      const deletedNotifications = body.archived ? await clearNotificationsForCards(tx, [id]) : [];
      return { updated: updated!, activity, deletedNotifications };
    });
    emitDeletedNotifications(deletedNotifications);
    emitCardActivityFeedItem(card.boardId, id, activity, { notify: false });
    const wireCard = toWireCard(updated, req.auth.cid);
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: card.boardId, card: wireCard });
    // Archiving hides the card from any "Up next" queue holding it (and restoring brings it back)
    // without touching the queue rows, so those audiences are pinged separately.
    await invalidateQueuesForCards([id]);
    return wireCard;
  });

  app.delete("/cards/:id/custom-fields/:fieldId", async (req, reply) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const [field] = await db.select().from(customFields).where(eq(customFields.id, fieldId)).limit(1);
    if (!field || field.workspaceId !== ctx.workspaceId) throw notFound("custom field not found");
    const [currentValue] = await db
      .select()
      .from(cardCustomFieldValues)
      .where(and(eq(cardCustomFieldValues.cardId, id), eq(cardCustomFieldValues.fieldId, fieldId)))
      .limit(1);
    // Clearing a checkbox returns it to the visible "No" state, which describe collapses
    // to "false"; scalar/select/user clear to null.
    const fromValue = await describeCustomFieldValue(field, currentValue);
    const toValue = await describeCustomFieldValue(field, null);

    await db
      .delete(cardCustomFieldValues)
      .where(and(eq(cardCustomFieldValues.cardId, id), eq(cardCustomFieldValues.fieldId, fieldId)));
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, { boardId: card.boardId, cardId: id, fieldId });
    const activity = await recordCoalescedActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET,
      coalesceKey: `customField:${fieldId}`,
      windowMs: 60_000,
      fromValue,
      toValue,
      payload: {
        fieldId,
        fieldName: field.name,
        fieldType: field.type,
        fromValue,
        toValue,
      },
    });
    emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
    return reply.status(204).send();
  });

  app.put("/cards/:id/labels", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardLabelsBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const currentAssignments = await db
      .select({ labelId: cardLabelAssignments.labelId })
      .from(cardLabelAssignments)
      .where(eq(cardLabelAssignments.cardId, id));
    const previousLabelIds = currentAssignments.map((assignment) => assignment.labelId);
    const previousLabelIdSet = new Set(previousLabelIds);
    const nextLabelIdSet = new Set(body.labelIds);
    let labelNames: string[] = [];
    let addedLabelNames: string[] = [];
    let removedLabelNames: string[] = [];
    let labelNamesById: Record<string, string> = {};

    if (body.labelIds.length > 0) {
      const validLabels = await db
        .select({ id: cardLabels.id, name: cardLabels.name })
        .from(cardLabels)
        .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, body.labelIds), isNull(cardLabels.archivedAt)));
      if (validLabels.length !== body.labelIds.length) throw badRequest("one or more label ids are invalid");

      const labelNameById = new Map(validLabels.map((label) => [label.id, label.name]));
      labelNamesById = Object.fromEntries(validLabels.map((label) => [label.id, label.name]));
      labelNames = body.labelIds
        .map((labelId) => labelNameById.get(labelId))
        .filter((labelName): labelName is string => Boolean(labelName));

      addedLabelNames = body.labelIds
        .filter((labelId) => !previousLabelIdSet.has(labelId))
        .map((labelId) => labelNameById.get(labelId))
        .filter((labelName): labelName is string => Boolean(labelName));
    }

    if (previousLabelIds.length > 0) {
      const removedLabelIds = previousLabelIds.filter((labelId) => !nextLabelIdSet.has(labelId));
      if (removedLabelIds.length > 0) {
        const previousLabels = await db
          .select({ id: cardLabels.id, name: cardLabels.name })
          .from(cardLabels)
          .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, removedLabelIds)));
        const previousLabelNameById = new Map(previousLabels.map((label) => [label.id, label.name]));
        labelNamesById = {
          ...labelNamesById,
          ...Object.fromEntries(previousLabels.map((label) => [label.id, label.name])),
        };
        removedLabelNames = removedLabelIds
          .map((labelId) => previousLabelNameById.get(labelId))
          .filter((labelName): labelName is string => Boolean(labelName));
      }
    }

    const previousSortedLabelIds = sortedIds(previousLabelIds);
    const nextSortedLabelIds = sortedIds(body.labelIds);
    const addedLabelIds = body.labelIds.filter((labelId) => !previousLabelIdSet.has(labelId));
    const { activity, automationEffects, finalLabelIds } = await db.transaction(async (tx) => {
      await tx.delete(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, id));
      if (body.labelIds.length > 0) {
        await tx.insert(cardLabelAssignments).values(body.labelIds.map((labelId) => ({ cardId: id, labelId })));
      }
      const activity = await recordCoalescedActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.LABELS_SET,
        coalesceKey: "card:labels",
        windowMs: CARD_LABEL_MISTAKE_WINDOW_MS,
        fromValue: previousSortedLabelIds,
        toValue: nextSortedLabelIds,
        payload: {
          labelIds: body.labelIds,
          labelNames,
          addedLabelNames,
          removedLabelNames,
          labelNamesById,
          fromValue: previousSortedLabelIds,
          toValue: nextSortedLabelIds,
        },
      });
      // Only newly added labels can fire label-set automations. Effects from
      // automation label actions are emitted later and intentionally do not cascade.
      const automationEffects = await runCardLabelSetAutomations(tx, {
        cardId: id,
        addedLabelIds,
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        triggerActorId: req.auth.sub,
      });
      const finalAssignments = await tx
        .select({ labelId: cardLabelAssignments.labelId })
        .from(cardLabelAssignments)
        .where(eq(cardLabelAssignments.cardId, id));
      return { activity, automationEffects, finalLabelIds: finalAssignments.map((assignment) => assignment.labelId) };
    });

    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId: card.boardId, cardId: id, labelIds: body.labelIds });
    await emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
    await emitAutomationEffects(automationEffects);
    return { labelIds: finalLabelIds };
  });

  app.put("/cards/:id/assignees", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardAssigneesBody.parse(req.body);
    const nextUserIds = Array.from(new Set(body.userIds));
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    if (nextUserIds.length > 0) {
      const eligibleUserIds = await ensureBoardMembershipForUsers(card.boardId, ctx.workspaceId, nextUserIds);
      if (eligibleUserIds.length !== nextUserIds.length) {
        throw badRequest("one or more user ids are not assignable members");
      }
    }

    const currentAssignments = await db
      .select({ userId: cardAssignees.userId })
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, id));
    const previousUserIds = currentAssignments.map((assignment) => assignment.userId);
    const previousUserIdSet = new Set(previousUserIds);
    const nextUserIdSet = new Set(nextUserIds);
    const addedUserIds = nextUserIds.filter((userId) => !previousUserIdSet.has(userId));
    const removedUserIds = previousUserIds.filter((userId) => !nextUserIdSet.has(userId));
    const relevantUserIds = Array.from(new Set([...previousUserIds, ...nextUserIds]));
    let addedAssigneeNames: string[] = [];
    let removedAssigneeNames: string[] = [];
    let assigneeNamesById: Record<string, string> = {};

    if (relevantUserIds.length > 0) {
      const changedUsers = await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, relevantUserIds));
      const userNameById = new Map(changedUsers.map((user) => [user.id, user.displayName]));
      assigneeNamesById = Object.fromEntries(changedUsers.map((user) => [user.id, user.displayName]));
      addedAssigneeNames = addedUserIds
        .map((userId) => userNameById.get(userId))
        .filter((displayName): displayName is string => Boolean(displayName));
      removedAssigneeNames = removedUserIds
        .map((userId) => userNameById.get(userId))
        .filter((displayName): displayName is string => Boolean(displayName));
    }

    const previousSortedUserIds = sortedIds(previousUserIds);
    const nextSortedUserIds = sortedIds(nextUserIds);
    const { activity, automationEffects, finalAssigneeIds } = await db.transaction(async (tx) => {
      await tx.delete(cardAssignees).where(eq(cardAssignees.cardId, id));
      if (nextUserIds.length > 0) {
        await tx.insert(cardAssignees).values(nextUserIds.map((userId) => ({ cardId: id, userId })));
      }

      const activity = await recordCoalescedActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.ASSIGNEES_SET,
        coalesceKey: "card:assignees",
        windowMs: CARD_ASSIGNEE_MISTAKE_WINDOW_MS,
        fromValue: previousSortedUserIds,
        toValue: nextSortedUserIds,
        payload: {
          assigneeIds: nextUserIds,
          addedAssigneeNames,
          removedAssigneeNames,
          assigneeNamesById,
          fromValue: previousSortedUserIds,
          toValue: nextSortedUserIds,
        },
      });
      // Assignment-triggered automations should only run for newly added users;
      // unchanged or removed assignees must not replay actions.
      const automationEffects = await runCardAssignedAutomations(tx, {
        cardId: id,
        addedUserIds,
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        triggerActorId: req.auth.sub,
      });
      const finalAssignments = await tx
        .select({ userId: cardAssignees.userId })
        .from(cardAssignees)
        .where(eq(cardAssignees.cardId, id));
      return { activity, automationEffects, finalAssigneeIds: finalAssignments.map((assignment) => assignment.userId) };
    });
    await enqueueCardAssignedEmails({
      tx: db,
      mailer: app.mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: id,
      actorId: req.auth.sub,
      recipientUserIds: addedUserIds,
    });
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId: card.boardId, cardId: id, assigneeIds: finalAssigneeIds });
    await emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
    await emitAutomationEffects(automationEffects);
    // Un-assigning drops a queued card out of the target's live "Up next" queue (and re-assigning
    // restores it) without touching card_priorities rows, so open queues must be pinged here.
    await invalidateQueuesForCards([id]);
    return { assigneeIds: finalAssigneeIds };
  });
}
