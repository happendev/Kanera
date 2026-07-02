import { dto } from "@kanera/shared";
import { SERVER_EVENTS, type WireCard, type WireCardChecklist, type WireCardDetail } from "@kanera/shared/events";
import { ACTIVITY_ACTION, activityEvents, boardMembers, boards, cardAssignees, cardAttachments, cardChecklistItems, cardChecklists, cardChecklistTemplateApplications, cardCustomFieldValues, cardLabelAssignments, cardLabels, cards, cardWatchers, customFieldOptions, customFields, lists, users, workspaceMembers, type ActivityEvent, type CardCustomFieldValue, type CustomFieldType } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { env } from "../../env.js";
import { assertBoardAccess } from "../../lib/access.js";
import {
  emitActivityFeedItem,
  emitActivityFeedItemDeleted,
  emitActivityFeedItemUpdated,
  recordActivity,
  recordCoalescedActivity,
  type CoalescedActivityResult,
} from "../../lib/activity.js";
import { enqueueCardAssignedEmails, enqueueDueDateChangedEmails } from "../../lib/assignee-email-notifications.js";
import { EMPTY_EFFECTS, emitAutomationEffects, runCardAssignedAutomations, runCardLabelSetAutomations, runCardMarkedCompleteAutomations, runChecklistCompletionAutomations, runListEntryAutomations, type AutomationEffects } from "../../lib/automations.js";
import { applyChecklistTemplates } from "../../lib/checklist-templates.js";
import { emitLaneRebalanced, positionForLaneInsert, rebalanceBoardLane } from "../../lib/board-lane.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { externalEmbeddedMediaReferences, signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { clearNotificationsForCards, clearOverdueChecklistItemNotifications, clearOverdueNotificationsForCards, emitDeletedNotifications, syncDirectNotificationForActivity } from "../../lib/notifications.js";
import { createOverdueNotificationsForCards } from "../../lib/overdue-notifications.js";
import { between } from "../../lib/position.js";
import { emitCardRebalancedByBoard, rebalanceCards } from "../../lib/rebalance.js";
import type { StorageProvider } from "../../lib/storage/index.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey, attachmentThumbnailStorageKey, cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { emitToBoard, emitToUser } from "../../realtime/emit.js";
import { loadLinkedNotesForCard, repairInternalLinksAroundCard, replaceInternalLinksForSource } from "../../lib/internal-links.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const CHECKLIST_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const CARD_ASSIGNEE_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const CARD_LABEL_MISTAKE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const CUSTOM_FIELD_VALUE_COLUMN_BY_TYPE = {
  text: "valueText",
  number: "valueNumber",
  checkbox: "valueCheckbox",
  date: "valueDate",
  url: "valueUrl",
  select: "valueOptionIds",
  user: "valueUserIds",
} as const satisfies Record<CustomFieldType, keyof CardCustomFieldValue>;
const CUSTOM_FIELD_VALUE_COLUMNS = [
  "valueText",
  "valueNumber",
  "valueCheckbox",
  "valueDate",
  "valueUrl",
  "valueOptionIds",
  "valueUserIds",
] as const satisfies readonly (keyof CardCustomFieldValue)[];

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

function cardUrl(boardId: string, cardId: string): string {
  return new URL(`/b/${boardId}/c/${cardId}`, env.WEB_ORIGIN).toString();
}

function toWireCard(card: typeof cards.$inferSelect, clientId: string): WireCard {
  return {
    ...card,
    description: signEmbeddedMediaUrls(card.description, clientId),
    url: cardUrl(card.boardId, card.id),
  };
}

async function ensureBoardMembershipForUsers(
  boardId: string,
  workspaceId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const [board] = await db
    .select({ visibility: boards.visibility })
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);
  if (!board) return [];

  const [workspaceEligible, existingMembers] = await Promise.all([
    db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, userIds),
        // Assignment represents ownership of work. Observers can watch cards and receive
        // notifications, but they cannot be card owners.
        sql`${workspaceMembers.role} <> 'observer'::member_role`,
      )),
    db
      .select({ userId: boardMembers.userId, role: boardMembers.role })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), inArray(boardMembers.userId, userIds))),
  ]);
  const workspaceEligibleIds = new Set(workspaceEligible.map((m) => m.userId));
  const boardEligibleIds = new Set(existingMembers.filter((m) => m.role !== "observer").map((m) => m.userId));
  const existingIds = new Set(existingMembers.map((m) => m.userId));
  const needsAdding = userIds.filter((uid) => workspaceEligibleIds.has(uid) && !existingIds.has(uid));
  const finalEligibleIds = userIds.filter((uid) => {
    if (boardEligibleIds.has(uid)) return true;
    if (!workspaceEligibleIds.has(uid)) return false;
    return board.visibility !== "private" || needsAdding.includes(uid);
  });

  if (needsAdding.length > 0) {
    const inserted = await db
      .insert(boardMembers)
      .values(needsAdding.map((userId) => ({ boardId, userId, role: "editor" as const })))
      .returning();
    const userRows = await db
      .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId })
      .from(users)
      .where(inArray(users.id, needsAdding));
    const userById = new Map(userRows.map((u) => [u.id, u]));
    for (const m of inserted) {
      const u = userById.get(m.userId);
      if (!u) continue;
      const payload = {
        boardId,
        member: m,
        user: {
          userId: u.id,
          displayName: u.displayName,
          avatarUrl: withSignedMedia(u.clientId, { avatarUrl: u.avatarUrl }).avatarUrl,
          role: m.role,
          source: "board" as const,
        },
      };
      // Assignment to a private board auto-adds eligible workspace members as board members.
      // Keep this durable event ahead of card:assignees:set so clients never reject the
      // assignment as referencing an unknown board member during outbox replay.
      await emitToBoard(boardId, SERVER_EVENTS.BOARD_MEMBER_ADDED, payload);
      emitToUser(u.id, SERVER_EVENTS.BOARD_MEMBER_ADDED, payload);
    }
  }

  return finalEligibleIds;
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

async function loadBulkBoardCards(boardId: string, cardIds: readonly string[]) {
  const uniqueIds = orderedUniqueIds(cardIds);
  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.boardId, boardId), inArray(cards.id, uniqueIds)));
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
  afterId?: string | null,
  beforeId?: string | null,
  tx: Tx = db,
) {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(eq(cardChecklists.cardId, cardId))
      .orderBy(asc(cardChecklists.position))
      .limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(eq(cardChecklists.cardId, cardId))
      .orderBy(desc(cardChecklists.position))
      .limit(1);
    prev = last?.position ?? null;
  } else if (afterId) {
    const [after] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, afterId), eq(cardChecklists.cardId, cardId)))
      .limit(1);
    if (!after) throw badRequest("afterChecklistId not found");
    const [nextRow] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.cardId, cardId), gt(cardChecklists.position, after.position)))
      .orderBy(asc(cardChecklists.position))
      .limit(1);
    prev = after.position;
    next = nextRow?.position ?? null;
  } else if (beforeId) {
    const [before] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, beforeId), eq(cardChecklists.cardId, cardId)))
      .limit(1);
    if (!before) throw badRequest("beforeChecklistId not found");
    const [prevRow] = await tx
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(and(eq(cardChecklists.cardId, cardId), lt(cardChecklists.position, before.position)))
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

async function rebalanceChecklists(cardId: string, tx: Tx = db) {
  const rows = await tx
    .select({ id: cardChecklists.id })
    .from(cardChecklists)
    .where(eq(cardChecklists.cardId, cardId))
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

async function loadChecklistsForCard(cardId: string, tx: Tx = db): Promise<WireCardChecklist[]> {
  const [checklistRows, itemRows] = await Promise.all([
    tx.select().from(cardChecklists).where(eq(cardChecklists.cardId, cardId)).orderBy(asc(cardChecklists.position)),
    tx
      .select({
        item: cardChecklistItems,
        checklistId: cardChecklistItems.checklistId,
      })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .where(eq(cardChecklists.cardId, cardId))
      .orderBy(asc(cardChecklists.position), asc(cardChecklistItems.position)),
  ]);
  const itemsByChecklist = new Map<string, typeof cardChecklistItems.$inferSelect[]>();
  for (const row of itemRows) {
    const items = itemsByChecklist.get(row.checklistId);
    if (items) items.push(row.item);
    else itemsByChecklist.set(row.checklistId, [row.item]);
  }
  return checklistRows.map((checklist) => ({
    ...checklist,
    items: itemsByChecklist.get(checklist.id) ?? [],
  }));
}

async function copyAttachmentBlobs(
  storage: StorageProvider,
  clientId: string,
  source: typeof cardAttachments.$inferSelect,
  newCardId: string,
): Promise<{
  fileKey: string;
  url: string;
  thumbnailFileKey: string | null;
  thumbnailUrl: string | null;
  coverImageFileKey: string | null;
  coverImageUrl: string | null;
}> {
  const ext = source.fileKey.includes(".") ? source.fileKey.slice(source.fileKey.lastIndexOf(".") + 1) : "";
  const baseKey = cardAttachmentStorageKey(newCardId, ext);

  const originalBuffer = await storage.get(source.fileKey);
  await storage.put(baseKey, originalBuffer, source.mimeType);
  const url = unsignedMediaUrl(clientId, baseKey) ?? baseKey;

  let thumbnailFileKey: string | null = null;
  let thumbnailUrl: string | null = null;
  if (source.thumbnailFileKey) {
    const buf = await storage.get(source.thumbnailFileKey);
    thumbnailFileKey = attachmentThumbnailStorageKey(baseKey);
    await storage.put(thumbnailFileKey, buf, "image/jpeg");
    thumbnailUrl = unsignedMediaUrl(clientId, thumbnailFileKey);
  }

  let coverImageFileKey: string | null = null;
  let coverImageUrl: string | null = null;
  if (source.coverImageFileKey) {
    const buf = await storage.get(source.coverImageFileKey);
    coverImageFileKey = attachmentCoverStorageKey(baseKey);
    await storage.put(coverImageFileKey, buf, "image/jpeg");
    coverImageUrl = unsignedMediaUrl(clientId, coverImageFileKey);
  }

  return { fileKey: baseKey, url, thumbnailFileKey, thumbnailUrl, coverImageFileKey, coverImageUrl };
}

export async function cardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/cards/:id/detail", async (req): Promise<WireCardDetail> => {
    const { id } = req.params as { id: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertBoardAccess(req.auth, card.boardId);
    await repairInternalLinksAroundCard(req.auth, id, ctx.workspaceId);

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
      attachments: attachments.map((attachment) => ({
        ...shapeAttachmentMedia(attachment),
        uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: attachment.uploadedByAvatarUrl }).uploadedByAvatarUrl,
      })),
      checklists,
      appliedChecklistTemplateIds: appliedTemplateRows.map((row) => row.templateId),
      linkedNotes,
    };
  });

  app.post("/boards/:boardId/lists/:id/cards", async (req, reply) => {
    const { boardId, id: listId } = req.params as { boardId: string; id: string };
    const body = dto.createCardBody.parse(req.body);
    assertIntegrationEmbeddedMediaStoredLocally(body.description, req.auth.cid, req.auth.authKind);
    const description = stripSignedEmbeddedMediaUrls(body.description ?? null, req.auth.cid);
    const assigneeIds = Array.from(new Set(body.assigneeIds ?? []));

    const [list] = await db.select().from(lists).where(eq(lists.id, listId)).limit(1);
    if (!list) throw notFound();
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    if (list.workspaceId !== ctx.workspaceId) throw badRequest("target list not in board workspace");
    if (assigneeIds.length > 0) {
      const eligibleUserIds = await ensureBoardMembershipForUsers(boardId, ctx.workspaceId, assigneeIds);
      if (eligibleUserIds.length !== assigneeIds.length) {
        throw badRequest("one or more user ids are not assignable members");
      }
    }

    const position = body.atTop
      ? await topPositionForList(boardId, listId)
      : await bottomPositionForList(boardId, listId);

    const { card, finalCard, activity, automationEffects, assignmentAutomationEffects } = await db.transaction(async (tx) => {
      const [card] = await tx
        .insert(cards)
        .values({
          listId,
          boardId,
          title: body.title,
          description,
          position,
          createdById: req.auth.sub,
        })
        .returning();

      if (assigneeIds.length > 0) {
        await tx.insert(cardAssignees).values(assigneeIds.map((userId) => ({ cardId: card!.id, userId })));
      }

      await replaceCardMentions({
        tx,
        boardId,
        cardId: card!.id,
        source: "description",
        markdown: description,
      });
      await replaceInternalLinksForSource({
        tx,
        claims: req.auth,
        workspaceId: ctx.workspaceId,
        sourceType: "card",
        sourceId: card!.id,
        markdown: description,
      });

      if (shouldAutoWatchAuthoredCards(req.auth.authKind)) {
        await tx
          .insert(cardWatchers)
          .values({ cardId: card!.id, userId: req.auth.sub })
          .onConflictDoNothing();
      }

      const activity = await recordActivity(tx, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: card!.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: { title: card!.title, listId },
      });
      // App and public API card creation share this route; keep list-entry
      // automations here so both surfaces behave the same.
      const automationEffects = await runListEntryAutomations(tx, {
        cardId: card!.id,
        listId,
        boardId,
        workspaceId: ctx.workspaceId,
        clientId: req.auth.cid,
        trigger: "create",
        triggerActorId: req.auth.sub,
      });
      // Creating from Assigned Work assigns the card immediately, so assignment-triggered
      // automations and notifications need to see the same committed card as ordinary creation.
      const assignmentAutomationEffects: AutomationEffects = assigneeIds.length > 0
        ? await runCardAssignedAutomations(tx, {
            cardId: card!.id,
            addedUserIds: assigneeIds,
            boardId,
            workspaceId: ctx.workspaceId,
            clientId: ctx.clientId,
            triggerActorId: req.auth.sub,
          })
        : { effects: [] };
      const [finalCard] = await tx.select().from(cards).where(eq(cards.id, card!.id)).limit(1);
      return { card: card!, finalCard: finalCard ?? card!, activity, automationEffects, assignmentAutomationEffects };
    });
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
      await emitAutomationEffects(assignmentAutomationEffects);
      emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: card.id, assigneeIds });
    }
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
        isNull(cards.archivedAt),
        body.completed ? isNull(cards.completedAt) : isNotNull(cards.completedAt),
      ));

    if (targetCards.length === 0) return { updated: 0 };

    const completedAt = body.completed ? new Date() : null;
    const updates = await db.transaction(async (tx) => {
      const rows: { card: typeof cards.$inferSelect; activity: ActivityEvent; automationEffects: AutomationEffects }[] = [];
      for (const row of targetCards) {
        const [card] = await tx
          .update(cards)
          .set({ completedAt, updatedAt: new Date() })
          .where(eq(cards.id, row.card.id))
          .returning();
        const activity = await recordActivity(tx, {
          boardId: row.card.boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: row.card.id,
          action: body.completed ? ACTIVITY_ACTION.COMPLETED : ACTIVITY_ACTION.UNCOMPLETED,
          payload: { completedAt },
        });
        if (body.completed) {
          await clearOverdueNotificationsForCards(tx, [row.card.id]);
        } else {
          await createOverdueNotificationsForCards(tx, [row.card.id]);
        }
        const automationEffects = body.completed
          ? await runCardMarkedCompleteAutomations(tx, {
            cardId: row.card.id,
            boardId: row.card.boardId,
            workspaceId: ctx.workspaceId,
            clientId: ctx.clientId,
            triggerActorId: req.auth.sub,
          })
          : { effects: [] };
        rows.push({ card: card!, activity, automationEffects });
      }
      return rows;
    });

    for (const { card, activity, automationEffects } of updates) {
      const wireCard = toWireCard(card, req.auth.cid);
      await emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: card.boardId, card: wireCard });
      await emitCardActivityFeedItem(card.boardId, card.id, activity, { notify: body.completed });
      await emitAutomationEffects(automationEffects);
    }
    return { updated: updates.length };
  });

  app.patch("/boards/:boardId/cards/bulk/completion", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardCompletionBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const changingCards = targetCards.filter((card) => body.completed !== Boolean(card.completedAt));
    if (changingCards.length === 0) return { updated: 0, cards: [], skippedCardIds };

    const completedAt = body.completed ? new Date() : null;
    const updates = await db.transaction(async (tx) => {
      const rows: { card: typeof cards.$inferSelect; finalCard: typeof cards.$inferSelect; activity: CoalescedActivityResult; automationEffects: AutomationEffects }[] = [];
      for (const current of changingCards) {
        const [card] = await tx
          .update(cards)
          .set({ completedAt, updatedAt: new Date() })
          .where(eq(cards.id, current.id))
          .returning();
        const activity = await recordCoalescedActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: current.id,
          action: ACTIVITY_ACTION.COMPLETION_SET,
          coalesceKey: "card:completion",
          windowMs: 60_000,
          fromValue: Boolean(current.completedAt),
          toValue: body.completed,
          payload: { completedAt, fromValue: Boolean(current.completedAt), toValue: body.completed },
        });
        if (body.completed) await clearOverdueNotificationsForCards(tx, [current.id]);
        else await createOverdueNotificationsForCards(tx, [current.id]);
        const automationEffects = body.completed
          ? await runCardMarkedCompleteAutomations(tx, {
            cardId: current.id,
            boardId,
            workspaceId: ctx.workspaceId,
            clientId: ctx.clientId,
            triggerActorId: req.auth.sub,
          })
          : { effects: [] };
        const [finalCard] = await tx.select().from(cards).where(eq(cards.id, current.id)).limit(1);
        rows.push({ card: card!, finalCard: finalCard ?? card!, activity, automationEffects });
      }
      return rows;
    });

    for (const { card, activity, automationEffects } of updates) {
      await emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: toWireCard(card, req.auth.cid) });
      await emitCoalescedCardActivityFeedItem(boardId, card.id, activity, { notify: body.completed });
      await emitAutomationEffects(automationEffects);
    }
    return { updated: updates.length, cards: updates.map(({ finalCard }) => toWireCard(finalCard, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/due-date", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardDueDateBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
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
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
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
    return { updated: updates.length, skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/assignees", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkPatchCardAssigneesBody.parse(req.body);
    const userIds = orderedUniqueIds(body.userIds);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
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
    return { updated: updates.length, skippedCardIds };
  });

  app.post("/boards/:boardId/cards/bulk/move", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkMoveCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
    if (!targetList || targetList.workspaceId !== ctx.workspaceId) throw badRequest("target list not in same workspace");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
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
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
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
    return { archived: updates.length, cards: updates.map(({ card }) => toWireCard(card, req.auth.cid)), skippedCardIds: [] };
  });

  app.post("/boards/:boardId/cards/bulk/duplicate", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkDuplicateCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const created: WireCard[] = [];

    for (const source of targetCards) {
      const position = await bottomPositionForList(boardId, source.listId);
      const [sourceLabels, sourceAssignees, sourceFieldValues, sourceAttachments, sourceChecklists, sourceTemplateApplications] = await Promise.all([
        db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, source.id)),
        db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, source.id)),
        db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, source.id)),
        db.select().from(cardAttachments).where(eq(cardAttachments.cardId, source.id)),
        loadChecklistsForCard(source.id),
        db.select({ templateId: cardChecklistTemplateApplications.templateId }).from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, source.id)),
      ]);
      const eligibleAssigneeIds = await ensureBoardMembershipForUsers(boardId, ctx.workspaceId, sourceAssignees.map((a) => a.userId));
      const storage = await getStorageForClient(req.auth.cid);
      const newCardId = randomUUID();
      const copiedAttachments = await Promise.all(sourceAttachments.map(async (att) => ({
        src: att,
        copy: await copyAttachmentBlobs(storage, req.auth.cid, att, newCardId),
      })));
      const { newCard, activity } = await db.transaction(async (tx) => {
        const [newCard] = await tx.insert(cards).values({
          id: newCardId,
          listId: source.listId,
          boardId,
          title: source.title,
          description: source.description,
          dueDateLocalDate: source.dueDateLocalDate,
          dueDateSlot: source.dueDateSlot,
          dueDateTimezone: source.dueDateTimezone,
          position,
          createdById: req.auth.sub,
        }).returning();
        if (shouldAutoWatchAuthoredCards(req.auth.authKind)) {
          await tx.insert(cardWatchers).values({ cardId: newCard!.id, userId: req.auth.sub }).onConflictDoNothing();
        }
        if (sourceLabels.length > 0) {
          await tx.insert(cardLabelAssignments).values(sourceLabels.map((row) => ({ cardId: newCard!.id, labelId: row.labelId })));
        }
        if (eligibleAssigneeIds.length > 0) {
          await tx.insert(cardAssignees).values(eligibleAssigneeIds.map((userId) => ({ cardId: newCard!.id, userId })));
        }
        if (sourceFieldValues.length > 0) {
          await tx.insert(cardCustomFieldValues).values(sourceFieldValues.map((value) => ({
            cardId: newCard!.id,
            fieldId: value.fieldId,
            valueText: value.valueText,
            valueNumber: value.valueNumber,
            valueCheckbox: value.valueCheckbox,
            valueDate: value.valueDate,
            valueUrl: value.valueUrl,
            valueOptionIds: value.valueOptionIds,
            valueUserIds: value.valueUserIds,
          })));
        }
        if (sourceTemplateApplications.length > 0) {
          await tx
            .insert(cardChecklistTemplateApplications)
            .values(sourceTemplateApplications.map((row) => ({ cardId: newCard!.id, templateId: row.templateId })))
            .onConflictDoNothing();
        }
        for (const sourceChecklist of sourceChecklists) {
          const [checklist] = await tx.insert(cardChecklists).values({
            cardId: newCard!.id,
            title: sourceChecklist.title,
            position: sourceChecklist.position,
          }).returning();
          if (sourceChecklist.items.length > 0) {
            await tx.insert(cardChecklistItems).values(sourceChecklist.items.map((item) => ({
              checklistId: checklist!.id,
              text: item.text,
              position: item.position,
              assigneeId: item.assigneeId && eligibleAssigneeIds.includes(item.assigneeId) ? item.assigneeId : null,
              completedAt: item.completedAt ? new Date(item.completedAt as unknown as string) : null,
              completedById: item.completedById,
              dueDateLocalDate: item.dueDateLocalDate,
              dueDateSlot: item.dueDateSlot,
              dueDateTimezone: item.dueDateTimezone,
            })));
          }
        }
        let finalCard = newCard!;
        let newCoverAttachmentId: string | null = null;
        for (const { src, copy } of copiedAttachments) {
          const [attachment] = await tx.insert(cardAttachments).values({
            cardId: newCard!.id,
            clientId: ctx.clientId,
            uploadedById: req.auth.sub,
            fileName: src.fileName,
            mimeType: src.mimeType,
            byteSize: src.byteSize,
            fileKey: copy.fileKey,
            url: copy.url,
            thumbnailFileKey: copy.thumbnailFileKey,
            thumbnailUrl: copy.thumbnailUrl,
            coverImageFileKey: copy.coverImageFileKey,
            coverImageUrl: copy.coverImageUrl,
            source: src.source === "comment" ? "attachment" : src.source,
            commentId: null,
          }).returning();
          if (source.coverAttachmentId === src.id) newCoverAttachmentId = attachment!.id;
        }
        if (newCoverAttachmentId) {
          const [withCover] = await tx
            .update(cards)
            .set({ coverAttachmentId: newCoverAttachmentId, updatedAt: new Date() })
            .where(eq(cards.id, newCard!.id))
            .returning();
          finalCard = withCover!;
        }
        const activity = await recordActivity(tx, {
          boardId,
          workspaceId: ctx.workspaceId,
          actorId: req.auth.sub,
          entityType: "card",
          entityId: finalCard.id,
          action: ACTIVITY_ACTION.CREATED,
          payload: { title: finalCard.title, listId: finalCard.listId, duplicatedFromId: source.id, bulk: true },
        });
        return { newCard: finalCard, activity };
      });
      const wireCard = toWireCard(newCard, req.auth.cid);
      await emitToBoard(boardId, SERVER_EVENTS.CARD_CREATED, { boardId, card: wireCard });
      await emitCardActivityFeedItem(boardId, newCard.id, activity);
      const copiedChecklists = await loadChecklistsForCard(newCard.id);
      for (const checklist of copiedChecklists) {
        emitToBoard(boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId, cardId: newCard.id, checklist });
      }
      if (sourceLabels.length > 0) emitToBoard(boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId, cardId: newCard.id, labelIds: sourceLabels.map((row) => row.labelId) });
      if (eligibleAssigneeIds.length > 0) emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: newCard.id, assigneeIds: eligibleAssigneeIds });
      if (copiedAttachments.length > 0) {
        const userRow = await db.select({ displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
        for (const att of await db
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
            source: cardAttachments.source,
            commentId: cardAttachments.commentId,
          })
          .from(cardAttachments)
          .where(eq(cardAttachments.cardId, newCard.id))) {
          emitToBoard(boardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
            boardId,
            cardId: newCard.id,
            attachment: {
              ...shapeAttachmentMedia(att),
              uploadedByName: userRow[0]?.displayName ?? "",
              uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: userRow[0]?.avatarUrl ?? null }).uploadedByAvatarUrl,
            },
          });
        }
      }
      created.push(wireCard);
    }

    return reply.status(201).send({ duplicated: created.length, cards: created, skippedCardIds });
  });

  app.patch("/cards/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCardBody.parse(req.body);
    assertIntegrationEmbeddedMediaStoredLocally(body.description, req.auth.cid, req.auth.authKind);
    const description = body.description === undefined
      ? undefined
      : stripSignedEmbeddedMediaUrls(body.description, req.auth.cid);

    const [current] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertBoardAccess(req.auth, current.boardId, "editor");
    assertCardActive(current);
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
    // Description saves are often repeated while someone is drafting. Coalesce
    // only description-only patches so title and due date history stays precise.
    const isDescriptionOnlyUpdate = body.description !== undefined
      && body.title === undefined
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
    const ctx = await assertBoardAccess(req.auth, current.boardId, "editor");
    assertCardActive(current);
    if (body.completed === Boolean(current.completedAt)) {
      return toWireCard(current, req.auth.cid);
    }

    const completedAt = body.completed ? new Date() : null;
    const { card, finalCard, activity, automationEffects } = await db.transaction(async (tx) => {
      const [card] = await tx
        .update(cards)
        .set({ completedAt, updatedAt: new Date() })
        .where(eq(cards.id, id))
        .returning();

      const activity = await recordCoalescedActivity(tx, {
        boardId: current.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.COMPLETION_SET,
        coalesceKey: "card:completion",
        windowMs: 60_000,
        fromValue: Boolean(current.completedAt),
        toValue: body.completed,
        payload: {
          completedAt,
          fromValue: Boolean(current.completedAt),
          toValue: body.completed,
        },
      });

      if (body.completed) {
        await clearOverdueNotificationsForCards(tx, [id]);
      } else {
        await createOverdueNotificationsForCards(tx, [id]);
      }

      const automationEffects = body.completed
        ? await runCardMarkedCompleteAutomations(tx, {
          cardId: id,
          boardId: current.boardId,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          triggerActorId: req.auth.sub,
        })
        : { effects: [] };
      const [finalCard] = await tx.select().from(cards).where(eq(cards.id, id)).limit(1);

      return { card: card!, finalCard: finalCard ?? card!, activity, automationEffects };
    });

    const wireCard = toWireCard(card, req.auth.cid);
    await emitToBoard(current.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: current.boardId, card: wireCard });
    await emitCoalescedCardActivityFeedItem(current.boardId, id, activity, { notify: body.completed });
    await emitAutomationEffects(automationEffects);
    return toWireCard(finalCard, req.auth.cid);
  });

  app.post("/cards/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardBody.parse(req.body);

    const [current] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertBoardAccess(req.auth, current.boardId, "editor");
    assertCardActive(current);

    const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
    if (!targetList || targetList.workspaceId !== ctx.workspaceId) {
      throw badRequest("target list not in same workspace");
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
      const result = await positionForLaneInsert({
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
    return { id, listId: finalListId, position: finalPosition };
  });

  app.post("/cards/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.duplicateCardBody.parse(req.body ?? {});

    const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!source) throw notFound();
    const srcCtx = await assertBoardAccess(req.auth, source.boardId, "editor");
    assertCardActive(source);

    const targetBoardId = body.boardId ?? source.boardId;
    let dstCtx = srcCtx;
    if (targetBoardId !== source.boardId) {
      dstCtx = await assertBoardAccess(req.auth, targetBoardId, "editor");
      if (dstCtx.workspaceId !== srcCtx.workspaceId) {
        throw badRequest("target board must be in the same workspace");
      }
    }

    const targetListId = body.listId ?? source.listId;
    const [targetList] = await db.select().from(lists).where(eq(lists.id, targetListId)).limit(1);
    if (!targetList || targetList.workspaceId !== dstCtx.workspaceId) {
      throw badRequest("target list not in same workspace");
    }

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

    const [sourceLabels, sourceFieldValues, sourceAssignees, sourceAttachments, sourceChecklists, sourceTemplateApplications] = await Promise.all([
      db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, source.id)),
      db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, source.id)),
      db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, source.id)),
      db.select().from(cardAttachments).where(eq(cardAttachments.cardId, source.id)),
      loadChecklistsForCard(source.id),
      db.select({ templateId: cardChecklistTemplateApplications.templateId }).from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, source.id)),
    ]);

    const storage = await getStorageForClient(req.auth.cid);
    const newCardId = randomUUID();
    const attachmentCopyTasks = sourceAttachments.map(async (att) => ({
      src: att,
      copy: await copyAttachmentBlobs(storage, req.auth.cid, att, newCardId),
    }));
    let copiedAttachments: { src: typeof cardAttachments.$inferSelect; copy: Awaited<ReturnType<typeof copyAttachmentBlobs>> }[] = [];
    try {
      copiedAttachments = await Promise.all(attachmentCopyTasks);
    } catch (err) {
      const settledCopies = await Promise.allSettled(attachmentCopyTasks);
      await Promise.all(
        settledCopies
          .filter((result): result is PromiseFulfilledResult<(typeof copiedAttachments)[number]> => result.status === "fulfilled")
          .map(({ value: { copy } }) =>
            Promise.allSettled([
              storage.delete(copy.fileKey),
              copy.thumbnailFileKey ? storage.delete(copy.thumbnailFileKey) : Promise.resolve(),
              copy.coverImageFileKey ? storage.delete(copy.coverImageFileKey) : Promise.resolve(),
            ]),
          ),
      );
      throw err;
    }

    const eligibleAssigneeIds = await ensureBoardMembershipForUsers(
      targetBoardId,
      dstCtx.workspaceId,
      sourceAssignees.map((a) => a.userId),
    );

    let validLabelIds: string[] = [];
    if (sourceLabels.length > 0) {
      const valid = await db
        .select({ id: cardLabels.id })
        .from(cardLabels)
        .where(and(
          eq(cardLabels.workspaceId, dstCtx.workspaceId),
          inArray(cardLabels.id, sourceLabels.map((l) => l.labelId)),
          isNull(cardLabels.archivedAt),
        ));
      validLabelIds = valid.map((l) => l.id);
    }

    const { newCard, attachmentRows, activity } = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(cards)
        .values({
          id: newCardId,
          listId: targetListId,
          boardId: targetBoardId,
          title: source.title,
          description: source.description,
          dueDateLocalDate: source.dueDateLocalDate,
          dueDateSlot: source.dueDateSlot,
          dueDateTimezone: source.dueDateTimezone,
          position,
          createdById: req.auth.sub,
        })
        .returning();

      await replaceCardMentions({
        tx,
        boardId: targetBoardId,
        cardId: inserted!.id,
        source: "description",
        markdown: inserted!.description,
      });

      if (shouldAutoWatchAuthoredCards(req.auth.authKind)) {
        await tx
          .insert(cardWatchers)
          .values({ cardId: inserted!.id, userId: req.auth.sub })
          .onConflictDoNothing();
      }

      if (validLabelIds.length > 0) {
        await tx
          .insert(cardLabelAssignments)
          .values(validLabelIds.map((labelId) => ({ cardId: inserted!.id, labelId })));
      }

      if (eligibleAssigneeIds.length > 0) {
        await tx
          .insert(cardAssignees)
          .values(eligibleAssigneeIds.map((userId) => ({ cardId: inserted!.id, userId })));
      }

      if (sourceFieldValues.length > 0) {
        const validFields = await tx
          .select({ id: customFields.id })
          .from(customFields)
          .where(and(
            eq(customFields.workspaceId, dstCtx.workspaceId),
            inArray(customFields.id, sourceFieldValues.map((v) => v.fieldId)),
            isNull(customFields.archivedAt),
          ));
        const validFieldIds = new Set(validFields.map((f) => f.id));
        const rows = sourceFieldValues
          .filter((v) => validFieldIds.has(v.fieldId))
          .map((v) => ({
            cardId: inserted!.id,
            fieldId: v.fieldId,
            valueText: v.valueText,
            valueNumber: v.valueNumber,
            valueCheckbox: v.valueCheckbox,
            valueDate: v.valueDate,
            valueUrl: v.valueUrl,
            valueOptionIds: v.valueOptionIds,
            valueUserIds: v.valueUserIds,
          }));
        if (rows.length > 0) {
          await tx.insert(cardCustomFieldValues).values(rows);
        }
      }

      // Carry over the template-application ledger so the duplicate (which already
      // has the seeded checklists copied below) does not re-acquire those templates
      // when it later enters a bound list.
      if (sourceTemplateApplications.length > 0) {
        await tx
          .insert(cardChecklistTemplateApplications)
          .values(sourceTemplateApplications.map((row) => ({ cardId: inserted!.id, templateId: row.templateId })))
          .onConflictDoNothing();
      }

      for (const sourceChecklist of sourceChecklists) {
        const [checklist] = await tx
          .insert(cardChecklists)
          .values({
            cardId: inserted!.id,
            title: sourceChecklist.title,
            position: sourceChecklist.position,
          })
          .returning();
        if (sourceChecklist.items.length > 0) {
          await tx.insert(cardChecklistItems).values(sourceChecklist.items.map((item) => ({
            checklistId: checklist!.id,
            text: item.text,
            position: item.position,
            assigneeId: item.assigneeId && eligibleAssigneeIds.includes(item.assigneeId) ? item.assigneeId : null,
            completedAt: item.completedAt ? new Date(item.completedAt as unknown as string) : null,
            completedById: item.completedById,
          })));
        }
      }

      const insertedAttachments: (typeof cardAttachments.$inferSelect)[] = [];
      let newCoverAttachmentId: string | null = null;
      for (const { src, copy } of copiedAttachments) {
        const [row] = await tx
          .insert(cardAttachments)
          .values({
            cardId: inserted!.id,
            clientId: dstCtx.clientId,
            uploadedById: req.auth.sub,
            fileName: src.fileName,
            mimeType: src.mimeType,
            byteSize: src.byteSize,
            fileKey: copy.fileKey,
            url: copy.url,
            thumbnailFileKey: copy.thumbnailFileKey,
            thumbnailUrl: copy.thumbnailUrl,
            coverImageFileKey: copy.coverImageFileKey,
            coverImageUrl: copy.coverImageUrl,
            source: src.source === "comment" ? "attachment" : src.source,
            commentId: null,
          })
          .returning();
        insertedAttachments.push(row!);
        if (source.coverAttachmentId === src.id) newCoverAttachmentId = row!.id;
      }

      let finalCard = inserted!;
      if (newCoverAttachmentId) {
        const [withCover] = await tx
          .update(cards)
          .set({ coverAttachmentId: newCoverAttachmentId, updatedAt: new Date() })
          .where(eq(cards.id, inserted!.id))
          .returning();
        finalCard = withCover!;
      }

      const activity = await recordActivity(tx, {
        boardId: targetBoardId,
        workspaceId: dstCtx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: finalCard.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: { title: finalCard.title, listId: targetListId, duplicatedFromId: source.id },
      });

      return { newCard: finalCard, attachmentRows: insertedAttachments, activity };
    });

    if (needsRebalance) {
      const positions = await rebalanceBoardLane(targetListId, targetBoardId);
      await emitLaneRebalanced(targetBoardId, targetListId, positions);
    }

    const wireNewCard = toWireCard(newCard, req.auth.cid);
    await emitToBoard(targetBoardId, SERVER_EVENTS.CARD_CREATED, { boardId: targetBoardId, card: wireNewCard });
    await emitCardActivityFeedItem(targetBoardId, newCard.id, activity);

    const copiedChecklists = await loadChecklistsForCard(newCard.id);
    for (const checklist of copiedChecklists) {
      emitToBoard(targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId: targetBoardId, cardId: newCard.id, checklist });
    }

    if (validLabelIds.length > 0) {
      emitToBoard(targetBoardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId: targetBoardId, cardId: newCard.id, labelIds: validLabelIds });
    }
    if (eligibleAssigneeIds.length > 0) {
      emitToBoard(targetBoardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId: targetBoardId, cardId: newCard.id, assigneeIds: eligibleAssigneeIds });
    }

    if (attachmentRows.length > 0) {
      const userRow = await db
        .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, req.auth.sub))
        .limit(1);
      const uploadedByName = userRow[0]?.displayName ?? "";
      const uploadedByAvatarUrl = userRow[0]?.avatarUrl ?? null;
      for (const att of attachmentRows) {
        emitToBoard(targetBoardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
          boardId: targetBoardId,
          cardId: newCard.id,
          attachment: {
            id: att.id,
            cardId: att.cardId,
            fileName: att.fileName,
            mimeType: att.mimeType,
            byteSize: att.byteSize,
            url: shapeAttachmentMedia(att).url,
            thumbnailUrl: shapeAttachmentMedia(att).thumbnailUrl,
            createdAt: att.createdAt,
            uploadedById: att.uploadedById,
            uploadedByName,
            uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl }).uploadedByAvatarUrl,
            source: att.source,
            commentId: att.commentId,
          },
        });
      }
      if (newCard.coverAttachmentId) {
        emitToBoard(targetBoardId, SERVER_EVENTS.CARD_UPDATED, { boardId: targetBoardId, card: wireNewCard });
      }
    }

    return reply.status(201).send(wireNewCard);
  });

  app.post("/cards/:id/move-to-board", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardToBoardBody.parse(req.body);

    const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!source) throw notFound();
    const srcCtx = await assertBoardAccess(req.auth, source.boardId, "editor");
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

    const [updated] = await db
      .update(cards)
      .set({ boardId: body.boardId, listId: targetListId, position, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();

    const activity = await recordCoalescedActivity(db, {
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
    await emitToBoard(fromBoardId, SERVER_EVENTS.CARD_DELETED, { boardId: fromBoardId, cardId: id });
    const wireUpdated = toWireCard(updated!, req.auth.cid);
    await emitToBoard(body.boardId, SERVER_EVENTS.CARD_CREATED, { boardId: body.boardId, card: wireUpdated });
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
    for (const att of attachmentRows) {
      emitToBoard(body.boardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
        boardId: body.boardId,
        cardId: id,
        attachment: {
          ...shapeAttachmentMedia(att),
          uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: att.uploadedByAvatarUrl }).uploadedByAvatarUrl,
        },
      });
    }

    return wireUpdated;
  });

  app.put("/cards/:id/custom-fields/:fieldId", async (req) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    const body = dto.setCustomFieldValueBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [field] = await db.select().from(customFields).where(eq(customFields.id, fieldId)).limit(1);
    if (!field || field.workspaceId !== ctx.workspaceId) throw notFound("custom field not found");
    const [currentValue] = await db
      .select()
      .from(cardCustomFieldValues)
      .where(and(eq(cardCustomFieldValues.cardId, id), eq(cardCustomFieldValues.fieldId, fieldId)))
      .limit(1);

    const expectedKey = CUSTOM_FIELD_VALUE_COLUMN_BY_TYPE[field.type];
    if (CUSTOM_FIELD_VALUE_COLUMNS.some((key) => key !== expectedKey && body[key] !== undefined))
      throw badRequest(`expected ${field.type} value`);

    // Start from all-null and populate only the column for this field's type.
    const cols = {
      valueText: null as string | null,
      valueNumber: null as string | null,
      valueCheckbox: null as boolean | null,
      valueDate: null as string | null,
      valueUrl: null as string | null,
      valueOptionIds: null as string[] | null,
      valueUserIds: null as string[] | null,
    };
    switch (field.type) {
      case "text":
        cols.valueText = body.valueText ?? null;
        break;
      case "number":
        cols.valueNumber = body.valueNumber == null ? null : String(body.valueNumber);
        break;
      case "checkbox":
        cols.valueCheckbox = body.valueCheckbox ?? null;
        break;
      case "date":
        cols.valueDate = body.valueDate ?? null;
        break;
      case "url":
        cols.valueUrl = body.valueUrl ?? null;
        break;
      case "select": {
        const ids = body.valueOptionIds ?? null;
        if (ids?.length) {
          if (!field.allowMultiple && ids.length > 1) throw badRequest("expected a single option");
          const valid = await db
            .select({ id: customFieldOptions.id })
            .from(customFieldOptions)
            .where(and(
              eq(customFieldOptions.fieldId, fieldId),
              inArray(customFieldOptions.id, ids),
              isNull(customFieldOptions.archivedAt),
            ));
          const validSet = new Set(valid.map((o) => o.id));
          if (ids.some((optionId) => !validSet.has(optionId))) throw badRequest("unknown option for this field");
        }
        cols.valueOptionIds = ids?.length ? ids : null;
        break;
      }
      case "user": {
        const ids = body.valueUserIds ?? null;
        if (ids?.length) {
          if (!field.allowMultiple && ids.length > 1) throw badRequest("expected a single user");
          const valid = await db
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), inArray(workspaceMembers.userId, ids)));
          const validSet = new Set(valid.map((m) => m.userId));
          if (ids.some((userId) => !validSet.has(userId))) throw badRequest("user is not a workspace member");
        }
        cols.valueUserIds = ids?.length ? ids : null;
        break;
      }
    }

    // Resolve a human-readable string for the activity feed (option labels / user names).
    const describeOptions = async (ids: string[] | null | undefined): Promise<string | null> => {
      if (!ids?.length) return null;
      const rows = await db
        .select({ id: customFieldOptions.id, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(inArray(customFieldOptions.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.label]));
      return ids.map((optionId) => byId.get(optionId) ?? "?").join(", ") || null;
    };
    const describeUsers = async (ids: string[] | null | undefined): Promise<string | null> => {
      if (!ids?.length) return null;
      const rows = await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.displayName]));
      return ids.map((userId) => byId.get(userId) ?? "?").join(", ") || null;
    };
    let fromValue: string | null;
    let toValue: string | null;
    switch (field.type) {
      case "checkbox":
        // Missing displays as "No", so null and false collapse together.
        fromValue = String(currentValue?.valueCheckbox === true);
        toValue = String(cols.valueCheckbox === true);
        break;
      case "select":
        fromValue = await describeOptions(currentValue?.valueOptionIds);
        toValue = await describeOptions(cols.valueOptionIds);
        break;
      case "user":
        fromValue = await describeUsers(currentValue?.valueUserIds);
        toValue = await describeUsers(cols.valueUserIds);
        break;
      default:
        fromValue =
          currentValue?.valueText ??
          currentValue?.valueNumber ??
          currentValue?.valueDate ??
          currentValue?.valueUrl ??
          null;
        toValue = cols.valueText ?? cols.valueNumber ?? cols.valueDate ?? cols.valueUrl ?? null;
    }

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

  app.post("/cards/:id/checklists", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.createChecklistBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [last] = await db
      .select({ position: cardChecklists.position })
      .from(cardChecklists)
      .where(eq(cardChecklists.cardId, id))
      .orderBy(desc(cardChecklists.position))
      .limit(1);
    const position = between(last?.position ?? null, null).position;

    const { checklist, activity } = await db.transaction(async (tx) => {
      const [checklist] = await tx
        .insert(cardChecklists)
        .values({ cardId: id, title: body.title, position })
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      const activity = await recordActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: id,
        action: ACTIVITY_ACTION.CHECKLIST_CREATED,
        payload: { checklistId: checklist!.id, title: checklist!.title },
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
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
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
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
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
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [current] = await db
      .select()
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
      .limit(1);
    if (!current) throw notFound("checklist not found");

    const result = await db.transaction(async (tx) => {
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
    await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [current] = await db
      .select()
      .from(cardChecklists)
      .where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id)))
      .limit(1);
    if (!current) throw notFound("checklist not found");
    const prevPosition = current.position;

    const { position, rebalancedPositions } = await db.transaction(async (tx) => {
      const { prev, next } = await neighbourChecklistPositions(id, body.afterChecklistId, body.beforeChecklistId, tx);
      const result = between(prev, next);
      let position = result.position;
      await tx.update(cardChecklists).set({ position, updatedAt: new Date() }).where(eq(cardChecklists.id, checklistId));
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      const rebalancedPositions = result.needsRebalance ? await rebalanceChecklists(id, tx) : null;
      if (rebalancedPositions) position = rebalancedPositions.find((p) => p.id === checklistId)?.position ?? position;
      return { position, rebalancedPositions };
    });

    if (rebalancedPositions) await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_REBALANCED, { boardId: card.boardId, cardId: id, positions: rebalancedPositions });
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_MOVED, { boardId: card.boardId, cardId: id, checklistId, position, prevPosition });
    return { id: checklistId, position };
  });

  app.post("/cards/:id/checklists/:checklistId/items", async (req, reply) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.createChecklistItemBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");
    const [last] = await db
      .select({ position: cardChecklistItems.position })
      .from(cardChecklistItems)
      .where(eq(cardChecklistItems.checklistId, checklistId))
      .orderBy(desc(cardChecklistItems.position))
      .limit(1);
    const position = between(last?.position ?? null, null).position;

    const item = await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(cardChecklistItems)
        .values({ checklistId, text: body.text, position })
        .returning();
      await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, id));
      return item!;
    });

    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId, item });
    return reply.status(201).send(item);
  });

  app.patch("/cards/:id/checklists/:checklistId/items/bulk", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.bulkUpdateChecklistItemsBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");

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
      emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId, item, prevCompletedAt: current.completedAt });
    }
    return { items };
  });

  app.patch("/cards/:id/checklists/:checklistId/items/:itemId", async (req) => {
    const { id, checklistId, itemId } = req.params as { id: string; checklistId: string; itemId: string };
    const body = dto.updateChecklistItemBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [checklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!checklist) throw notFound("checklist not found");
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
    const { item, activities, assigneeActivity, dueDateActivity, automationEffects } = await db.transaction(async (tx) => {
      const [item] = await tx
        .update(cardChecklistItems)
        .set({
          text: nextText,
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
      if (assigneeChanged) {
        // Checklist-item assignment is independent of card assignment: assigning an item no
        // longer adds the user to cardAssignees. The item is surfaced as a first-class work
        // item via the assigned-work / home / digest surfaces instead, and the assignee still
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
            payload: { checklistId, title: checklist.title, fromValue: false, toValue: true },
          }));
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
      return { item: item!, activities, assigneeActivity, dueDateActivity, automationEffects };
    });

    for (const activity of activities) emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
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
    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: card.boardId, cardId: id, cardTitle: card.title, listId: card.listId, checklistId, item, prevCompletedAt: current.completedAt });
    return item;
  });

  app.delete("/cards/:id/checklists/:checklistId/items/:itemId", async (req, reply) => {
    const { id, checklistId, itemId } = req.params as { id: string; checklistId: string; itemId: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertBoardAccess(req.auth, card.boardId, "editor");
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

    emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED, { boardId: card.boardId, cardId: id, checklistId, itemId, completedAt: current.completedAt });
    return reply.status(204).send();
  });

  app.post("/cards/:id/checklists/:checklistId/items/:itemId/move", async (req) => {
    const { id, checklistId, itemId } = req.params as { id: string; checklistId: string; itemId: string };
    const body = dto.moveChecklistItemBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [sourceChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, checklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!sourceChecklist) throw notFound("checklist not found");
    const targetChecklistId = body.checklistId ?? checklistId;
    const [targetChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.id, targetChecklistId), eq(cardChecklists.cardId, id))).limit(1);
    if (!targetChecklist) throw badRequest("target checklist not on this card");
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
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");

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
    return wireCard;
  });

  app.delete("/cards/:id/custom-fields/:fieldId", async (req, reply) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
    assertCardActive(card);
    const [field] = await db.select().from(customFields).where(eq(customFields.id, fieldId)).limit(1);
    if (!field || field.workspaceId !== ctx.workspaceId) throw notFound("custom field not found");
    const [currentValue] = await db
      .select()
      .from(cardCustomFieldValues)
      .where(and(eq(cardCustomFieldValues.cardId, id), eq(cardCustomFieldValues.fieldId, fieldId)))
      .limit(1);
    const describeOptions = async (ids: string[] | null | undefined): Promise<string | null> => {
      if (!ids?.length) return null;
      const rows = await db
        .select({ id: customFieldOptions.id, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(inArray(customFieldOptions.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.label]));
      return ids.map((optionId) => byId.get(optionId) ?? "?").join(", ") || null;
    };
    const describeUsers = async (ids: string[] | null | undefined): Promise<string | null> => {
      if (!ids?.length) return null;
      const rows = await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.displayName]));
      return ids.map((userId) => byId.get(userId) ?? "?").join(", ") || null;
    };
    // Clearing a checkbox returns it to the visible "No" state, which is the
    // same as false for feed coalescing purposes.
    let fromValue: string | null;
    switch (field.type) {
      case "checkbox":
        fromValue = String(currentValue?.valueCheckbox === true);
        break;
      case "select":
        fromValue = await describeOptions(currentValue?.valueOptionIds);
        break;
      case "user":
        fromValue = await describeUsers(currentValue?.valueUserIds);
        break;
      default:
        fromValue =
          currentValue?.valueText ??
          currentValue?.valueNumber ??
          currentValue?.valueDate ??
          currentValue?.valueUrl ??
          null;
    }
    const toValue = field.type === "checkbox" ? "false" : null;

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
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
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
    const ctx = await assertBoardAccess(req.auth, card.boardId, "editor");
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
    return { assigneeIds: finalAssigneeIds };
  });
}
