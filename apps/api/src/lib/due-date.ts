import { DUE_DATE_SLOT_TIMES, type CardDueDateSlot } from "@kanera/shared/due-date-slots";

import { wallClockPartsOrUtc } from "./date-time-formatter.js";

export interface DueDateCandidate {
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

/** Local calendar date and wall-clock time in `timezone`, falling back to UTC for unknown zones. */
export function localParts(now: Date, timezone: string): { date: string; hour: number; minute: number } {
  const { date, hour, minute } = wallClockPartsOrUtc(now, timezone);
  return { date, hour, minute };
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
 * The YYYY-MM-DD wall-clock date an instant falls on in the given zone. An unknown or malformed
 * zone falls back to UTC rather than throwing, matching `isDueDateOverdue` above.
 */
export function localDateInTimezone(date: Date, timezone: string): string {
  return wallClockPartsOrUtc(date, timezone).date;
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

/**
 * Pull a planned start back to the due date when it would otherwise land after it. A start is
 * date-only, so the comparison is a plain YYYY-MM-DD string compare; no due date (or no start)
 * leaves the start untouched, because a start with no due date is a valid "point" schedule.
 */
export function clampStartToDue(startDateLocalDate: string | null, dueDateLocalDate: string | null): string | null {
  if (!startDateLocalDate || !dueDateLocalDate) return startDateLocalDate;
  return startDateLocalDate > dueDateLocalDate ? dueDateLocalDate : startDateLocalDate;
}

type StartDatePatch =
  | { kind: "unchanged" }
  | { kind: "rejected"; reason: string }
  | { kind: "write"; startDateLocalDate: string | null };

const START_AFTER_DUE_REASON = "startDateLocalDate must be on or before dueDateLocalDate";

/**
 * Derive the start-date column a write should leave behind, given the due date the same write
 * results in (`resultingDueDate`: the one in the body, else the stored one).
 *
 * The Timeline draws a card as a bar from start to due and the scheduling engine measures the
 * span between them, so a start may never sit after the due date:
 * - an explicit start later than the resulting due date is the caller's mistake and is rejected;
 * - a due date moved before the stored start pulls the start along (clamp), so a reschedule from
 *   the calendar or an automation never leaves an inverted bar behind;
 * - clearing the due date keeps the start, clearing the start never touches the due date.
 * Callers run `resolveDueDatePatch` first and feed its result in here.
 */
export function resolveStartDatePatch(
  body: { startDateLocalDate?: string | null },
  current: { startDateLocalDate: string | null },
  resultingDueDate: string | null,
): StartDatePatch {
  if (body.startDateLocalDate !== undefined) {
    if (body.startDateLocalDate === null) {
      return current.startDateLocalDate === null ? { kind: "unchanged" } : { kind: "write", startDateLocalDate: null };
    }
    if (resultingDueDate && body.startDateLocalDate > resultingDueDate) return { kind: "rejected", reason: START_AFTER_DUE_REASON };
    return body.startDateLocalDate === current.startDateLocalDate ? { kind: "unchanged" } : { kind: "write", startDateLocalDate: body.startDateLocalDate };
  }
  const clamped = clampStartToDue(current.startDateLocalDate, resultingDueDate);
  return clamped === current.startDateLocalDate ? { kind: "unchanged" } : { kind: "write", startDateLocalDate: clamped };
}
