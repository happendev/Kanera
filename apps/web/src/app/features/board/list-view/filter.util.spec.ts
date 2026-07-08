import { describe, expect, it } from "vitest";
import { hasActiveFilter, matchesCfConditions } from "./filter.util";
import type { CfFilterCondition, FilterValue } from "./filter.types";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
import type { AnyCustomField } from "./list-view.types";

const FIELD_ID = "field-1";

function customField(type: AnyCustomField["type"]): AnyCustomField {
  return {
    id: FIELD_ID,
    workspaceId: "w1",
    name: "Field",
    icon: "forms",
    type,
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyCustomField;
}

function fieldsById(type: AnyCustomField["type"]): Map<string, AnyCustomField> {
  return new Map([[FIELD_ID, customField(type)]]);
}

function fieldValue(value: Partial<CardCustomFieldValue>): CardCustomFieldValue {
  return {
    cardId: "c1",
    fieldId: FIELD_ID,
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

function valuesFor(value: CardCustomFieldValue | null): Map<string, Map<string, CardCustomFieldValue>> {
  const map = new Map<string, Map<string, CardCustomFieldValue>>();
  if (value) map.set("c1", new Map([[FIELD_ID, value]]));
  return map;
}

/** Evaluate a single condition against one stored value for a field of `type`. */
function match(
  type: AnyCustomField["type"],
  condition: Omit<CfFilterCondition, "fieldId">,
  value: Partial<CardCustomFieldValue> | null,
): boolean {
  return matchesCfConditions(
    "c1",
    [{ fieldId: FIELD_ID, ...condition }],
    fieldsById(type),
    valuesFor(value ? fieldValue(value) : null),
  );
}

describe("matchesCfConditions", () => {
  it("returns true when there are no conditions", () => {
    expect(matchesCfConditions("c1", [], fieldsById("text"), valuesFor(null))).toBe(true);
  });

  it("ignores conditions whose field no longer exists", () => {
    const condition: CfFilterCondition = { fieldId: "missing", op: "equals", value: "x" };
    expect(matchesCfConditions("c1", [condition], fieldsById("text"), valuesFor(null))).toBe(true);
  });

  it("ANDs multiple conditions", () => {
    const fields = new Map<string, AnyCustomField>([
      ["a", { ...customField("text"), id: "a" } as AnyCustomField],
      ["b", { ...customField("number"), id: "b" } as AnyCustomField],
    ]);
    const values = new Map([["c1", new Map([
      ["a", fieldValue({ fieldId: "a", valueText: "hi" })],
      ["b", fieldValue({ fieldId: "b", valueNumber: "5" })],
    ])]]);
    const pass: CfFilterCondition[] = [
      { fieldId: "a", op: "contains", value: "hi" },
      { fieldId: "b", op: "gt", value: "3" },
    ];
    const fail: CfFilterCondition[] = [
      { fieldId: "a", op: "contains", value: "hi" },
      { fieldId: "b", op: "gt", value: "10" },
    ];
    expect(matchesCfConditions("c1", pass, fields, values)).toBe(true);
    expect(matchesCfConditions("c1", fail, fields, values)).toBe(false);
  });

  describe("text / url", () => {
    for (const type of ["text", "url"] as const) {
      const column = type === "text" ? "valueText" : "valueUrl";
      it(`${type} contains (case-insensitive)`, () => {
        expect(match(type, { op: "contains", value: "BRU" }, { [column]: "february bruary" })).toBe(true);
        expect(match(type, { op: "contains", value: "xyz" }, { [column]: "february" })).toBe(false);
      });
      it(`${type} equals (case-insensitive, trimmed)`, () => {
        expect(match(type, { op: "equals", value: "february 2026" }, { [column]: " February 2026 " })).toBe(true);
        expect(match(type, { op: "equals", value: "march" }, { [column]: "february" })).toBe(false);
      });
      it(`${type} empty operand is inactive`, () => {
        expect(match(type, { op: "contains", value: "" }, { [column]: "anything" })).toBe(true);
      });
      it(`${type} isEmpty / isNotEmpty`, () => {
        expect(match(type, { op: "isEmpty" }, null)).toBe(true);
        expect(match(type, { op: "isEmpty" }, { [column]: "" })).toBe(true);
        expect(match(type, { op: "isNotEmpty" }, { [column]: "x" })).toBe(true);
        expect(match(type, { op: "isNotEmpty" }, null)).toBe(false);
      });
    }
  });

  describe("number", () => {
    it("comparison operators", () => {
      expect(match("number", { op: "eq", value: "10" }, { valueNumber: "10" })).toBe(true);
      expect(match("number", { op: "neq", value: "10" }, { valueNumber: "11" })).toBe(true);
      expect(match("number", { op: "gt", value: "10" }, { valueNumber: "11" })).toBe(true);
      expect(match("number", { op: "gt", value: "10" }, { valueNumber: "10" })).toBe(false);
      expect(match("number", { op: "gte", value: "10" }, { valueNumber: "10" })).toBe(true);
      expect(match("number", { op: "lt", value: "10" }, { valueNumber: "9" })).toBe(true);
      expect(match("number", { op: "lte", value: "10" }, { valueNumber: "10" })).toBe(true);
    });
    it("compares numerically, not lexically", () => {
      expect(match("number", { op: "gt", value: "9" }, { valueNumber: "10" })).toBe(true);
    });
    it("missing value fails a comparison but empty operand is inactive", () => {
      expect(match("number", { op: "gt", value: "5" }, null)).toBe(false);
      expect(match("number", { op: "gt", value: "" }, { valueNumber: "1" })).toBe(true);
    });
    it("isEmpty / isNotEmpty", () => {
      expect(match("number", { op: "isEmpty" }, null)).toBe(true);
      expect(match("number", { op: "isNotEmpty" }, { valueNumber: "0" })).toBe(true);
    });
  });

  describe("date", () => {
    it("on / before / after (lexical ISO)", () => {
      expect(match("date", { op: "on", value: "2026-02-01" }, { valueDate: "2026-02-01" })).toBe(true);
      expect(match("date", { op: "before", value: "2026-02-01" }, { valueDate: "2026-01-15" })).toBe(true);
      expect(match("date", { op: "after", value: "2026-02-01" }, { valueDate: "2026-03-15" })).toBe(true);
      expect(match("date", { op: "before", value: "2026-02-01" }, { valueDate: "2026-02-01" })).toBe(false);
    });
    it("between is inclusive", () => {
      expect(match("date", { op: "between", value: "2026-02-01", value2: "2026-02-28" }, { valueDate: "2026-02-01" })).toBe(true);
      expect(match("date", { op: "between", value: "2026-02-01", value2: "2026-02-28" }, { valueDate: "2026-02-28" })).toBe(true);
      expect(match("date", { op: "between", value: "2026-02-01", value2: "2026-02-28" }, { valueDate: "2026-03-01" })).toBe(false);
    });
    it("missing value fails but empty operand is inactive", () => {
      expect(match("date", { op: "on", value: "2026-02-01" }, null)).toBe(false);
      expect(match("date", { op: "on", value: "" }, { valueDate: "2026-02-01" })).toBe(true);
    });
    it("isEmpty / isNotEmpty", () => {
      expect(match("date", { op: "isEmpty" }, null)).toBe(true);
      expect(match("date", { op: "isNotEmpty" }, { valueDate: "2026-02-01" })).toBe(true);
    });
  });

  describe("checkbox", () => {
    it("checked matches only explicit true", () => {
      expect(match("checkbox", { op: "checked" }, { valueCheckbox: true })).toBe(true);
      expect(match("checkbox", { op: "checked" }, { valueCheckbox: false })).toBe(false);
      expect(match("checkbox", { op: "checked" }, null)).toBe(false);
    });
    it("unchecked matches false or missing", () => {
      expect(match("checkbox", { op: "unchecked" }, { valueCheckbox: false })).toBe(true);
      expect(match("checkbox", { op: "unchecked" }, null)).toBe(true);
      expect(match("checkbox", { op: "unchecked" }, { valueCheckbox: true })).toBe(false);
    });
  });

  describe("hasActiveFilter", () => {
    const empty: FilterValue = {
      labelIds: [],
      memberIds: [],
      listIds: [],
      boardIds: [],
      cfConditions: [],
      showUnreadOnly: false,
      showOverdueOnly: false,
    };
    it("is false when nothing is set", () => {
      expect(hasActiveFilter(empty)).toBe(false);
    });
    it("is true when any dimension is set", () => {
      expect(hasActiveFilter({ ...empty, labelIds: ["l1"] })).toBe(true);
      expect(hasActiveFilter({ ...empty, memberIds: ["m1"] })).toBe(true);
      expect(hasActiveFilter({ ...empty, listIds: ["li1"] })).toBe(true);
      expect(hasActiveFilter({ ...empty, boardIds: ["b1"] })).toBe(true);
      expect(hasActiveFilter({ ...empty, cfConditions: [{ fieldId: "f", op: "isEmpty" }] })).toBe(true);
      expect(hasActiveFilter({ ...empty, showUnreadOnly: true })).toBe(true);
      expect(hasActiveFilter({ ...empty, showOverdueOnly: true })).toBe(true);
    });
  });

  describe("select / user", () => {
    for (const type of ["select", "user"] as const) {
      const column = type === "select" ? "valueOptionIds" : "valueUserIds";
      it(`${type} isAnyOf intersects`, () => {
        expect(match(type, { op: "isAnyOf", ids: ["a", "b"] }, { [column]: ["b", "c"] })).toBe(true);
        expect(match(type, { op: "isAnyOf", ids: ["a"] }, { [column]: ["b", "c"] })).toBe(false);
      });
      it(`${type} isNoneOf excludes`, () => {
        expect(match(type, { op: "isNoneOf", ids: ["a"] }, { [column]: ["b", "c"] })).toBe(true);
        expect(match(type, { op: "isNoneOf", ids: ["b"] }, { [column]: ["b", "c"] })).toBe(false);
      });
      it(`${type} empty selection is inactive`, () => {
        expect(match(type, { op: "isAnyOf", ids: [] }, { [column]: ["b"] })).toBe(true);
      });
      it(`${type} isEmpty / isNotEmpty`, () => {
        expect(match(type, { op: "isEmpty" }, null)).toBe(true);
        expect(match(type, { op: "isEmpty" }, { [column]: [] })).toBe(true);
        expect(match(type, { op: "isNotEmpty" }, { [column]: ["a"] })).toBe(true);
      });
    }
  });
});
