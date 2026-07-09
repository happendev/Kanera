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
      aggregateSplitBy: "none",
      aggregateSplitLabel: "No breakdown",
      cardLabels: [],
      currentUserId: null,
      cardLinkBaseUrl: "https://kanera.example",
    });

    expect(payload.metadata.columns.map((column) => column.label)).toEqual(["Due date", "Priority"]);
    expect(payload.groups.map((group) => group.label)).toEqual(["Todo", "Done"]);
    expect(payload.groups[0]!.cards.map((row) => row["Title"])).toEqual(["Alpha", "Beta"]);
    expect(payload.groups[0]!.cards[0]).toMatchObject({
      Group: "Todo",
      Title: "Alpha",
      "Due date": "2026-06-01",
      Priority: "High",
      "Card detail link": "https://kanera.example/b/b1?cardId=a",
    });
    // Aggregates live in the tidy summary, not on the grouped Cards rows.
    expect(payload.summary).toEqual([
      { group: "Todo", split: null, field: "Hours", metric: "sum", total: null, value: 6 },
      { group: "Todo", split: null, field: "Hours", metric: "avg", total: null, value: 3 },
    ]);
    expect(payload.overallSummary).toEqual([
      { group: "Overall", split: null, field: "Hours", metric: "sum", total: null, value: 6 },
      { group: "Overall", split: null, field: "Hours", metric: "avg", total: null, value: 3 },
    ]);
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
      aggregateSplitBy: "none",
      aggregateSplitLabel: "No breakdown",
      cardLabels: [],
      currentUserId: null,
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
      aggregateSplitBy: "none",
      aggregateSplitLabel: "No breakdown",
      cardLabels: [],
      currentUserId: null,
    });

    const workbookRows = buildWorkbookRows(payload);

    // The Cards sheet carries no aggregate columns — those move to the tidy Summary sheet.
    expect(workbookRows.headers).toEqual(["Group", "Title", "Assignees", "Card detail link"]);
    expect(workbookRows.rows).toEqual([
      { Group: "Alice", Title: "1 card" },
      { Group: "Alice", Title: "Alpha", Assignees: "Alice", "Card detail link": "/b/b1?cardId=a" },
    ]);
    expect(payload.summary).toEqual([{ group: "Alice", split: null, field: "Hours", metric: "sum", total: null, value: 2 }]);
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
      aggregateSplitBy: "none",
      aggregateSplitLabel: "No breakdown",
      cardLabels: [],
      currentUserId: null,
    });

    const workbook = buildWorkbookExport(payload);
    const cards = workbook.sheets.find((sheet) => sheet.name === "Cards")!;
    const summary = workbook.sheets.find((sheet) => sheet.name === "Summary")!;

    // Cards sheet holds only card data (no aggregate columns); Summary carries the numbers.
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Cards", "Summary", "Report"]);
    expect(cards.rows.slice(0, 6)).toEqual([
      ["Kanera export: Roadmap"],
      [expect.stringContaining("Exported"), "Grouped by List", "Sorted by Manual"],
      [],
      ["Group", "Title", "List", "Card detail link"],
      ["Todo", "1 card"],
      ["Todo", "Alpha", "Todo", "/b/b1?cardId=a"],
    ]);
    expect(cards.autoFilterRange).toBe("A4:D6");
    expect(cards.columnWidths.length).toBe(4);
    expect(cards.boldRows).toEqual([0, 1, 3, 4]);

    // Summary sheet: tidy rows with a numeric Value, AutoFilter over the table.
    expect(summary.rows).toEqual([
      ["Kanera summary: Roadmap"],
      ["Grouped by List", "No breakdown"],
      [],
      ["List", "Field", "Metric", "Value"],
      ["Todo", "Hours", "sum", 2],
      ["Overall", "Hours", "sum", 2],
    ]);
    expect(summary.autoFilterRange).toBe("A4:D6");
    const report = workbook.sheets.find((sheet) => sheet.name === "Report")!;
    expect(report.rows.slice(-2)).toEqual([
      ["Overall totals", "1 card"],
      [
        "Overall",
        "Total",
        {
          type: "Formula",
          value: "SUMIFS('Summary'!$D:$D,'Summary'!$A:$A,$A10,'Summary'!$B:$B,\"Hours\",'Summary'!$C:$C,\"sum\")",
        },
      ],
    ]);
  });

  it("emits split aggregates as tidy summary rows", () => {
    const option = (fieldId: string, id: string, labelText: string, position: string) => ({
      id, fieldId, label: labelText, color: null, position, archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const clientField = {
      ...customField("client", "Client", "select"),
      options: [option("client", "opt-liquid", "Liquid", "1000"), option("client", "opt-herotel", "Herotel", "2000")],
    } as unknown as AnyCustomField;
    const devTypeField = {
      ...customField("devType", "Dev Type", "select", "2000"),
      options: [option("devType", "opt-custom", "Custom", "1000"), option("devType", "opt-internal", "Internal", "2000")],
    } as unknown as AnyCustomField;
    const hours = customField("hours", "Hours", "number", "3000");
    const customFields = [clientField, devTypeField, hours];

    const cards = [card({ id: "a", title: "A" }), card({ id: "b", title: "B" }), card({ id: "c", title: "C" }), card({ id: "d", title: "D" })];
    const values = valuesByCard([
      fieldValue("a", "client", { valueOptionIds: ["opt-liquid"] }),
      fieldValue("a", "devType", { valueOptionIds: ["opt-custom"] }),
      fieldValue("a", "hours", { valueNumber: "4" }),
      fieldValue("b", "client", { valueOptionIds: ["opt-liquid"] }),
      fieldValue("b", "devType", { valueOptionIds: ["opt-custom"] }),
      fieldValue("b", "hours", { valueNumber: "20" }),
      fieldValue("c", "client", { valueOptionIds: ["opt-liquid"] }),
      fieldValue("c", "devType", { valueOptionIds: ["opt-internal"] }),
      fieldValue("c", "hours", { valueNumber: "6" }),
      fieldValue("d", "client", { valueOptionIds: ["opt-herotel"] }),
      fieldValue("d", "devType", { valueOptionIds: ["opt-internal"] }),
      fieldValue("d", "hours", { valueNumber: "8" }),
    ]);
    const groupCtx = {
      lists: [], labels: [], members: [],
      labelsByCard: new Map<string, AnyLabel[]>(), assigneesByCard: new Map<string, AnyMember[]>(),
      customFields, customFieldValuesByCardAndField: values, currentUserId: null,
    };
    const groups = groupCards(cards, "cf:client", "position", groupCtx);

    const payload = buildBoardExportPayload({
      board: { id: "b1", name: "Billing" },
      exportedAt: "2026-05-27T12:00:00.000Z",
      groupBy: "Client",
      sortBy: "Manual",
      columns: [{ id: "cf:devType", label: "Dev Type" }, { id: "cf:hours", label: "Hours" }],
      aggregateConfig: { hours: ["sum", "avg"] },
      aggregateSplitBy: "cf:devType",
      aggregateSplitLabel: "Dev Type",
      groups,
      lists: [],
      cardLabels: [],
      labelsByCard: new Map(),
      assigneesByCard: new Map(),
      customFields,
      members: [],
      customFieldValuesByCardAndField: values,
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      boardSummariesById: null,
      currentUserId: null,
    });

    // Tidy/long summary: one numeric row per group × split bucket (no double-counting total row).
    expect(payload.summary).toEqual([
      { group: "Liquid", split: "Custom", field: "Hours", metric: "sum", total: 30, value: 24 },
      { group: "Liquid", split: "Internal", field: "Hours", metric: "sum", total: 30, value: 6 },
      { group: "Liquid", split: "Custom", field: "Hours", metric: "avg", total: 10, value: 12 },
      { group: "Liquid", split: "Internal", field: "Hours", metric: "avg", total: 10, value: 6 },
      { group: "Herotel", split: "Internal", field: "Hours", metric: "sum", total: 8, value: 8 },
      { group: "Herotel", split: "Internal", field: "Hours", metric: "avg", total: 8, value: 8 },
    ]);

    // Summary sheet uses the group/split dimension labels as headers and keeps values numeric.
    const workbook = buildWorkbookExport(payload);
    const summary = workbook.sheets.find((sheet) => sheet.name === "Summary")!;
    const layout = workbook.sheets.find((sheet) => sheet.name === "Report")!;
    expect(summary.rows).toEqual([
      ["Kanera summary: Billing"],
      ["Grouped by Client", "Break down by Dev Type"],
      [],
      ["Client", "Dev Type", "Field", "Metric", "Value", "Total"],
      ["Liquid", "Custom", "Hours", "sum", 24, 30],
      ["Liquid", "Internal", "Hours", "sum", 6, 30],
      ["Liquid", "Custom", "Hours", "avg", 12, 10],
      ["Liquid", "Internal", "Hours", "avg", 6, 10],
      ["Herotel", "Internal", "Hours", "sum", 8, 8],
      ["Herotel", "Internal", "Hours", "avg", 8, 8],
      ["Overall", "Custom", "Hours", "sum", 24, 38],
      ["Overall", "Internal", "Hours", "sum", 14, 38],
      ["Overall", "Custom", "Hours", "avg", 12, 9.5],
      ["Overall", "Internal", "Hours", "avg", 7, 9.5],
    ]);
    expect(summary.autoFilterRange).toBe("A4:F14");
    expect(layout.rows[3]).toEqual(["Client", "Title", "Dev Type", "Hours", "Hours avg"]);
    expect(layout.rows[4]).toEqual(["Liquid", "A", "Custom", 4, 4]);
    expect(layout.rows[5]).toEqual(["Liquid", "B", "Custom", 20, 20]);
    expect(layout.rows[6]).toEqual(["Liquid", "C", "Internal", 6, 6]);
    expect(layout.rows[7]).toEqual([
      "Liquid",
      "Summary",
      "Custom",
      {
        type: "Formula",
        value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A8,'Summary'!$B:$B,$C8,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"sum\")",
      },
      {
        type: "Formula",
        value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A8,'Summary'!$B:$B,$C8,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"avg\")",
      },
    ]);
    expect(layout.rows[8]).toEqual([
      "Liquid",
      "Summary",
      "Internal",
      {
        type: "Formula",
        value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A9,'Summary'!$B:$B,$C9,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"sum\")",
      },
      {
        type: "Formula",
        value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A9,'Summary'!$B:$B,$C9,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"avg\")",
      },
    ]);
    expect(layout.rows[9]).toEqual([
      "Liquid",
      "Total",
      "",
      {
        type: "Formula",
        value: "MAXIFS('Summary'!$F:$F,'Summary'!$A:$A,\"Liquid\",'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"sum\")",
      },
      {
        type: "Formula",
        value: "MAXIFS('Summary'!$F:$F,'Summary'!$A:$A,\"Liquid\",'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"avg\")",
      },
    ]);
    expect(payload.overallSummary).toEqual([
      { group: "Overall", split: "Custom", field: "Hours", metric: "sum", total: 38, value: 24 },
      { group: "Overall", split: "Internal", field: "Hours", metric: "sum", total: 38, value: 14 },
      { group: "Overall", split: "Custom", field: "Hours", metric: "avg", total: 9.5, value: 12 },
      { group: "Overall", split: "Internal", field: "Hours", metric: "avg", total: 9.5, value: 7 },
    ]);
    expect(layout.rows.slice(-4)).toEqual([
      ["Overall totals", "4 cards"],
      [
        "Overall",
        "Summary",
        "Custom",
        {
          type: "Formula",
          value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A17,'Summary'!$B:$B,$C17,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"sum\")",
        },
        {
          type: "Formula",
          value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A17,'Summary'!$B:$B,$C17,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"avg\")",
        },
      ],
      [
        "Overall",
        "Summary",
        "Internal",
        {
          type: "Formula",
          value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A18,'Summary'!$B:$B,$C18,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"sum\")",
        },
        {
          type: "Formula",
          value: "SUMIFS('Summary'!$E:$E,'Summary'!$A:$A,$A18,'Summary'!$B:$B,$C18,'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"avg\")",
        },
      ],
      [
        "Overall",
        "Total",
        "",
        {
          type: "Formula",
          value: "MAXIFS('Summary'!$F:$F,'Summary'!$A:$A,\"Overall\",'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"sum\")",
        },
        {
          type: "Formula",
          value: "MAXIFS('Summary'!$F:$F,'Summary'!$A:$A,\"Overall\",'Summary'!$C:$C,\"Hours\",'Summary'!$D:$D,\"avg\")",
        },
      ],
    ]);
  });

  it("summarises split by the built-in label dimension", () => {
    const bug = label("bug", "Bug");
    const urgent = label("urgent", "Urgent", "2000");
    const hours = customField("hours", "Hours", "number");
    const cards = [card({ id: "a", title: "A" }), card({ id: "b", title: "B" }), card({ id: "c", title: "C" })];
    const labelsByCard = new Map([["a", [bug]], ["b", [urgent]]]);
    const values = valuesByCard([
      fieldValue("a", "hours", { valueNumber: "5" }),
      fieldValue("b", "hours", { valueNumber: "3" }),
      fieldValue("c", "hours", { valueNumber: "2" }),
    ]);
    const groups = groupCards(cards, "none", "position", {
      lists: [], labels: [bug, urgent], members: [],
      labelsByCard, assigneesByCard: new Map(),
      customFields: [hours], customFieldValuesByCardAndField: values, currentUserId: null,
    });

    const payload = buildBoardExportPayload({
      board: { id: "b1", name: "Billing" },
      exportedAt: "2026-05-27T12:00:00.000Z",
      groupBy: "No grouping",
      sortBy: "Manual",
      columns: [],
      aggregateConfig: { hours: ["sum"] },
      aggregateSplitBy: "label",
      aggregateSplitLabel: "Label",
      groups,
      lists: [],
      cardLabels: [bug, urgent],
      labelsByCard,
      assigneesByCard: new Map(),
      customFields: [hours],
      members: [],
      customFieldValuesByCardAndField: values,
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      boardSummariesById: null,
      currentUserId: null,
    });

    expect(payload.summary).toEqual([
      { group: "All cards", split: "Bug", field: "Hours", metric: "sum", total: 10, value: 5 },
      { group: "All cards", split: "Urgent", field: "Hours", metric: "sum", total: 10, value: 3 },
      { group: "All cards", split: "No label", field: "Hours", metric: "sum", total: 10, value: 2 },
    ]);
  });

  it("sanitizes filenames", () => {
    expect(sanitizeExportFileName(' Roadmap: Q2 / "Launch" ')).toBe("Roadmap- Q2 - -Launch-");
    expect(sanitizeExportFileName("   ")).toBe("board");
  });
});
