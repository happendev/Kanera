import assert from "node:assert/strict";
import { test } from "node:test";
import type { CsvColumnMapping } from "@kanera/shared/dto";
import { deriveCsvImport, parsedNumber } from "./derive.js";
import type { CsvSource } from "./parse.js";

const source: CsvSource = {
  rows: [
    ["ID", "Title", "List", "Labels", "Labels", "Comment", "Checklist", "Owner", "Score"],
    ["A-1", "Ship", "Doing", "api;urgent", "backend", "First", "[x] Review", "ada@example.com", "1,200"],
    ["A-1", "Ship", "Doing", "web", "urgent", "Second", "[ ] Deploy", "ada@example.com", ""],
    ["A-2", "", "", "", "", "", "", "", "nope"],
  ],
  delimiter: ",",
  encoding: "utf-8",
  raggedRows: 0,
  columnCount: 9,
};
const mapping: CsvColumnMapping = {
  hasHeaderRow: true,
  multiValueDelimiter: ";",
  dateOrder: "auto",
  timezone: "Not/AZone",
  columns: {
    "0": { target: "cardId" }, "1": { target: "title" }, "2": { target: "list" },
    "3": { target: "labels" }, "4": { target: "labels" }, "5": { target: "comment" },
    "6": { target: "checklistItem" }, "7": { target: "assignees" },
    "8": { target: "customField", name: "Score", type: "number" },
  },
};

void test("deriveCsvImport deterministically groups and accumulates CSV rows", () => {
  const context = { actorId: "actor", workspaceId: "workspace", fileName: "jira.csv", now: new Date("2026-01-01T00:00:00Z") };
  const first = deriveCsvImport(source, mapping, context);
  const second = deriveCsvImport(source, mapping, context);
  assert.deepEqual(first, second);
  assert.equal(first.archive.cards.length, 1);
  assert.equal(first.archive.cardLabelAssignments.length, 4);
  assert.equal(first.archive.comments.length, 2);
  assert.equal(first.archive.checklists[0]?.items.length, 2);
  assert.equal(first.archive.checklists[0]?.items[0]?.text, "Review");
  assert.ok(first.archive.checklists[0]?.items[0]?.completedAt);
  assert.equal(first.archive.members[0]?.email, "ada@example.com");
  assert.equal(first.archive.cards[0]?.dueDateTimezone, null);
  assert.equal(first.archive.cardCustomFieldValues[0]?.valueNumber, "1200");
  assert.equal(first.issues.rowsWithoutTitle, 1);
  assert.equal(first.manifest.counts.skippedRows, 1);
});

void test("deriveCsvImport creates the fallback list only when it is used", () => {
  const noList = { ...mapping, columns: { ...mapping.columns, "2": { target: "ignore" as const } } };
  const result = deriveCsvImport(source, noList, { actorId: "actor", workspaceId: "workspace", fileName: "cards.csv", now: new Date("2026-01-01T00:00:00Z") });
  assert.deepEqual(result.manifest.lists.map((list) => list.id), ["list:__default"]);
});

void test("deriveCsvImport supports headerless rows and falls back to UTC", () => {
  const headerlessSource: CsvSource = {
    rows: [["Card", "2025-01-31", "A"], ["Second", "2025-02-01", "A"]],
    delimiter: ",", encoding: "utf-8", raggedRows: 0, columnCount: 3,
  };
  const headerlessMapping: CsvColumnMapping = {
    hasHeaderRow: false,
    multiValueDelimiter: ",",
    dateOrder: "auto",
    timezone: "Invalid/Timezone",
    columns: {
      "0": { target: "title" }, "1": { target: "dueDate" },
      "2": { target: "customField", name: "Choice", type: "select" },
    },
  };
  const result = deriveCsvImport(headerlessSource, headerlessMapping, { actorId: "actor", workspaceId: "workspace", fileName: "data.csv", now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(result.archive.cards.length, 2);
  assert.equal(result.archive.cards[0]?.dueDateTimezone, "UTC");
  assert.equal(result.archive.customFields[0]?.options.length, 1);
  assert.deepEqual(result.archive.cardCustomFieldValues.map((value) => value.valueOptionIds), [["option:2:a"], ["option:2:a"]]);
});

void test("parsedNumber resolves locale separators and rejects non-decimal syntax", () => {
  assert.equal(parsedNumber("1,200"), "1200");
  assert.equal(parsedNumber("1,5"), "1.5");
  assert.equal(parsedNumber("1.200,50"), "1200.50");
  assert.equal(parsedNumber("1,200.50"), "1200.50");
  assert.equal(parsedNumber("-3.5e2"), "-3.5e2");
  assert.equal(parsedNumber("0x10"), null);
  assert.equal(parsedNumber("abc"), null);
});
