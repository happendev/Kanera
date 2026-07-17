import { SERVER_EVENTS, type WireCard, type WireCardChecklist } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  activityEvents,
  boardMembers,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardChecklistTemplateApplications,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  cardWatchers,
  commentReactions,
  comments,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaceMembers,
  type ActivityEvent,
  type CustomFieldType,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { env } from "../../env.js";
import type { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { emptyValueColumns, hasCustomFieldValue, type CustomFieldValueColumns } from "../../lib/custom-fields.js";
import { badRequest } from "../../lib/errors.js";
import { signEmbeddedMediaUrls, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import type { StorageProvider } from "../../lib/storage/index.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey, attachmentThumbnailStorageKey, cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { emitToBoard } from "../../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DuplicateIdMap {
  comments: Map<string, string>;
  attachments: Map<string, string>;
  checklists: Map<string, string>;
  checklistItems: Map<string, string>;
  activities: Map<string, string>;
}

function shouldAutoWatchAuthoredCards(authKind: AuthClaims["authKind"]) {
  return authKind !== "apiKey";
}

async function ensureBoardMembershipForUsers(
  boardId: string,
  _workspaceId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  // Assignment eligibility remains board-scoped for ordinary copies and mirror snapshots alike.
  // A workspace member who is not an explicit non-observer board member cannot own card work.
  const rows = await db.select({ userId: boardMembers.userId, role: boardMembers.role }).from(boardMembers).where(and(
    eq(boardMembers.boardId, boardId),
    inArray(boardMembers.userId, userIds),
  ));
  const eligible = new Set(rows.filter((member) => member.role !== "observer").map((member) => member.userId));
  return userIds.filter((userId) => eligible.has(userId));
}

async function ensureWorkspaceMembershipForUsers(workspaceId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId),
    inArray(workspaceMembers.userId, userIds),
  ));
  const eligible = new Set(rows.map((row) => row.userId));
  return userIds.filter((userId) => eligible.has(userId));
}

async function ensureMirrorAssignmentEligibility(boardId: string, workspaceId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const [workspaceRows, boardRows] = await Promise.all([
    db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      inArray(workspaceMembers.userId, userIds),
    )),
    db.select({ userId: boardMembers.userId, role: boardMembers.role }).from(boardMembers).where(and(
      eq(boardMembers.boardId, boardId),
      inArray(boardMembers.userId, userIds),
    )),
  ]);
  // Workspace membership grants access to every board, while board membership admits guests.
  // An explicit observer role still wins because observers cannot own card or checklist work.
  const eligible = new Set(workspaceRows.map((row) => row.userId));
  for (const row of boardRows) {
    if (row.role === "observer") eligible.delete(row.userId);
    else eligible.add(row.userId);
  }
  return userIds.filter((userId) => eligible.has(userId));
}

function cardUrl(boardId: string, cardId: string): string {
  return new URL(`/b/${boardId}/c/${cardId}`, env.WEB_ORIGIN).toString();
}

function toWireCard(card: typeof cards.$inferSelect, clientId: string): WireCard {
  const { clientToken: _clientToken, ...publicCard } = card;
  return {
    ...publicCard,
    description: signEmbeddedMediaUrls(card.description, clientId),
    url: cardUrl(card.boardId, card.id),
  };
}

async function emitCardActivityFeedItem(boardId: string, cardId: string, activity: ActivityEvent) {
  await emitActivityFeedItem(boardId, cardId, activity);
}

export async function loadChecklistsForCard(cardId: string, tx: Tx = db): Promise<WireCardChecklist[]> {
  // A transaction handle uses one pg client; sequential queries avoid overlapping client.query.
  const checklistRows = await tx.select().from(cardChecklists).where(eq(cardChecklists.cardId, cardId)).orderBy(asc(cardChecklists.position));
  const itemRows = await tx
      .select({
        item: cardChecklistItems,
        checklistId: cardChecklistItems.checklistId,
      })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .where(eq(cardChecklists.cardId, cardId))
      .orderBy(asc(cardChecklists.position), asc(cardChecklistItems.position));
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

export async function copyAttachmentBlobs(
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

export async function resolveDuplicateTargetList(
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

  const [sourceList] = await db.select({ name: lists.name, workspaceId: lists.workspaceId }).from(lists).where(eq(lists.id, source.listId)).limit(1);
  if (sourceList?.workspaceId === dstCtx.workspaceId) return source.listId;

  if (sourceList?.name) {
    const matchingLists = await db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.workspaceId, dstCtx.workspaceId), eq(lists.name, sourceList.name), isNull(lists.archivedAt)));
    if (matchingLists.length === 1) return matchingLists[0]!.id;
  }

  // Cross-workspace copies cannot reuse the source list id because lists are workspace-scoped.
  // Exact name matching preserves the common lane automatically; ambiguous or missing matches
  // still require an explicit target list from the UI/API client.
  throw badRequest("target list required");
}

export async function duplicateLabelIds(
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

export async function duplicateCustomFieldValues(
  sourceValues: (typeof cardCustomFieldValues.$inferSelect)[],
  srcCtx: Pick<CardAccessContext, "workspaceId">,
  dstCtx: Pick<BoardAccessContext, "workspaceId">,
  eligibleAssigneeIds: string[],
): Promise<DuplicateFieldValueRow[]> {
  if (sourceValues.length === 0) return [];
  const sourceFieldIds = sourceValues.map((value) => value.fieldId);
  if (srcCtx.workspaceId === dstCtx.workspaceId) {
    const validFields = await db
      .select({ id: customFields.id, type: customFields.type, allowMultiple: customFields.allowMultiple })
      .from(customFields)
      .where(and(eq(customFields.workspaceId, dstCtx.workspaceId), inArray(customFields.id, sourceFieldIds), isNull(customFields.archivedAt)));
    const validFieldById = new Map(validFields.map((field) => [field.id, field]));
    const eligibleUsers = new Set(eligibleAssigneeIds);
    return sourceValues
      .flatMap((value) => {
        const field = validFieldById.get(value.fieldId);
        if (!field) return [];
        const userIds = field.type === "user"
          ? (value.valueUserIds ?? []).filter((userId) => eligibleUsers.has(userId))
          : value.valueUserIds;
        if (field.type === "user" && (!userIds || userIds.length === 0)) return [];
        return [{
          fieldId: value.fieldId,
          valueText: value.valueText,
          valueNumber: value.valueNumber,
          valueCheckbox: value.valueCheckbox,
          valueDate: value.valueDate,
          valueUrl: value.valueUrl,
          valueOptionIds: value.valueOptionIds,
          valueUserIds: field.type === "user" && !field.allowMultiple ? userIds!.slice(0, 1) : userIds,
        }];
      });
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
  if (kind === "support") return fallbackName ?? `Kanera Support (${supportActorEmail ?? "operator"})`;
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
      clientId: activityEvents.clientId,
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
      actorNameSnapshot: sql<string | null>`case when ${activityEvents.actorKind} = 'system' then 'Kanera' when ${activityEvents.actorKind} = 'support' then ${users.displayName} when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key') else ${users.displayName} end`,
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
  ids?: Pick<DuplicateIdMap, "comments" | "attachments" | "checklists" | "checklistItems">,
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
  if (typeof payload.attachmentId === "string") payload.attachmentId = ids?.attachments.get(payload.attachmentId) ?? payload.attachmentId;
  if (typeof payload.commentId === "string") payload.commentId = ids?.comments.get(payload.commentId) ?? payload.commentId;
  if (typeof payload.checklistId === "string") payload.checklistId = ids?.checklists.get(payload.checklistId) ?? payload.checklistId;
  if (typeof payload.itemId === "string") payload.itemId = ids?.checklistItems.get(payload.itemId) ?? payload.itemId;
  if (copiedActorName) payload.copiedActorName = copiedActorName;
  return payload;
}

export async function duplicateCardInto({
  source,
  srcCtx,
  dstCtx,
  targetBoardId,
  targetListId,
  position,
  actor,
  bulk = false,
  includeAssignees = true,
  includeActivityHistory = true,
  autoWatch = true,
  systemAttributeComments = false,
  createdActivityPayload,
  activityActorKind,
  includeLifecycleState = false,
  includeArchivedState = includeLifecycleState,
  includeCover = true,
  resetChecklistItemCompletion = false,
  resolveChecklistAssigneesIndependently = false,
  resolveMirrorAssigneesFromBoardAccess = false,
  resolveCustomFieldUsersFromWorkspace = false,
  systemAttributeActivities = false,
  excludeCreatedActivityHistory = false,
  attributeCreatedActivityToSource = false,
  copiedActivityPayload,
  withinTx,
}: {
  source: typeof cards.$inferSelect;
  srcCtx: Pick<CardAccessContext, "workspaceId" | "clientId">;
  dstCtx: BoardAccessContext;
  targetBoardId: string;
  targetListId: string;
  position: string;
  actor: AuthClaims;
  bulk?: boolean;
  includeAssignees?: boolean;
  includeActivityHistory?: boolean;
  autoWatch?: boolean;
  systemAttributeComments?: boolean;
  createdActivityPayload?: Record<string, unknown>;
  activityActorKind?: "system";
  includeLifecycleState?: boolean;
  includeArchivedState?: boolean;
  includeCover?: boolean;
  /** Mirror snapshots start every item unchecked; ordinary duplication preserves its old state. */
  resetChecklistItemCompletion?: boolean;
  /** Mirror snapshots consider checklist-only assignees without changing ordinary copy semantics. */
  resolveChecklistAssigneesIndependently?: boolean;
  /** Mirror snapshots include workspace members and eligible board guests; ordinary copies do not. */
  resolveMirrorAssigneesFromBoardAccess?: boolean;
  /** Mirror user fields use workspace eligibility independently from card assignment eligibility. */
  resolveCustomFieldUsersFromWorkspace?: boolean;
  systemAttributeActivities?: boolean;
  excludeCreatedActivityHistory?: boolean;
  attributeCreatedActivityToSource?: boolean;
  copiedActivityPayload?: Record<string, unknown>;
  withinTx?: (tx: Tx, result: { newCard: typeof cards.$inferSelect; ids: DuplicateIdMap }) => Promise<void>;
}) {
  const [sourceLabels, sourceFieldValues, sourceAssignees, sourceAttachments, sourceChecklists, sourceTemplateApplications, sourceComments, sourceActivityRows, targetAttributionIds, sourceListNames] = await Promise.all([
    db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, source.id)),
    db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, source.id)),
    includeAssignees
      ? db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, source.id))
      : Promise.resolve([]),
    db.select().from(cardAttachments).where(eq(cardAttachments.cardId, source.id)),
    loadChecklistsForCard(source.id),
    srcCtx.workspaceId === dstCtx.workspaceId
      ? db.select({ templateId: cardChecklistTemplateApplications.templateId }).from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, source.id))
      : Promise.resolve([]),
    loadCommentsForDuplicate(source.id),
    includeActivityHistory || attributeCreatedActivityToSource ? loadActivityForDuplicate(source) : Promise.resolve([]),
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
  // A copy may preserve source identities only when they already have assignable access to the
  // target board. It must never turn an assignee into destination membership implicitly.
  const checklistAssigneeIds = sourceChecklists.flatMap((checklist) => checklist.items.flatMap((item) => item.assigneeId ? [item.assigneeId] : []));
  const assignmentCandidates = [...new Set([
    ...sourceAssignees.map((assignee) => assignee.userId),
    ...(resolveChecklistAssigneesIndependently ? checklistAssigneeIds : []),
  ])];
  const fieldUserCandidates = [...new Set(sourceFieldValues.flatMap((value) => value.valueUserIds ?? []))];
  // Assignment and user-valued fields have different tenancy rules. A board guest can be assigned
  // work without becoming a target-workspace member, while a user-field value must belong to that
  // workspace even when the user is not assigned to the card.
  const [eligibleAssignmentIds, eligibleFieldUserIds] = await Promise.all([
    includeAssignees
      ? resolveMirrorAssigneesFromBoardAccess
        ? ensureMirrorAssignmentEligibility(targetBoardId, dstCtx.workspaceId, assignmentCandidates)
        : ensureBoardMembershipForUsers(targetBoardId, dstCtx.workspaceId, assignmentCandidates)
      : Promise.resolve([]),
    resolveCustomFieldUsersFromWorkspace
      ? ensureWorkspaceMembershipForUsers(dstCtx.workspaceId, fieldUserCandidates)
      : Promise.resolve([]),
  ]);
  const eligibleAssignmentSet = new Set(eligibleAssignmentIds);
  const eligibleAssigneeIds = sourceAssignees.map((assignee) => assignee.userId).filter((userId) => eligibleAssignmentSet.has(userId));
  const [labelIds, fieldValueRows] = await Promise.all([
    duplicateLabelIds(sourceLabels, srcCtx, dstCtx),
    duplicateCustomFieldValues(
      sourceFieldValues,
      srcCtx,
      dstCtx,
      resolveCustomFieldUsersFromWorkspace ? eligibleFieldUserIds : eligibleAssigneeIds,
    ),
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
          ...(includeLifecycleState && { completedAt: source.completedAt }),
          ...(includeArchivedState && { archivedAt: source.archivedAt }),
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

      if (autoWatch && shouldAutoWatchAuthoredCards(actor.authKind)) {
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

      const checklistIdMap = new Map<string, string>();
      const checklistItemIdMap = new Map<string, string>();
      const insertDuplicatedChecklist = async (
        sourceChecklist: (typeof sourceChecklists)[number],
        parentItemId: string | null,
      ) => {
        const newChecklistId = randomUUID();
        const [checklist] = await tx
          .insert(cardChecklists)
          .values({
            id: newChecklistId,
            cardId: inserted!.id,
            parentItemId,
            title: sourceChecklist.title,
            position: sourceChecklist.position,
          })
          .returning();
        checklistIdMap.set(sourceChecklist.id, checklist!.id);
        if (sourceChecklist.items.length > 0) {
          await tx.insert(cardChecklistItems).values(sourceChecklist.items.map((item) => {
            const newItemId = randomUUID();
            checklistItemIdMap.set(item.id, newItemId);
            return {
              id: newItemId,
              checklistId: checklist!.id,
              text: item.text,
              description: item.description,
              position: item.position,
              assigneeId: item.assigneeId && eligibleAssignmentSet.has(item.assigneeId) ? item.assigneeId : null,
              completedAt: resetChecklistItemCompletion ? null : item.completedAt ? new Date(item.completedAt as unknown as string) : null,
              completedById: !resetChecklistItemCompletion && includeAssignees && item.completedById && eligibleAssignmentSet.has(item.completedById)
                ? item.completedById
                : null,
              dueDateLocalDate: item.dueDateLocalDate,
              dueDateSlot: item.dueDateSlot,
              dueDateTimezone: item.dueDateTimezone,
            };
          }));
        }
      };

      // Parent items must exist before their detail checklists can be re-parented on the copy.
      // The product caps nesting at one level, so these two passes preserve the full hierarchy.
      for (const sourceChecklist of sourceChecklists) {
        if (sourceChecklist.parentItemId === null) await insertDuplicatedChecklist(sourceChecklist, null);
      }
      for (const sourceChecklist of sourceChecklists) {
        if (sourceChecklist.parentItemId === null) continue;
        const parentItemId = checklistItemIdMap.get(sourceChecklist.parentItemId);
        if (parentItemId) await insertDuplicatedChecklist(sourceChecklist, parentItemId);
      }

      const sourceCommentIdToNewId = new Map<string, string>();
      if (sourceComments.length > 0) {
        const commentRows = sourceComments.map((comment) => {
          const canKeepOriginalUser = !systemAttributeComments && comment.authorKind === "user" && targetAttributionIds.has(comment.authorId);
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
      const attachmentIdMap = new Map<string, string>();
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
            coverImageWidth: copy.coverImageFileKey ? src.coverImageWidth : null,
            coverImageHeight: copy.coverImageFileKey ? src.coverImageHeight : null,
            coverImageColor: copy.coverImageFileKey ? src.coverImageColor : null,
            source: src.source === "comment" && copiedCommentId ? "comment" : src.source === "comment" ? "attachment" : src.source,
            commentId: copiedCommentId,
          })
          .returning();
        insertedAttachments.push(row!);
        attachmentIdMap.set(src.id, row!.id);
        if (includeCover && source.coverAttachmentId === src.id) newCoverAttachmentId = row!.id;
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

      const sourceActivityIdToNewId = new Map<string, string>();
      const historicalActivities = (includeActivityHistory ? sourceActivityRows : [])
        .filter((event) => event.entityType !== "comment"
          && event.coalesceKey !== "card:mirrorSync"
          && (includeCover || (event.action !== ACTIVITY_ACTION.COVER_SET && event.action !== ACTIVITY_ACTION.COVER_REMOVED))
          && (!excludeCreatedActivityHistory || event.action !== ACTIVITY_ACTION.CREATED))
        .map((event) => {
          const canKeepOriginalUser = !systemAttributeActivities && event.actorKind === "user" && event.actorId !== null && targetAttributionIds.has(event.actorId);
          const existingPayload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload as Record<string, unknown>
            : {};
          const existingSnapshot = typeof existingPayload.copiedActorName === "string" ? existingPayload.copiedActorName : null;
          const copiedActorName = canKeepOriginalUser
            ? null
            : existingSnapshot ?? (event.actorKind === "system"
              ? null
              : duplicateActorSnapshotName(event.actorKind, event.actorNameSnapshot, event.apiKeyName, event.supportActorEmail));
          const newActivityId = randomUUID();
          sourceActivityIdToNewId.set(event.id, newActivityId);
          return {
            id: newActivityId,
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
            payload: {
              ...cloneActivityPayloadForDuplicate(event, source, finalCard.id, sourceListNames, copiedActorName, {
                comments: sourceCommentIdToNewId,
                attachments: attachmentIdMap,
                checklists: checklistIdMap,
                checklistItems: checklistItemIdMap,
              }),
              ...copiedActivityPayload,
            },
            feedVisible: event.feedVisible,
            coalesceKey: event.coalesceKey,
            coalescedCount: event.coalescedCount,
            coalescedUntil: event.coalescedUntil,
            createdAt: event.createdAt,
            updatedAt: event.updatedAt,
          };
        });
      if (historicalActivities.length > 0) await tx.insert(activityEvents).values(historicalActivities);

      const sourceCreatedActivity = attributeCreatedActivityToSource
        ? sourceActivityRows.find((event) => event.entityType === "card" && event.entityId === source.id && event.action === ACTIVITY_ACTION.CREATED)
        : null;
      const sourceCreatedPayload = sourceCreatedActivity?.payload && typeof sourceCreatedActivity.payload === "object" && !Array.isArray(sourceCreatedActivity.payload)
        ? sourceCreatedActivity.payload as Record<string, unknown>
        : {};
      const existingCreatedActorName = typeof sourceCreatedPayload.copiedActorName === "string" ? sourceCreatedPayload.copiedActorName : null;
      const copiedCreatedActorName = sourceCreatedActivity
        ? existingCreatedActorName ?? (sourceCreatedActivity.actorKind === "system"
          ? null
          : duplicateActorSnapshotName(
              sourceCreatedActivity.actorKind,
              sourceCreatedActivity.actorNameSnapshot,
              sourceCreatedActivity.apiKeyName,
              sourceCreatedActivity.supportActorEmail,
            ))
        : null;

      const activity = await recordActivity(tx, {
        boardId: targetBoardId,
        workspaceId: dstCtx.workspaceId,
        actorId: actor.sub,
        entityType: "card",
        entityId: finalCard.id,
        action: ACTIVITY_ACTION.CREATED,
        actorKind: activityActorKind,
        payload: {
          title: finalCard.title,
          listId: targetListId,
          ...(createdActivityPayload ?? {
            duplicatedFromId: source.id,
            duplicatedFromBoardId: source.boardId,
            duplicatedFromBoardName: sourceBoard?.name ?? null,
          }),
          // Mirror-created cards are system-owned on the target, but their feed should still name
          // the person who created the original card (and preserve that snapshot across mirrors).
          ...(copiedCreatedActorName && { copiedActorName: copiedCreatedActorName }),
          ...(bulk && { bulk: true }),
        },
      });

      // Mirror idempotency links must commit atomically with every copied entity. Keeping this as
      // the final transactional hook prevents a crash from leaving an unlinked deep copy behind.
      await withinTx?.(tx, {
        newCard: finalCard,
        ids: {
          comments: sourceCommentIdToNewId,
          attachments: attachmentIdMap,
          checklists: checklistIdMap,
          checklistItems: checklistItemIdMap,
          activities: sourceActivityIdToNewId,
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

  return { ...result, labelIds, assigneeIds: eligibleAssigneeIds, customFieldValues: fieldValueRows };
}

export async function emitDuplicatedCardIntoBoard({
  actor,
  boardId,
  card,
  activity,
  labelIds,
  assigneeIds,
  customFieldValues,
  attachmentRows,
}: {
  actor: AuthClaims;
  boardId: string;
  card: typeof cards.$inferSelect;
  activity: ActivityEvent;
  labelIds: string[];
  assigneeIds: string[];
  customFieldValues: DuplicateFieldValueRow[];
  attachmentRows: (typeof cardAttachments.$inferSelect)[];
}) {
  const wireCard = toWireCard(card, actor.cid);
  await emitToBoard(boardId, SERVER_EVENTS.CARD_CREATED, { boardId, card: wireCard });
  await emitCardActivityFeedItem(boardId, card.id, activity);

  const copiedChecklists = await loadChecklistsForCard(card.id);
  for (const checklist of copiedChecklists) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId, cardId: card.id, checklist });
  }

  if (labelIds.length > 0) await emitToBoard(boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId, cardId: card.id, labelIds });
  if (assigneeIds.length > 0) await emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: card.id, assigneeIds });
  // CARD_CREATED carries only the card row. Publish copied field snapshots afterwards so clients
  // that already have the destination board open see the complete initial mirror without a reload.
  for (const value of customFieldValues) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
      boardId,
      cardId: card.id,
      ...value,
    });
  }

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
      await emitToBoard(boardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
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
      await emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: wireCard });
    }
  }
  return wireCard;
}
