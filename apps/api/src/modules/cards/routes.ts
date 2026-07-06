import { dto } from "@kanera/shared";
import { SERVER_EVENTS, type WireCard, type WireCardChecklist, type WireCardDetail } from "@kanera/shared/events";
import { ACTIVITY_ACTION, activityEvents, boardMembers, boards, cardAssignees, cardAttachments, cardChecklistItems, cardChecklists, cardChecklistTemplateApplications, cardCustomFieldValues, cardLabelAssignments, cardLabels, cards, cardWatchers, commentReactions, comments, customFieldOptions, customFields, lists, users, type ActivityEvent, type CustomFieldType } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { env } from "../../env.js";
import { assignedCardVisibility, assertBoardAccess, assertCardAccess } from "../../lib/access.js";
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
import { assertValidOptionIds, assertWorkspaceMemberIds, buildCustomFieldValueColumns, customFieldValueEquals, describeCustomFieldValue, emptyValueColumns, hasCustomFieldValue, type CustomFieldValueColumns } from "../../lib/custom-fields.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { externalEmbeddedMediaReferences, signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { clearNotificationsForCards, clearOverdueChecklistItemNotifications, clearOverdueNotificationsForCards, emitDeletedNotifications, syncDirectNotificationForActivity } from "../../lib/notifications.js";
import { createOverdueNotificationsForCards } from "../../lib/overdue-notifications.js";
import { between } from "../../lib/position.js";
import type { StorageProvider } from "../../lib/storage/index.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey, attachmentThumbnailStorageKey, cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { emitToBoard } from "../../realtime/emit.js";
import { loadLinkedNotesForCard, repairInternalLinksAroundCard, replaceInternalLinksForSource } from "../../lib/internal-links.js";

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
  srcStorage: StorageProvider,
  dstStorage: StorageProvider,
  dstClientId: string,
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

  const originalBuffer = await srcStorage.get(source.fileKey);
  await dstStorage.put(baseKey, originalBuffer, source.mimeType);
  const url = unsignedMediaUrl(dstClientId, baseKey) ?? baseKey;

  let thumbnailFileKey: string | null = null;
  let thumbnailUrl: string | null = null;
  if (source.thumbnailFileKey) {
    const buf = await srcStorage.get(source.thumbnailFileKey);
    thumbnailFileKey = attachmentThumbnailStorageKey(baseKey, mediaExtensionForKey(source.thumbnailFileKey));
    await dstStorage.put(thumbnailFileKey, buf, mediaContentTypeForKey(source.thumbnailFileKey));
    thumbnailUrl = unsignedMediaUrl(dstClientId, thumbnailFileKey);
  }

  let coverImageFileKey: string | null = null;
  let coverImageUrl: string | null = null;
  if (source.coverImageFileKey) {
    const buf = await srcStorage.get(source.coverImageFileKey);
    coverImageFileKey = attachmentCoverStorageKey(baseKey, mediaExtensionForKey(source.coverImageFileKey));
    await dstStorage.put(coverImageFileKey, buf, mediaContentTypeForKey(source.coverImageFileKey));
    coverImageUrl = unsignedMediaUrl(dstClientId, coverImageFileKey);
  }

  return { fileKey: baseKey, url, thumbnailFileKey, thumbnailUrl, coverImageFileKey, coverImageUrl };
}

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;
type DuplicatedAttachment = {
  src: typeof cardAttachments.$inferSelect;
  copy: Awaited<ReturnType<typeof copyAttachmentBlobs>>;
};
type DuplicateFieldValueRow = {
  fieldId: string;
} & CustomFieldValueColumns;

function mediaContentTypeForKey(key: string): string {
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function mediaExtensionForKey(key: string): string {
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  return ext || "jpg";
}

async function resolveDuplicateTargetList(
  source: typeof cards.$inferSelect,
  dstCtx: Pick<BoardAccessContext, "workspaceId">,
  explicitListId?: string,
): Promise<string> {
  if (explicitListId) {
    const [targetList] = await db.select().from(lists).where(eq(lists.id, explicitListId)).limit(1);
    if (!targetList || targetList.workspaceId !== dstCtx.workspaceId) {
      throw badRequest("target list not in same workspace");
    }
    return explicitListId;
  }

  const [sourceList] = await db.select({ workspaceId: lists.workspaceId }).from(lists).where(eq(lists.id, source.listId)).limit(1);
  if (sourceList?.workspaceId === dstCtx.workspaceId) return source.listId;

  // Cross-workspace copies cannot infer a lane from the source card because lists are
  // workspace-scoped. The UI supplies a target list after the board is picked; this is the
  // server-side guard for API clients and stale frontends.
  throw badRequest("target list required");
}

async function duplicateLabelIds(
  sourceLabels: { labelId: string }[],
  srcCtx: Pick<CardAccessContext, "workspaceId">,
  dstCtx: Pick<BoardAccessContext, "workspaceId">,
): Promise<string[]> {
  if (sourceLabels.length === 0) return [];
  const sourceIds = sourceLabels.map((label) => label.labelId);
  if (srcCtx.workspaceId === dstCtx.workspaceId) {
    const valid = await db
      .select({ id: cardLabels.id })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, dstCtx.workspaceId), inArray(cardLabels.id, sourceIds), isNull(cardLabels.archivedAt)));
    const validIds = new Set(valid.map((label) => label.id));
    return sourceIds.filter((id) => validIds.has(id));
  }

  const [sourceRows, destRows] = await Promise.all([
    db
      .select({ id: cardLabels.id, name: cardLabels.name })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, srcCtx.workspaceId), inArray(cardLabels.id, sourceIds), isNull(cardLabels.archivedAt))),
    db
      .select({ id: cardLabels.id, name: cardLabels.name })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, dstCtx.workspaceId), isNull(cardLabels.archivedAt)))
      .orderBy(asc(cardLabels.position)),
  ]);
  const sourceNameById = new Map(sourceRows.map((label) => [label.id, label.name]));
  const destIdByName = new Map(destRows.map((label) => [label.name, label.id]));
  const mapped: string[] = [];
  for (const sourceId of sourceIds) {
    const destId = destIdByName.get(sourceNameById.get(sourceId) ?? "");
    if (destId && !mapped.includes(destId)) mapped.push(destId);
  }
  return mapped;
}

async function duplicateCustomFieldValues(
  sourceValues: (typeof cardCustomFieldValues.$inferSelect)[],
  srcCtx: Pick<CardAccessContext, "workspaceId">,
  dstCtx: Pick<BoardAccessContext, "workspaceId">,
  eligibleAssigneeIds: string[],
): Promise<DuplicateFieldValueRow[]> {
  if (sourceValues.length === 0) return [];
  const sourceFieldIds = sourceValues.map((value) => value.fieldId);
  if (srcCtx.workspaceId === dstCtx.workspaceId) {
    const validFields = await db
      .select({ id: customFields.id })
      .from(customFields)
      .where(and(eq(customFields.workspaceId, dstCtx.workspaceId), inArray(customFields.id, sourceFieldIds), isNull(customFields.archivedAt)));
    const validFieldIds = new Set(validFields.map((field) => field.id));
    return sourceValues
      .filter((value) => validFieldIds.has(value.fieldId))
      .map((value) => ({
        fieldId: value.fieldId,
        valueText: value.valueText,
        valueNumber: value.valueNumber,
        valueCheckbox: value.valueCheckbox,
        valueDate: value.valueDate,
        valueUrl: value.valueUrl,
        valueOptionIds: value.valueOptionIds,
        valueUserIds: value.valueUserIds,
      }));
  }

  const [sourceFields, destFields] = await Promise.all([
    db
      .select()
      .from(customFields)
      .where(and(eq(customFields.workspaceId, srcCtx.workspaceId), inArray(customFields.id, sourceFieldIds), isNull(customFields.archivedAt))),
    db
      .select()
      .from(customFields)
      .where(and(eq(customFields.workspaceId, dstCtx.workspaceId), isNull(customFields.archivedAt)))
      .orderBy(asc(customFields.position)),
  ]);
  const sourceFieldById = new Map(sourceFields.map((field) => [field.id, field]));
  const destFieldByNameAndType = new Map<string, (typeof customFields.$inferSelect)>();
  for (const field of destFields) {
    const key = `${field.name}\0${field.type}`;
    if (!destFieldByNameAndType.has(key)) destFieldByNameAndType.set(key, field);
  }

  const allSourceOptionIds = sourceValues.flatMap((value) => value.valueOptionIds ?? []);
  const destSelectFieldIds = destFields.filter((field) => field.type === "select").map((field) => field.id);
  const [sourceOptionRows, destOptionRows] = await Promise.all([
    allSourceOptionIds.length > 0
      ? db
        .select({ id: customFieldOptions.id, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(inArray(customFieldOptions.id, allSourceOptionIds))
      : Promise.resolve([]),
    destSelectFieldIds.length > 0
      ? db
        .select({ id: customFieldOptions.id, fieldId: customFieldOptions.fieldId, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(and(inArray(customFieldOptions.fieldId, destSelectFieldIds), isNull(customFieldOptions.archivedAt)))
        .orderBy(asc(customFieldOptions.position))
      : Promise.resolve([]),
  ]);
  const sourceOptionLabelById = new Map(sourceOptionRows.map((option) => [option.id, option.label]));
  const destOptionIdByFieldAndLabel = new Map<string, string>();
  for (const option of destOptionRows) {
    const key = `${option.fieldId}\0${option.label}`;
    if (!destOptionIdByFieldAndLabel.has(key)) destOptionIdByFieldAndLabel.set(key, option.id);
  }
  const eligibleUsers = new Set(eligibleAssigneeIds);

  const rows: DuplicateFieldValueRow[] = [];
  for (const value of sourceValues) {
    const sourceField = sourceFieldById.get(value.fieldId);
    if (!sourceField || !hasCustomFieldValue(sourceField.type, value)) continue;
    const destField = destFieldByNameAndType.get(`${sourceField.name}\0${sourceField.type}`);
    if (!destField) continue;
    const cols = emptyValueColumns();
    switch (sourceField.type as CustomFieldType) {
      case "text": cols.valueText = value.valueText; break;
      case "number": cols.valueNumber = value.valueNumber; break;
      case "checkbox": cols.valueCheckbox = value.valueCheckbox; break;
      case "date": cols.valueDate = value.valueDate; break;
      case "url": cols.valueUrl = value.valueUrl; break;
      case "select": {
        const mapped: string[] = [];
        for (const sourceOptionId of value.valueOptionIds ?? []) {
          const label = sourceOptionLabelById.get(sourceOptionId);
          const destOptionId = label ? destOptionIdByFieldAndLabel.get(`${destField.id}\0${label}`) : undefined;
          if (destOptionId && !mapped.includes(destOptionId)) mapped.push(destOptionId);
        }
        const capped = destField.allowMultiple ? mapped : mapped.slice(0, 1);
        if (capped.length === 0) continue;
        cols.valueOptionIds = capped;
        break;
      }
      case "user": {
        const mapped = (value.valueUserIds ?? []).filter((userId) => eligibleUsers.has(userId));
        const capped = destField.allowMultiple ? mapped : mapped.slice(0, 1);
        if (capped.length === 0) continue;
        cols.valueUserIds = capped;
        break;
      }
    }
    rows.push({ fieldId: destField.id, ...cols });
  }
  return rows;
}

async function copyAttachmentsForDuplicate(
  sourceAttachments: (typeof cardAttachments.$inferSelect)[],
  srcCtx: Pick<CardAccessContext, "clientId">,
  dstCtx: Pick<BoardAccessContext, "clientId">,
  newCardId: string,
): Promise<{ copiedAttachments: DuplicatedAttachment[]; dstStorage: StorageProvider }> {
  const srcStorage = await getStorageForClient(srcCtx.clientId);
  const dstStorage = srcCtx.clientId === dstCtx.clientId ? srcStorage : await getStorageForClient(dstCtx.clientId);
  const attachmentCopyTasks = sourceAttachments.map(async (att) => ({
    src: att,
    copy: await copyAttachmentBlobs(srcStorage, dstStorage, dstCtx.clientId, att, newCardId),
  }));
  try {
    const copiedAttachments = await Promise.all(attachmentCopyTasks);
    return { copiedAttachments, dstStorage };
  } catch (err) {
    const settledCopies = await Promise.allSettled(attachmentCopyTasks);
    await Promise.all(
      settledCopies
        .filter((result): result is PromiseFulfilledResult<DuplicatedAttachment> => result.status === "fulfilled")
        .map(({ value: { copy } }) =>
          Promise.allSettled([
            dstStorage.delete(copy.fileKey),
            copy.thumbnailFileKey ? dstStorage.delete(copy.thumbnailFileKey) : Promise.resolve(),
            copy.coverImageFileKey ? dstStorage.delete(copy.coverImageFileKey) : Promise.resolve(),
          ]),
        ),
    );
    throw err;
  }
}

type SourceCommentForDuplicate = typeof comments.$inferSelect & { authorName: string };
type SourceActivityForDuplicate = typeof activityEvents.$inferSelect & { actorNameSnapshot: string | null };

function duplicateActorSnapshotName(
  kind: SourceActivityForDuplicate["actorKind"] | SourceCommentForDuplicate["authorKind"],
  fallbackName: string | null | undefined,
  apiKeyName: string | null | undefined,
  supportActorEmail?: string | null,
): string | null {
  if (kind === "apiKey") return apiKeyName ?? "API key";
  if (kind === "support") return `Kanera Support (${supportActorEmail ?? "operator"})`;
  if (kind === "system") return "Kanera";
  return fallbackName ?? "Unknown";
}

async function targetAttributionUserIds(boardId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(eq(boardMembers.boardId, boardId));
  return new Set(rows.map((row) => row.userId));
}

async function loadCommentsForDuplicate(cardId: string): Promise<SourceCommentForDuplicate[]> {
  return db
    .select({
      id: comments.id,
      cardId: comments.cardId,
      authorId: comments.authorId,
      authorKind: comments.authorKind,
      apiKeyId: comments.apiKeyId,
      apiKeyName: comments.apiKeyName,
      body: comments.body,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
      searchVector: comments.searchVector,
      authorName: sql<string>`case when ${comments.authorKind} = 'system' then coalesce(${comments.apiKeyName}, 'Kanera') when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.cardId, cardId))
    .orderBy(asc(comments.createdAt));
}

async function loadActivityForDuplicate(card: typeof cards.$inferSelect): Promise<SourceActivityForDuplicate[]> {
  return db
    .select({
      id: activityEvents.id,
      boardId: activityEvents.boardId,
      workspaceId: activityEvents.workspaceId,
      actorId: activityEvents.actorId,
      actorKind: activityEvents.actorKind,
      apiKeyId: activityEvents.apiKeyId,
      apiKeyName: activityEvents.apiKeyName,
      supportSessionId: activityEvents.supportSessionId,
      supportActorEmail: activityEvents.supportActorEmail,
      entityType: activityEvents.entityType,
      entityId: activityEvents.entityId,
      action: activityEvents.action,
      payload: activityEvents.payload,
      feedVisible: activityEvents.feedVisible,
      coalesceKey: activityEvents.coalesceKey,
      coalescedCount: activityEvents.coalescedCount,
      coalescedUntil: activityEvents.coalescedUntil,
      createdAt: activityEvents.createdAt,
      updatedAt: activityEvents.updatedAt,
      actorNameSnapshot: sql<string | null>`case when ${activityEvents.actorKind} = 'system' then 'Kanera' when ${activityEvents.actorKind} = 'support' then ('Kanera Support (' || coalesce(${activityEvents.supportActorEmail}, 'operator') || ')') when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key') else ${users.displayName} end`,
    })
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .where(
      and(
        eq(activityEvents.boardId, card.boardId),
        eq(activityEvents.feedVisible, true),
        or(
          and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, card.id)),
          sql`${activityEvents.payload}->>'cardId' = ${card.id}`,
        )!,
      ),
    )
    .orderBy(asc(activityEvents.createdAt));
}

async function sourceListNameMap(workspaceId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(eq(lists.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.id, row.name]));
}

function cloneActivityPayloadForDuplicate(
  event: SourceActivityForDuplicate,
  source: typeof cards.$inferSelect,
  newCardId: string,
  sourceListNames: Map<string, string>,
  copiedActorName: string | null,
): Record<string, unknown> {
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? { ...(event.payload as Record<string, unknown>) }
    : {};
  if (payload.cardId === source.id) payload.cardId = newCardId;

  const fromListId = typeof payload.fromListId === "string" ? payload.fromListId : null;
  const toListId = typeof payload.toListId === "string" ? payload.toListId : null;
  if (fromListId && !payload.fromListName) payload.fromListName = sourceListNames.get(fromListId) ?? null;
  if (toListId && !payload.toListName) payload.toListName = sourceListNames.get(toListId) ?? null;
  if (typeof payload.listId === "string" && !payload.listName) {
    payload.listName = sourceListNames.get(payload.listId) ?? null;
  }
  if (copiedActorName) payload.copiedActorName = copiedActorName;
  return payload;
}

async function duplicateCardInto({
  source,
  srcCtx,
  dstCtx,
  targetBoardId,
  targetListId,
  position,
  actor,
  bulk,
}: {
  source: typeof cards.$inferSelect;
  srcCtx: Pick<CardAccessContext, "workspaceId" | "clientId">;
  dstCtx: BoardAccessContext;
  targetBoardId: string;
  targetListId: string;
  position: string;
  actor: AuthClaims;
  bulk: boolean;
}) {
  const [sourceLabels, sourceFieldValues, sourceAssignees, sourceAttachments, sourceChecklists, sourceTemplateApplications, sourceComments, sourceActivityRows, targetAttributionIds, sourceListNames] = await Promise.all([
    db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, source.id)),
    db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, source.id)),
    db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, source.id)),
    db.select().from(cardAttachments).where(eq(cardAttachments.cardId, source.id)),
    loadChecklistsForCard(source.id),
    db.select({ templateId: cardChecklistTemplateApplications.templateId }).from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, source.id)),
    loadCommentsForDuplicate(source.id),
    loadActivityForDuplicate(source),
    targetAttributionUserIds(targetBoardId),
    sourceListNameMap(srcCtx.workspaceId),
  ]);
  const sourceCommentReactions = sourceComments.length > 0
    ? await db.select().from(commentReactions).where(inArray(commentReactions.commentId, sourceComments.map((comment) => comment.id)))
    : [];
  const [sourceBoard] = await db
    .select({ id: boards.id, name: boards.name })
    .from(boards)
    .where(eq(boards.id, source.boardId))
    .limit(1);
  const eligibleAssigneeIds = await ensureBoardMembershipForUsers(
    targetBoardId,
    dstCtx.workspaceId,
    sourceAssignees.map((assignee) => assignee.userId),
  );
  const [labelIds, fieldValueRows] = await Promise.all([
    duplicateLabelIds(sourceLabels, srcCtx, dstCtx),
    duplicateCustomFieldValues(sourceFieldValues, srcCtx, dstCtx, eligibleAssigneeIds),
  ]);

  const newCardId = randomUUID();
  const { copiedAttachments, dstStorage } = await copyAttachmentsForDuplicate(sourceAttachments, srcCtx, dstCtx, newCardId);

  let result: { newCard: typeof cards.$inferSelect; attachmentRows: (typeof cardAttachments.$inferSelect)[]; activity: ActivityEvent };
  try {
    result = await db.transaction(async (tx) => {
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
          createdById: actor.sub,
        })
        .returning();

      await replaceCardMentions({
        tx,
        boardId: targetBoardId,
        cardId: inserted!.id,
        source: "description",
        markdown: inserted!.description,
      });

      if (shouldAutoWatchAuthoredCards(actor.authKind)) {
        await tx.insert(cardWatchers).values({ cardId: inserted!.id, userId: actor.sub }).onConflictDoNothing();
      }

      if (labelIds.length > 0) {
        await tx.insert(cardLabelAssignments).values(labelIds.map((labelId) => ({ cardId: inserted!.id, labelId })));
      }
      if (eligibleAssigneeIds.length > 0) {
        await tx.insert(cardAssignees).values(eligibleAssigneeIds.map((userId) => ({ cardId: inserted!.id, userId })));
      }
      if (fieldValueRows.length > 0) {
        await tx.insert(cardCustomFieldValues).values(fieldValueRows.map((value) => ({
          cardId: inserted!.id,
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
            dueDateLocalDate: item.dueDateLocalDate,
            dueDateSlot: item.dueDateSlot,
            dueDateTimezone: item.dueDateTimezone,
          })));
        }
      }

      const sourceCommentIdToNewId = new Map<string, string>();
      if (sourceComments.length > 0) {
        const commentRows = sourceComments.map((comment) => {
          const canKeepOriginalUser = comment.authorKind === "user" && targetAttributionIds.has(comment.authorId);
          const newCommentId = randomUUID();
          sourceCommentIdToNewId.set(comment.id, newCommentId);
          const originalName = duplicateActorSnapshotName(comment.authorKind, comment.authorName, comment.apiKeyName);
          return {
            id: newCommentId,
            cardId: inserted!.id,
            authorId: canKeepOriginalUser ? comment.authorId : actor.sub,
            // Historical comments from users outside the target board are system-attributed so the
            // feed keeps the original name without implying that person is a current board member.
            authorKind: canKeepOriginalUser ? "user" as const : "system" as const,
            apiKeyId: null,
            apiKeyName: canKeepOriginalUser ? null : originalName,
            body: comment.body,
            editedAt: comment.editedAt,
            createdAt: comment.createdAt,
          };
        });
        await tx.insert(comments).values(commentRows);
        for (const comment of sourceComments) {
          const newCommentId = sourceCommentIdToNewId.get(comment.id);
          if (!newCommentId) continue;
          await replaceCardMentions({
            tx,
            boardId: targetBoardId,
            cardId: inserted!.id,
            commentId: newCommentId,
            source: "comment",
            markdown: comment.body,
          });
        }
      }

      const copiedReactions = sourceCommentReactions
        .map((reaction) => {
          const commentId = sourceCommentIdToNewId.get(reaction.commentId);
          if (!commentId || !targetAttributionIds.has(reaction.userId)) return null;
          return {
            commentId,
            userId: reaction.userId,
            reactionType: reaction.reactionType,
            createdAt: reaction.createdAt,
          };
        })
        .filter((reaction): reaction is NonNullable<typeof reaction> => reaction !== null);
      if (copiedReactions.length > 0) {
        await tx.insert(commentReactions).values(copiedReactions).onConflictDoNothing();
      }

      const insertedAttachments: (typeof cardAttachments.$inferSelect)[] = [];
      let newCoverAttachmentId: string | null = null;
      for (const { src, copy } of copiedAttachments) {
        const copiedCommentId = src.commentId ? sourceCommentIdToNewId.get(src.commentId) ?? null : null;
        const [row] = await tx
          .insert(cardAttachments)
          .values({
            cardId: inserted!.id,
            clientId: dstCtx.clientId,
            uploadedById: actor.sub,
            fileName: src.fileName,
            mimeType: src.mimeType,
            byteSize: src.byteSize,
            fileKey: copy.fileKey,
            url: copy.url,
            thumbnailFileKey: copy.thumbnailFileKey,
            thumbnailUrl: copy.thumbnailUrl,
            coverImageFileKey: copy.coverImageFileKey,
            coverImageUrl: copy.coverImageUrl,
            source: src.source === "comment" && copiedCommentId ? "comment" : src.source === "comment" ? "attachment" : src.source,
            commentId: copiedCommentId,
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

      const historicalActivities = sourceActivityRows
        .filter((event) => event.entityType !== "comment")
        .map((event) => {
          const canKeepOriginalUser = event.actorKind === "user" && event.actorId !== null && targetAttributionIds.has(event.actorId);
          const existingPayload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload as Record<string, unknown>
            : {};
          const existingSnapshot = typeof existingPayload.copiedActorName === "string" ? existingPayload.copiedActorName : null;
          const copiedActorName = canKeepOriginalUser
            ? null
            : existingSnapshot ?? duplicateActorSnapshotName(event.actorKind, event.actorNameSnapshot, event.apiKeyName, event.supportActorEmail);
          return {
            boardId: targetBoardId,
            workspaceId: dstCtx.workspaceId,
            actorId: canKeepOriginalUser ? event.actorId : null,
            actorKind: canKeepOriginalUser ? "user" as const : "system" as const,
            apiKeyId: null,
            apiKeyName: null,
            supportSessionId: null,
            supportActorEmail: null,
            entityType: event.entityType,
            entityId: event.entityType === "card" && event.entityId === source.id ? finalCard.id : event.entityId,
            action: event.action,
            payload: cloneActivityPayloadForDuplicate(event, source, finalCard.id, sourceListNames, copiedActorName),
            feedVisible: event.feedVisible,
            coalesceKey: event.coalesceKey,
            coalescedCount: event.coalescedCount,
            coalescedUntil: event.coalescedUntil,
            createdAt: event.createdAt,
            updatedAt: event.updatedAt,
          };
        });
      if (historicalActivities.length > 0) await tx.insert(activityEvents).values(historicalActivities);

      const activity = await recordActivity(tx, {
        boardId: targetBoardId,
        workspaceId: dstCtx.workspaceId,
        actorId: actor.sub,
        entityType: "card",
        entityId: finalCard.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: {
          title: finalCard.title,
          listId: targetListId,
          duplicatedFromId: source.id,
          duplicatedFromBoardId: source.boardId,
          duplicatedFromBoardName: sourceBoard?.name ?? null,
          ...(bulk && { bulk: true }),
        },
      });

      return { newCard: finalCard, attachmentRows: insertedAttachments, activity };
    });
  } catch (err) {
    // Blob copies happen before the database transaction so failures inside the write path need
    // explicit destination cleanup, especially when crossing org-prefixed storage roots.
    await Promise.all(copiedAttachments.map(({ copy }) =>
      Promise.allSettled([
        dstStorage.delete(copy.fileKey),
        copy.thumbnailFileKey ? dstStorage.delete(copy.thumbnailFileKey) : Promise.resolve(),
        copy.coverImageFileKey ? dstStorage.delete(copy.coverImageFileKey) : Promise.resolve(),
      ]),
    ));
    throw err;
  }

  return { ...result, labelIds, assigneeIds: eligibleAssigneeIds };
}

async function emitDuplicatedCardIntoBoard({
  actor,
  boardId,
  card,
  activity,
  labelIds,
  assigneeIds,
  attachmentRows,
}: {
  actor: AuthClaims;
  boardId: string;
  card: typeof cards.$inferSelect;
  activity: ActivityEvent;
  labelIds: string[];
  assigneeIds: string[];
  attachmentRows: (typeof cardAttachments.$inferSelect)[];
}) {
  const wireCard = toWireCard(card, actor.cid);
  await emitToBoard(boardId, SERVER_EVENTS.CARD_CREATED, { boardId, card: wireCard });
  await emitCardActivityFeedItem(boardId, card.id, activity);

  const copiedChecklists = await loadChecklistsForCard(card.id);
  for (const checklist of copiedChecklists) {
    emitToBoard(boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId, cardId: card.id, checklist });
  }

  if (labelIds.length > 0) emitToBoard(boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId, cardId: card.id, labelIds });
  if (assigneeIds.length > 0) emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: card.id, assigneeIds });

  if (attachmentRows.length > 0) {
    const userRow = await db
      .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, actor.sub))
      .limit(1);
    const uploadedByName = userRow[0]?.displayName ?? "";
    const uploadedByAvatarUrl = userRow[0]?.avatarUrl ?? null;
    for (const att of attachmentRows) {
      const shaped = shapeAttachmentMedia(att);
      emitToBoard(boardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
        boardId,
        cardId: card.id,
        attachment: {
          id: att.id,
          cardId: att.cardId,
          fileName: att.fileName,
          mimeType: att.mimeType,
          byteSize: att.byteSize,
          url: shaped.url,
          thumbnailUrl: shaped.thumbnailUrl,
          createdAt: att.createdAt,
          uploadedById: att.uploadedById,
          uploadedByName,
          uploadedByAvatarUrl: withSignedMedia(actor.cid, { uploadedByAvatarUrl }).uploadedByAvatarUrl,
          source: att.source,
          commentId: att.commentId,
        },
      });
    }
    if (card.coverAttachmentId) {
      emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: wireCard });
    }
  }
  return wireCard;
}

export async function cardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/cards/:id/detail", async (req): Promise<WireCardDetail> => {
    const { id } = req.params as { id: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id);
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
    // Restricted editors must retain access to cards they create; make that grant atomic with the
    // card creation rather than relying on a follow-up client request.
    if (ctx.assignedItemsOnly && !assigneeIds.includes(req.auth.sub)) assigneeIds.push(req.auth.sub);
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
      // Emit the requested assignment first because automation effects contain the final set;
      // clients use last-write-wins semantics when applying assignee snapshots.
      await emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: card.id, assigneeIds });
      await emitAutomationEffects(assignmentAutomationEffects);
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
        ctx.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined,
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
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
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
    return { updated: updates.length, skippedCardIds };
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
    return { updated: updates.length, skippedCardIds };
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
        attachmentRows: duplicated.attachmentRows,
      });
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
    const ctx = await assertCardAccess(req.auth, current.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, current.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, current.id, "editor");
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
    const srcCtx = await assertCardAccess(req.auth, source.id, "editor");
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
      attachmentRows: duplicated.attachmentRows,
    });

    return reply.status(201).send(wireNewCard);
  });

  app.post("/cards/:id/move-to-board", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardToBoardBody.parse(req.body);

    const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!source) throw notFound();
    const srcCtx = await assertCardAccess(req.auth, source.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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

  app.post("/cards/:id/checklists", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.createChecklistBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    await assertCardAccess(req.auth, card.id, "editor");
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
    await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    await assertCardAccess(req.auth, card.id, "editor");
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
    await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");

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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
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
