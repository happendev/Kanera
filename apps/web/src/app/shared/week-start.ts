import { weekdayLabels } from "./date-format";

/**
 * Every calendar grid in the app starts its week on Monday: Kanera is a work tool, so the working
 * week reads as one unbroken block and the weekend sits together at the end instead of being split
 * across both edges of the row.
 *
 * Keep the labels and the index in step — a grid that pads by one rule and labels by the other puts
 * every date under the wrong weekday.
 */
// Short weekday names in the viewer's language, Monday first. The locale is fixed for the page load
// (a language change reloads), so computing once at module load is safe.
export const WEEKDAY_LABELS: readonly string[] = weekdayLabels();

/** 0 for Monday … 6 for Sunday, i.e. how many cells a date sits from the start of its week. */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** Midnight on the Monday of this date's week. */
export function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - weekdayIndex(date));
  return start;
}
