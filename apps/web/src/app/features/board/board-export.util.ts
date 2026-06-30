import type { BoardExportArchive } from "@kanera/shared/dto";
import type { Cell } from "write-excel-file/browser";
import { sanitizeExportFileName, timestampForFileName } from "./list-view/export.util";

type WorkbookCell = string | number | boolean | null;

export function boardArchiveFileName(archive: BoardExportArchive, extension: "json" | "xlsx"): string {
  return `${sanitizeExportFileName(archive.board.name)}-${timestampForFileName(archive.exportedAt)}.${extension}`;
}

export function boardArchiveToReportRows(archive: BoardExportArchive): WorkbookCell[][] {
  const listsById = new Map(archive.lists.map((list) => [list.id, list]));
  const membersById = new Map(archive.members.map((member) => [member.userId, member.displayName]));
  const labelsById = new Map(archive.labels.map((label) => [label.id, label.name]));
  // Select-option ids are globally unique, so one label map across all fields avoids re-scanning
  // each field's options for every card's custom-field cell.
  const optionLabelById = new Map<string, string>();
  for (const field of archive.customFields) {
    if (field.type === "select") for (const option of field.options) optionLabelById.set(option.id, option.label);
  }
  const fieldValuesByCardAndField = new Map<string, Map<string, (typeof archive.cardCustomFieldValues)[number]>>();
  for (const value of archive.cardCustomFieldValues) {
    let byField = fieldValuesByCardAndField.get(value.cardId);
    if (!byField) {
      byField = new Map();
      fieldValuesByCardAndField.set(value.cardId, byField);
    }
    byField.set(value.fieldId, value);
  }

  const assigneesByCard = groupValues(archive.cardAssignees, "cardId", (row) => membersById.get(row.userId) ?? row.userId);
  const labelsByCard = groupValues(archive.cardLabelAssignments, "cardId", (row) => labelsById.get(row.labelId) ?? row.labelId);
  const commentsByCard = countBy(archive.comments, (row) => row.cardId);
  const checklistTotalsByCard = new Map<string, { done: number; total: number }>();
  for (const checklist of archive.checklists) {
    const current = checklistTotalsByCard.get(checklist.cardId) ?? { done: 0, total: 0 };
    current.total += checklist.items.length;
    current.done += checklist.items.filter((item) => item.completedAt).length;
    checklistTotalsByCard.set(checklist.cardId, current);
  }
  const attachmentsByCard = new Map<string, typeof archive.attachments>();
  for (const attachment of archive.attachments) {
    const list = attachmentsByCard.get(attachment.cardId);
    if (list) list.push(attachment);
    else attachmentsByCard.set(attachment.cardId, [attachment]);
  }

  const activeFields = archive.customFields.filter((field) => !field.archivedAt);
  const headers = [
    "List",
    "Title",
    "Description",
    "Assignees",
    "Labels",
    "Due date",
    "Due slot",
    "Completed at",
    "Archived at",
    "Created at",
    "Updated at",
    "Comments",
    "Checklist",
    "Attachments",
    "Attachment URLs",
    ...activeFields.map((field) => field.name),
  ];
  const rows: WorkbookCell[][] = [
    [`Kanera board export: ${archive.board.name}`],
    [`Exported ${formatDate(archive.exportedAt)}`, `${archive.cards.length} cards`],
    [],
    headers,
  ];

  const cards = [...archive.cards].sort((a, b) => {
    const listDelta = Number(listsById.get(a.listId)?.position ?? 0) - Number(listsById.get(b.listId)?.position ?? 0);
    return listDelta || Number(a.position) - Number(b.position);
  });
  for (const card of cards) {
    const checklist = checklistTotalsByCard.get(card.id);
    const attachments = attachmentsByCard.get(card.id) ?? [];
    rows.push([
      listsById.get(card.listId)?.name ?? "",
      card.title,
      plainText(card.description),
      join(assigneesByCard.get(card.id)),
      join(labelsByCard.get(card.id)),
      card.dueDateLocalDate,
      card.dueDateSlot,
      dateValue(card.completedAt),
      dateValue(card.archivedAt),
      dateValue(card.createdAt),
      dateValue(card.updatedAt),
      commentsByCard.get(card.id) ?? 0,
      checklist ? `${checklist.done}/${checklist.total}` : null,
      attachments.length,
      attachments.map((attachment) => attachment.url).join("\n") || null,
      ...activeFields.map((field) => customFieldDisplayValue(field, fieldValuesByCardAndField.get(card.id)?.get(field.id), membersById, optionLabelById)),
    ]);
  }

  return rows;
}

export function styledBoardReportRows(rows: WorkbookCell[][]): Cell[][] {
  return rows.map((row, rowIndex) =>
    row.map((value) => ({
      value: value ?? undefined,
      fontWeight: rowIndex === 0 || rowIndex === 1 || rowIndex === 3 ? "bold" : undefined,
      wrap: true,
    })),
  );
}

export function boardReportColumnWidths(rows: WorkbookCell[][]): { width: number }[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  return Array.from({ length: columnCount }, (_, index) => ({
    width: Math.min(48, Math.max(12, rows.reduce((max, row) => Math.max(max, String(row[index] ?? "").length), 0) + 2)),
  }));
}

function groupValues<T, K extends keyof T>(rows: T[], key: K, value: (row: T) => string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const groupKey = String(row[key]);
    const list = map.get(groupKey);
    if (list) list.push(value(row));
    else map.set(groupKey, [value(row)]);
  }
  return map;
}

function countBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) map.set(key(row), (map.get(key(row)) ?? 0) + 1);
  return map;
}

function join(values: string[] | undefined): string | null {
  return values?.length ? values.join(", ") : null;
}

function dateValue(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function plainText(value: string | null): string | null {
  const text = value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
  return text || null;
}

function customFieldDisplayValue(
  field: BoardExportArchive["customFields"][number],
  value: BoardExportArchive["cardCustomFieldValues"][number] | undefined,
  memberNameById: Map<string, string>,
  optionLabelById: Map<string, string>,
): WorkbookCell {
  if (!value) return null;
  switch (field.type) {
    case "select":
      return value.valueOptionIds?.map((id) => optionLabelById.get(id) ?? id).join(", ") || null;
    case "user":
      return value.valueUserIds?.map((id) => memberNameById.get(id) ?? id).join(", ") || null;
    case "date":
      return value.valueDate;
    case "url":
      return value.valueUrl;
    default:
      break;
  }
  if (value.valueCheckbox !== null && value.valueCheckbox !== undefined) return value.valueCheckbox;
  if (value.valueNumber !== null && value.valueNumber !== undefined) return Number(value.valueNumber);
  return value.valueText;
}
