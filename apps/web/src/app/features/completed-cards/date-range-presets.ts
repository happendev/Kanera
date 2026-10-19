import { addDays, localDateKey } from "../../shared/day-key.util";
import { startOfWeek } from "../../shared/week-start";

/** Named calendar-period presets offered by the date range picker beside the "Last N days" shortcuts. */
export type DateRangePreset = "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth" | "lastQuarter";

export interface DateRangeKeys {
  /** Inclusive local YYYY-MM-DD start. */
  from: string;
  /** Inclusive local YYYY-MM-DD end. */
  to: string;
}

/**
 * Resolves a preset against `today` (local time) to inclusive day keys.
 *
 * "This …" periods end today rather than at the period's last day: the picker filters completed
 * work, which can't exist in the future, and the summary should read as the range actually covered.
 * "Last …" periods are the whole previous calendar period. Weeks start where every calendar grid in
 * the app starts them (`startOfWeek`), so a week preset always lines up with one row of the grid.
 */
export function resolveDateRangePreset(preset: DateRangePreset, today: Date): DateRangeKeys {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  switch (preset) {
    case "thisWeek":
      return keys(startOfWeek(day), day);
    case "lastWeek": {
      const start = addDays(startOfWeek(day), -7);
      return keys(start, addDays(start, 6));
    }
    case "thisMonth":
      return keys(new Date(day.getFullYear(), day.getMonth(), 1), day);
    case "lastMonth":
      // Day 0 of the current month is the last day of the previous one; Date handles the January
      // rollover into December of the prior year.
      return keys(new Date(day.getFullYear(), day.getMonth() - 1, 1), new Date(day.getFullYear(), day.getMonth(), 0));
    case "lastQuarter": {
      // The previous calendar quarter (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec), not the trailing 3 months.
      const quarterStartMonth = Math.floor(day.getMonth() / 3) * 3;
      return keys(
        new Date(day.getFullYear(), quarterStartMonth - 3, 1),
        new Date(day.getFullYear(), quarterStartMonth, 0),
      );
    }
  }
}

/** The last `days` days, inclusive of today. */
export function resolveLastDays(days: number, today: Date): DateRangeKeys {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return keys(addDays(day, -(days - 1)), day);
}

function keys(from: Date, to: Date): DateRangeKeys {
  return { from: localDateKey(from), to: localDateKey(to) };
}
