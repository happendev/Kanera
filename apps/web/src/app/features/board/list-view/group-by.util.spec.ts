import { describe, expect, it } from "vitest";
import { dueBucket, groupCards, sortGroupCards } from "./group-by.util";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
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
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
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

function customField(id: string, name: string, type: AnyCustomField["type"]): AnyCustomField {
  return {
    id,
    workspaceId: "w1",
    name,
    icon: "forms",
    type,
    position: "1000.0000000000",
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

const baseCtx = {
  lists: [],
  labels: [],
  members: [],
  labelsByCard: new Map<string, AnyLabel[]>(),
  assigneesByCard: new Map<string, AnyMember[]>(),
  currentUserId: null as string | null,
};

describe("groupCards", () => {
  it("groups by list using list order", () => {
    const cards = [
      card({ id: "a", listId: "l2", position: "1000" }),
      card({ id: "b", listId: "l1", position: "2000" }),
      card({ id: "c", listId: "l1", position: "1000" }),
    ];
    const groups = groupCards(cards, "list", "position", {
      ...baseCtx,
      lists: [list("l1", "Todo", "1000"), list("l2", "Done", "2000")],
    });
    expect(groups.map((group) => group.key)).toEqual(["list:l1", "list:l2"]);
    expect(groups[0]!.cards.map((c) => c.id)).toEqual(["c", "b"]);
    expect(groups[1]!.cards.map((c) => c.id)).toEqual(["a"]);
  });

  it("places unassigned cards into the Unassigned group when grouping by assignee", () => {
    const cards = [
      card({ id: "a" }),
      card({ id: "b" }),
    ];
    const groups = groupCards(cards, "assignee", "position", {
      ...baseCtx,
      members: [member("u1", "Alice")],
      assigneesByCard: new Map([["a", [member("u1", "Alice")]]]),
    });
    expect(groups.map((group) => group.label)).toEqual(["Alice", "Unassigned"]);
    expect(groups[0]!.cards.map((c) => c.id)).toEqual(["a"]);
    expect(groups[1]!.cards.map((c) => c.id)).toEqual(["b"]);
  });

  it("places the current user first when grouping by assignee", () => {
    const cards = [card({ id: "a" }), card({ id: "b" })];
    const groups = groupCards(cards, "assignee", "position", {
      ...baseCtx,
      members: [member("u1", "Alice"), member("me", "Me")],
      currentUserId: "me",
      assigneesByCard: new Map([
        ["a", [member("u1", "Alice")]],
        ["b", [member("me", "Me")]],
      ]),
    });
    expect(groups[0]!.label).toBe("Me");
  });

  it("emits a card in every label group it belongs to", () => {
    const cards = [card({ id: "a" })];
    const groups = groupCards(cards, "label", "position", {
      ...baseCtx,
      labels: [label("l1", "Bug"), label("l2", "Urgent", "2000")],
      labelsByCard: new Map([["a", [label("l1", "Bug"), label("l2", "Urgent", "2000")]]]),
    });
    expect(groups.map((group) => group.label)).toEqual(["Bug", "Urgent"]);
    for (const group of groups) {
      expect(group.cards.map((c) => c.id)).toEqual(["a"]);
    }
  });

  it("groups by due-date bucket using the configured 'now'", () => {
    const now = new Date("2026-05-28T12:00:00Z");
    const cards = [
      card({ id: "overdue", dueDateLocalDate: "2026-05-20" }),
      card({ id: "today", dueDateLocalDate: "2026-05-28" }),
      card({ id: "tomorrow", dueDateLocalDate: "2026-05-29" }),
      card({ id: "thisWeek", dueDateLocalDate: "2026-06-02" }),
      card({ id: "later", dueDateLocalDate: "2026-08-15" }),
      card({ id: "none" }),
    ];
    const groups = groupCards(cards, "dueDate", "position", { ...baseCtx, now });
    expect(groups.map((group) => group.key)).toEqual([
      "due:overdue",
      "due:today",
      "due:tomorrow",
      "due:thisWeek",
      "due:later",
      "due:noDate",
    ]);
  });

  it("groups by text custom field with empty values last", () => {
    const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" }), card({ id: "d" })];
    const priority = customField("field-1", "Priority", "text");
    const groups = groupCards(cards, "cf:field-1", "position", {
      ...baseCtx,
      customFields: [priority],
      customFieldValuesByCardAndField: valuesByCard([
        fieldValue("a", "field-1", { valueText: "High" }),
        fieldValue("b", "field-1", { valueText: " Low " }),
        fieldValue("c", "field-1", { valueText: " " }),
      ]),
    });

    expect(groups.map((group) => group.label)).toEqual(["High", "Low", "No Priority"]);
    expect(groups.map((group) => group.cards.map((c) => c.id))).toEqual([["a"], ["b"], ["c", "d"]]);
    expect(groups.every((group) => !group.acceptsDrop)).toBe(true);
  });

  it("groups by number custom field in numeric order", () => {
    const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
    const effort = customField("field-1", "Effort", "number");
    const groups = groupCards(cards, "cf:field-1", "position", {
      ...baseCtx,
      customFields: [effort],
      customFieldValuesByCardAndField: valuesByCard([
        fieldValue("a", "field-1", { valueNumber: "10" }),
        fieldValue("b", "field-1", { valueNumber: "2" }),
      ]),
    });

    expect(groups.map((group) => group.label)).toEqual(["2", "10", "No Effort"]);
    expect(groups.map((group) => group.cards.map((c) => c.id))).toEqual([["b"], ["a"], ["c"]]);
  });

  it("groups by checkbox custom field as yes, no, then empty", () => {
    const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
    const approved = customField("field-1", "Approved", "checkbox");
    const groups = groupCards(cards, "cf:field-1", "position", {
      ...baseCtx,
      customFields: [approved],
      customFieldValuesByCardAndField: valuesByCard([
        fieldValue("a", "field-1", { valueCheckbox: true }),
        fieldValue("b", "field-1", { valueCheckbox: false }),
      ]),
    });

    expect(groups.map((group) => group.label)).toEqual(["Yes", "No", "No Approved"]);
    expect(groups.map((group) => group.cards.map((c) => c.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("groups by select custom field in option order, repeating multi-value cards", () => {
    const field = {
      ...customField("field-1", "Status", "select"),
      allowMultiple: true,
      options: [
        { id: "opt-todo", fieldId: "field-1", label: "Todo", color: null, position: "1000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "opt-done", fieldId: "field-1", label: "Done", color: null, position: "2000", archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
      ],
    } as unknown as AnyCustomField;
    const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
    const groups = groupCards(cards, "cf:field-1", "position", {
      ...baseCtx,
      customFields: [field],
      customFieldValuesByCardAndField: valuesByCard([
        fieldValue("a", "field-1", { valueOptionIds: ["opt-todo", "opt-done"] }),
        fieldValue("b", "field-1", { valueOptionIds: ["opt-done"] }),
      ]),
    });

    expect(groups.map((group) => group.label)).toEqual(["Todo", "Done", "No Status"]);
    expect(groups.map((group) => group.cards.map((c) => c.id))).toEqual([["a"], ["a", "b"], ["c"]]);
  });

  it("groups by user custom field with empty values last", () => {
    const field = customField("field-1", "Reviewer", "user");
    const cards = [card({ id: "a" }), card({ id: "b" })];
    const groups = groupCards(cards, "cf:field-1", "position", {
      ...baseCtx,
      members: [member("u1", "Ada"), member("u2", "Bo")],
      customFields: [field],
      customFieldValuesByCardAndField: valuesByCard([
        fieldValue("a", "field-1", { valueUserIds: ["u2"] }),
      ]),
    });

    expect(groups.map((group) => group.label)).toEqual(["Bo", "No Reviewer"]);
    expect(groups.map((group) => group.cards.map((c) => c.id))).toEqual([["a"], ["b"]]);
  });

  it("groups by date custom field ascending with empty values last", () => {
    const field = customField("field-1", "Start", "date");
    const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
    const groups = groupCards(cards, "cf:field-1", "position", {
      ...baseCtx,
      customFields: [field],
      customFieldValuesByCardAndField: valuesByCard([
        fieldValue("a", "field-1", { valueDate: "2026-06-10" }),
        fieldValue("b", "field-1", { valueDate: "2026-06-01" }),
      ]),
    });

    expect(groups.map((group) => group.label)).toEqual(["2026-06-01", "2026-06-10", "No Start"]);
    expect(groups.map((group) => group.cards.map((c) => c.id))).toEqual([["b"], ["a"], ["c"]]);
  });

  it("falls back to no grouping when a custom field is missing", () => {
    const groups = groupCards([card({ id: "a" }), card({ id: "b" })], "cf:missing", "position", baseCtx);

    expect(groups.map((group) => group.label)).toEqual(["All cards"]);
    expect(groups[0]!.cards.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("sortGroupCards", () => {
  it("sorts by position ascending by default", () => {
    const cards = [
      card({ id: "a", position: "2000" }),
      card({ id: "b", position: "1000" }),
    ];
    const sorted = sortGroupCards(cards, "position");
    expect(sorted.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("places cards without a due date at the bottom regardless of direction", () => {
    const cards = [
      card({ id: "a" }),
      card({ id: "b", dueDateLocalDate: "2026-05-20" }),
      card({ id: "c", dueDateLocalDate: "2026-05-22" }),
    ];
    const asc = sortGroupCards(cards, "due-asc");
    expect(asc.map((c) => c.id)).toEqual(["b", "c", "a"]);
    const desc = sortGroupCards(cards, "due-desc");
    expect(desc.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by title alphabetically", () => {
    const cards = [
      card({ id: "a", title: "Banana" }),
      card({ id: "b", title: "Apple" }),
    ];
    expect(sortGroupCards(cards, "title-asc").map((c) => c.id)).toEqual(["b", "a"]);
    expect(sortGroupCards(cards, "title-desc").map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("dueBucket", () => {
  const now = new Date("2026-05-28T12:00:00Z");

  it("classifies past dates as overdue when not completed", () => {
    expect(dueBucket(card({ dueDateLocalDate: "2026-05-20" }), now)).toBe("overdue");
  });

  it("classifies past dates as later when the card is completed", () => {
    expect(dueBucket(card({ dueDateLocalDate: "2026-05-20", completedAt: new Date() }), now)).toBe("later");
  });

  it("classifies today and the rest of this week", () => {
    expect(dueBucket(card({ dueDateLocalDate: "2026-05-28" }), now)).toBe("today");
    expect(dueBucket(card({ dueDateLocalDate: "2026-05-29" }), now)).toBe("tomorrow");
    expect(dueBucket(card({ dueDateLocalDate: "2026-06-02" }), now)).toBe("thisWeek");
  });

  it("classifies missing due dates", () => {
    expect(dueBucket(card({}), now)).toBe("noDate");
  });
});
