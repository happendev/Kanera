import type { CardCustomFieldValue } from "@kanera/shared/schema";
import type { WireCardSummary } from "@kanera/shared/events";
import type {
  AggregateConfig,
  AggregateMetric,
  AnyCard,
  AnyCustomField,
  AnyLabel,
  AnyList,
  AnyMember,
  CardGroup,
} from "./list-view.types";

export interface BoardExportSummary {
  id: string;
  name: string;
}

export interface BoardExportColumn {
  id: string;
  label: string;
}

export interface BoardExportContext {
  board: BoardExportSummary;
  exportedAt: string;
  groupBy: string;
  sortBy: string;
  columns: BoardExportColumn[];
  aggregateConfig: AggregateConfig;
  groups: CardGroup[];
  lists: AnyList[];
  labelsByCard: Map<string, AnyLabel[]>;
  assigneesByCard: Map<string, AnyMember[]>;
  customFields: AnyCustomField[];
  members: AnyMember[];
  customFieldValuesByCardAndField: Map<string, Map<string, CardCustomFieldValue>>;
  commentCounts: Map<string, number>;
  attachmentCountByCard: Map<string, number>;
  boardSummariesById: Map<string, BoardExportSummary> | null;
}

export interface BoardExportPayload {
  metadata: {
    boardId: string;
    boardName: string;
    exportedAt: string;
    groupBy: string;
    sortBy: string;
    columns: BoardExportColumn[];
    aggregateConfig: AggregateConfig;
  };
  groups: BoardExportGroup[];
}

export interface BoardExportGroup {
  key: string;
  label: string;
  cardCount: number;
  aggregates: Record<string, number>;
  cards: BoardExportCard[];
}

export type BoardExportCard = Record<string, string | number | boolean | null>;

export interface WorkbookRows {
  headers: string[];
  rows: BoardExportCard[];
}

export type WorkbookCell = string | number | boolean | null;

export interface WorkbookSheet {
  name: string;
  rows: WorkbookCell[][];
  columnWidths: number[];
  boldRows: number[];
  autoFilterRange?: string;
}

export interface WorkbookExport {
  sheets: WorkbookSheet[];
}

export interface BoardExportSnapshot {
  cards: AnyCard[];
  customFieldValuesByCardAndField: Map<string, Map<string, CardCustomFieldValue>>;
  labelsByCard: Map<string, AnyLabel[]>;
  assigneesByCard: Map<string, AnyMember[]>;
  commentCounts: Map<string, number>;
  attachmentCountByCard: Map<string, number>;
}

// Lookups built once per export instead of re-scanning ctx arrays for every card/field/group.
// Each cell resolution would otherwise be O(lists + customFields + members), making a full
// export O(cards × fields × (lists + customFields + members)) on large boards.
interface ExportIndex {
  listById: Map<string, AnyList>;
  customFieldById: Map<string, AnyCustomField>;
  memberNameById: Map<string, string>;
  optionLabelById: Map<string, string>;
}

function buildExportIndex(ctx: BoardExportContext): ExportIndex {
  // Select-option ids are globally unique, so a single label map across all fields is safe.
  const optionLabelById = new Map<string, string>();
  for (const field of ctx.customFields) {
    if ("options" in field && field.options) {
      for (const option of field.options) optionLabelById.set(option.id, option.label);
    }
  }
  return {
    listById: new Map(ctx.lists.map((list) => [list.id, list])),
    customFieldById: new Map(ctx.customFields.map((field) => [field.id, field])),
    memberNameById: new Map(ctx.members.map((member) => [member.userId, member.displayName])),
    optionLabelById,
  };
}

export function buildBoardExportPayload(ctx: BoardExportContext): BoardExportPayload {
  const index = buildExportIndex(ctx);
  return {
    metadata: {
      boardId: ctx.board.id,
      boardName: ctx.board.name,
      exportedAt: ctx.exportedAt,
      groupBy: ctx.groupBy,
      sortBy: ctx.sortBy,
      columns: ctx.columns,
      aggregateConfig: ctx.aggregateConfig,
    },
    groups: ctx.groups.map((group) => ({
      key: group.key,
      label: group.label,
      cardCount: group.cards.length,
      aggregates: aggregateValuesFor(group, ctx, index),
      cards: group.cards.map((card) => exportCardForGroup(group, card, ctx, index)),
    })),
  };
}

export function buildWorkbookExport(payload: BoardExportPayload): WorkbookExport {
  const { headers } = buildWorkbookRows(payload);
  const cardsRows: WorkbookCell[][] = [
    [`Kanera export: ${payload.metadata.boardName}`],
    [
      `Exported ${formatExportedAt(payload.metadata.exportedAt)}`,
      `Grouped by ${payload.metadata.groupBy}`,
      `Sorted by ${payload.metadata.sortBy}`,
    ],
    [],
    headers,
  ];
  const headerRowNumber = cardsRows.length;
  const boldRows = [0, 1, headerRowNumber - 1];

  for (const group of payload.groups) {
    boldRows.push(cardsRows.length);
    const aggregateText = Object.entries(group.aggregates)
      .map(([label, value]) => `${label}: ${formatNumber(value)}`)
      .join(" | ");
    cardsRows.push([
      group.label,
      `${group.cardCount} card${group.cardCount === 1 ? "" : "s"}`,
      aggregateText || null,
    ]);
    for (const card of group.cards) {
      cardsRows.push(headers.map((header) => card[header] ?? null));
    }
  }

  return {
    sheets: [
      {
        name: "Cards",
        rows: cardsRows,
        columnWidths: headers.map((header, index) => widthForColumn(header, index, cardsRows)),
        boldRows,
        autoFilterRange: `A${headerRowNumber}:${columnName(headers.length)}${cardsRows.length}`,
      },
    ],
  };
}

export function buildWorkbookRows(payload: BoardExportPayload): WorkbookRows {
  const headers = [
    "Group",
    "Title",
    ...payload.metadata.columns.map((column) => column.label),
  ];
  const aggregateLabels = new Set<string>();
  for (const group of payload.groups) {
    for (const label of Object.keys(group.aggregates)) aggregateLabels.add(label);
  }
  headers.push(...aggregateLabels);

  const rows: BoardExportCard[] = [];
  for (const group of payload.groups) {
    rows.push({
      Group: group.label,
      Title: `${group.cardCount} card${group.cardCount === 1 ? "" : "s"}`,
      ...group.aggregates,
    });
    rows.push(...group.cards);
  }

  return { headers, rows };
}

function widthForColumn(header: string, index: number, rows: WorkbookCell[][]): number {
  const headerWidth = header.length + 2;
  const contentWidth = rows.reduce((max, row) => {
    return Math.max(max, stringWidth(row[index]));
  }, headerWidth);
  return Math.min(42, Math.max(12, contentWidth + 2));
}

function stringWidth(value: WorkbookCell | undefined): number {
  if (value === null || value === undefined) return 0;
  return String(value).length;
}

function columnName(count: number): string {
  let n = count;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function formatExportedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function sanitizeExportFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return cleaned || "board";
}

export function timestampForFileName(value: string): string {
  return value.replace(/[:.]/g, "-");
}

export function boardExportSnapshotFromCards(
  cards: WireCardSummary[],
  labels: AnyLabel[],
  members: AnyMember[],
): BoardExportSnapshot {
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const membersById = new Map(members.map((member) => [member.userId, member]));
  const customFieldValuesByCardAndField = new Map<string, Map<string, CardCustomFieldValue>>();
  const labelsByCard = new Map<string, AnyLabel[]>();
  const assigneesByCard = new Map<string, AnyMember[]>();
  const commentCounts = new Map<string, number>();
  const attachmentCountByCard = new Map<string, number>();

  for (const card of cards) {
    const valuesByField = new Map<string, CardCustomFieldValue>();
    for (const value of card.customFieldValues) valuesByField.set(value.fieldId, value);
    customFieldValuesByCardAndField.set(card.id, valuesByField);
    labelsByCard.set(card.id, card.labelIds.map((id) => labelsById.get(id)).filter((label): label is AnyLabel => Boolean(label)));
    assigneesByCard.set(card.id, card.assigneeIds.map((id) => membersById.get(id)).filter((member): member is AnyMember => Boolean(member)));
    commentCounts.set(card.id, card.commentCount);
    attachmentCountByCard.set(card.id, card.attachmentCount);
  }

  return {
    cards,
    customFieldValuesByCardAndField,
    labelsByCard,
    assigneesByCard,
    commentCounts,
    attachmentCountByCard,
  };
}

function exportCardForGroup(group: CardGroup, card: AnyCard, ctx: BoardExportContext, index: ExportIndex): BoardExportCard {
  const row: BoardExportCard = {
    Group: group.label,
    Title: card.title,
  };
  for (const column of ctx.columns) {
    row[column.label] = valueForColumn(card, column.id, ctx, index);
  }
  return row;
}

function valueForColumn(card: AnyCard, columnId: string, ctx: BoardExportContext, index: ExportIndex): string | number | boolean | null {
  switch (columnId) {
    case "status":
      return index.listById.get(card.listId)?.name ?? null;
    case "board":
      return ctx.boardSummariesById?.get(card.boardId)?.name ?? ctx.board.name;
    case "assignees":
      return joinNames(ctx.assigneesByCard.get(card.id)?.map((member) => member.displayName));
    case "due":
      return card.dueDateLocalDate ?? null;
    case "labels":
      return joinNames(ctx.labelsByCard.get(card.id)?.map((label) => label.name));
    case "checklist":
      return checklistSummary(card);
    case "updated":
      return formatDateValue(card.updatedAt);
    case "created":
      return formatDateValue(card.createdAt);
    case "description":
      return "hasDescription" in card
        ? (card.hasDescription ? "Yes" : null)
        : plainText((card as { description?: string | null }).description ?? null);
    default:
      if (columnId.startsWith("cf:")) return customFieldValue(card.id, columnId.slice(3), ctx, index);
      return null;
  }
}

function aggregateValuesFor(group: CardGroup, ctx: BoardExportContext, index: ExportIndex): Record<string, number> {
  const aggregates: Record<string, number> = {};
  for (const [fieldId, metrics] of Object.entries(ctx.aggregateConfig)) {
    const field = index.customFieldById.get(fieldId);
    if (!field || field.type !== "number") continue;
    const numbers = group.cards
      .map((card) => numberValue(ctx.customFieldValuesByCardAndField.get(card.id)?.get(fieldId)?.valueNumber))
      .filter((value): value is number => value !== null);
    if (!numbers.length) continue;
    const sum = numbers.reduce((total, value) => total + value, 0);
    for (const metric of metrics) {
      aggregates[aggregateLabel(field.name, metric)] = metric === "avg" ? sum / numbers.length : sum;
    }
  }
  return aggregates;
}

function aggregateLabel(fieldName: string, metric: AggregateMetric): string {
  return `${fieldName} ${metric}`;
}

function customFieldValue(cardId: string, fieldId: string, ctx: BoardExportContext, index: ExportIndex): string | number | boolean | null {
  const value = ctx.customFieldValuesByCardAndField.get(cardId)?.get(fieldId);
  if (!value) return null;
  const field = index.customFieldById.get(fieldId);
  switch (field?.type) {
    case "select": {
      const labels = (value.valueOptionIds ?? [])
        .map((id) => index.optionLabelById.get(id))
        .filter((label): label is string => Boolean(label));
      return labels.length ? labels.join(", ") : null;
    }
    case "user": {
      const names = (value.valueUserIds ?? [])
        .map((id) => index.memberNameById.get(id))
        .filter((name): name is string => Boolean(name));
      return names.length ? names.join(", ") : null;
    }
    case "date":
      return value.valueDate?.trim() || null;
    case "url":
      return value.valueUrl?.trim() || null;
    default:
      break;
  }
  if (value.valueCheckbox !== null && value.valueCheckbox !== undefined) return value.valueCheckbox;
  const number = numberValue(value.valueNumber);
  if (number !== null) return number;
  return value.valueText?.trim() || null;
}

function numberValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function joinNames(values: string[] | undefined): string | null {
  const names = values?.filter(Boolean) ?? [];
  return names.length ? names.join(", ") : null;
}

function checklistSummary(card: AnyCard): string | null {
  const total = "checklistTotalCount" in card ? card.checklistTotalCount : 0;
  if (!total) return null;
  const done = "checklistDoneCount" in card ? card.checklistDoneCount : 0;
  return `${done}/${total}`;
}

function formatDateValue(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function plainText(value: string | null): string | null {
  const text = value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
  return text || null;
}
