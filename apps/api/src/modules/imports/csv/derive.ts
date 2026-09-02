import { COLOR_TOKENS, type ColorToken } from "@kanera/shared/colors";
import type {
  BoardExportArchive,
  CsvColumnMapping,
  CsvColumnTarget,
  CsvCustomFieldType,
  CsvImportIssues,
  CsvImportManifest,
} from "@kanera/shared/dto";
import { CARD_LABEL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "@kanera/shared/dto";
import { badRequest } from "../../../lib/errors.js";
import { positionAtIndex } from "../../../lib/position.js";
import { inferDateOrder, isValidTimezone, parseCsvDate, toInstant, toLocalDate } from "./dates.js";
import type { CsvSource } from "./parse.js";

export interface DerivedCsvImport {
  manifest: CsvImportManifest;
  archive: BoardExportArchive;
  issues: CsvImportIssues;
}

interface DeriveContext {
  actorId: string;
  workspaceId: string;
  fileName: string;
  now: Date;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function key(value: string): string {
  return encodeURIComponent(normalize(value));
}

function splitValue(value: string, delimiter: CsvColumnMapping["multiValueDelimiter"]): string[] {
  const token = delimiter === "newline" ? /\r?\n/ : delimiter;
  return value.split(token).map((item) => item.trim()).filter(Boolean);
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on", "done", "completed", "resolved", "closed", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", "open", "incomplete"]);

function booleanValue(value: string): boolean | null {
  const normalized = normalize(value);
  if (TRUE_WORDS.has(normalized)) return true;
  if (FALSE_WORDS.has(normalized)) return false;
  return null;
}

function cleanChecklistItem(value: string): { text: string; completed: boolean } | null {
  const trimmed = value.trim();
  const completed = /^(?:\[x\]|\(x\)|☑|✓|✔)\s*/i.test(trimmed);
  const text = trimmed.replace(/^(?:\[x\]|\(x\)|☑|✓|✔|\[\s\]|\(\s\)|☐)\s*/i, "").trim();
  return text ? { text, completed } : null;
}

const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Normalise a spreadsheet number to PostgreSQL `numeric` input syntax. `Number()` alone is too lax
 * (it accepts `0x10`, which numeric rejects mid-transaction) and a blanket comma strip turns the
 * European decimal `1,5` into `15`, so the separator roles are resolved before validation.
 */
export function parsedNumber(value: string): string | null {
  let compact = value.replace(/\s/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Both separators present: the later one is the decimal mark, the other groups thousands.
    compact = lastComma > lastDot ? compact.replace(/\./g, "").replace(",", ".") : compact.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // Comma only: a single comma followed by 1-2 digits is a decimal mark, otherwise grouping.
    compact = /^[+-]?\d+,\d{1,2}$/.test(compact) ? compact.replace(",", ".") : compact.replace(/,/g, "");
  }
  return DECIMAL_NUMBER.test(compact) ? compact : null;
}

function validUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function boardName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const cleaned = Array.from(withoutExtension, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, WORKSPACE_ENTITY_NAME_MAX_LENGTH) || "Imported board";
}

function indexesFor(mapping: CsvColumnMapping, target: CsvColumnTarget["target"]): number[] {
  return Object.entries(mapping.columns)
    .filter(([, entry]) => entry.target === target)
    .map(([index]) => Number(index))
    .sort((a, b) => a - b);
}

function firstCell(rows: string[][], indexes: number[]): string {
  for (const row of rows) {
    for (const index of indexes) {
      const value = row[index]?.trim() ?? "";
      if (value) return value;
    }
  }
  return "";
}

/**
 * Turns parsed CSV rows plus a column mapping into an import manifest and a synthetic board archive.
 *
 * This runs once on `/columns` (to build the manifest the wizard maps against) and again on
 * `/commit` (to build the archive that is imported). The commit body is keyed by the manifest ids,
 * so every synthetic id (`list:`, `label:`, `field:`, `option:`, `member:`, `card:`) must be a pure
 * function of the rows and the mapping, and `ctx.now` must be the same instant on both calls.
 * Never derive an id from a random value or from anything outside `source`/`mapping`.
 *
 * Author-like ids that have no CSV counterpart use the `csv:importer` sentinel: the importer maps
 * unknown member ids to the acting user, so those comments and completions are attributed to the
 * person running the import.
 */
export function deriveCsvImport(source: CsvSource, mapping: CsvColumnMapping, ctx: DeriveContext): DerivedCsvImport {
  for (const rawIndex of Object.keys(mapping.columns)) {
    if (Number(rawIndex) >= source.columnCount) throw badRequest(`CSV column ${Number(rawIndex) + 1} does not exist`);
  }
  const dataRows = mapping.hasHeaderRow ? source.rows.slice(1) : source.rows;
  const timezone = isValidTimezone(mapping.timezone) ? mapping.timezone : "UTC";
  const issues: CsvImportIssues = {
    rowsWithoutTitle: 0,
    unparseableDates: 0,
    unparseableNumbers: 0,
    invalidUrls: 0,
    ambiguousDateColumns: [],
    raggedRows: source.raggedRows,
  };

  const dateOrderByColumn = new Map<number, "dmy" | "mdy">();
  for (const [rawIndex, entry] of Object.entries(mapping.columns)) {
    if (!["dueDate", "completed", "archived", "createdAt"].includes(entry.target) && !(entry.target === "customField" && entry.type === "date")) continue;
    const index = Number(rawIndex);
    if (mapping.dateOrder === "auto") {
      const inferred = inferDateOrder(dataRows.map((row) => row[index] ?? "").filter(Boolean));
      dateOrderByColumn.set(index, inferred.order);
      if (inferred.ambiguous) issues.ambiguousDateColumns.push(index);
    } else {
      dateOrderByColumn.set(index, mapping.dateOrder);
    }
  }

  const cardIdIndex = indexesFor(mapping, "cardId")[0];
  const grouped = new Map<string, string[][]>();
  dataRows.forEach((row, rowIndex) => {
    const explicit = cardIdIndex === undefined ? "" : row[cardIdIndex]?.trim() ?? "";
    // Group by the normalised key that also forms the synthetic card id, so ids differing only by
    // case or inner whitespace merge here instead of colliding later in the importer's id maps.
    const groupKey = explicit ? key(explicit) : `row:${rowIndex}`;
    const rows = grouped.get(groupKey);
    if (rows) rows.push(row);
    else grouped.set(groupKey, [row]);
  });

  const titleIndexes = indexesFor(mapping, "title");
  const descriptionIndexes = indexesFor(mapping, "description");
  const listIndexes = indexesFor(mapping, "list");
  const labelIndexes = indexesFor(mapping, "labels");
  const assigneeIndexes = indexesFor(mapping, "assignees");
  const dueIndex = indexesFor(mapping, "dueDate")[0];
  const completedIndex = indexesFor(mapping, "completed")[0];
  const archivedIndex = indexesFor(mapping, "archived")[0];
  const createdIndex = indexesFor(mapping, "createdAt")[0];
  const commentIndexes = indexesFor(mapping, "comment");
  const checklistIndexes = indexesFor(mapping, "checklistItem");

  const listByKey = new Map<string, { id: string; name: string; count: number }>();
  const labelByKey = new Map<string, { id: string; name: string; color: ColorToken }>();
  const memberByKey = new Map<string, { id: string; displayName: string; email?: string }>();
  const cards: Array<Record<string, unknown>> = [];
  const cardLabelAssignments: Array<{ cardId: string; labelId: string }> = [];
  const cardAssignees: Array<{ cardId: string; userId: string }> = [];
  const checklists: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const cardCustomFieldValues: Array<Record<string, unknown>> = [];

  const customFieldEntries = Object.entries(mapping.columns)
    .filter((entry): entry is [string, Extract<CsvColumnTarget, { target: "customField" }>] => entry[1].target === "customField")
    .map(([rawIndex, entry]) => ({ index: Number(rawIndex), ...entry }));
  const effectiveFieldType = new Map<number, CsvCustomFieldType>();
  const optionValuesByField = new Map<number, Map<string, string>>();
  for (const field of customFieldEntries) {
    let type = field.type;
    if (type === "select") {
      const values = new Map<string, string>();
      for (const rows of grouped.values()) {
        const value = firstCell(rows, [field.index]);
        if (value && !values.has(normalize(value))) values.set(normalize(value), value);
      }
      if (values.size > 100) type = "text";
      else optionValuesByField.set(field.index, values);
    }
    effectiveFieldType.set(field.index, type);
  }

  let skippedRows = 0;
  for (const [groupKey, rows] of grouped) {
    const title = firstCell(rows, titleIndexes).slice(0, 500);
    if (!title) {
      issues.rowsWithoutTitle += 1;
      skippedRows += rows.length;
      continue;
    }
    const cardId = `card:${groupKey}`;
    const listName = firstCell(rows, listIndexes) || "Imported";
    const listId = listName === "Imported" && !firstCell(rows, listIndexes) ? "list:__default" : `list:${key(listName)}`;
    const existingList = listByKey.get(listId);
    if (existingList) existingList.count += 1;
    else listByKey.set(listId, { id: listId, name: listName.slice(0, WORKSPACE_ENTITY_NAME_MAX_LENGTH), count: 1 });

    let createdAt = ctx.now;
    if (createdIndex !== undefined) {
      const raw = firstCell(rows, [createdIndex]);
      if (raw) {
        const parsed = parseCsvDate(raw, dateOrderByColumn.get(createdIndex) ?? "dmy");
        if (parsed) createdAt = toInstant(parsed, timezone);
        else issues.unparseableDates += 1;
      }
    }
    const timestampValue = (index: number | undefined): Date | null => {
      if (index === undefined) return null;
      const raw = firstCell(rows, [index]);
      if (!raw) return null;
      const bool = booleanValue(raw);
      if (bool !== null) return bool ? ctx.now : null;
      const parsed = parseCsvDate(raw, dateOrderByColumn.get(index) ?? "dmy");
      if (!parsed) {
        issues.unparseableDates += 1;
        return null;
      }
      return toInstant(parsed, timezone);
    };
    let dueDateLocalDate: string | null = null;
    if (dueIndex !== undefined) {
      const raw = firstCell(rows, [dueIndex]);
      if (raw) {
        const parsed = parseCsvDate(raw, dateOrderByColumn.get(dueIndex) ?? "dmy");
        if (parsed) dueDateLocalDate = toLocalDate(parsed, timezone);
        else issues.unparseableDates += 1;
      }
    }

    cards.push({
      id: cardId, clientToken: null, workspaceId: ctx.workspaceId, organisationKey: "", number: 0,
      key: "", listId, boardId: "", title, description: firstCell(rows, descriptionIndexes).slice(0, 20_000) || null,
      position: "0", dueDateLocalDate, dueDateSlot: dueDateLocalDate ? "anyTime" : null,
      dueDateTimezone: dueDateLocalDate ? timezone : null, completedAt: timestampValue(completedIndex),
      archivedAt: timestampValue(archivedIndex), createdById: ctx.actorId, coverAttachmentId: null,
      createdAt, updatedAt: createdAt,
    });

    const seenLabels = new Set<string>();
    const seenMembers = new Set<string>();
    for (const row of rows) {
      for (const index of labelIndexes) {
        for (const value of splitValue(row[index] ?? "", mapping.multiValueDelimiter)) {
          const normalized = key(value);
          const labelId = `label:${normalized}`;
          if (!labelByKey.has(labelId)) {
            labelByKey.set(labelId, { id: labelId, name: value.slice(0, CARD_LABEL_NAME_MAX_LENGTH), color: COLOR_TOKENS[labelByKey.size % COLOR_TOKENS.length]! });
          }
          if (!seenLabels.has(labelId)) cardLabelAssignments.push({ cardId, labelId });
          seenLabels.add(labelId);
        }
      }
      for (const index of assigneeIndexes) {
        for (const value of splitValue(row[index] ?? "", mapping.multiValueDelimiter)) {
          const memberId = `member:${key(value)}`;
          if (!memberByKey.has(memberId)) memberByKey.set(memberId, { id: memberId, displayName: value, ...(zEmail(value) ? { email: value } : {}) });
          if (!seenMembers.has(memberId)) cardAssignees.push({ cardId, userId: memberId });
          seenMembers.add(memberId);
        }
      }
    }

    const checklistItems: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      for (const index of checklistIndexes) {
        for (const raw of splitValue(row[index] ?? "", mapping.multiValueDelimiter)) {
          const item = cleanChecklistItem(raw);
          if (!item) continue;
          const itemIndex = checklistItems.length;
          checklistItems.push({
            id: `checkitem:${groupKey}:${itemIndex}`, checklistId: `checklist:${groupKey}`,
            text: item.text, description: null, position: positionAtIndex(itemIndex), assigneeId: null,
            dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null,
            completedAt: item.completed ? ctx.now : null, completedById: item.completed ? "csv:importer" : null,
            createdAt, updatedAt: createdAt,
          });
        }
      }
    }
    if (checklistItems.length) {
      checklists.push({ id: `checklist:${groupKey}`, cardId, parentItemId: null, title: "Checklist", position: positionAtIndex(0), createdAt, updatedAt: createdAt, items: checklistItems });
    }

    let commentNumber = 0;
    for (const row of rows) {
      for (const index of commentIndexes) {
        const body = (row[index] ?? "").trim();
        if (!body) continue;
        comments.push({
          id: `comment:${groupKey}:${commentNumber++}`, cardId, authorId: "csv:importer", authorKind: "user",
          apiKeyId: null, apiKeyName: null, authorName: null, authorAvatarUrl: null, body: body.slice(0, 20_000),
          editedAt: null, createdAt,
        });
      }
    }

    for (const field of customFieldEntries) {
      const raw = firstCell(rows, [field.index]);
      if (!raw) continue;
      const type = effectiveFieldType.get(field.index)!;
      const value: Record<string, unknown> = { cardId, fieldId: `field:${field.index}` };
      if (type === "text") value.valueText = raw.slice(0, 20_000);
      else if (type === "number") {
        const number = parsedNumber(raw);
        if (number === null) {
          issues.unparseableNumbers += 1;
          continue;
        }
        value.valueNumber = number;
      } else if (type === "checkbox") {
        const checked = booleanValue(raw);
        if (checked === null) continue;
        value.valueCheckbox = checked;
      } else if (type === "date") {
        const parsed = parseCsvDate(raw, dateOrderByColumn.get(field.index) ?? "dmy");
        if (!parsed) {
          issues.unparseableDates += 1;
          continue;
        }
        value.valueDate = toLocalDate(parsed, timezone);
      } else if (type === "url") {
        const url = validUrl(raw);
        if (!url) {
          issues.invalidUrls += 1;
          continue;
        }
        value.valueUrl = url;
      } else {
        value.valueOptionIds = [`option:${field.index}:${key(raw)}`];
      }
      cardCustomFieldValues.push(value);
    }
  }

  const lists = Array.from(listByKey.values()).map((list, index) => ({
    id: list.id, workspaceId: ctx.workspaceId, name: list.name, icon: "list", color: null,
    position: positionAtIndex(index), archivedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
  }));
  const labels = Array.from(labelByKey.values()).map((label, index) => ({
    id: label.id, workspaceId: ctx.workspaceId, name: label.name, color: label.color,
    position: positionAtIndex(index), archivedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
  }));
  const customFields = customFieldEntries.map((field, index) => {
    const type = effectiveFieldType.get(field.index)!;
    const optionValues = optionValuesByField.get(field.index);
    return {
      id: `field:${field.index}`, workspaceId: ctx.workspaceId, name: field.name, icon: "forms", type,
      allowMultiple: false, position: positionAtIndex(index), showOnCard: true, archivedAt: null,
      createdAt: ctx.now, updatedAt: ctx.now,
      options: type === "select" && optionValues ? Array.from(optionValues.entries()).map(([normalized, label], optionIndex) => ({
        id: `option:${field.index}:${encodeURIComponent(normalized)}`, fieldId: `field:${field.index}`, label,
        color: null, position: positionAtIndex(optionIndex), archivedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
      })) : [],
    };
  });
  const members = Array.from(memberByKey.values()).map((member) => ({
    workspaceId: ctx.workspaceId, userId: member.id, role: null, displayName: member.displayName,
    ...(member.email ? { email: member.email } : {}), avatarUrl: null, source: "workspace" as const,
    boardRole: null, addedAt: ctx.now,
  }));
  const archive = {
    format: "kanera.board.export", version: 1, exportedAt: ctx.now.toISOString(),
    board: {
      id: "board:csv", workspaceId: ctx.workspaceId, groupId: null, standaloneGroupId: null,
      name: boardName(ctx.fileName), description: null, icon: null, iconColor: null, backgroundGradient: null,
      position: "0", archivedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
    },
    lists, labels, customFields, members, cards, cardAssignees, cardLabelAssignments,
    cardCustomFieldValues, checklists, comments, commentReactions: [], cardWatchers: [], attachments: [],
  } as unknown as BoardExportArchive;

  const manifest: CsvImportManifest = {
    source: "csv",
    board: { name: boardName(ctx.fileName), desc: null },
    lists: Array.from(listByKey.values()).map((list) => ({ id: list.id, name: list.name, closed: false, cardCount: list.count })),
    labels: Array.from(labelByKey.values()).map((label) => ({ id: label.id, name: label.name, trelloColor: null, suggestedToken: label.color })),
    customFields: customFields.map((field) => ({
      id: field.id, name: field.name, trelloType: "csv", suggestedType: field.type,
      ...(field.options.length ? { options: field.options.map((option) => ({ id: option.id, label: option.label, color: null })) } : {}),
    })),
    members: Array.from(memberByKey.values()).map((member) => ({ id: member.id, fullName: member.displayName, username: null, email: member.email ?? null })),
    counts: {
      cards: cards.length, checklists: checklists.length, comments: comments.length,
      linkAttachments: 0, uploadedAttachments: 0, rows: dataRows.length, skippedRows,
    },
  };
  return { manifest, archive, issues };
}

function zEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
