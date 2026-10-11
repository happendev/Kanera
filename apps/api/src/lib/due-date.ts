import { DUE_DATE_SLOT_TIMES, type CardDueDateSlot } from "@kanera/shared/due-date-slots";

import { dateTimeFormatter } from "./date-time-formatter.js";

const dateFormatter = dateTimeFormatter({ year: "numeric", month: "2-digit", day: "2-digit" });
const minuteFormatter = dateTimeFormatter({
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23",
});

export interface DueDateCandidate {
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

/** Local calendar date and wall-clock time in `timezone`, falling back to UTC for unknown zones. */
export function localParts(now: Date, timezone: string): { date: string; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = minuteFormatter(timezone || "UTC").formatToParts(now);
  } catch {
    parts = minuteFormatter("UTC").formatToParts(now);
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
    parts = dateFormatter(timezone || "UTC").formatToParts(date);
  } catch {
    parts = dateFormatter("UTC").formatToParts(date);
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


export interface DueDatePatchInput {
  dueDateLocalDate?: string | null;
  dueDateSlot?: CardDueDateSlot | null;
}

export type DueDatePatch =
  | { kind: "unchanged" }
  | { kind: "rejected"; reason: string }
  | { kind: "write"; dueDateLocalDate: string | null; dueDateSlot: CardDueDateSlot | null; dueDateTimezone: string | null };

/**
 * Derive the due-date columns a partial PATCH should write.
 *
 * Shared by the card and checklist-item routes so their rules cannot drift:
 * - no due-date field present: nothing to write;
 * - a date (or `null`) present: set it; a date defaults the slot to `anyTime` and captures the
 *   actor's zone, `null` clears all three columns;
 * - only a slot present: keep the stored calendar date and change (or, for `null`, reset) the slot
 *   on it. Clients that "move the time of day" send exactly this shape. The previous derivation
 *   coalesced the omitted date to `null`, so a slot-only patch deleted the entire due date.
 *   A slot cannot be attached to a card that has no date, so that combination is rejected
 *   instead of being silently dropped; `null` on an undated card is a no-op.
 */
export function resolveDueDatePatch(
  body: DueDatePatchInput,
  current: DueDateCandidate,
  actorTimezone: string,
): DueDatePatch {
  if (body.dueDateLocalDate === undefined && body.dueDateSlot === undefined) return { kind: "unchanged" };
  if (body.dueDateLocalDate === undefined) {
    if (!current.dueDateLocalDate) {
      if (body.dueDateSlot === null) return { kind: "unchanged" };
      return { kind: "rejected", reason: "provide dueDateLocalDate when setting dueDateSlot" };
    }
    return {
      kind: "write",
      dueDateLocalDate: current.dueDateLocalDate,
      dueDateSlot: body.dueDateSlot ?? "anyTime",
      // The date did not move, so the zone it was set in still describes it.
      dueDateTimezone: current.dueDateTimezone ?? actorTimezone,
    };
  }
  if (body.dueDateLocalDate === null) {
    return { kind: "write", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null };
  }
  return {
    kind: "write",
    dueDateLocalDate: body.dueDateLocalDate,
    dueDateSlot: body.dueDateSlot ?? "anyTime",
    dueDateTimezone: actorTimezone,
  };
}
