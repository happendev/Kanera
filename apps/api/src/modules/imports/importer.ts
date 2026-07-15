import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { CardAttachmentRow, CardFeedItem, CommentRow } from "@kanera/shared/dto";
import type { CommitImportBody, ImportResultSummary } from "@kanera/shared/dto";
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
  cards,
  comments,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import type { ActivityEvent, Board, Card, CardLabel, CustomField, List } from "@kanera/shared/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { badRequest } from "../../lib/errors.js";
import { formatStorageBytes, type UploadEntitlements } from "../../lib/entitlements.js";
import { generateCoverImage, generateThumbnail, isProcessableImage } from "../../lib/image.js";
import { unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { between, positionAtIndex } from "../../lib/position.js";
import { seedBoardMembersFromWorkspace } from "../../lib/board-membership.js";
import type { StorageProvider } from "../../lib/storage/index.js";
import { attachmentCoverStorageKey, attachmentThumbnailStorageKey, cardAttachmentStorageKey } from "../../lib/storage/keys.js";
import { assertBoardLimit } from "../../lib/tier-limits.js";
import type { NormalizedTrelloBoard, TrelloAttachmentSource, TrelloCardSource, TrelloChecklistSource, TrelloCustomFieldSource } from "./types.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type TrelloAttachmentImportProgress = {
  phase: "attachments" | "finalizing";
  total: number;
  processed: number;
  imported: number;
  skipped: number;
};

export interface TrelloImportResult {
  summary: ImportResultSummary;
  board: Board;
  createdLists: List[];
  createdLabels: CardLabel[];
  createdCustomFields: WireCustomField[];
  events: TrelloImportEvents;
}

export interface TrelloImportEvents {
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
}

interface ImportContext {
  tx: Tx;
  source: NormalizedTrelloBoard;
  body: CommitImportBody;
  workspaceId: string;
  clientId: string;
  actorId: string;
  actorTimezone: string;
  targetBoardId: string | null;
  storage: StorageProvider | null;
  trelloApiKey: string | null;
  trelloToken: string | null;
  uploadEntitlements: UploadEntitlements | null;
  onAttachmentProgress?: (progress: TrelloAttachmentImportProgress) => Promise<void>;
  warnings: string[];
  actorName: string;
  actorAvatarUrl: string | null;
}

const CHUNK_SIZE = 500;
const ATTACHMENT_COPY_CONCURRENCY = 5;

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

function chunks<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function insertMany<T extends Record<string, unknown>, R>(
  tx: Tx,
  table: Parameters<Tx["insert"]>[0],
  rows: T[],
): Promise<R[]> {
  const inserted: R[] = [];
  for (const chunk of chunks(rows)) {
    if (chunk.length === 0) continue;
    inserted.push(...await tx.insert(table).values(chunk).returning() as R[]);
  }
  return inserted;
}

function localDateParts(date: Date, timezone: string): { date: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    return {
      date: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
      hour: Number(byType.get("hour") ?? "0"),
    };
  } catch {
    return { date: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
  }
}

function dueParts(iso: string | null, timezone: string) {
  if (!iso) return { dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null };
  const local = localDateParts(date, timezone);
  return {
    dueDateLocalDate: local.date,
    dueDateSlot: "anyTime",
    dueDateTimezone: timezone,
  } as const;
}

function cardUrl(boardId: string, cardId: string): string {
  return `/b/${boardId}/c/${cardId}`;
}

function toWireCard(card: Card): WireCard {
  return { ...card, url: cardUrl(card.boardId, card.id) };
}

function attachmentLinksSection(attachments: TrelloAttachmentSource[]): string | null {
  if (attachments.length === 0) return null;
  const lines = attachments.map((attachment) => {
    const name = attachment.name.trim() || "Attachment";
    return `- [${name.replace(/\]/gu, "\\]")}](${attachment.url})`;
  });
  return `Imported Trello attachments\n\n${lines.join("\n")}`;
}

function descriptionWithAttachmentLinks(description: string | null, attachments: TrelloAttachmentSource[]): string | null {
  const section = attachmentLinksSection(attachments);
  if (!section) return description;
  const base = description?.trim();
  return base ? `${base}\n\n---\n\n${section}` : section;
}

function trelloAttachmentUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if ((url.hostname === "trello.com" || url.hostname === "www.trello.com") && url.pathname.startsWith("/1/cards/")) {
    url.hostname = "api.trello.com";
  }
  // Attachment downloads reject key/token query auth; keep signature parameters but remove
  // stale auth params from exports or retries and send credentials via Authorization header.
  url.searchParams.delete("key");
  url.searchParams.delete("token");
  return url.toString();
}

function trelloAuthorizationHeader(apiKey: string, token: string): string {
  const quoted = (value: string) => value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
  return `OAuth oauth_consumer_key="${quoted(apiKey)}", oauth_token="${quoted(token)}"`;
}

function trelloDownloadUrlFor(cardId: string, attachment: TrelloAttachmentSource): string | null {
  try {
    const url = new URL(attachment.url);
    const host = url.hostname.toLowerCase();
    if ((host === "trello.com" || host === "api.trello.com" || host.endsWith(".trello.com")) && url.pathname.includes("/attachments/") && url.pathname.includes("/download/")) {
      return trelloAttachmentUrl(url.toString());
    }
  } catch {
    // Fall through to the canonical route built from export ids.
  }
  if (!attachment.id || !attachment.name) return null;
  return `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachment.id)}/download/${encodeURIComponent(attachment.name)}`;
}

function cleanFileName(value: string | null): string | null {
  const cleaned = value?.trim().replace(/[\\/]/gu, "_").split("").map((char) => char.charCodeAt(0) < 32 ? "_" : char).join("");
  return cleaned ? cleaned.slice(0, 240) : null;
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try {
      return cleanFileName(decodeURIComponent(encoded.trim().replace(/^"|"$/gu, "")));
    } catch {
      return cleanFileName(encoded.trim().replace(/^"|"$/gu, ""));
    }
  }
  return cleanFileName(/filename\s*=\s*([^;]+)/iu.exec(header)?.[1]?.trim().replace(/^"|"$/gu, "") ?? null);
}

function filenameFromUrl(rawUrl: string): string | null {
  try {
    const segment = new URL(rawUrl).pathname.split("/").filter(Boolean).at(-1);
    return cleanFileName(segment ? decodeURIComponent(segment) : null);
  } catch {
    return null;
  }
}

function isGenericTrelloFileName(fileName: string): boolean {
  return /^(attachment|image|image\s*\(\d+\)|pasted\s+image)(\.[a-z0-9]{2,8})?$/iu.test(fileName.trim());
}

function disambiguateGenericFileName(fileName: string, attachmentId: string): string {
  if (!isGenericTrelloFileName(fileName)) return fileName;
  const dot = fileName.lastIndexOf(".");
  const suffix = attachmentId.replace(/[^a-z0-9]/giu, "").slice(-8) || "trello";
  if (dot > 0) return `${fileName.slice(0, dot)}-${suffix}${fileName.slice(dot)}`;
  return `${fileName}-${suffix}`;
}

function trelloImportedFileName(attachment: TrelloAttachmentSource, response: Response, downloadUrl: string): string {
  const responseName = filenameFromContentDisposition(response.headers.get("content-disposition"));
  const exportName = cleanFileName(attachment.name);
  const urlName = filenameFromUrl(downloadUrl);
  const preferred = responseName ?? (exportName && !isGenericTrelloFileName(exportName) ? exportName : urlName) ?? exportName ?? "Attachment";
  return disambiguateGenericFileName(preferred, attachment.id);
}

async function copyTrelloAttachments(ctx: ImportContext, cardIdByTrelloId: Map<string, string>): Promise<{ rows: CardAttachmentRow[]; coverUpdates: Map<string, string> }> {
  const rows: CardAttachmentRow[] = [];
  const coverUpdates = new Map<string, string>();
  const uploadedAttachments = ctx.source.cards.flatMap((card) =>
    card.attachments
      .filter((attachment) => attachment.isUpload)
      .map((attachment) => ({ card, attachment, cardId: cardIdByTrelloId.get(card.id) }))
      .filter((entry): entry is { card: TrelloCardSource; attachment: TrelloAttachmentSource; cardId: string } => !!entry.cardId)
  );
  if (uploadedAttachments.length === 0) return { rows, coverUpdates };

  if (ctx.body.options.attachmentCopyMode === "skip") {
    ctx.warnings.push(`${uploadedAttachments.length} Trello uploaded attachment${uploadedAttachments.length === 1 ? "" : "s"} skipped by import option.`);
    return { rows, coverUpdates };
  }
  if (!ctx.storage || !ctx.trelloApiKey || !ctx.trelloToken) {
    ctx.warnings.push(`${uploadedAttachments.length} Trello uploaded attachment${uploadedAttachments.length === 1 ? "" : "s"} could not be copied because Trello was not connected.`);
    return { rows, coverUpdates };
  }

  const entitlements = ctx.uploadEntitlements;
  if (!entitlements) {
    ctx.warnings.push(`${uploadedAttachments.length} Trello uploaded attachment${uploadedAttachments.length === 1 ? "" : "s"} could not be copied because upload limits were unavailable.`);
    return { rows, coverUpdates };
  }
  const progress: TrelloAttachmentImportProgress = {
    phase: "attachments",
    total: uploadedAttachments.length,
    processed: 0,
    imported: 0,
    skipped: 0,
  };
  let lastProgressAt = 0;
  const reportProgress = async (force = false) => {
    if (!ctx.onAttachmentProgress) return;
    const now = Date.now();
    if (!force && progress.processed < progress.total && progress.processed % 25 !== 0 && now - lastProgressAt < 1_000) return;
    lastProgressAt = now;
    await ctx.onAttachmentProgress({ ...progress });
  };
  await reportProgress(true);
  let acceptedBytes = 0;
  type Prepared = {
    attachment: TrelloAttachmentSource;
    card: TrelloCardSource;
    cardId: string;
    fileName: string;
    fileKey: string;
    byteSize: number;
    mimeType: string;
    thumbnailUrl: string | null;
    thumbnailFileKey: string | null;
    coverImageUrl: string | null;
    coverImageFileKey: string | null;
  } | { warning: string; reason: string };
  const failureReasons = new Map<string, number>();

  const prepared = await mapWithConcurrency(uploadedAttachments, ATTACHMENT_COPY_CONCURRENCY, async ({ attachment, card, cardId }): Promise<Prepared> => {
    let outcome: Prepared;
    const mimeType = attachment.mimeType ?? "application/octet-stream";
    const ext = getAllowedAttachmentExtension(mimeType, attachment.name);
    const downloadUrl = trelloDownloadUrlFor(card.id, attachment);
    if (!ext) outcome = { warning: `Skipped Trello attachment "${attachment.name}" because its file type is unsupported.`, reason: "unsupported file type" };
    else if (!downloadUrl) outcome = { warning: `Skipped Trello attachment "${attachment.name}" because its URL was not a Trello download URL.`, reason: "not a Trello download URL" };
    else {
      try {
        const response = await fetch(downloadUrl, { headers: { Authorization: trelloAuthorizationHeader(ctx.trelloApiKey!, ctx.trelloToken!) } });
        if (!response.ok) {
          const reason = `Trello returned HTTP ${response.status}`;
          outcome = { warning: `Could not copy Trello attachment "${attachment.name}" because ${reason}.`, reason };
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.byteLength > entitlements.maxFileBytes) {
            outcome = { warning: `Skipped Trello attachment "${attachment.name}" because it exceeds the ${formatStorageBytes(entitlements.maxFileBytes)} file limit.`, reason: "file size limit" };
          } else if (entitlements.limited && entitlements.quotaBytes !== null && entitlements.usedBytes + acceptedBytes + buffer.byteLength > entitlements.quotaBytes) {
            outcome = { warning: `Skipped Trello attachment "${attachment.name}" because the organisation storage quota would be exceeded.`, reason: "organisation storage quota" };
          } else {
            acceptedBytes += buffer.byteLength;

            const fileKey = cardAttachmentStorageKey(cardId, ext);
            await ctx.storage!.put(fileKey, buffer, mimeType);
            let thumbnailUrl: string | null = null;
            let thumbnailFileKey: string | null = null;
            let coverImageUrl: string | null = null;
            let coverImageFileKey: string | null = null;
            if (isProcessableImage(mimeType)) {
              const thumb = await generateThumbnail(buffer, mimeType);
              thumbnailFileKey = attachmentThumbnailStorageKey(fileKey, thumb.ext);
              await ctx.storage!.put(thumbnailFileKey, thumb.buffer, thumb.mimeType);
              thumbnailUrl = unsignedMediaUrl(ctx.clientId, thumbnailFileKey);

              if (card.coverAttachmentId === attachment.id) {
                const cover = await generateCoverImage(buffer, mimeType);
                coverImageFileKey = attachmentCoverStorageKey(fileKey, cover.ext);
                await ctx.storage!.put(coverImageFileKey, cover.buffer, cover.mimeType);
                coverImageUrl = unsignedMediaUrl(ctx.clientId, coverImageFileKey);
              }
            }
            outcome = { attachment, card, cardId, fileName: trelloImportedFileName(attachment, response, downloadUrl), fileKey, byteSize: buffer.byteLength, mimeType, thumbnailUrl, thumbnailFileKey, coverImageUrl, coverImageFileKey };
          }
        }
      } catch {
        outcome = { warning: `Could not copy Trello attachment "${attachment.name}" because the download failed.`, reason: "download failed" };
      }
    }
    progress.processed += 1;
    if ("warning" in outcome) progress.skipped += 1;
    else progress.imported += 1;
    await reportProgress(progress.processed === progress.total);
    return outcome;
  });

  const uploads = prepared.filter((entry): entry is Extract<Prepared, { fileKey: string }> => "fileKey" in entry);
  for (const entry of prepared) {
    if (!("warning" in entry)) continue;
    failureReasons.set(entry.reason, (failureReasons.get(entry.reason) ?? 0) + 1);
  }
  for (const [reason, count] of failureReasons) ctx.warnings.push(`${count} Trello uploaded attachment${count === 1 ? "" : "s"} skipped: ${reason}.`);
  for (const entry of prepared.filter((item): item is Extract<Prepared, { warning: string; reason: string }> => "warning" in item).slice(0, 10)) ctx.warnings.push(entry.warning);
  const inserted = await insertMany<Record<string, unknown>, typeof cardAttachments.$inferSelect>(ctx.tx, cardAttachments, uploads.map((upload) => ({
    cardId: upload.cardId,
    clientId: ctx.clientId,
    uploadedById: ctx.actorId,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    byteSize: upload.byteSize,
    fileKey: upload.fileKey,
    url: unsignedMediaUrl(ctx.clientId, upload.fileKey)!,
    thumbnailUrl: upload.thumbnailUrl,
    thumbnailFileKey: upload.thumbnailFileKey,
    coverImageUrl: upload.coverImageUrl,
    coverImageFileKey: upload.coverImageFileKey,
    source: "attachment",
  })));
  inserted.forEach((row, index) => {
    const upload = uploads[index]!;
    if (upload.card.coverAttachmentId === upload.attachment.id) coverUpdates.set(upload.cardId, row.id);
    rows.push(withSignedMedia(ctx.clientId, {
      id: row.id,
      cardId: row.cardId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      url: unsignedMediaUrl(ctx.clientId, row.fileKey)!,
      thumbnailUrl: row.thumbnailUrl,
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

function commentBody(text: string, memberName: string | null, usedActor: boolean): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const body = usedActor && memberName
    ? `[Imported from Trello - ${memberName}]\n\n${trimmed}`
    : trimmed;
  return body.slice(0, 20_000);
}

function customFieldValueFor(
  field: CustomField,
  sourceField: TrelloCustomFieldSource | undefined,
  item: TrelloCardSource["customFieldItems"][number],
  optionMap: Map<string, string>,
): Record<string, unknown> | null {
  const value = item.value && typeof item.value === "object" && !Array.isArray(item.value)
    ? item.value as Record<string, unknown>
    : {};
  if (field.type === "select") {
    const optionId = item.optionId ? optionMap.get(item.optionId) : null;
    return optionId ? { valueOptionIds: [optionId] } : null;
  }
  if (field.type === "checkbox") {
    const checked = value.checked;
    if (typeof checked === "string") return { valueCheckbox: checked === "true" };
    if (typeof checked === "boolean") return { valueCheckbox: checked };
    return null;
  }
  if (field.type === "date") {
    const date = typeof value.date === "string" ? value.date.slice(0, 10) : null;
    return date && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? { valueDate: date } : null;
  }
  if (field.type === "number") {
    const numberValue = typeof value.number === "string" ? value.number : null;
    return numberValue !== null && numberValue.trim() ? { valueNumber: numberValue } : null;
  }
  if (field.type === "text") {
    const text = typeof value.text === "string" ? value.text : null;
    return text ? { valueText: text.slice(0, 20_000) } : null;
  }
  // Trello has no native URL/user custom field equivalents in this import shape.
  return sourceField ? null : null;
}

async function createBoard(ctx: ImportContext): Promise<Board> {
  if (ctx.targetBoardId) {
    const [target] = await ctx.tx
      .select()
      .from(boards)
      .where(and(eq(boards.id, ctx.targetBoardId), eq(boards.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!target) throw badRequest("standalone board import target not found");
    // Existing identity and membership belong to the standalone board; an import only appends
    // mapped workspace resources and cards, rather than replacing the destination board shell.
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
  const [last] = await ctx.tx
    .select({ position: boards.position })
    .from(boards)
    .where(eq(boards.workspaceId, ctx.workspaceId))
    .orderBy(desc(boards.position))
    .limit(1);
  const [board] = await ctx.tx.insert(boards).values({
    workspaceId: ctx.workspaceId,
    name: ctx.body.board.name,
    description: ctx.source.board.desc,
    icon: ctx.body.board.icon ?? "layout-kanban",
    iconColor: ctx.body.board.iconColor ?? null,
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
  const [last] = await ctx.tx
    .select({ position: lists.position })
    .from(lists)
    .where(eq(lists.workspaceId, ctx.workspaceId))
    .orderBy(desc(lists.position))
    .limit(1);
  let prev = last?.position ?? null;
  const rows = [];
  const sourceIds: string[] = [];
  const map = new Map<string, string>();

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
    rows.push({
      workspaceId: ctx.workspaceId,
      name: mapping.name ?? sourceList.name,
      icon: mapping.icon ?? null,
      color: mapping.color ?? null,
      position,
    });
  }
  const created = await insertMany<typeof rows[number], List>(ctx.tx, lists, rows);
  created.forEach((list, index) => map.set(sourceIds[index]!, list.id));
  return { map, created };
}

async function mapLabels(ctx: ImportContext): Promise<{ map: Map<string, string>; created: CardLabel[] }> {
  const existing = await ctx.tx.select({ id: cardLabels.id }).from(cardLabels).where(eq(cardLabels.workspaceId, ctx.workspaceId));
  const existingIds = new Set(existing.map((label) => label.id));
  const [last] = await ctx.tx
    .select({ position: cardLabels.position })
    .from(cardLabels)
    .where(eq(cardLabels.workspaceId, ctx.workspaceId))
    .orderBy(desc(cardLabels.position))
    .limit(1);
  let prev = last?.position ?? null;
  const rows = [];
  const sourceIds: string[] = [];
  const map = new Map<string, string>();
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
    rows.push({
      workspaceId: ctx.workspaceId,
      name: mapping.name ?? (sourceLabel.name || "Imported label"),
      color: mapping.color ?? null,
      position,
    });
  }
  const created = await insertMany<typeof rows[number], CardLabel>(ctx.tx, cardLabels, rows);
  created.forEach((label, index) => map.set(sourceIds[index]!, label.id));
  return { map, created };
}

async function mapCustomFields(ctx: ImportContext): Promise<{ map: Map<string, CustomField>; optionMap: Map<string, string>; created: WireCustomField[] }> {
  if (!ctx.body.options.importCustomFields) return { map: new Map(), optionMap: new Map(), created: [] };
  const existing = await ctx.tx.select().from(customFields).where(eq(customFields.workspaceId, ctx.workspaceId));
  const existingById = new Map(existing.map((field) => [field.id, field]));
  const [last] = await ctx.tx
    .select({ position: customFields.position })
    .from(customFields)
    .where(eq(customFields.workspaceId, ctx.workspaceId))
    .orderBy(desc(customFields.position))
    .limit(1);
  let prev = last?.position ?? null;
  const rows = [];
  const sourceIds: string[] = [];
  const map = new Map<string, CustomField>();
  for (const sourceField of ctx.source.customFields) {
    const mapping = ctx.body.customFields[sourceField.id] ?? { action: "skip" as const };
    if (mapping.action === "skip") continue;
    if (mapping.action === "map") {
      const field = existingById.get(mapping.targetFieldId!);
      if (!field) throw badRequest("custom field mapping target not found");
      if (field.type !== sourceField.suggestedType) {
        ctx.warnings.push(`Skipped values for "${sourceField.name}" because the mapped Kanera field type is ${field.type}.`);
      }
      map.set(sourceField.id, field);
      continue;
    }
    const type = mapping.type ?? sourceField.suggestedType;
    const position = between(prev, null).position;
    prev = position;
    sourceIds.push(sourceField.id);
    rows.push({
      workspaceId: ctx.workspaceId,
      name: mapping.name ?? sourceField.name,
      icon: mapping.icon ?? "forms",
      type,
      allowMultiple: false,
      position,
      showOnCard: true,
    });
  }
  const createdRows = await insertMany<typeof rows[number], CustomField>(ctx.tx, customFields, rows);
  const createdSourceIds = new Set(sourceIds);
  createdRows.forEach((field, index) => map.set(sourceIds[index]!, field));

  const optionMap = new Map<string, string>();
  const mappedSelectFields = ctx.source.customFields
    .map((sourceField) => ({ sourceField, field: map.get(sourceField.id) }))
    .filter((entry): entry is { sourceField: TrelloCustomFieldSource; field: CustomField } =>
      !!entry.field && entry.field.type === "select" && !createdSourceIds.has(entry.sourceField.id)
    );
  if (mappedSelectFields.length > 0) {
    const existingOptions = await ctx.tx
      .select()
      .from(customFieldOptions)
      .where(and(
        inArray(customFieldOptions.fieldId, mappedSelectFields.map((entry) => entry.field.id)),
        isNull(customFieldOptions.archivedAt),
      ));
    for (const { sourceField, field } of mappedSelectFields) {
      const optionsForField = existingOptions.filter((option) => option.fieldId === field.id);
      for (const sourceOption of sourceField.options) {
        const target = optionsForField.find((option) => option.label.trim().toLowerCase() === sourceOption.label.trim().toLowerCase());
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
      optionRows.push({
        fieldId: field.id,
        label: option.label,
        color: option.color,
        position: positionAtIndex(index),
      });
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
  return {
    map,
    optionMap,
    created: createdRows.map((field) => ({ ...field, options: optionsByField.get(field.id) ?? [] })),
  };
}

export async function runTrelloImport(
  tx: Tx,
  args: {
    source: NormalizedTrelloBoard;
    body: CommitImportBody;
    workspaceId: string;
    clientId: string;
    actorId: string;
    actorTimezone: string;
    targetBoardId?: string | null;
    storage?: StorageProvider | null;
    trelloApiKey?: string | null;
    trelloToken?: string | null;
    uploadEntitlements?: UploadEntitlements | null;
    onAttachmentProgress?: (progress: TrelloAttachmentImportProgress) => Promise<void>;
  },
): Promise<TrelloImportResult> {
  const ctx: ImportContext = {
    tx,
    warnings: [],
    actorName: "Importer",
    actorAvatarUrl: null,
    storage: null,
    trelloApiKey: null,
    trelloToken: null,
    uploadEntitlements: null,
    targetBoardId: null,
    ...args,
  };
  const [workspaceUserRows, actorRow] = await Promise.all([
    tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ctx.workspaceId)),
    tx.select({ timezone: users.timezone, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, ctx.actorId)).limit(1),
  ]);
  ctx.actorTimezone = actorRow[0]?.timezone ?? ctx.actorTimezone;
  ctx.actorName = actorRow[0]?.displayName ?? "Importer";
  ctx.actorAvatarUrl = actorRow[0]?.avatarUrl ?? null;
  const workspaceUserIds = new Set(workspaceUserRows.map((row) => row.userId));
  for (const targetUserId of Object.values(ctx.body.members)) {
    if (targetUserId && !workspaceUserIds.has(targetUserId)) throw badRequest("member mapping target not found in workspace");
  }

  const board = await createBoard(ctx);
  const listMapping = await mapLists(ctx);
  const labelMapping = await mapLabels(ctx);
  const fieldMapping = await mapCustomFields(ctx);
  const skippedListIds = new Set(ctx.source.lists.filter((list) => !listMapping.map.has(list.id)).map((list) => list.id));
  const closedListIds = new Set(ctx.source.lists.filter((list) => list.closed).map((list) => list.id));
  const importCards = ctx.source.cards.filter((card) =>
    listMapping.map.has(card.listId) &&
    (ctx.body.options.includeArchived || (!card.closed && !closedListIds.has(card.listId)))
  );
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
    const due = dueParts(card.due, ctx.actorTimezone);
    const completedAt = card.dueComplete ? new Date() : null;
    return {
      listId,
      boardId: board.id,
      title: card.name,
      description: descriptionWithAttachmentLinks(card.desc, card.attachments),
      position,
      dueDateLocalDate: due.dueDateLocalDate,
      dueDateSlot: due.dueDateSlot,
      dueDateTimezone: due.dueDateTimezone,
      completedAt,
      archivedAt: card.closed ? new Date() : null,
      createdById: ctx.actorId,
    };
  });
  const insertedCards = await insertMany<typeof cardRows[number], Card>(tx, cards, cardRows);
  const cardIdByTrelloId = new Map<string, string>();
  insertedCards.forEach((card, index) => cardIdByTrelloId.set(importCards[index]!.id, card.id));

  const preservedAttachmentLinks = importCards.reduce((sum, card) => sum + card.attachments.length, 0);

  const labelAssignments: { cardId: string; labelId: string }[] = [];
  const assignees: { cardId: string; userId: string }[] = [];
  const fieldValues: TrelloImportEvents["customFieldValuesSet"] = [];
  for (const card of importCards) {
    const cardId = cardIdByTrelloId.get(card.id)!;
    for (const labelId of new Set(card.labelIds)) {
      const mappedLabelId = labelMapping.map.get(labelId);
      if (mappedLabelId) labelAssignments.push({ cardId, labelId: mappedLabelId });
    }
    for (const memberId of new Set(card.memberIds)) {
      const userId = ctx.body.members[memberId];
      if (userId) assignees.push({ cardId, userId });
      else ctx.warnings.push(`Skipped an unmapped assignee on "${card.name}".`);
    }
    for (const item of card.customFieldItems) {
      const field = fieldMapping.map.get(item.fieldId);
      const sourceField = ctx.source.customFields.find((candidate) => candidate.id === item.fieldId);
      if (!field || !sourceField || field.type !== sourceField.suggestedType) continue;
      const value = customFieldValueFor(field, sourceField, item, fieldMapping.optionMap);
      if (!value) continue;
      fieldValues.push({ cardId, fieldId: field.id, ...value });
    }
  }
  await insertMany(tx, cardLabelAssignments, labelAssignments);
  await insertMany(tx, cardAssignees, assignees);
  await insertMany(tx, cardCustomFieldValues, fieldValues);

  const checklistById = new Map(ctx.source.checklists.map((checklist) => [checklist.id, checklist]));
  const checklistRows: { cardId: string; title: string; position: string }[] = [];
  const checklistSources: TrelloChecklistSource[] = [];
  for (const card of importCards) {
    const cardId = cardIdByTrelloId.get(card.id)!;
    for (const [index, checklistId] of card.checklistIds.entries()) {
      const checklist = checklistById.get(checklistId);
      if (!checklist) continue;
      checklistSources.push(checklist);
      checklistRows.push({ cardId, title: checklist.name, position: positionAtIndex(index) });
    }
  }
  const insertedChecklists = await insertMany<typeof checklistRows[number], { id: string }>(tx, cardChecklists, checklistRows);
  const itemRows = [];
  for (const [checklistIndex, checklist] of checklistSources.entries()) {
    const checklistId = insertedChecklists[checklistIndex]!.id;
    for (const [itemIndex, item] of checklist.items.entries()) {
      const due = dueParts(item.due ?? null, ctx.actorTimezone);
      const completed = item.state === "complete";
      itemRows.push({
        checklistId,
        text: item.name,
        position: positionAtIndex(itemIndex),
        assigneeId: item.idMember ? ctx.body.members[item.idMember] ?? null : null,
        dueDateLocalDate: due.dueDateLocalDate,
        dueDateSlot: due.dueDateSlot,
        dueDateTimezone: due.dueDateTimezone,
        completedAt: completed ? new Date() : null,
        completedById: completed ? ctx.actorId : null,
      });
    }
  }
  const insertedChecklistItems = await insertMany<typeof itemRows[number], WireCardChecklistItem>(tx, cardChecklistItems, itemRows);

  const commentRows = [];
  if (ctx.body.options.importComments) {
    for (const comment of ctx.source.comments) {
      const cardId = cardIdByTrelloId.get(comment.cardId);
      if (!cardId) continue;
      const mappedAuthorId = comment.memberId ? ctx.body.members[comment.memberId] ?? null : null;
      const body = commentBody(comment.text, comment.memberName, !mappedAuthorId);
      if (!body) continue;
      commentRows.push({
        cardId,
        authorId: mappedAuthorId ?? ctx.actorId,
        authorKind: "user" as const,
        body,
        createdAt: Number.isNaN(Date.parse(comment.date)) ? new Date() : new Date(comment.date),
      });
    }
  }
  const insertedComments = await insertMany<typeof commentRows[number], typeof comments.$inferSelect>(tx, comments, commentRows);

  const copiedAttachments = await copyTrelloAttachments(ctx, cardIdByTrelloId);
  if (ctx.onAttachmentProgress) {
    const uploadedAttachmentCount = importCards.reduce((sum, card) => sum + card.attachments.filter((attachment) => attachment.isUpload).length, 0);
    await ctx.onAttachmentProgress({
      phase: "finalizing",
      total: uploadedAttachmentCount,
      processed: uploadedAttachmentCount,
      imported: copiedAttachments.rows.length,
      skipped: Math.max(0, uploadedAttachmentCount - copiedAttachments.rows.length),
    });
  }
  for (const [cardId, coverAttachmentId] of copiedAttachments.coverUpdates) {
    await tx.update(cards).set({ coverAttachmentId, updatedAt: new Date() }).where(eq(cards.id, cardId));
  }

  const skippedCards = ctx.source.cards.filter((card) => skippedListIds.has(card.listId)).length;
  if (skippedCards > 0) ctx.warnings.push(`${skippedCards} card${skippedCards === 1 ? "" : "s"} skipped because their list was skipped.`);
  const skippedClosedListCards = ctx.source.cards.filter((card) => closedListIds.has(card.listId) && listMapping.map.has(card.listId) && !ctx.body.options.includeArchived).length;
  if (skippedClosedListCards > 0) ctx.warnings.push(`${skippedClosedListCards} card${skippedClosedListCards === 1 ? "" : "s"} skipped because their Trello list was archived.`);
  const skippedArchivedCards = ctx.source.cards.filter((card) => card.closed && listMapping.map.has(card.listId) && !closedListIds.has(card.listId) && !ctx.body.options.includeArchived).length;
  if (skippedArchivedCards > 0) ctx.warnings.push(`${skippedArchivedCards} archived card${skippedArchivedCards === 1 ? "" : "s"} skipped by default.`);
  if (preservedAttachmentLinks > 0) ctx.warnings.push(`${preservedAttachmentLinks} Trello attachment link${preservedAttachmentLinks === 1 ? " was" : "s were"} preserved on imported cards.`);

  const summary: ImportResultSummary = {
    createdBoardId: board.id,
    lists: {
      created: listMapping.created.length,
      reused: Array.from(listMapping.map.values()).length - listMapping.created.length,
      skipped: ctx.source.lists.length - Array.from(listMapping.map.keys()).length,
    },
    labels: {
      created: labelMapping.created.length,
      reused: Array.from(labelMapping.map.values()).length - labelMapping.created.length,
      skipped: ctx.source.labels.length - Array.from(labelMapping.map.keys()).length,
    },
    customFields: {
      created: fieldMapping.created.length,
      reused: Array.from(fieldMapping.map.values()).length - fieldMapping.created.length,
      skipped: ctx.body.options.importCustomFields ? ctx.source.customFields.length - Array.from(fieldMapping.map.keys()).length : ctx.source.customFields.length,
    },
    cards: {
      created: insertedCards.length,
      archived: insertedCards.filter((card) => card.archivedAt !== null).length,
    },
    checklists: insertedChecklists.length,
    checklistItems: itemRows.length,
    comments: commentRows.length,
    attachments: {
      imported: copiedAttachments.rows.length,
      skipped: Math.max(0, importCards.reduce((sum, card) => sum + card.attachments.filter((attachment) => attachment.isUpload).length, 0) - copiedAttachments.rows.length),
    },
    warnings: Array.from(new Set(ctx.warnings)),
  };

  const createdActivities: ActivityEvent[] = [];
  if (!ctx.targetBoardId) {
    const boardActivity = await recordActivity(tx, {
      boardId: board.id,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      entityType: "board",
      entityId: board.id,
      action: "created",
      payload: { name: board.name, importedFrom: "trello", counts: summary },
    });
    createdActivities.push(boardActivity);
  }

  for (const list of listMapping.created) {
    createdActivities.push(await recordActivity(tx, {
      boardId: null,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      entityType: "list",
      entityId: list.id,
      action: "created",
      payload: { name: list.name, importedFrom: "trello" },
    }));
  }
  for (const label of labelMapping.created) {
    createdActivities.push(await recordActivity(tx, {
      boardId: null,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      entityType: "cardLabel",
      entityId: label.id,
      action: "created",
      payload: { name: label.name, importedFrom: "trello" },
    }));
  }
  for (const field of fieldMapping.created) {
    createdActivities.push(await recordActivity(tx, {
      boardId: null,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      entityType: "customField",
      entityId: field.id,
      action: "created",
      payload: { name: field.name, icon: field.icon, type: field.type, importedFrom: "trello" },
    }));
  }
  for (const card of insertedCards) {
    createdActivities.push(await recordActivity(tx, {
      boardId: board.id,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      entityType: "card",
      entityId: card.id,
      action: "created",
      payload: { title: card.title, listId: card.listId, importedFrom: "trello" },
    }));
  }

  const activityRows = createdActivities.length
    ? await tx.select().from(activityEvents).where(inArray(activityEvents.id, createdActivities.map((activity) => activity.id)))
    : [];
  const activityByEntityId = new Map(activityRows.map((activity) => [activity.entityId, activity]));
  const insertedChecklistItemsByChecklist = new Map<string, WireCardChecklistItem[]>();
  for (const item of insertedChecklistItems) {
    const rows = insertedChecklistItemsByChecklist.get(item.checklistId);
    if (rows) rows.push(item);
    else insertedChecklistItemsByChecklist.set(item.checklistId, [item]);
  }
  const checklistEvents = insertedChecklists.map((checklist, index) => {
    const row = checklist as typeof cardChecklists.$inferSelect;
    const source = checklistRows[index]!;
    return {
      cardId: source.cardId,
      checklist: { ...row, items: insertedChecklistItemsByChecklist.get(row.id) ?? [] },
    };
  });
  const commentEvents = insertedComments.map((comment) => {
    const row: CommentRow = {
      id: comment.id,
      cardId: comment.cardId,
      authorId: comment.authorId,
      authorKind: comment.authorKind,
      apiKeyId: comment.apiKeyId,
      apiKeyName: comment.apiKeyName,
      authorName: ctx.actorName,
      authorAvatarUrl: ctx.actorAvatarUrl,
      body: comment.body,
      editedAt: comment.editedAt,
      createdAt: comment.createdAt,
      reactions: [],
    };
    return { cardId: comment.cardId, comment: row, item: { type: "comment" as const, data: row } };
  });
  const activityFeedItems = insertedCards.flatMap((card) => {
    const activity = activityByEntityId.get(card.id);
    if (!activity) return [];
    return [{
      cardId: card.id,
      item: {
        type: "activity" as const,
        data: {
          ...activity,
          actorName: ctx.actorName,
          actorAvatarUrl: ctx.actorAvatarUrl,
        },
      },
    }];
  });
  const updatedCards = copiedAttachments.coverUpdates.size
    ? await tx.select().from(cards).where(inArray(cards.id, Array.from(copiedAttachments.coverUpdates.keys())))
    : [];

  return {
    summary,
    board,
    createdLists: listMapping.created,
    createdLabels: labelMapping.created,
    createdCustomFields: fieldMapping.created,
    events: {
      cardsCreated: insertedCards.map((card) => toWireCard({ ...card, coverAttachmentId: copiedAttachments.coverUpdates.get(card.id) ?? card.coverAttachmentId })),
      cardsUpdated: updatedCards.map(toWireCard),
      labelsSet: insertedCards.map((card) => ({ cardId: card.id, labelIds: labelAssignments.filter((row) => row.cardId === card.id).map((row) => row.labelId) })).filter((row) => row.labelIds.length > 0),
      assigneesSet: insertedCards.map((card) => ({ cardId: card.id, assigneeIds: assignees.filter((row) => row.cardId === card.id).map((row) => row.userId) })).filter((row) => row.assigneeIds.length > 0),
      customFieldValuesSet: fieldValues,
      checklistsCreated: checklistEvents,
      checklistItemsCreated: checklistEvents.flatMap(({ cardId, checklist }) => checklist.items.map((item) => ({ cardId, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, item }))),
      commentsCreated: commentEvents,
      activityFeedItemsCreated: activityFeedItems,
      attachmentsCreated: copiedAttachments.rows.map((attachment) => ({ cardId: attachment.cardId, attachment })),
    },
  };
}
