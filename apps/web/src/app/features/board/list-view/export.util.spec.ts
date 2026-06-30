import type { CardCustomFieldValue } from "@kanera/shared/schema";
import { describe, expect, it } from "vitest";
import { groupCards } from "./group-by.util";
import { buildBoardExportPayload, buildWorkbookExport, buildWorkbookRows, sanitizeExportFileName } from "./export.util";
import type { AnyCard, AnyCustomField, AnyLabel, AnyList, AnyMember } from "./list-view.types";

function card(overrides: Partial<AnyCard>): AnyCard {
  return {
    id: overrides.id ?? "c1",
    listId: overrides.listId ?? "l1",
    boardId: overrides.boardId ?? "b1",
    title: overrides.title ?? "Untitled",
    position: overrides.position ?? "1000.0000000000",
    dueDateLocalDate: overrides.dueDateLocalDate ?? null,
    dueDateSlot: overrides.dueDateSlot ?? null,
    dueDateTimezone: overrides.dueDateTimezone ?? null,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    coverAttachmentId: overrides.coverAttachmentId ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-02T00:00:00Z"),
    description: (overrides as { description?: string | null }).description ?? null,
    createdById: (overrides as { createdById?: string }).createdById ?? "u1",
  } as unknown as AnyCard;
}

function list(id: string, name: string, position = "1000.0000000000"): AnyList {
  return {
    id,
    workspaceId: "w1",
    name,
    icon: null,
    color: null,
    position,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyList;
}

function label(id: string, name: string, position = "1000.0000000000"): AnyLabel {
  return {
    id,
    workspaceId: "w1",
    name,
    color: null,
    icon: null,
    position,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyLabel;
}

function member(userId: string, displayName: string): AnyMember {
  return { userId, displayName, avatarUrl: null, role: "editor", source: "workspace" };
}

function customField(id: string, name: string, type: AnyCustomField["type"], position = "1000.0000000000"): AnyCustomField {
  return {
    id,
    workspaceId: "w1",
    name,
    icon: "forms",
    type,
    position,
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyCustomField;
}

function fieldValue(cardId: string, fieldId: string, value: Partial<CardCustomFieldValue>): CardCustomFieldValue {
  return {
    cardId,
    fieldId,
    valueText: null,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date(),
    ...value,
  };
}

function valuesByCard(values: CardCustomFieldValue[]): Map<string, Map<string, CardCustomFieldValue>> {
  const map = new Map<string, Map<string, CardCustomFieldValue>>();
  for (const value of values) {
    let byField = map.get(value.cardId);
    if (!byField) {
      byField = new Map();
      map.set(value.cardId, byField);
    }
    byField.set(value.fieldId, value);
  }
  return map;
}

describe("board list export", () => {
  it("serializes grouped, sorted, filtered cards with visible columns and aggregates", () => {
    const lists = [list("todo", "Todo"), list("done", "Done", "2000")];
    const cards = [
      card({ id: "b", title: "Beta", listId: "todo", position: "2000", dueDateLocalDate: "2026-06-02" }),
      card({ id: "a", title: "Alpha", listId: "todo", position: "1000", dueDateLocalDate: "2026-06-01" }),
      card({ id: "hidden", title: "Hidden", listId: "done", position: "1000" }),
    ];
    const hours = customField("hours", "Hours", "number");
    const priority = customField("priority", "Priority", "text", "2000");
    const values = valuesByCard([
      fieldValue("a", "hours", { valueNumber: "2" }),
      fieldValue("b", "hours", { valueNumber: "4" }),
      fieldValue("a", "priority", { valueText: "High" }),
      fieldValue("b", "priority", { valueText: "Low" }),
    ]);
    const visibleCards = cards.filter((item) => item.id !== "hidden");
    const groups = groupCards(visibleCards, "list", "title-asc", {
      lists,
      labels: [],
      members: [],
      labelsByCard: new Map(),
      assigneesByCard: new Map(),
      customFields: [hours, priority],
      customFieldValuesByCardAndField: values,
      currentUserId: null,
    });

    const payload = buildBoardExportPayload({
      board: { id: "b1", name: "Roadmap" },
      exportedAt: "2026-05-27T12:00:00.000Z",
      groupBy: "List",
      sortBy: "Title A to Z",
      columns: [{ id: "due", label: "Due date" }, { id: "cf:priority", label: "Priority" }],
      aggregateConfig: { hours: ["sum", "avg"] },
      groups,
      lists,
      labelsByCard: new Map(),
      assigneesByCard: new Map(),
      customFields: [hours, priority],
      members: [],
      customFieldValuesByCardAndField: values,
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      boardSummariesById: null,
    });

    expect(payload.metadata.columns.map((column) => column.label)).toEqual(["Due date", "Priority"]);
    expect(payload.groups.map((group) => group.label)).toEqual(["Todo", "Done"]);
    expect(payload.groups[0]!.cards.map((row) => row["Title"])).toEqual(["Alpha", "Beta"]);
    expect(payload.groups[0]!.cards[0]).toMatchObject({ Group: "Todo", Title: "Alpha", "Due date": "2026-06-01", Priority: "High" });
    expect(payload.groups[0]!.aggregates).toEqual({ "Hours sum": 6, "Hours avg": 3 });
    expect(payload.groups[1]!.cards).toEqual([]);
  });

  it("keeps repeated cards for multi-group label exports", () => {
    const bug = label("bug", "Bug");
    const urgent = label("urgent", "Urgent", "2000");
    const cards = [card({ id: "a", title: "Fix login" })];
    const labelsByCard = new Map([["a", [bug, urgent]]]);
    const groups = groupCards(cards, "label", "position", {
      lists: [list("l1", "Todo")],
      labels: [bug, urgent],
      members: [],
      labelsByCard,
      assigneesByCard: new Map(),
      currentUserId: null,
    });

    const payload = buildBoardExportPayload({
      board: { id: "b1", name: "Roadmap" },
      exportedAt: "2026-05-27T12:00:00.000Z",
      groupBy: "Label",
      sortBy: "Manual",
      columns: [{ id: "labels", label: "Labels" }],
      aggregateConfig: {},
      groups,
      lists: [list("l1", "Todo")],
      labelsByCard,
      assigneesByCard: new Map(),
      customFields: [],
      members: [],
      customFieldValuesByCardAndField: new Map(),
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      boardSummariesById: null,
    });

    expect(payload.groups.map((group) => group.cards.map((row) => row["Title"]))).toEqual([["Fix login"], ["Fix login"]]);
    expect(payload.groups[0]!.cards[0]!["Labels"]).toBe("Bug, Urgent");
  });

  it("builds workbook rows with group header rows", () => {
    const hours = customField("hours", "Hours", "number");
    const values = valuesByCard([fieldValue("a", "hours", { valueNumber: "2" })]);
    const payload = buildBoardExportPayload({
      board: { id: "b1", name: "Roadmap" },
      exportedAt: "2026-05-27T12:00:00.000Z",
      groupBy: "Assignee",
      sortBy: "Manual",
      columns: [{ id: "assignees", label: "Assignees" }],
      aggregateConfig: { hours: ["sum"] },
      groups: groupCards([card({ id: "a", title: "Alpha" })], "assignee", "position", {
        lists: [],
        labels: [],
        members: [member("u1", "Alice")],
        labelsByCard: new Map(),
        assigneesByCard: new Map([["a", [member("u1", "Alice")]]]),
        customFields: [hours],
        customFieldValuesByCardAndField: values,
        currentUserId: null,
      }),
      lists: [],
      labelsByCard: new Map(),
      assigneesByCard: new Map([["a", [member("u1", "Alice")]]]),
      customFields: [hours],
      members: [],
      customFieldValuesByCardAndField: values,
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      boardSummariesById: null,
    });

    const workbookRows = buildWorkbookRows(payload);

    expect(workbookRows.headers).toEqual(["Group", "Title", "Assignees", "Hours sum"]);
    expect(workbookRows.rows).toEqual([
      { Group: "Alice", Title: "1 card", "Hours sum": 2 },
      { Group: "Alice", Title: "Alpha", Assignees: "Alice" },
    ]);
  });

  it("builds a formatted workbook with a cards sheet", () => {
    const hours = customField("hours", "Hours", "number");
    const values = valuesByCard([fieldValue("a", "hours", { valueNumber: "2" })]);
    const payload = buildBoardExportPayload({
      board: { id: "b1", name: "Roadmap" },
      exportedAt: "2026-05-27T12:00:00.000Z",
      groupBy: "List",
      sortBy: "Manual",
      columns: [{ id: "status", label: "List" }],
      aggregateConfig: { hours: ["sum"] },
      groups: groupCards([card({ id: "a", title: "Alpha" })], "list", "position", {
        lists: [list("l1", "Todo")],
        labels: [],
        members: [],
        labelsByCard: new Map(),
        assigneesByCard: new Map(),
        customFields: [hours],
        customFieldValuesByCardAndField: values,
        currentUserId: null,
      }),
      lists: [list("l1", "Todo")],
      labelsByCard: new Map(),
      assigneesByCard: new Map(),
      customFields: [hours],
      members: [],
      customFieldValuesByCardAndField: values,
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      boardSummariesById: null,
    });

    const workbook = buildWorkbookExport(payload);
    const cards = workbook.sheets.find((sheet) => sheet.name === "Cards")!;

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Cards"]);
    expect(cards.rows.slice(0, 6)).toEqual([
      ["Kanera export: Roadmap"],
      [expect.stringContaining("Exported"), "Grouped by List", "Sorted by Manual"],
      [],
      ["Group", "Title", "List", "Hours sum"],
      ["Todo", "1 card", "Hours sum: 2"],
      ["Todo", "Alpha", "Todo", null],
    ]);
    expect(cards.autoFilterRange).toBe("A4:D6");
    expect(cards.columnWidths.length).toBe(4);
    expect(cards.boldRows).toEqual([0, 1, 3, 4]);
  });

  it("sanitizes filenames", () => {
    expect(sanitizeExportFileName(' Roadmap: Q2 / "Launch" ')).toBe("Roadmap- Q2 - -Launch-");
    expect(sanitizeExportFileName("   ")).toBe("board");
  });
});
