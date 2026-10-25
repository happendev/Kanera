import { addWorkingDays, dateKeyOf, dayNumber, lastWorkingDayOnOrBefore, nextWorkingDayOnOrAfter } from "@kanera/shared/schedule";

const londonDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
});
const londonHour = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "numeric", hourCycle: "h23",
});

/** Backfilled work stops on Friday, rather than appearing as weekend work after a reset.
 * Clamp evenings too so projecting Saturday back to Friday cannot put it before a Friday event.
 */
export function seedActivityTime(value: Date): Date {
  const date = londonDate.format(value);
  const day = dayNumber(date);
  const workDate = dateKeyOf(lastWorkingDayOnOrBefore(day));
  const noon = new Date(`${workDate}T12:00:00Z`);
  const offsetHours = Number(londonHour.format(noon)) - 12;
  const end = new Date(`${workDate}T17:00:00Z`);
  end.setUTCHours(end.getUTCHours() - offsetHours);
  return new Date(Math.min(value.getTime(), end.getTime()));
}

/** One immutable London date per reset. Day numbers represent calendar dates, never DST durations. */
export function seedCalendar(reference: Date | string) {
  const date = typeof reference === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reference)
    ? reference
    : londonDate.format(typeof reference === "string" ? new Date(reference) : reference);
  const day = dayNumber(date);
  if (!Number.isFinite(day) || dateKeyOf(day) !== date) throw new Error("Seed reference date must be a valid ISO date or instant.");
  const first = nextWorkingDayOnOrAfter(day);
  const business = (offset: number) => dateKeyOf(addWorkingDays(first, offset));
  const previous = (count: number) => dateKeyOf(addWorkingDays(nextWorkingDayOnOrAfter(day), -count));
  const label = (offset: number) => new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${business(offset)}T12:00:00Z`));
  const baseDate = new Date(`${date}T09:13:27Z`);
  const instant = typeof reference === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reference)
    ? baseDate : new Date(reference);
  return { date, business, previous, label, baseDate, instant, activityInstant: seedActivityTime(instant) };
}

// Explicit authored offsets: these must never be inferred from previously rebased database dates.
export const MARKETING_DEADLINES: Readonly<Record<number, number>> = Object.fromEntries([
  [0, [5, 16, 29, 86, 96, 102]], [1, [8, 11, 28, 57, 94, 95]],
  [2, [6, 27, 32, 47, 49, 50, 68, 90, 114]], [3, [10, 31, 34, 35, 55, 56, 70, 72, 89, 93, 106]],
  [4, [12, 13, 33, 36, 58, 74, 92, 111]], [5, [48, 73, 76]], [6, [14, 52, 120]],
  [7, [107, 115]], [8, [51, 108]], [9, [46, 53, 71, 110]], [10, [30, 75, 113]],
  [11, [54, 77]], [12, [91, 109]], [13, [67, 88, 112]], [14, [69]], [15, [87]],
].flatMap(([offset, numbers]) => (numbers as number[]).map((number) => [number, offset as number])));

export const OTHER_DEADLINES: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  "Development Team": { 1: -3, 2: 5, 3: 3, 4: -2, 5: 4, 6: 6, 7: 8, 8: 12, 9: 5, 10: 7, 13: -2, 14: 9, 15: 3, 16: 1, 18: 8, 19: 3, 21: 4, 23: 0 },
  DevOps: { 1: -3, 2: 4, 3: 5, 4: 2, 5: 3, 6: 10, 7: 1, 8: 12, 9: 3, 12: 9, 13: -3, 14: 5, 15: 8, 16: 6, 17: 7, 18: 11, 19: 4, 21: 5, 23: 9, 24: 8 },
  "Launch Checklist": { 1: -1, 2: -1, 3: 1, 4: 1, 5: 2 },
};

export type SeedNotificationTime = { workingDaysAgo: number; hour: number; minute: number };

/** A prior working day's London clock keeps seeded inboxes historical on weekday and weekend resets. */
export function seedNotificationTime(reference: Date | string, time: SeedNotificationTime): Date {
  const date = seedCalendar(reference).previous(time.workingDaysAgo);
  const noon = new Date(`${date}T12:00:00Z`);
  const offsetHours = Number(londonHour.format(noon)) - 12;
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCHours(time.hour - offsetHours, time.minute, 0, 0);
  return at;
}
