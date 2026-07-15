import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { BoardExportArchive, CardAttachmentRow, CardFeedItem, CommentRow, CommitImportBody, ImportResultSummary, ReactionUserSummary } from "@kanera/shared/dto";
import type { WireCard, WireCardChecklist, WireCardChecklistItem, WireCustomField, WireCustomFieldOption } from "@kanera/shared/events";
import {
  activityEvents,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cardWatchers,
  cards,
  commentReactions,
  comments,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import type { ActivityEvent, Board, Card, CardLabel, CustomField, List } from "@kanera/shared/schema";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { badRequest } from "../../lib/errors.js";
import { unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { between, positionAtIndex } from "../../lib/position.js";
import { seedBoardMembersFromWorkspace } from "../../lib/board-membership.js";
import type { StorageProvider } from "../../lib/storage/index.js";
import { cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { assertBoardLimit } from "../../lib/tier-limits.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const CHUNK_SIZE = 500;

// Attachment copy is network-bound (download from the source export, upload to storage). The
// whole import runs in one transaction, so we parallelize only the I/O and keep DB writes serial:
// a Drizzle transaction is a single connection and cannot run concurrent queries safely.
const ATTACHMENT_COPY_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface KaneraBoardImportEvents {
  cardsCreated: WireCard[];
  cardsUpdated: WireCard[];
  labelsSet: { cardId: string; labelIds: string[] }[];
  assigneesSet: { cardId: string; assigneeIds: string[] }[];
  customFieldValuesSet: {
    cardId: string;
    fieldId: string;
    valueText?: string | null;
    valueNumber?: string | null;
    valueCheckbox?: boolean | null;
    valueDate?: string | null;
    valueUrl?: string | null;
    valueOptionIds?: string[] | null;
    valueUserIds?: string[] | null;
  }[];
  checklistsCreated: { cardId: string; checklist: WireCardChecklist }[];
  checklistItemsCreated: { cardId: string; checklistId: string; checklistParentItemId: string | null; item: WireCardChecklistItem }[];
  commentsCreated: { cardId: string; comment: CommentRow; item: CardFeedItem }[];
  activityFeedItemsCreated: { cardId: string; item: CardFeedItem }[];
  attachmentsCreated: { cardId: string; attachment: CardAttachmentRow }[];
  reactionsAdded: { cardId: string; commentId: string; type: "thumbs_up"; user: ReactionUserSummary }[];
}

export interface KaneraBoardImportResult {
  summary: ImportResultSummary;
  board: Board;
  createdLists: List[];
  createdLabels: CardLabel[];
  createdCustomFields: WireCustomField[];
  events: KaneraBoardImportEvents;
}

interface ImportContext {
  tx: Tx;
  source: BoardExportArchive;
  body: CommitImportBody;
  workspaceId: string;
  clientId: string;
  actorId: string;
  targetBoardId: string | null;
  storage: StorageProvider;
  warnings: string[];
  actorName: string;
  actorAvatarUrl: string | null;
}

function chunks<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function insertMany<T extends Record<string, unknown>, R>(tx: Tx, table: Parameters<Tx["insert"]>[0], rows: T[]): Promise<R[]> {
  const inserted: R[] = [];
  for (const chunk of chunks(rows)) {
    if (chunk.length === 0) continue;
    inserted.push(...await tx.insert(table).values(chunk).returning() as R[]);
  }
  return inserted;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date || typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date) return null;
  return Number.isNaN(date.getTime()) ? null : date;
}

function cardUrl(boardId: string, cardId: string): string {
  return `/b/${boardId}/c/${cardId}`;
}

function toWireCard(card: Card): WireCard {
  return { ...card, url: cardUrl(card.boardId, card.id) };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function importedCommentBody(body: string, authorName: string | null, mappedAuthor: boolean): string {
  const trimmed = body.trim();
  if (mappedAuthor || !authorName) return trimmed.slice(0, 20_000);
  return `[Imported from Kanera - ${authorName}]\n\n${trimmed}`.slice(0, 20_000);
}

async function createBoard(ctx: ImportContext): Promise<Board> {
  if (ctx.targetBoardId) {
    const [target] = await ctx.tx
      .select()
      .from(boards)
      .where(and(eq(boards.id, ctx.targetBoardId), eq(boards.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!target) throw badRequest("standalone board import target not found");
    // A standalone import is additive: keep the destination board's identity and permissions while
    // importing mapped configuration and cards into its sole board row.
    return target;
  }
  const [workspace] = await ctx.tx
    .select({ kind: workspaces.kind })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  // Commit-time defense in depth protects imports analyzed before a workspace kind change.
  if (workspace?.kind === "board") throw badRequest("imports cannot create a second board in a standalone board");
  await assertBoardLimit(ctx.clientId, ctx.tx);
  const [last] = await ctx.tx.select({ position: boards.position }).from(boards).where(eq(boards.workspaceId, ctx.workspaceId)).orderBy(desc(boards.position)).limit(1);
  const [board] = await ctx.tx.insert(boards).values({
    workspaceId: ctx.workspaceId,
    name: ctx.body.board.name,
    description: ctx.source.board.description,
    icon: ctx.body.board.icon ?? ctx.source.board.icon ?? "layout-kanban",
    iconColor: ctx.body.board.iconColor ?? ctx.source.board.iconColor ?? null,
    backgroundGradient: ctx.source.board.backgroundGradient,
    position: between(last?.position ?? null, null).position,
  }).returning();
  if (!board) throw badRequest("could not create board");
  // Seed explicit board membership from the workspace roster (importer = owner) so the imported
  // board is accessible to the team; board membership is the sole access model.
  await seedBoardMembersFromWorkspace(ctx.tx, board.id, ctx.workspaceId, ctx.actorId);
  return board;
}

async function mapLists(ctx: ImportContext): Promise<{ map: Map<string, string>; created: List[] }> {
  const existing = await ctx.tx.select({ id: lists.id }).from(lists).where(eq(lists.workspaceId, ctx.workspaceId));
  const existingIds = new Set(existing.map((list) => list.id));
  const [last] = await ctx.tx.select({ position: lists.position }).from(lists).where(eq(lists.workspaceId, ctx.workspaceId)).orderBy(desc(lists.position)).limit(1);
  let prev = last?.position ?? null;
  const map = new Map<string, string>();
  const sourceIds: string[] = [];
  const rows = [];
  for (const sourceList of ctx.source.lists) {
    const mapping = ctx.body.lists[sourceList.id] ?? { action: "skip" as const };
    if (mapping.action === "skip") continue;
    if (mapping.action === "map") {
      if (!existingIds.has(mapping.targetListId!)) throw badRequest("list mapping target not found in workspace");
      map.set(sourceList.id, mapping.targetListId!);
      continue;
    }
    const position = between(prev, null).position;
    prev = position;
    sourceIds.push(sourceList.id);
    rows.push({ workspaceId: ctx.workspaceId, name: mapping.name ?? sourceList.name, icon: mapping.icon ?? sourceList.icon, color: mapping.color ?? sourceList.color, position });
  }
  const created = await insertMany<typeof rows[number], List>(ctx.tx, lists, rows);
  created.forEach((list, index) => map.set(sourceIds[index]!, list.id));
  return { map, created };
}

async function mapLabels(ctx: ImportContext): Promise<{ map: Map<string, string>; created: CardLabel[] }> {
  const existing = await ctx.tx.select({ id: cardLabels.id }).from(cardLabels).where(eq(cardLabels.workspaceId, ctx.workspaceId));
  const existingIds = new Set(existing.map((label) => label.id));
  const [last] = await ctx.tx.select({ position: cardLabels.position }).from(cardLabels).where(eq(cardLabels.workspaceId, ctx.workspaceId)).orderBy(desc(cardLabels.position)).limit(1);
  let prev = last?.position ?? null;
  const map = new Map<string, string>();
  const sourceIds: string[] = [];
  const rows = [];
  for (const sourceLabel of ctx.source.labels) {
    const mapping = ctx.body.labels[sourceLabel.id] ?? { action: "skip" as const };
    if (mapping.action === "skip") continue;
    if (mapping.action === "map") {
      if (!existingIds.has(mapping.targetLabelId!)) throw badRequest("label mapping target not found in workspace");
      map.set(sourceLabel.id, mapping.targetLabelId!);
      continue;
    }
    const position = between(prev, null).position;
    prev = position;
    sourceIds.push(sourceLabel.id);
    rows.push({ workspaceId: ctx.workspaceId, name: mapping.name ?? sourceLabel.name, color: mapping.color ?? sourceLabel.color, position });
  }
  const created = await insertMany<typeof rows[number], CardLabel>(ctx.tx, cardLabels, rows);
  created.forEach((label, index) => map.set(sourceIds[index]!, label.id));
  return { map, created };
}

async function mapCustomFields(ctx: ImportContext): Promise<{ map: Map<string, CustomField>; optionMap: Map<string, string>; created: WireCustomField[] }> {
  if (!ctx.body.options.importCustomFields) return { map: new Map(), optionMap: new Map(), created: [] };
  const existing = await ctx.tx.select().from(customFields).where(eq(customFields.workspaceId, ctx.workspaceId));
  const existingById = new Map(existing.map((field) => [field.id, field]));
  const [last] = await ctx.tx.select({ position: customFields.position }).from(customFields).where(eq(customFields.workspaceId, ctx.workspaceId)).orderBy(desc(customFields.position)).limit(1);
  let prev = last?.position ?? null;
  const map = new Map<string, CustomField>();
  const sourceIds: string[] = [];
  const rows = [];
  for (const sourceField of ctx.source.customFields) {
    const mapping = ctx.body.customFields[sourceField.id] ?? { action: "skip" as const };
    if (mapping.action === "skip") continue;
    if (mapping.action === "map") {
      const field = existingById.get(mapping.targetFieldId!);
      if (!field) throw badRequest("custom field mapping target not found");
      if (field.type !== sourceField.type) ctx.warnings.push(`Skipped values for "${sourceField.name}" because the mapped Kanera field type is ${field.type}.`);
      map.set(sourceField.id, field);
      continue;
    }
    const position = between(prev, null).position;
    prev = position;
    sourceIds.push(sourceField.id);
    rows.push({
      workspaceId: ctx.workspaceId,
      name: mapping.name ?? sourceField.name,
      icon: mapping.icon ?? sourceField.icon,
      type: mapping.type ?? sourceField.type,
      allowMultiple: sourceField.allowMultiple,
      position,
      showOnCard: sourceField.showOnCard,
    });
  }
  const createdRows = await insertMany<typeof rows[number], CustomField>(ctx.tx, customFields, rows);
  const createdSourceIds = new Set(sourceIds);
  createdRows.forEach((field, index) => map.set(sourceIds[index]!, field));

  const optionMap = new Map<string, string>();
  const mappedSelectFields = ctx.source.customFields
    .map((sourceField) => ({ sourceField, field: map.get(sourceField.id) }))
    .filter((entry): entry is { sourceField: BoardExportArchive["customFields"][number]; field: CustomField } => !!entry.field && entry.field.type === "select" && !createdSourceIds.has(entry.sourceField.id));
  if (mappedSelectFields.length > 0) {
    const existingOptions = await ctx.tx.select().from(customFieldOptions).where(and(inArray(customFieldOptions.fieldId, mappedSelectFields.map((entry) => entry.field.id)), isNull(customFieldOptions.archivedAt)));
    for (const { sourceField, field } of mappedSelectFields) {
      const optionsForField = existingOptions.filter((option) => option.fieldId === field.id);
      for (const sourceOption of sourceField.options) {
        const target = optionsForField.find((option) => normalize(option.label) === normalize(sourceOption.label));
        if (target) optionMap.set(sourceOption.id, target.id);
      }
    }
  }

  const optionRows = [];
  const optionSourceIds: string[] = [];
  for (const sourceField of ctx.source.customFields) {
    const field = map.get(sourceField.id);
    if (!field || field.type !== "select") continue;
    for (const [index, option] of sourceField.options.entries()) {
      if (!createdSourceIds.has(sourceField.id) && optionMap.has(option.id)) continue;
      optionSourceIds.push(option.id);
      optionRows.push({ fieldId: field.id, label: option.label, color: option.color, position: option.position ?? positionAtIndex(index) });
    }
  }
  const createdOptions = await insertMany<typeof optionRows[number], WireCustomFieldOption>(ctx.tx, customFieldOptions, optionRows);
  createdOptions.forEach((option, index) => optionMap.set(optionSourceIds[index]!, option.id));
  const optionsByField = new Map<string, WireCustomFieldOption[]>();
  for (const option of createdOptions) {
    const options = optionsByField.get(option.fieldId);
    if (options) options.push(option);
    else optionsByField.set(option.fieldId, [option]);
  }
  return { map, optionMap, created: createdRows.map((field) => ({ ...field, options: optionsByField.get(field.id) ?? [] })) };
}

function mappedFieldValue(value: BoardExportArchive["cardCustomFieldValues"][number], field: CustomField, optionMap: Map<string, string>, memberMap: Map<string, string>): KaneraBoardImportEvents["customFieldValuesSet"][number] | null {
  if (field.type === "select") {
    const ids = (value.valueOptionIds ?? []).map((id) => optionMap.get(id)).filter((id): id is string => !!id);
    return ids.length ? { cardId: "", fieldId: field.id, valueOptionIds: field.allowMultiple ? ids : ids.slice(0, 1) } : null;
  }
  if (field.type === "user") {
    const ids = (value.valueUserIds ?? []).map((id) => memberMap.get(id)).filter((id): id is string => !!id);
    return ids.length ? { cardId: "", fieldId: field.id, valueUserIds: field.allowMultiple ? ids : ids.slice(0, 1) } : null;
  }
  return {
    cardId: "",
    fieldId: field.id,
    valueText: value.valueText,
    valueNumber: value.valueNumber,
    valueCheckbox: value.valueCheckbox,
    valueDate: value.valueDate,
    valueUrl: value.valueUrl,
  };
}

async function copyAttachments(ctx: ImportContext, cardIdBySourceId: Map<string, string>, commentIdBySourceId: Map<string, string>): Promise<{ rows: CardAttachmentRow[]; coverUpdates: Map<string, string> }> {
  const rows: CardAttachmentRow[] = [];
  const coverUpdates = new Map<string, string>();
  if (ctx.body.options.attachmentCopyMode === "skip") {
    if (ctx.source.attachments.length) ctx.warnings.push(`${ctx.source.attachments.length} attachment${ctx.source.attachments.length === 1 ? "" : "s"} skipped by import option.`);
    return { rows, coverUpdates };
  }

  // Cover lookup once instead of scanning source cards per attachment.
  const coverAttachmentBySourceCard = new Map(ctx.source.cards.map((card) => [card.id, card.coverAttachmentId]));

  // Phase 1: download + upload each file. This is the slow part, so run it with bounded
  // concurrency. No DB queries happen here, so it is safe alongside the open transaction.
  type Prepared = { attachment: BoardExportArchive["attachments"][number]; cardId: string; fileKey: string; byteSize: number } | { warning: string };
  const candidates = ctx.source.attachments
    .map((attachment) => ({ attachment, cardId: cardIdBySourceId.get(attachment.cardId) }))
    .filter((candidate): candidate is { attachment: BoardExportArchive["attachments"][number]; cardId: string } => !!candidate.cardId);
  const prepared = await mapWithConcurrency(candidates, ATTACHMENT_COPY_CONCURRENCY, async ({ attachment, cardId }): Promise<Prepared> => {
    const ext = getAllowedAttachmentExtension(attachment.mimeType, attachment.fileName);
    if (!ext) return { warning: `Skipped attachment "${attachment.fileName}" because its file type is unsupported.` };
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileKey = cardAttachmentStorageKey(cardId, ext);
      await ctx.storage.put(fileKey, buffer, attachment.mimeType);
      return { attachment, cardId, fileKey, byteSize: buffer.byteLength };
    } catch {
      // Exported attachment URLs are signed and may expire before import. Keep the board import
      // moving and surface the missed file in the result instead of rolling back all entities.
      return { warning: `Could not copy attachment "${attachment.fileName}".` };
    }
  });

  // Phase 2: insert the successfully-uploaded files in one batch on the transaction. Returned rows
  // preserve VALUES order, so they zip back to `uploads` for cover and event mapping.
  const uploads = prepared.filter((entry): entry is Extract<Prepared, { fileKey: string }> => "fileKey" in entry);
  for (const entry of prepared) if ("warning" in entry) ctx.warnings.push(entry.warning);
  const inserted = await insertMany<Record<string, unknown>, typeof cardAttachments.$inferSelect>(ctx.tx, cardAttachments, uploads.map(({ attachment, cardId, fileKey, byteSize }) => ({
    cardId,
    clientId: ctx.clientId,
    uploadedById: ctx.body.members[attachment.uploadedById] ?? ctx.actorId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteSize,
    fileKey,
    url: unsignedMediaUrl(ctx.clientId, fileKey)!,
    source: attachment.source,
    commentId: attachment.commentId ? commentIdBySourceId.get(attachment.commentId) ?? null : null,
    createdAt: toDate(attachment.createdAt) ?? new Date(),
  })));
  inserted.forEach((row, index) => {
    const { attachment, cardId } = uploads[index]!;
    if (coverAttachmentBySourceCard.get(attachment.cardId) === attachment.id) coverUpdates.set(cardId, row.id);
    rows.push(withSignedMedia(ctx.clientId, {
      id: row.id,
      cardId: row.cardId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      url: unsignedMediaUrl(ctx.clientId, row.fileKey)!,
      thumbnailUrl: null,
      createdAt: row.createdAt,
      uploadedById: row.uploadedById,
      uploadedByName: ctx.actorName,
      uploadedByAvatarUrl: ctx.actorAvatarUrl,
      source: row.source,
      commentId: row.commentId,
    }));
  });
  return { rows, coverUpdates };
}

export async function runKaneraBoardImport(tx: Tx, args: { source: BoardExportArchive; body: CommitImportBody; workspaceId: string; clientId: string; actorId: string; targetBoardId?: string | null; storage: StorageProvider }): Promise<KaneraBoardImportResult> {
  const ctx: ImportContext = { tx, warnings: [], actorName: "Importer", actorAvatarUrl: null, targetBoardId: null, ...args };
  const [workspaceUserRows, actorRow] = await Promise.all([
    tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ctx.workspaceId)),
    tx.select({ displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, ctx.actorId)).limit(1),
  ]);
  ctx.actorName = actorRow[0]?.displayName ?? "Importer";
  ctx.actorAvatarUrl = actorRow[0]?.avatarUrl ?? null;
  const workspaceUserIds = new Set(workspaceUserRows.map((row) => row.userId));
  for (const targetUserId of Object.values(ctx.body.members)) {
    if (targetUserId && !workspaceUserIds.has(targetUserId)) throw badRequest("member mapping target not found in workspace");
  }
  const memberMap = new Map(Object.entries(ctx.body.members).filter((entry): entry is [string, string] => !!entry[1]));

  const board = await createBoard(ctx);
  const listMapping = await mapLists(ctx);
  const labelMapping = await mapLabels(ctx);
  const fieldMapping = await mapCustomFields(ctx);
  const skippedListIds = new Set(ctx.source.lists.filter((list) => !listMapping.map.has(list.id)).map((list) => list.id));
  const importCards = ctx.source.cards.filter((card) => listMapping.map.has(card.listId) && (ctx.body.options.includeArchived || !card.archivedAt));
  const targetListIds = Array.from(new Set(importCards.map((card) => listMapping.map.get(card.listId)!)));
  const tailRows = targetListIds.length === 0
    ? []
    : await ctx.tx
        .select({ listId: cards.listId, position: sql<string | null>`max(${cards.position})` })
        .from(cards)
        .where(inArray(cards.listId, targetListIds))
        .groupBy(cards.listId);
  const nextPositionByList = new Map(tailRows.map((row) => [row.listId, row.position]));
  const cardRows = importCards.map((card) => {
    const listId = listMapping.map.get(card.listId)!;
    const position = between(nextPositionByList.get(listId) ?? null, null).position;
    nextPositionByList.set(listId, position);
    return {
      listId,
      boardId: board.id,
      title: card.title,
      description: card.description,
      position,
      dueDateLocalDate: card.dueDateLocalDate,
      dueDateSlot: card.dueDateSlot,
      dueDateTimezone: card.dueDateTimezone,
      completedAt: toDate(card.completedAt),
      archivedAt: toDate(card.archivedAt),
      createdById: memberMap.get(card.createdById) ?? ctx.actorId,
      createdAt: toDate(card.createdAt) ?? new Date(),
      updatedAt: toDate(card.updatedAt) ?? new Date(),
    };
  });
  const insertedCards = await insertMany<typeof cardRows[number], Card>(tx, cards, cardRows);
  const cardIdBySourceId = new Map<string, string>();
  insertedCards.forEach((card, index) => cardIdBySourceId.set(importCards[index]!.id, card.id));

  const labelAssignments = ctx.source.cardLabelAssignments
    .map((row) => ({ cardId: cardIdBySourceId.get(row.cardId), labelId: labelMapping.map.get(row.labelId) }))
    .filter((row): row is { cardId: string; labelId: string } => !!row.cardId && !!row.labelId);
  const assignees = ctx.source.cardAssignees
    .map((row) => ({ cardId: cardIdBySourceId.get(row.cardId), userId: memberMap.get(row.userId) }))
    .filter((row): row is { cardId: string; userId: string } => !!row.cardId && !!row.userId);
  const watchers = ctx.source.cardWatchers
    .map((row) => ({ cardId: cardIdBySourceId.get(row.cardId), userId: memberMap.get(row.userId) }))
    .filter((row): row is { cardId: string; userId: string } => !!row.cardId && !!row.userId);
  const fieldValues = ctx.source.cardCustomFieldValues.flatMap((value) => {
    const cardId = cardIdBySourceId.get(value.cardId);
    const field = fieldMapping.map.get(value.fieldId);
    if (!cardId || !field) return [];
    const mapped = mappedFieldValue(value, field, fieldMapping.optionMap, memberMap);
    return mapped ? [{ ...mapped, cardId }] : [];
  });
  await insertMany(tx, cardLabelAssignments, labelAssignments);
  await insertMany(tx, cardAssignees, assignees);
  await insertMany(tx, cardWatchers, watchers);
  await insertMany(tx, cardCustomFieldValues, fieldValues);

  // Checklists import in two passes so nested item-detail checklists (parentItemId set) can be
  // re-parented onto the freshly inserted items, and item descriptions are preserved. Copying every
  // checklist flat, or dropping item.description, would silently flatten the item-detail hierarchy
  // and lose descriptions when restoring a backup that used checklist-item details.
  const importableChecklists = ctx.source.checklists.filter((checklist) => cardIdBySourceId.has(checklist.cardId));
  const checklistIdBySourceId = new Map<string, string>();
  const itemIdBySourceId = new Map<string, string>();
  const insertedChecklists: (typeof cardChecklists.$inferSelect)[] = [];
  const insertedChecklistItems: WireCardChecklistItem[] = [];

  // Insert one ownership group plus its items, recording source->new id remaps. parentItemId is
  // resolved through the item map filled by the previous pass (null for top-level checklists). We
  // assign explicit item ids up front so nested checklists in the next pass can reference them.
  const importChecklistGroup = async (group: BoardExportArchive["checklists"]) => {
    const rows = group.map((checklist) => ({
      cardId: cardIdBySourceId.get(checklist.cardId)!,
      parentItemId: checklist.parentItemId ? itemIdBySourceId.get(checklist.parentItemId) ?? null : null,
      title: checklist.title,
      position: checklist.position,
      createdAt: toDate(checklist.createdAt) ?? new Date(),
      updatedAt: toDate(checklist.updatedAt) ?? new Date(),
    }));
    const inserted = await insertMany<typeof rows[number], typeof cardChecklists.$inferSelect>(tx, cardChecklists, rows);
    group.forEach((checklist, index) => checklistIdBySourceId.set(checklist.id, inserted[index]!.id));
    insertedChecklists.push(...inserted);

    const itemRows = group.flatMap((checklist) => checklist.items.map((item) => {
      const newItemId = randomUUID();
      itemIdBySourceId.set(item.id, newItemId);
      return {
        id: newItemId,
        checklistId: checklistIdBySourceId.get(checklist.id)!,
        text: item.text,
        description: item.description,
        position: item.position,
        assigneeId: item.assigneeId ? memberMap.get(item.assigneeId) ?? null : null,
        dueDateLocalDate: item.dueDateLocalDate,
        dueDateSlot: item.dueDateSlot,
        dueDateTimezone: item.dueDateTimezone,
        completedAt: toDate(item.completedAt),
        completedById: item.completedById ? memberMap.get(item.completedById) ?? ctx.actorId : null,
        createdAt: toDate(item.createdAt) ?? new Date(),
        updatedAt: toDate(item.updatedAt) ?? new Date(),
      };
    }));
    insertedChecklistItems.push(...await insertMany<typeof itemRows[number], WireCardChecklistItem>(tx, cardChecklistItems, itemRows));
  };

  // Pass 1 establishes every top-level item id; pass 2 re-parents nested checklists onto them. A
  // nested checklist whose parent item wasn't imported (impossible under the one-level depth cap) is
  // dropped rather than silently promoted to a top-level checklist.
  await importChecklistGroup(importableChecklists.filter((checklist) => checklist.parentItemId === null));
  await importChecklistGroup(importableChecklists.filter((checklist) => checklist.parentItemId !== null && itemIdBySourceId.has(checklist.parentItemId)));

  const commentRows = ctx.body.options.importComments
    ? ctx.source.comments.flatMap((comment) => {
      const cardId = cardIdBySourceId.get(comment.cardId);
      if (!cardId) return [];
      const mappedAuthorId = memberMap.get(comment.authorId) ?? null;
      return [{
        cardId,
        authorId: mappedAuthorId ?? ctx.actorId,
        authorKind: "user" as const,
        body: importedCommentBody(comment.body, comment.authorName, !!mappedAuthorId),
        editedAt: toDate(comment.editedAt),
        createdAt: toDate(comment.createdAt) ?? new Date(),
      }];
    })
    : [];
  const insertedComments = await insertMany<typeof commentRows[number], typeof comments.$inferSelect>(tx, comments, commentRows);
  const commentIdBySourceId = new Map<string, string>();
  ctx.source.comments.filter((comment) => cardIdBySourceId.has(comment.cardId)).forEach((comment, index) => {
    if (insertedComments[index]) commentIdBySourceId.set(comment.id, insertedComments[index]!.id);
  });

  const reactionRows = ctx.body.options.importComments
    ? ctx.source.commentReactions.flatMap((reaction) => {
      const commentId = commentIdBySourceId.get(reaction.commentId);
      const userId = memberMap.get(reaction.userId);
      return commentId && userId ? [{ commentId, userId, reactionType: reaction.reactionType }] : [];
    })
    : [];
  const insertedReactions = await insertMany<typeof reactionRows[number], typeof commentReactions.$inferSelect>(tx, commentReactions, reactionRows);

  const attachments = await copyAttachments(ctx, cardIdBySourceId, commentIdBySourceId);
  for (const [cardId, coverAttachmentId] of attachments.coverUpdates) {
    await tx.update(cards).set({ coverAttachmentId, updatedAt: new Date() }).where(eq(cards.id, cardId));
  }

  const skippedByList = ctx.source.cards.filter((card) => skippedListIds.has(card.listId)).length;
  if (skippedByList) ctx.warnings.push(`${skippedByList} card${skippedByList === 1 ? "" : "s"} skipped because their list was skipped.`);
  const skippedArchived = ctx.source.cards.filter((card) => card.archivedAt && listMapping.map.has(card.listId) && !ctx.body.options.includeArchived).length;
  if (skippedArchived) ctx.warnings.push(`${skippedArchived} archived card${skippedArchived === 1 ? "" : "s"} skipped by default.`);

  const summary: ImportResultSummary = {
    createdBoardId: board.id,
    lists: { created: listMapping.created.length, reused: Array.from(listMapping.map.values()).length - listMapping.created.length, skipped: ctx.source.lists.length - Array.from(listMapping.map.keys()).length },
    labels: { created: labelMapping.created.length, reused: Array.from(labelMapping.map.values()).length - labelMapping.created.length, skipped: ctx.source.labels.length - Array.from(labelMapping.map.keys()).length },
    customFields: { created: fieldMapping.created.length, reused: Array.from(fieldMapping.map.values()).length - fieldMapping.created.length, skipped: ctx.body.options.importCustomFields ? ctx.source.customFields.length - Array.from(fieldMapping.map.keys()).length : ctx.source.customFields.length },
    cards: { created: insertedCards.length, archived: insertedCards.filter((card) => card.archivedAt !== null).length },
    checklists: insertedChecklists.length,
    checklistItems: insertedChecklistItems.length,
    comments: insertedComments.length,
    attachments: { imported: attachments.rows.length, skipped: Math.max(0, ctx.source.attachments.length - attachments.rows.length) },
    warnings: Array.from(new Set(ctx.warnings)),
  };

  const createdActivities: ActivityEvent[] = [];
  if (!ctx.targetBoardId) {
    createdActivities.push(await recordActivity(tx, { boardId: board.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, entityType: "board", entityId: board.id, action: "created", payload: { name: board.name, importedFrom: "kanera", counts: summary } }));
  }
  for (const list of listMapping.created) createdActivities.push(await recordActivity(tx, { boardId: null, workspaceId: ctx.workspaceId, actorId: ctx.actorId, entityType: "list", entityId: list.id, action: "created", payload: { name: list.name, importedFrom: "kanera" } }));
  for (const label of labelMapping.created) createdActivities.push(await recordActivity(tx, { boardId: null, workspaceId: ctx.workspaceId, actorId: ctx.actorId, entityType: "cardLabel", entityId: label.id, action: "created", payload: { name: label.name, importedFrom: "kanera" } }));
  for (const field of fieldMapping.created) createdActivities.push(await recordActivity(tx, { boardId: null, workspaceId: ctx.workspaceId, actorId: ctx.actorId, entityType: "customField", entityId: field.id, action: "created", payload: { name: field.name, icon: field.icon, type: field.type, importedFrom: "kanera" } }));
  for (const card of insertedCards) createdActivities.push(await recordActivity(tx, { boardId: board.id, workspaceId: ctx.workspaceId, actorId: ctx.actorId, entityType: "card", entityId: card.id, action: "created", payload: { title: card.title, listId: card.listId, importedFrom: "kanera" } }));

  const activityRows = createdActivities.length ? await tx.select().from(activityEvents).where(inArray(activityEvents.id, createdActivities.map((activity) => activity.id))) : [];
  const activityByEntityId = new Map(activityRows.map((activity) => [activity.entityId, activity]));
  const insertedChecklistItemsByChecklist = new Map<string, WireCardChecklistItem[]>();
  for (const item of insertedChecklistItems) {
    const rows = insertedChecklistItemsByChecklist.get(item.checklistId);
    if (rows) rows.push(item);
    else insertedChecklistItemsByChecklist.set(item.checklistId, [item]);
  }
  // The inserted checklist row already carries cardId, so build events from it directly rather than
  // relying on positional alignment with a separate rows array (the two-pass import breaks that).
  const checklistEvents = insertedChecklists.map((checklist) => ({ cardId: checklist.cardId, checklist: { ...checklist, items: insertedChecklistItemsByChecklist.get(checklist.id) ?? [] } }));
  const commentEvents = insertedComments.map((comment) => {
    const row: CommentRow = {
      id: comment.id,
      cardId: comment.cardId,
      authorId: comment.authorId,
      authorKind: comment.authorKind,
      apiKeyId: comment.apiKeyId,
      apiKeyName: comment.apiKeyName,
      authorName: comment.authorId === ctx.actorId ? ctx.actorName : ctx.source.members.find((member) => member.userId === comment.authorId)?.displayName ?? ctx.actorName,
      authorAvatarUrl: comment.authorId === ctx.actorId ? ctx.actorAvatarUrl : null,
      body: comment.body,
      editedAt: comment.editedAt,
      createdAt: comment.createdAt,
      reactions: [],
    };
    return { cardId: comment.cardId, comment: row, item: { type: "comment" as const, data: row } };
  });
  const usersById = new Map((await tx.select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, insertedReactions.map((reaction) => reaction.userId)))).map((user) => [user.id, user]));
  const reactionsAdded = insertedReactions.flatMap((reaction) => {
    const comment = insertedComments.find((candidate) => candidate.id === reaction.commentId);
    const user = usersById.get(reaction.userId);
    return comment && user ? [{ cardId: comment.cardId, commentId: comment.id, type: "thumbs_up" as const, user }] : [];
  });
  const activityFeedItems = insertedCards.flatMap((card) => {
    const activity = activityByEntityId.get(card.id);
    return activity ? [{ cardId: card.id, item: { type: "activity" as const, data: { ...activity, actorName: ctx.actorName, actorAvatarUrl: ctx.actorAvatarUrl } } }] : [];
  });
  const updatedCards = attachments.coverUpdates.size
    ? await tx.select().from(cards).where(inArray(cards.id, Array.from(attachments.coverUpdates.keys())))
    : [];

  return {
    summary,
    board,
    createdLists: listMapping.created,
    createdLabels: labelMapping.created,
    createdCustomFields: fieldMapping.created,
    events: {
      cardsCreated: insertedCards.map((card) => toWireCard({ ...card, coverAttachmentId: attachments.coverUpdates.get(card.id) ?? card.coverAttachmentId })),
      cardsUpdated: updatedCards.map(toWireCard),
      labelsSet: insertedCards.map((card) => ({ cardId: card.id, labelIds: labelAssignments.filter((row) => row.cardId === card.id).map((row) => row.labelId) })).filter((row) => row.labelIds.length > 0),
      assigneesSet: insertedCards.map((card) => ({ cardId: card.id, assigneeIds: assignees.filter((row) => row.cardId === card.id).map((row) => row.userId) })).filter((row) => row.assigneeIds.length > 0),
      customFieldValuesSet: fieldValues,
      checklistsCreated: checklistEvents,
      checklistItemsCreated: checklistEvents.flatMap(({ cardId, checklist }) => checklist.items.map((item) => ({ cardId, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, item }))),
      commentsCreated: commentEvents,
      activityFeedItemsCreated: activityFeedItems,
      attachmentsCreated: attachments.rows.map((attachment) => ({ cardId: attachment.cardId, attachment })),
      reactionsAdded,
    },
  };
}
