import { addDays, localDateKey, parseDateKey } from "../day-key.util";
import { formatDate } from "../date-format";

export interface ProfileActivityCell {
  date: string;
  count: number;
  /** 0–4 like the activity strips; "future" marks the rest of the running week, which has no data yet. */
  level: 0 | 1 | 2 | 3 | 4 | "future";
  label: string;
}

export interface ProfileActivityGrid {
  /** One entry per week, Monday first; each holds exactly seven cells. */
  weeks: ProfileActivityCell[][];
  /** One label slot per week column; empty where no month starts. */
  months: string[];
  /** Days within the window with at least one completion. */
  activeDays: number;
}

/**
 * Monday-first week grid ending on the week that contains `today`.
 *
 * A popover is the one place in the product where the GitHub-style week grid is the right shape: it
 * is narrow, so 18 week columns fill its width edge to edge, whereas the day-per-column activity
 * strips need a page-wide panel. It plots completions, as Work done's "Completed" strip does, with
 * the same success tone and peak-relative levels, so the two read as one visual language.
 */
export function buildProfileActivityGrid(
  counts: ReadonlyMap<string, number>,
  today: string,
  weeks: number,
): ProfileActivityGrid {
  const end = parseDateKey(today);
  // getDay() puts Sunday at 0; shift so Monday is row 0.
  const weekday = (end.getDay() + 6) % 7;
  const start = addDays(end, -weekday - (weeks - 1) * 7);

  let peak = 0;
  for (const value of counts.values()) peak = Math.max(peak, value);

  const grid: ProfileActivityCell[][] = [];
  let activeDays = 0;
  for (let column = 0; column < weeks; column += 1) {
    const cells: ProfileActivityCell[] = [];
    for (let row = 0; row < 7; row += 1) {
      const day = addDays(start, column * 7 + row);
      const date = localDateKey(day);
      if (date > today) {
        cells.push({ date, count: 0, level: "future", label: "" });
        continue;
      }
      const count = counts.get(date) ?? 0;
      if (count > 0) activeDays += 1;
      cells.push({
        date,
        count,
        level: count === 0 ? 0 : (Math.min(4, Math.ceil((count / Math.max(peak, 1)) * 4)) as 1 | 2 | 3 | 4),
        label: `${count === 0 ? "No" : count} ${count === 1 ? "completion" : "completions"} · ${formatDate(day, "weekday")}`,
      });
    }
    grid.push(cells);
  }

  // A month is labelled on the first column whose Monday falls in it. A label needs about three
  // columns of room, so the window's opening partial month gives way to the next one when they would
  // overprint, and any later collision drops the later label.
  const starts = grid.flatMap((cells, column) =>
    column === 0 || cells[0]!.date.slice(0, 7) !== grid[column - 1]![0]!.date.slice(0, 7) ? [column] : []
  );
  if (starts.length > 1 && starts[1]! - starts[0]! < 3) starts.shift();
  const months = grid.map(() => "");
  let lastLabelColumn = -Infinity;
  for (const column of starts) {
    if (column - lastLabelColumn < 3) continue;
    months[column] = formatDate(grid[column]![0]!.date, "month");
    lastLabelColumn = column;
  }
  return { weeks: grid, months, activeDays };
}
