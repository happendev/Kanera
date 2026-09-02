import assert from "node:assert/strict";
import { test } from "node:test";
import { inferCustomFieldType, suggestColumnMapping } from "./suggest.js";

void test("suggestColumnMapping maps Jira-like headers by index", () => {
  const mapping = suggestColumnMapping([
    ["Issue key", "Summary", "Status", "Labels", "Labels", "Assignee", "Due date", "Story points", "Sub-tasks", "Parent"],
    ["A-1", "Ship", "Doing", "api", "urgent", "ada@example.com", "31/01/2025", "3", "[x] Review", "E-1"],
    ["A-1", "Ship", "Doing", "web", "", "ada@example.com", "31/01/2025", "5", "[ ] Deploy", "E-1"],
  ], true);
  // `Parent` is repeated but must not become the Card ID group: that would merge sibling sub-tasks.
  assert.deepEqual(Object.values(mapping.columns).map((entry) => entry.target), ["cardId", "title", "list", "labels", "labels", "assignees", "dueDate", "customField", "checklistItem", "customField"]);
  assert.equal(mapping.columns["7"]?.target === "customField" && mapping.columns["7"].type, "number");
});

void test("inferCustomFieldType recognizes checkbox, URL, date, and select data", () => {
  assert.equal(inferCustomFieldType(["yes", "no"]), "checkbox");
  assert.equal(inferCustomFieldType(["https://example.com", "http://example.org"]), "url");
  assert.equal(inferCustomFieldType(["2025-01-01", "2025-02-01"]), "date");
  assert.equal(inferCustomFieldType(["A", "A", "B", "B"]), "select");
});
