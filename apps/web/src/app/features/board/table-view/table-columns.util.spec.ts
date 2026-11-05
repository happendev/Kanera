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
  distributeColumnSlack,
  gridTemplateFrom,
  lendSpareWidthToFirst,
  measuredColumnContentWidth,
  measuredColumnContentWidths,
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

  describe("distributeColumnSlack", () => {
    const base: Record<string, number> = { title: 180, priority: 90, status: 140, due: 130 };
    const ids = ["title", "priority", "status", "due"];
    const baseFor = (id: string) => base[id]!;
    const total = ids.reduce((sum, id) => sum + base[id]!, 0);
    const targets: Record<string, number> = { title: 260, priority: 100, status: 220, due: 180 };
    const targetFor = (id: string) => targets[id]!;

    it("leaves widths untouched when the sheet is already wider than its scrollport", () => {
      expect(distributeColumnSlack({ ids, available: total - 200, baseFor, targetFor })).toEqual(base);
      expect(distributeColumnSlack({ ids, available: total, baseFor, targetFor })).toEqual(base);
    });

    it("fits Title before spending slack on following columns", () => {
      const widths = distributeColumnSlack({ ids, available: total + 100, baseFor, targetFor });
      expect(widths).toEqual({ ...base, title: 260, priority: 100, status: 150 });
    });

    it("uses measured targets rather than column-specific growth caps", () => {
      const arbitraryTargets: Record<string, number> = { ...targets, title: 347, due: 413 };
      const widths = distributeColumnSlack({
        ids,
        available: total + 1_000,
        baseFor,
        targetFor: (id) => arbitraryTargets[id]!,
      });
      expect(widths).toEqual(arbitraryTargets);
    });

    it("leaves surplus space to the filler once every rendered value fits", () => {
      const widths = distributeColumnSlack({ ids, available: total + 5_000, baseFor, targetFor });
      expect(widths).toEqual(targets);
      const spent = ids.reduce((sum, id) => sum + widths[id]!, 0);
      expect(spent).toBeLessThan(total + 5_000);
    });

    it("skips a hand-sized column so a drag is not quietly undone, and passes its slack on", () => {
      // Title stays at its chosen width while each following column grows only until its value fits.
      const widths = distributeColumnSlack({
        ids,
        available: total + 300,
        baseFor,
        targetFor,
        isPinned: (id) => id === "title",
      });
      expect(widths).toEqual({ title: 180, priority: 100, status: 220, due: 180 });
    });
  });

  describe("lendSpareWidthToFirst", () => {
    const ids = ["title", "assignees", "due", "labels"];
    const widths = { title: 400, assignees: 150, due: 120, labels: 250 };
    const floors: Record<string, number> = { assignees: 130, due: 90, labels: 230 };
    const floorFor = (id: string) => floors[id]!;
    const targetFor = (id: string) => (id === "title" ? 600 : widths[id as keyof typeof widths]);

    it("moves only what the visible columns are not using, keeping the sheet's total width", () => {
      const next = lendSpareWidthToFirst({ ids, widths, available: 2_000, targetFor, floorFor });
      expect(next).toEqual({ title: 470, assignees: 130, due: 90, labels: 230 });
    });

    it("never borrows from a column that starts beyond the visible sheet", () => {
      // labels starts at 670, so a 660px viewport must not shift assignees or due out of view for it.
      const next = lendSpareWidthToFirst({ ids, widths, available: 660, targetFor, floorFor });
      expect(next).toEqual({ title: 450, assignees: 130, due: 90, labels: 250 });
    });

    it("leaves a hand-sized Title and hand-sized donors alone", () => {
      expect(lendSpareWidthToFirst({ ids, widths, available: 2_000, targetFor, floorFor, isPinned: (id) => id === "title" }))
        .toEqual(widths);
      expect(lendSpareWidthToFirst({ ids, widths, available: 2_000, targetFor, floorFor, isPinned: (id) => id === "assignees" }))
        .toEqual({ title: 450, assignees: 150, due: 90, labels: 230 });
    });
  });

  it("counts negative margins once, so a trigger bleeding over its cell's padding is not measured twice", () => {
    const cell = document.createElement("div");
    cell.style.display = "flex";
    cell.style.padding = "0 10px";
    const trigger = document.createElement("button");
    trigger.style.display = "flex";
    trigger.style.margin = "0 -10px";
    trigger.style.padding = "0 10px";
    const value = document.createElement("span");
    Object.defineProperty(value, "scrollWidth", { configurable: true, value: 80 });
    trigger.append(value);
    cell.append(trigger);

    expect(measuredColumnContentWidth(cell)).toBe(100);
  });

  it("measures direct text alongside child elements without feeding back the assigned cell width", () => {
    const cell = document.createElement("div");
    cell.style.display = "flex";
    cell.style.paddingLeft = "28px";
    cell.style.paddingRight = "10px";
    const trigger = document.createElement("button");
    trigger.style.display = "flex";
    trigger.style.paddingRight = "10px";
    const title = document.createElement("span");
    title.style.display = "block";
    const key = document.createElement("span");
    title.append(key, "A title much wider than its card key");
    trigger.append(title);
    cell.append(trigger);

    Object.defineProperty(cell, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(trigger, "scrollWidth", { configurable: true, value: 180 });
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 310 });
    Object.defineProperty(key, "scrollWidth", { configurable: true, value: 45 });

    // 310px intrinsic title + 10px trigger padding + 38px title-cell gutter/padding. The root's
    // assigned 500px width must not win, or double-click could resize wider but never shrink.
    expect(measuredColumnContentWidth(cell)).toBe(358);
  });

  it("measures all requested columns in one pass and keeps the widest rendered cell", () => {
    const root = document.createElement("div");
    for (const [id, width] of [["title", 210], ["cf:team", 180], ["title", 330], ["ignored", 900]] as const) {
      const cell = document.createElement("div");
      cell.dataset["col"] = id;
      const value = document.createElement("span");
      Object.defineProperty(value, "scrollWidth", { configurable: true, value: width });
      cell.append(value);
      root.append(cell);
    }

    expect(measuredColumnContentWidths(root, ["title", "cf:team"]))
      .toEqual({ title: 330, "cf:team": 180 });
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
