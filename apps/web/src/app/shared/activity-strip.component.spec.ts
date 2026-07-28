import { describe, expect, it } from "vitest";
import { buildActivityStripCells, type ActivityStripSeries } from "./activity-strip.component";
import { addDays, localDateKey } from "./day-key.util";

function series(counts: Record<string, number>, noun = "move"): ActivityStripSeries {
  return {
    key: "moved",
    label: "Card movement",
    noun,
    tone: "accent",
    counts: new Map(Object.entries(counts)),
  };
}

describe("buildActivityStripCells", () => {
  const today = new Date();
  const yesterday = addDays(today, -1);
  const todayKey = localDateKey(today);
  const yesterdayKey = localDateKey(yesterday);

  it("lays out one column per day, oldest first, ending on the end date", () => {
    const cells = buildActivityStripCells(series({ [todayKey]: 8, [yesterdayKey]: 2 }), 60, today);

    expect(cells).toHaveLength(60);
    // Today is the final column; the window runs forward to it.
    expect(cells.at(-1)!.date).toBe(todayKey);
    expect(cells.at(-2)!.date).toBe(yesterdayKey);
    expect(cells[0]!.date).toBe(localDateKey(addDays(today, -59)));
  });

  it("scales levels to the busiest day in the window", () => {
    const cells = buildActivityStripCells(series({ [todayKey]: 8, [yesterdayKey]: 2 }), 60, today);
    const cellFor = (key: string) => cells.find((cell) => cell.date === key)!;

    // The peak day saturates; a quarter-height day lands on the lowest visible step.
    expect(cellFor(todayKey).level).toBe(4);
    expect(cellFor(yesterdayKey).level).toBe(1);
  });

  it("renders unreported days as empty columns rather than omitting them", () => {
    const cells = buildActivityStripCells(series({ [todayKey]: 3 }), 14, today);

    expect(cells).toHaveLength(14);
    expect(cells[0]!.count).toBe(0);
    // Zero is never tinted, however high the window's peak is.
    expect(cells[0]!.level).toBe(0);
  });

  it("pluralises the tooltip noun and names the day", () => {
    const cells = buildActivityStripCells(
      series({ [todayKey]: 1, [yesterdayKey]: 2 }, "completion"),
      7,
      today,
    );
    const cellFor = (key: string) => cells.find((cell) => cell.date === key)!;

    expect(cellFor(todayKey).label.startsWith("1 completion ·")).toBe(true);
    expect(cellFor(yesterdayKey).label.startsWith("2 completions ·")).toBe(true);
  });

  it("flags Mondays as week starts", () => {
    const cells = buildActivityStripCells(series({}), 14, today);

    for (const cell of cells) {
      // Parsed at noon so a DST shift cannot move the weekday.
      expect(cell.weekStart).toBe(new Date(`${cell.date}T12:00:00`).getDay() === 1);
    }
  });

  it("keeps every series on identical day columns so metrics stack", () => {
    const moved = buildActivityStripCells(series({ [todayKey]: 8 }), 30, today);
    const completed = buildActivityStripCells(
      { ...series({ [yesterdayKey]: 4 }), key: "completed", tone: "success" },
      30,
      today,
    );

    expect(completed.map((cell) => cell.date)).toEqual(moved.map((cell) => cell.date));
  });
});
