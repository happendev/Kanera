import { describe, expect, it } from "vitest";
import { resolveDateRangePreset, resolveLastDays } from "./date-range-presets";

/** Local date at an awkward time of day, to prove the time component never leaks into the keys. */
function at(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 23, 30);
}

describe("resolveDateRangePreset", () => {
  it("starts this week on the app's week start (Monday) and ends today", () => {
    // Wed 15 Oct 2025.
    expect(resolveDateRangePreset("thisWeek", at(2025, 10, 15))).toEqual({ from: "2025-10-13", to: "2025-10-15" });
  });

  it("treats Sunday as the last day of the week, not the first", () => {
    // Sun 19 Oct 2025 belongs to the week of Mon 13 Oct.
    expect(resolveDateRangePreset("thisWeek", at(2025, 10, 19))).toEqual({ from: "2025-10-13", to: "2025-10-19" });
    expect(resolveDateRangePreset("lastWeek", at(2025, 10, 19))).toEqual({ from: "2025-10-06", to: "2025-10-12" });
  });

  it("is a single day on Monday", () => {
    expect(resolveDateRangePreset("thisWeek", at(2025, 10, 13))).toEqual({ from: "2025-10-13", to: "2025-10-13" });
    expect(resolveDateRangePreset("lastWeek", at(2025, 10, 13))).toEqual({ from: "2025-10-06", to: "2025-10-12" });
  });

  it("crosses the year boundary for weeks", () => {
    // Thu 1 Jan 2026: the week started Mon 29 Dec 2025.
    expect(resolveDateRangePreset("thisWeek", at(2026, 1, 1))).toEqual({ from: "2025-12-29", to: "2026-01-01" });
    expect(resolveDateRangePreset("lastWeek", at(2026, 1, 1))).toEqual({ from: "2025-12-22", to: "2025-12-28" });
  });

  it("resolves this month and last month, including February and the January rollover", () => {
    expect(resolveDateRangePreset("thisMonth", at(2024, 3, 10))).toEqual({ from: "2024-03-01", to: "2024-03-10" });
    expect(resolveDateRangePreset("lastMonth", at(2024, 3, 31))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(resolveDateRangePreset("lastMonth", at(2026, 1, 15))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("uses the previous calendar quarter", () => {
    expect(resolveDateRangePreset("lastQuarter", at(2025, 10, 1))).toEqual({ from: "2025-07-01", to: "2025-09-30" });
    expect(resolveDateRangePreset("lastQuarter", at(2025, 6, 30))).toEqual({ from: "2025-01-01", to: "2025-03-31" });
    expect(resolveDateRangePreset("lastQuarter", at(2025, 12, 31))).toEqual({ from: "2025-07-01", to: "2025-09-30" });
  });

  it("rolls the quarter back into the previous year from Q1", () => {
    expect(resolveDateRangePreset("lastQuarter", at(2026, 1, 1))).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(resolveDateRangePreset("lastQuarter", at(2026, 3, 31))).toEqual({ from: "2025-10-01", to: "2025-12-31" });
  });
});

describe("resolveLastDays", () => {
  it("includes today and crosses the year boundary", () => {
    expect(resolveLastDays(7, at(2026, 1, 3))).toEqual({ from: "2025-12-28", to: "2026-01-03" });
    expect(resolveLastDays(1, at(2026, 1, 3))).toEqual({ from: "2026-01-03", to: "2026-01-03" });
  });
});
