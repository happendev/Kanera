import { describe, expect, it } from "vitest";
import { BUILTIN_COLUMN_IDS } from "./table-view.types";
import {
  ROW_INTERACTION_STOP_SELECTOR,
  applySavedColumnOrder,
  builtinColumnIcon,
  builtinColumnLabel,
  clampWidth,
  columnWidthsEqual,
  cssEscape,
  gridTemplateFrom,
} from "./table-columns.util";

describe("table column helpers", () => {
  it("applies a saved order, drops unknown ids, and appends new columns", () => {
    expect(applySavedColumnOrder(["status", "due", "cf:new"], ["due", "missing", "status"]))
      .toEqual(["due", "status", "cf:new"]);
  });

  it("clamps and rounds widths against caller-owned bounds", () => {
    expect(clampWidth(39.6, { min: 80, max: 300 })).toBe(80);
    expect(clampWidth(120.6, { min: 80, max: 300 })).toBe(121);
    expect(clampWidth(900, { min: 80, max: 300 })).toBe(300);
  });

  it("compares width maps by both keys and values", () => {
    expect(columnWidthsEqual({ title: 240 }, { title: 240 })).toBe(true);
    expect(columnWidthsEqual({ title: 240 }, { title: 241 })).toBe(false);
    expect(columnWidthsEqual({ title: 240 }, { title: 240, due: 120 })).toBe(false);
  });

  it("builds the grid in column order and appends trailing widths", () => {
    expect(gridTemplateFrom(["title", "cf:one"], (id) => id === "title" ? 220 : 140, [38]))
      .toBe("220px 140px 38px");
  });

  it("escapes selector-sensitive custom-field ids", () => {
    const escaped = cssEscape('cf:a"b\\c');
    expect(escaped).toContain('\\"');
    expect(escaped).toContain("\\\\");
  });

  it("gives every built-in column a real label and icon", () => {
    for (const id of BUILTIN_COLUMN_IDS) {
      expect(builtinColumnLabel(id)).not.toBe(id);
      expect(builtinColumnIcon(id)).not.toBe("minus");
    }
  });

  it("keeps the shared interaction selector valid", () => {
    expect(() => document.querySelector(ROW_INTERACTION_STOP_SELECTOR)).not.toThrow();
    expect(ROW_INTERACTION_STOP_SELECTOR).toContain(".mp-panel");
  });
});
