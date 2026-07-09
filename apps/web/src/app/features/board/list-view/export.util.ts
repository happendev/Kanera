import type { CardCustomFieldValue } from "@kanera/shared/schema";
import type { WireCardSummary } from "@kanera/shared/events";
import { cardDetailUrl } from "../card-navigation.util";
import { groupCards } from "./group-by.util";
import type {
  AggregateConfig,
  AggregateMetric,
  AnyCard,
  AnyCustomField,
  AnyLabel,
  AnyList,
  AnyMember,
  CardGroup,
  GroupBy,
} from "./list-view.types";

const CARD_DETAIL_LINK_HEADER = "Card detail link";

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
  // Secondary dimension each group's aggregate is broken down by ("none" = no breakdown). Its
  // human label for display lives in metadata; the raw GroupBy here drives the sub-partition.
  aggregateSplitBy: GroupBy;
  aggregateSplitLabel: string;
  groups: CardGroup[];
  lists: AnyList[];
  cardLabels: AnyLabel[];
  labelsByCard: Map<string, AnyLabel[]>;
  assigneesByCard: Map<string, AnyMember[]>;
  customFields: AnyCustomField[];
  members: AnyMember[];
  customFieldValuesByCardAndField: Map<string, Map<string, CardCustomFieldValue>>;
  commentCounts: Map<string, number>;
  attachmentCountByCard: Map<string, number>;
  boardSummariesById: Map<string, BoardExportSummary> | null;
  currentUserId: string | null;
  cardLinkBaseUrl?: string;
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
    aggregateSplitBy: string;
  };
  groups: BoardExportGroup[];
  /**
   * Aggregates in tidy/long form (one row per group × field × metric × split bucket) so the
   * workbook's Summary sheet is directly usable in Excel PivotTables, SUMIFS and AutoFilter —
   * unlike embedding aggregate values as columns on the grouped Cards sheet, which cannot be
   * filtered or referenced cleanly.
   */
  summary: AggregateSummaryRow[];
  /** Overall aggregates across the deduplicated exported cards, matching the list-view total row. */
  overallSummary: AggregateSummaryRow[];
}

export interface BoardExportGroup {
  key: string;
  label: string;
  cardCount: number;
  cards: BoardExportCard[];
}

export interface AggregateSummaryRow {
  /** Top-level group value, e.g. the Client. */
  group: string;
  /** Split-dimension bucket (e.g. Dev Type), or null when no split is active. */
  split: string | null;
  /** Numeric field name being aggregated, e.g. "Billing Hours". */
  field: string;
  metric: AggregateMetric;
  /** Group-level total for this field/metric when a breakdown is active. */
  total: number | null;
  value: number;
}

export type BoardExportCard = Record<string, string | number | boolean | null>;

export interface WorkbookRows {
  headers: string[];
  rows: BoardExportCard[];
}

export type WorkbookPrimitiveCell = string | number | boolean | null;

export interface WorkbookFormulaCell {
  type: "Formula";
  value: string;
}

export type WorkbookCell = WorkbookPrimitiveCell | WorkbookFormulaCell;

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
      aggregateSplitBy: ctx.aggregateSplitLabel,
    },
    groups: ctx.groups.map((group) => ({
      key: group.key,
      label: group.label,
      cardCount: group.cards.length,
      cards: group.cards.map((card) => exportCardForGroup(group, card, ctx, index)),
    })),
    summary: buildSummaryRows(ctx, index),
    overallSummary: buildOverallSummaryRows(ctx, index),
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

  // Aggregates deliberately do NOT sit on this grouped, human-readable sheet — a group-header row
  // carrying summary values can't be filtered, summed or referenced. They live on the Summary sheet.
  for (const group of payload.groups) {
    boldRows.push(cardsRows.length);
    cardsRows.push([group.label, `${group.cardCount} card${group.cardCount === 1 ? "" : "s"}`]);
    for (const card of group.cards) {
      cardsRows.push(headers.map((header) => card[header] ?? null));
    }
  }

  const sheets: WorkbookSheet[] = [
    {
      name: "Cards",
      rows: cardsRows,
      columnWidths: headers.map((header, index) => widthForColumn(header, index, cardsRows)),
      boldRows,
      autoFilterRange: `A${headerRowNumber}:${columnName(headers.length)}${cardsRows.length}`,
    },
  ];

  const summarySheet = buildSummarySheet(payload);
  if (summarySheet) {
    sheets.push(summarySheet);
    sheets.push(buildReportSheet(payload, summarySheet));
  }

  return { sheets };
}

/**
 * Tidy/long summary sheet: dimension columns (group, optional breakdown, field, metric) then a
 * numeric Value column and, when broken down, the group Total. This is the shape Excel PivotTables
 * and SUMIFS expect, so clients can filter and compute against the aggregates directly.
 */
function buildSummarySheet(payload: BoardExportPayload): WorkbookSheet | null {
  const summary = [...payload.summary, ...payload.overallSummary];
  if (!summary.length) return null;
  const splitActive = summary.some((row) => row.split !== null);
  const groupHeader = payload.metadata.groupBy || "Group";
  const splitHeader = payload.metadata.aggregateSplitBy || "Split";

  const headers: string[] = [groupHeader];
  if (splitActive) headers.push(splitHeader);
  headers.push("Field", "Metric", "Value");
  if (splitActive) headers.push("Total");

  const rows: WorkbookCell[][] = [
    [`Kanera summary: ${payload.metadata.boardName}`],
    [`Grouped by ${payload.metadata.groupBy}`, splitActive ? `Break down by ${splitHeader}` : "No breakdown"],
    [],
    headers,
  ];
  const headerRowNumber = rows.length;

  for (const row of summary) {
    const cells: WorkbookCell[] = [row.group];
    if (splitActive) cells.push(row.split ?? "");
    cells.push(row.field, row.metric, row.value);
    if (splitActive) cells.push(row.total);
    rows.push(cells);
  }

  return {
    name: "Summary",
    rows,
    columnWidths: headers.map((header, index) => widthForColumn(header, index, rows)),
    boldRows: [0, 1, headerRowNumber - 1],
    autoFilterRange: `A${headerRowNumber}:${columnName(headers.length)}${rows.length}`,
  };
}

function buildReportSheet(payload: BoardExportPayload, summarySheet: WorkbookSheet): WorkbookSheet {
  const summary = payload.summary;
  const splitActive = summary.some((row) => row.split !== null);
  const groupHeader = payload.metadata.groupBy || "Group";
  const splitHeader = payload.metadata.aggregateSplitBy || "Split";
  const aggregateKeys = uniqueSummaryKeys(summary);
  const aggregateHeaders = aggregateKeys.map((key) => aggregateHeader(key));
  const headers = [groupHeader, "Title", ...(splitActive ? [splitHeader] : []), ...aggregateHeaders];
  const rows: WorkbookCell[][] = [
    [`Kanera report: ${payload.metadata.boardName}`],
    [
      `Grouped by ${payload.metadata.groupBy}`,
      splitActive ? `Break down by ${payload.metadata.aggregateSplitBy}` : "No breakdown",
    ],
    [],
    headers,
  ];

  for (const group of unique(summary.map((row) => row.group))) {
    const groupRows = summary.filter((row) => row.group === group);
    const exportGroup = payload.groups.find((item) => item.label === group);
    for (const card of exportGroup?.cards ?? []) {
      const row: WorkbookCell[] = [group, card["Title"] ?? ""];
      if (splitActive) row.push(card[splitHeader] ?? "");
      row.push(...aggregateKeys.map((key) => card[key.field] ?? null));
      rows.push(row);
    }

    // Keep the presentation sheet tied to the tidy Summary table with formulas, so the workbook has
    // one aggregate source of truth while still offering a client-friendly single-sheet layout.
    const breakdowns = splitActive ? unique(groupRows.map((row) => row.split ?? "")) : [""];
    for (const breakdown of breakdowns) {
      const rowNumber = rows.length + 1;
      const row: WorkbookCell[] = [group, "Summary"];
      if (splitActive) row.push(breakdown);
      row.push(
        ...aggregateKeys.map((key) => ({
          type: "Formula" as const,
          value: summaryLookupFormula({
            summarySheet,
            rowNumber,
            splitActive,
            field: key.field,
            metric: key.metric,
          }),
        })),
      );
      rows.push(row);
    }
    rows.push([
      group,
      "Total",
      ...(splitActive ? [""] : []),
      ...aggregateKeys.map((key) => ({
        type: "Formula" as const,
        value: totalFormula({
          summarySheet,
          group,
          splitActive,
          field: key.field,
          metric: key.metric,
        }),
      })),
    ]);
    rows.push([]);
  }

  if (payload.overallSummary.length) {
    rows.push(...overallReportRows(payload, aggregateKeys, summarySheet, splitActive, rows.length + 1));
  }

  return {
    name: "Report",
    rows,
    columnWidths: headers.map((header, index) => widthForColumn(header, index, rows)),
    boldRows: [0, 1, 3],
    autoFilterRange: `A4:${columnName(headers.length)}${Math.max(4, rows.length)}`,
  };
}

function overallReportRows(
  payload: BoardExportPayload,
  aggregateKeys: { field: string; metric: AggregateMetric }[],
  summarySheet: WorkbookSheet,
  splitActive: boolean,
  startRowNumber: number,
): WorkbookCell[][] {
  const rows: WorkbookCell[][] = [];
  const summary = payload.overallSummary;
  const breakdowns = splitActive ? unique(summary.map((row) => row.split ?? "")) : [""];
  const cardCount = dedupedExportCardCount(payload.groups);
  rows.push(["Overall totals", `${cardCount} card${cardCount === 1 ? "" : "s"}`]);
  let rowNumber = startRowNumber + 1;
  for (const breakdown of breakdowns) {
    const row: WorkbookCell[] = ["Overall", splitActive ? "Summary" : "Total"];
    if (splitActive) row.push(breakdown);
    row.push(
      ...aggregateKeys.map((key) => ({
        type: "Formula" as const,
        value: summaryLookupFormula({
          summarySheet,
          rowNumber,
          splitActive,
          field: key.field,
          metric: key.metric,
        }),
      })),
    );
    rows.push(row);
    rowNumber += 1;
  }
  if (splitActive) {
    rows.push([
      "Overall",
      "Total",
      "",
      ...aggregateKeys.map((key) => ({
        type: "Formula" as const,
        value: totalFormula({
          summarySheet,
          group: "Overall",
          splitActive,
          field: key.field,
          metric: key.metric,
        }),
      })),
    ]);
  }
  return rows;
}

export function buildWorkbookRows(payload: BoardExportPayload): WorkbookRows {
  const headers = [
    "Group",
    "Title",
    ...payload.metadata.columns.map((column) => column.label),
    CARD_DETAIL_LINK_HEADER,
  ];

  const rows: BoardExportCard[] = [];
  for (const group of payload.groups) {
    rows.push({
      Group: group.label,
      Title: `${group.cardCount} card${group.cardCount === 1 ? "" : "s"}`,
    });
    rows.push(...group.cards);
  }

  return { headers, rows };
}

function uniqueSummaryKeys(summary: AggregateSummaryRow[]): { field: string; metric: AggregateMetric }[] {
  const seen = new Set<string>();
  const keys: { field: string; metric: AggregateMetric }[] = [];
  for (const row of summary) {
    const key = `${row.field}\u0000${row.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ field: row.field, metric: row.metric });
  }
  return keys;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function aggregateHeader(key: { field: string; metric: AggregateMetric }): string {
  return key.metric === "sum" ? key.field : `${key.field} ${key.metric}`;
}

function summaryLookupFormula(input: {
  summarySheet: WorkbookSheet;
  rowNumber: number;
  splitActive: boolean;
  field: string;
  metric: AggregateMetric;
}): string {
  const valueColumn = input.splitActive ? "E" : "D";
  const fieldColumn = input.splitActive ? "C" : "B";
  const metricColumn = input.splitActive ? "D" : "C";
  const criteria = [
    `${quotedSheet(input.summarySheet.name)}!$A:$A,$A${input.rowNumber}`,
    ...(input.splitActive ? [`${quotedSheet(input.summarySheet.name)}!$B:$B,$C${input.rowNumber}`] : []),
    `${quotedSheet(input.summarySheet.name)}!$${fieldColumn}:$${fieldColumn},${excelString(input.field)}`,
    `${quotedSheet(input.summarySheet.name)}!$${metricColumn}:$${metricColumn},${excelString(input.metric)}`,
  ];
  return `SUMIFS(${quotedSheet(input.summarySheet.name)}!$${valueColumn}:$${valueColumn},${criteria.join(",")})`;
}

function totalFormula(input: {
  summarySheet: WorkbookSheet;
  group: string;
  splitActive: boolean;
  field: string;
  metric: AggregateMetric;
}): string {
  const valueColumn = input.splitActive ? "F" : "D";
  const fieldColumn = input.splitActive ? "C" : "B";
  const metricColumn = input.splitActive ? "D" : "C";
  const criteria = [
    `${quotedSheet(input.summarySheet.name)}!$A:$A,${excelString(input.group)}`,
    `${quotedSheet(input.summarySheet.name)}!$${fieldColumn}:$${fieldColumn},${excelString(input.field)}`,
    `${quotedSheet(input.summarySheet.name)}!$${metricColumn}:$${metricColumn},${excelString(input.metric)}`,
  ];
  // With breakdowns, Summary repeats the true group/overall total on every split bucket row.
  // Use MAXIFS to retrieve that repeated scalar instead of summing buckets or averaging sums.
  const fn = input.splitActive ? "MAXIFS" : input.metric === "avg" ? "AVERAGEIFS" : "SUMIFS";
  return `${fn}(${quotedSheet(input.summarySheet.name)}!$${valueColumn}:$${valueColumn},${criteria.join(",")})`;
}

function quotedSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function excelString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
  if (isWorkbookFormulaCell(value)) return 8;
  return String(value).length;
}

export function isWorkbookFormulaCell(value: WorkbookCell): value is WorkbookFormulaCell {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "Formula");
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
  row[CARD_DETAIL_LINK_HEADER] = cardDetailLink(card, ctx);
  return row;
}

function cardDetailLink(card: AnyCard, ctx: BoardExportContext): string {
  const path = cardDetailUrl(card.boardId, card.id);
  return ctx.cardLinkBaseUrl ? new URL(path, ctx.cardLinkBaseUrl).toString() : path;
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

function buildSummaryRows(ctx: BoardExportContext, index: ExportIndex): AggregateSummaryRow[] {
  const rows: AggregateSummaryRow[] = [];
  const splitActive = ctx.aggregateSplitBy !== "none";
  for (const group of ctx.groups) {
    // When splitting, sub-partition this group's cards once (reusing the List View's grouping) so
    // every numeric field shares the same buckets. A card with a multi-value split dimension lands
    // in several buckets, matching how the List View repeats such cards across groups.
    const buckets = splitActive
      ? groupCards(group.cards, ctx.aggregateSplitBy, "position", {
          lists: ctx.lists,
          labels: ctx.cardLabels,
          members: ctx.members,
          customFields: ctx.customFields,
          labelsByCard: ctx.labelsByCard,
          assigneesByCard: ctx.assigneesByCard,
          customFieldValuesByCardAndField: ctx.customFieldValuesByCardAndField,
          currentUserId: ctx.currentUserId,
        })
      : null;

    for (const [fieldId, metrics] of Object.entries(ctx.aggregateConfig)) {
      const field = index.customFieldById.get(fieldId);
      if (!field || field.type !== "number") continue;
      for (const metric of metrics) {
        if (buckets) {
          // Keep one row per bucket while carrying the true group total as a column. This preserves
          // tidy summary data without making totals depend on summing bucket values (especially avg).
          const total = metricOver(group.cards, fieldId, metric, ctx);
          if (total === null) continue;
          for (const bucket of buckets) {
            const value = metricOver(bucket.cards, fieldId, metric, ctx);
            if (value === null) continue;
            rows.push({ group: group.label, split: bucket.label, field: field.name, metric, total, value });
          }
        } else {
          const value = metricOver(group.cards, fieldId, metric, ctx);
          if (value === null) continue;
          rows.push({ group: group.label, split: null, field: field.name, metric, total: null, value });
        }
      }
    }
  }
  return rows;
}

function buildOverallSummaryRows(ctx: BoardExportContext, index: ExportIndex): AggregateSummaryRow[] {
  const rows: AggregateSummaryRow[] = [];
  const cards = dedupedCards(ctx.groups);
  const splitActive = ctx.aggregateSplitBy !== "none";
  const buckets = splitActive
    ? groupCards(cards, ctx.aggregateSplitBy, "position", {
        lists: ctx.lists,
        labels: ctx.cardLabels,
        members: ctx.members,
        customFields: ctx.customFields,
        labelsByCard: ctx.labelsByCard,
        assigneesByCard: ctx.assigneesByCard,
        customFieldValuesByCardAndField: ctx.customFieldValuesByCardAndField,
        currentUserId: ctx.currentUserId,
      })
    : null;

  for (const [fieldId, metrics] of Object.entries(ctx.aggregateConfig)) {
    const field = index.customFieldById.get(fieldId);
    if (!field || field.type !== "number") continue;
    for (const metric of metrics) {
      if (buckets) {
        const total = metricOver(cards, fieldId, metric, ctx);
        if (total === null) continue;
        for (const bucket of buckets) {
          const value = metricOver(bucket.cards, fieldId, metric, ctx);
          if (value === null) continue;
          rows.push({ group: "Overall", split: bucket.label, field: field.name, metric, total, value });
        }
      } else {
        const value = metricOver(cards, fieldId, metric, ctx);
        if (value === null) continue;
        rows.push({ group: "Overall", split: null, field: field.name, metric, total: null, value });
      }
    }
  }

  return rows;
}

function dedupedCards(groups: CardGroup[]): AnyCard[] {
  const byId = new Map<string, AnyCard>();
  for (const group of groups) {
    for (const card of group.cards) {
      if (!byId.has(card.id)) byId.set(card.id, card);
    }
  }
  return [...byId.values()];
}

function dedupedExportCardCount(groups: BoardExportGroup[]): number {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const card of group.cards) {
      const link = card[CARD_DETAIL_LINK_HEADER];
      if (typeof link === "string") ids.add(link);
      else ids.add(`${group.label}\u0000${String(card["Title"] ?? "")}`);
    }
  }
  return ids.size;
}

/** Sum or average of a numeric field across the given cards, or null when no card holds a value. */
function metricOver(cards: CardGroup["cards"], fieldId: string, metric: AggregateMetric, ctx: BoardExportContext): number | null {
  const numbers = cards
    .map((card) => numberValue(ctx.customFieldValuesByCardAndField.get(card.id)?.get(fieldId)?.valueNumber))
    .filter((value): value is number => value !== null);
  if (!numbers.length) return null;
  const sum = numbers.reduce((accumulator, value) => accumulator + value, 0);
  return metric === "avg" ? sum / numbers.length : sum;
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
