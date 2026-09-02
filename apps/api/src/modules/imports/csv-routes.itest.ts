import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyzeCsvImportResponse, CsvColumnMapping, CsvColumnsResponse, ImportResultSummary } from "@kanera/shared/dto";
import { activityEvents, boards, cardAssignees, cardChecklistItems, cardChecklists, cardCustomFieldValues, cardLabelAssignments, cards, comments, customFields, eventOutbox, lists } from "@kanera/shared/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

function csvForm(value: string, fileName = "jira.csv") {
  const form = new FormData();
  form.append("file", new Blob([Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(value)])], { type: "text/csv" }), fileName);
  return form;
}

void test("CSV analyze, column mapping, and commit import the synthesized board archive", async () => {
  const app = await buildIntegrationServer();
  const { auth, user } = await signupOwner(app, { orgName: "CSV Imports", email: "csv-import@example.com", displayName: "Ada" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Migration" } });
  assert.equal(created.statusCode, 201);
  const workspaceId = created.json<{ id: string }>().id;
  const analyzedResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/imports/csv/analyze`,
    headers: auth,
    payload: csvForm("Title;List;Labels;Owner;Due;Score;Comment;Checklist\nShip;Doing;urgent|api;csv-import@example.com;31/01/2025;1,200;Looks good;[x] Review"),
  });
  assert.equal(analyzedResponse.statusCode, 201, analyzedResponse.body);
  const analyzed = analyzedResponse.json<AnalyzeCsvImportResponse>();
  assert.equal(analyzed.preview.delimiter, ";");
  assert.equal(analyzed.preview.encoding, "utf-8");
  assert.equal(analyzed.preview.suggestedMapping.columns["0"]?.target, "title");

  const premature = await app.inject({ method: "POST", url: `/imports/csv/${analyzed.importId}/commit`, headers: auth, payload: { board: { name: "CSV" }, lists: {}, labels: {}, customFields: {}, members: {}, options: {} } });
  assert.equal(premature.statusCode, 409);

  const invalid = await app.inject({
    method: "POST", url: `/imports/csv/${analyzed.importId}/columns`, headers: auth,
    payload: { ...analyzed.preview.suggestedMapping, columns: { "0": { target: "ignore" } } },
  });
  assert.equal(invalid.statusCode, 400);

  const mapping: CsvColumnMapping = {
    hasHeaderRow: true,
    multiValueDelimiter: "|",
    dateOrder: "dmy",
    timezone: "Europe/London",
    columns: {
      "0": { target: "title" }, "1": { target: "list" }, "2": { target: "labels" },
      "3": { target: "assignees" }, "4": { target: "dueDate" },
      "5": { target: "customField", name: "Score", type: "number" },
      "6": { target: "comment" }, "7": { target: "checklistItem" },
    },
  };
  const columnsResponse = await app.inject({ method: "POST", url: `/imports/csv/${analyzed.importId}/columns`, headers: auth, payload: mapping });
  assert.equal(columnsResponse.statusCode, 200, columnsResponse.body);
  const columns = columnsResponse.json<CsvColumnsResponse>();
  assert.equal(columns.manifest.lists[0]?.name, "Doing");
  assert.deepEqual(columns.manifest.labels.map((label) => label.name), ["urgent", "api"]);
  assert.equal(columns.manifest.members[0]?.email, "csv-import@example.com");

  const committedResponse = await app.inject({
    method: "POST",
    url: `/imports/csv/${analyzed.importId}/commit`,
    headers: auth,
    payload: {
      board: { name: "CSV launch" },
      lists: Object.fromEntries(columns.manifest.lists.map((list) => [list.id, { action: "create", name: list.name }])),
      labels: Object.fromEntries(columns.manifest.labels.map((label) => [label.id, { action: "create", name: label.name, color: label.suggestedToken }])),
      customFields: Object.fromEntries(columns.manifest.customFields.map((field) => [field.id, { action: "create", name: field.name, type: field.suggestedType }])),
      members: { [columns.manifest.members[0]!.id]: user.id },
      options: { includeArchived: true, importComments: true, importCustomFields: true, attachmentCopyMode: "skip" },
    },
  });
  assert.equal(committedResponse.statusCode, 200, committedResponse.body);
  const result = committedResponse.json<ImportResultSummary>();
  assert.equal(result.cards.created, 1);
  assert.equal(result.comments, 1);
  assert.equal(result.checklistItems, 1);

  const [card] = await db.select().from(cards).where(eq(cards.boardId, result.createdBoardId));
  assert.equal(card?.title, "Ship");
  assert.equal(card?.dueDateLocalDate, "2025-01-31");
  assert.equal(card?.dueDateSlot, "anyTime");
  assert.equal(card?.dueDateTimezone, "Europe/London");
  assert.equal(await db.$count(cardLabelAssignments, eq(cardLabelAssignments.cardId, card!.id)), 2);
  assert.equal(await db.$count(cardAssignees, eq(cardAssignees.cardId, card!.id)), 1);
  const [comment] = await db.select().from(comments).where(eq(comments.cardId, card!.id));
  assert.equal(comment?.body, "Looks good");
  const [checklist] = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, card!.id));
  const [item] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, checklist!.id));
  assert.equal(item?.text, "Review");
  assert.ok(item?.completedAt);
  const [field] = await db.select().from(customFields).where(and(eq(customFields.workspaceId, workspaceId), eq(customFields.name, "Score")));
  const [fieldValue] = await db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.fieldId, field!.id));
  assert.equal(fieldValue?.valueNumber, "1200");
  const importedActivities = await db.select().from(activityEvents).where(eq(activityEvents.boardId, result.createdBoardId));
  assert.ok(importedActivities.some((activity) => (activity.payload as { importedFrom?: string }).importedFrom === "csv"));
  const outbox = await db.select().from(eventOutbox).where(inArray(eventOutbox.scopeId, [workspaceId, result.createdBoardId])).orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
  assert.ok(outbox.findIndex((row) => row.eventType === "card:created") > outbox.findIndex((row) => row.eventType === "board:created"));
});

void test("CSV import appends to a standalone board without creating another board", async () => {
  const app = await buildIntegrationServer();
  const { auth } = await signupOwner(app, { orgName: "Standalone CSV", email: "standalone-csv@example.com", displayName: "Owner" });
  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { kind: "board", name: "Hidden configuration", initialBoard: { name: "Personal", icon: "layout-kanban", iconColor: "blue" }, lists: [{ name: "Todo" }, { name: "Done" }], customFields: [], labels: [] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const workspace = created.json<{ id: string; initialBoard: { id: string } }>();
  const [targetList] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id));
  const analyzedResponse = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/imports/csv/analyze`, headers: auth, payload: csvForm("Title,List\nAppend me,Todo", "append.csv") });
  const analyzed = analyzedResponse.json<AnalyzeCsvImportResponse>();
  const mapping: CsvColumnMapping = { ...analyzed.preview.suggestedMapping, timezone: "UTC" };
  const columnsResponse = await app.inject({ method: "POST", url: `/imports/csv/${analyzed.importId}/columns`, headers: auth, payload: mapping });
  assert.equal(columnsResponse.statusCode, 200, columnsResponse.body);
  const manifest = columnsResponse.json<CsvColumnsResponse>().manifest;
  const committed = await app.inject({
    method: "POST",
    url: `/imports/csv/${analyzed.importId}/commit`,
    headers: auth,
    payload: {
      board: { name: "Ignored" },
      lists: { [manifest.lists[0]!.id]: { action: "map", targetListId: targetList!.id } },
      labels: {}, customFields: {}, members: {},
      options: { includeArchived: true, importComments: true, importCustomFields: true, attachmentCopyMode: "skip" },
    },
  });
  assert.equal(committed.statusCode, 200, committed.body);
  assert.equal(committed.json<ImportResultSummary>().createdBoardId, workspace.initialBoard.id);
  assert.equal(await db.$count(boards, eq(boards.workspaceId, workspace.id)), 1);
  assert.equal(await db.$count(cards, eq(cards.boardId, workspace.initialBoard.id)), 1);
});
