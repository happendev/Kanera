import type { CsvColumnMapping, CsvColumnTarget, CsvCustomFieldType } from "@kanera/shared/dto";
import { inferDateOrder, parseCsvDate } from "./dates.js";
import { parsedNumber } from "./derive.js";

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

const TRUE_FALSE = new Set(["true", "false", "yes", "no", "y", "n", "1", "0", "on", "off", "done", "open", "completed", "incomplete"]);

export function inferCustomFieldType(cells: string[]): CsvCustomFieldType {
  const values = cells.map((cell) => cell.trim()).filter(Boolean);
  if (values.length === 0) return "text";
  if (values.every((value) => parsedNumber(value) !== null)) return "number";
  if (values.every((value) => TRUE_FALSE.has(value.toLocaleLowerCase()))) return "checkbox";
  // Infer the day/month order once; doing it inside every() made an all-date column quadratic.
  const dateOrder = inferDateOrder(values).order;
  if (values.every((value) => !!parseCsvDate(value, dateOrder))) return "date";
  if (values.every((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  })) return "url";
  const distinct = new Set(values.map((value) => value.toLocaleLowerCase())).size;
  if (distinct <= 30 && values.length >= distinct * 2) return "select";
  return "text";
}

export function suggestMultiValueDelimiter(cells: string[]): CsvColumnMapping["multiValueDelimiter"] {
  const candidates: Array<{ delimiter: CsvColumnMapping["multiValueDelimiter"]; token: string }> = [
    { delimiter: "newline", token: "\n" },
    { delimiter: ";", token: ";" },
    { delimiter: "|", token: "|" },
    { delimiter: ",", token: "," },
  ];
  let best = candidates[candidates.length - 1]!;
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = cells.reduce((total, cell) => total + (cell.includes(candidate.token) ? 1 : 0), 0);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best.delimiter;
}

function targetForHeader(header: string, values: string[], repeatedCardIds: boolean): CsvColumnTarget | null {
  const name = normalizeHeader(header);
  if (["title", "name", "summary", "subject"].includes(name)) return { target: "title" };
  if (["description", "desc", "notes", "details"].includes(name)) return { target: "description" };
  if (["list", "status", "column", "stage", "state"].includes(name)) return { target: "list" };
  if (/^(labels?|tags?|categories|components)$/.test(name)) return { target: "labels" };
  if (/^(assignees?|owners?|members?)$/.test(name)) return { target: "assignees" };
  if (name === "due" || name.includes("due date") || name.includes("deadline")) return { target: "dueDate" };
  if (/^(done|completed|resolved)$/.test(name) || name.includes("completed at")) return { target: "completed" };
  if (/^(archived|closed)$/.test(name) || name.includes("archived at")) return { target: "archived" };
  if (name === "created" || name.includes("created at") || name.includes("created date")) return { target: "createdAt" };
  if (/^comments?$/.test(name)) return { target: "comment" };
  if (/^(checklist|checklist items?|sub ?tasks?)$/.test(name)) return { target: "checklistItem" };
  // `Parent` is deliberately excluded: sub-tasks share a parent key, so grouping on it would merge
  // sibling tasks into one card.
  if (repeatedCardIds && /^(id|key|issue key|card id)$/.test(name)) return { target: "cardId" };
  if (values.every((value) => !value.trim())) return { target: "ignore" };
  return null;
}

export function suggestColumnMapping(rows: string[][], hasHeaderRow: boolean): CsvColumnMapping {
  const columnCount = rows[0]?.length ?? 0;
  const dataRows = hasHeaderRow ? rows.slice(1) : rows;
  const headers = hasHeaderRow ? rows[0]! : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const allCells = dataRows.flat();
  const columns: Record<string, CsvColumnTarget> = {};
  let usedTitle = false;
  const pendingTitleIndexes: number[] = [];

  for (let index = 0; index < columnCount; index += 1) {
    const values = dataRows.map((row) => row[index] ?? "");
    const nonBlank = values.map((value) => value.trim()).filter(Boolean);
    const repeated = nonBlank.length > new Set(nonBlank.map((value) => value.toLocaleLowerCase())).size;
    let target = hasHeaderRow ? targetForHeader(headers[index] ?? "", values, repeated) : null;
    if (target?.target === "title") {
      if (usedTitle) target = null;
      else usedTitle = true;
    }
    if (!target) {
      if (values.every((value) => !value.trim())) target = { target: "ignore" };
      else {
        target = { target: "customField", name: (headers[index] ?? `Column ${index + 1}`).trim().slice(0, 35) || `Column ${index + 1}`, type: inferCustomFieldType(values) };
        pendingTitleIndexes.push(index);
      }
    }
    columns[String(index)] = target;
  }

  if (!usedTitle && columnCount > 0) {
    const index = pendingTitleIndexes[0] ?? 0;
    columns[String(index)] = { target: "title" };
  }
  return {
    hasHeaderRow,
    multiValueDelimiter: suggestMultiValueDelimiter(allCells),
    dateOrder: "auto",
    timezone: "UTC",
    columns,
  };
}
