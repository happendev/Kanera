/**
 * Time in progress is time *tracking*, so wall-clock time is reduced to working time: only
 * 09:00-17:00, Monday to Friday, in the workspace's time zone counts. That caps a day at 8 hours and
 * skips nights and weekends, so a card left in an in-progress list over a weekend does not read as
 * 72 hours of work, and two weeks in progress reads as 80 hours. Stints never overlap in time, so
 * the cap holds across a card bouncing in and out of progress with no state carried between stints.
 *
 * `in_progress_working_seconds` (Postgres, migration 0072) implements the same rule when the card
 * trigger banks a stint; clients use this module to show the running stint live. Keep them in step.
 */
export const WORKDAY_START_HOUR = 9;
export const WORKDAY_END_HOUR = 17;

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const partFormatters = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA zone: the given one when the runtime knows it, else UTC (as the database does). */
export function trackingTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    localParts(0, timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function localParts(ms: number, timeZone: string): LocalParts {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partFormatters.set(timeZone, formatter);
  }
  const parts: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(ms)) {
    if (part.type in parts) parts[part.type as keyof LocalParts] = Number(part.value);
  }
  return parts;
}

/** The instant a local wall-clock hour starts on a local date in `timeZone` (month is 1-based). */
function localInstant(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let guess = wall;
  // Two passes settle the zone's offset, including on a DST-change day.
  for (let pass = 0; pass < 2; pass++) {
    const local = localParts(guess, timeZone);
    const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - guess;
    guess = wall - offset;
  }
  return guess;
}

// Working-day bounds per zone and local date. A running card re-reads its whole stint every minute,
// so the zone arithmetic is done once per day rather than once per tick.
const workdayBounds = new Map<string, [number, number]>();

function workdayFor(dateKey: number, timeZone: string): [number, number] {
  const key = `${timeZone}|${dateKey}`;
  let bounds = workdayBounds.get(key);
  if (!bounds) {
    const date = new Date(dateKey);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    bounds = [localInstant(y, m, d, WORKDAY_START_HOUR, timeZone), localInstant(y, m, d, WORKDAY_END_HOUR, timeZone)];
    workdayBounds.set(key, bounds);
  }
  return bounds;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Working time (09:00-17:00, Monday to Friday, local to `timeZone`) between two instants, in ms. */
export function workingMs(startMs: number, stopMs: number, timeZone: string | null | undefined): number {
  if (!(stopMs > startMs)) return 0;
  const zone = trackingTimeZone(timeZone);
  const first = localParts(startMs, zone);
  const last = localParts(stopMs, zone);
  const lastKey = Date.UTC(last.year, last.month - 1, last.day);
  let total = 0;
  // Local dates are walked as UTC date keys: plain calendar arithmetic, no zone involved.
  for (let dateKey = Date.UTC(first.year, first.month - 1, first.day); dateKey <= lastKey; dateKey += DAY_MS) {
    const weekday = new Date(dateKey).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const [open, close] = workdayFor(dateKey, zone);
    total += Math.max(0, Math.min(close, stopMs) - Math.max(open, startMs));
  }
  return total;
}

/** Whether `timeZone` is an IANA zone this runtime knows, for validating the workspace setting. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
