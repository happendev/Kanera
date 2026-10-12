import { wallClockPartsOrUtc } from "./date-time-formatter.js";

export function localDateParts(date: Date, timezone: string): { date: string; hour: number } {
  const { date: localDate, hour } = wallClockPartsOrUtc(date, timezone);
  return { date: localDate, hour };
}
