import { DUE_DATE_SLOT_TIMES, type CardDueDateSlot } from "@kanera/shared/due-date-slots";

export interface DueDateCandidate {
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

function localParts(now: Date, timezone: string): { date: string; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(now);
  }

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const rawHour = Number(value("hour"));
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(value("minute")),
  };
}

export function isDueDateOverdue(candidate: DueDateCandidate, now = new Date()): boolean {
  const dueDate = candidate.dueDateLocalDate;
  if (!dueDate) return false;
  const local = localParts(now, candidate.dueDateTimezone || "UTC");
  if (local.date > dueDate) return true;
  if (local.date < dueDate) return false;
  const boundary = DUE_DATE_SLOT_TIMES[candidate.dueDateSlot ?? "anyTime"];
  return local.hour > boundary.hour || (local.hour === boundary.hour && local.minute >= boundary.minute);
}

/**
 * The YYYY-MM-DD wall-clock date an instant falls on in the given zone.
 *
 * `en-CA` is used because its short date format is already ISO-ordered. An unknown or malformed
 * zone falls back to UTC rather than throwing, matching `isDueDateOverdue` above — a bad stored
 * zone must degrade, not take down a read path.
 */
export function localDateInTimezone(date: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  }
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * Shifts a YYYY-MM-DD wall-clock date by whole days.
 *
 * Deliberately computed in UTC: the input is a calendar date, not an instant, so no zone or DST
 * offset must be applied. Doing this with a local-zone Date would shift the result by a day either
 * side of a DST boundary.
 */
export function addDays(localDate: string, days: number): string {
  const [yearString, monthString, dayString] = localDate.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

