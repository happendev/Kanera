/**
 * Resolves the date phrases people actually say to an agent ("tomorrow 1pm", "next friday",
 * "in 2 weeks", "oct 12") into a wall-clock date and optional time in the user's own zone.
 *
 * Dependency-free and deliberately small: it only accepts phrases with one unambiguous reading and
 * rejects everything else with a message naming the accepted forms, so a model corrects itself
 * instead of Kanera guessing a date. Tools echo the resolved date back so the user can confirm it.
 */
import { CARD_DUE_DATE_SLOTS, DUE_DATE_SLOT_TIMES, type CardDueDateSlot } from "@kanera/shared/due-date-slots";

export type LocalTime = { hour: number; minute: number };
export type ResolvedLocalDate = { date: string; time: LocalTime | null };

const RELATIVE_DATE_FORMS = "YYYY-MM-DD, today, tomorrow, yesterday, a weekday (\"friday\" is the next one, today included; \"next friday\" is a week later), \"in 3 days\"/\"in 2 weeks\"/\"in 1 month\", \"next week\" (Monday), \"next month\" (the 1st), \"end of week\" (Friday), \"end of month\", or a month and day such as \"oct 12\"; optionally followed by a time such as 1pm, 13:30, noon, morning, afternoon, or end of day";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const NAMED_TIMES: Record<string, LocalTime> = {
  noon: { hour: 12, minute: 0 },
  midday: { hour: 12, minute: 0 },
  morning: DUE_DATE_SLOT_TIMES.morning,
  afternoon: DUE_DATE_SLOT_TIMES.afternoon,
  "end of day": DUE_DATE_SLOT_TIMES.endOfWorkDay,
  eod: DUE_DATE_SLOT_TIMES.endOfWorkDay,
  "end of work day": DUE_DATE_SLOT_TIMES.endOfWorkDay,
  evening: DUE_DATE_SLOT_TIMES.anyTime,
  tonight: DUE_DATE_SLOT_TIMES.anyTime,
};

export class RelativeDateError extends Error {}

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = utcDate(date);
  next.setUTCDate(next.getUTCDate() + days);
  return iso(next);
}

function addMonths(date: string, months: number): string {
  const current = utcDate(date);
  const day = current.getUTCDate();
  const target = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + months, 1));
  // Clamp to the target month's length so "in 1 month" from Jan 31 lands on Feb 28/29.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return iso(target);
}

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && iso(utcDate(value)) === value;
}

function prefixMatch(word: string, names: readonly string[]): number {
  if (word.length < 3) return -1;
  return names.findIndex((name) => name.startsWith(word));
}

function parseTime(text: string): LocalTime | null | undefined {
  const value = text.replace(/^at\s+/u, "").trim();
  if (value === "") return null;
  if (value in NAMED_TIMES) return NAMED_TIMES[value]!;
  const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/u.exec(value);
  if (twelveHour) {
    const hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return undefined;
    return { hour: (hour % 12) + (twelveHour[3] === "pm" ? 12 : 0), minute };
  }
  const twentyFourHour = /^(\d{1,2}):(\d{2})$/u.exec(value);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    if (hour > 23 || minute > 59) return undefined;
    return { hour, minute };
  }
  return undefined;
}

function parseDate(text: string, today: string): string | undefined {
  if (isValidIsoDate(text)) return text;
  if (text === "today" || text === "tonight") return today;
  if (text === "tomorrow") return addDays(today, 1);
  if (text === "yesterday") return addDays(today, -1);
  if (text === "day after tomorrow" || text === "the day after tomorrow") return addDays(today, 2);
  const todayWeekday = utcDate(today).getUTCDay();
  if (text === "next week") return addDays(today, ((8 - todayWeekday) % 7) || 7);
  if (text === "next month") return iso(new Date(Date.UTC(utcDate(today).getUTCFullYear(), utcDate(today).getUTCMonth() + 1, 1)));
  if (text === "end of week" || text === "eow" || text === "this week") return addDays(today, (5 - todayWeekday + 7) % 7);
  if (text === "end of month" || text === "eom") {
    const current = utcDate(today);
    return iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)));
  }

  const offset = /^(?:in\s+)?(\d{1,3}|a|an|one)\s+(day|week|month)s?(?:\s+from\s+(?:now|today))?$/u.exec(text)
    ?? /^\+(\d{1,3})(d|w|m)$/u.exec(text);
  if (offset && (text.startsWith("in ") || text.startsWith("+") || text.includes(" from "))) {
    const amount = /^\d+$/u.test(offset[1]!) ? Number(offset[1]) : 1;
    const unit = offset[2]![0];
    if (unit === "d") return addDays(today, amount);
    if (unit === "w") return addDays(today, amount * 7);
    return addMonths(today, amount);
  }

  const weekday = /^(this\s+|next\s+|on\s+)?([a-z]+)$/u.exec(text);
  if (weekday) {
    const index = prefixMatch(weekday[2]!, WEEKDAYS);
    if (index >= 0) {
      const ahead = (index - todayWeekday + 7) % 7;
      return addDays(today, ahead + (weekday[1]?.startsWith("next") ? 7 : 0));
    }
  }

  // "oct 12", "october 12 2027", "12 oct", "12 october 2027". Without a year, the next occurrence
  // on or after today, because a reminder or due date in the past is almost never meant.
  const monthDay = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/u.exec(text);
  const dayMonth = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:,?\s+(\d{4}))?$/u.exec(text);
  const parts = monthDay
    ? { month: monthDay[1]!, day: monthDay[2]!, year: monthDay[3] }
    : dayMonth ? { month: dayMonth[2]!, day: dayMonth[1]!, year: dayMonth[3] } : null;
  if (parts) {
    const month = prefixMatch(parts.month, MONTHS);
    if (month < 0) return undefined;
    const build = (year: number) => `${year}-${String(month + 1).padStart(2, "0")}-${parts.day.padStart(2, "0")}`;
    const thisYear = utcDate(today).getUTCFullYear();
    if (parts.year) {
      const candidate = build(Number(parts.year));
      return isValidIsoDate(candidate) ? candidate : undefined;
    }
    const candidate = build(thisYear);
    if (!isValidIsoDate(candidate) && !isValidIsoDate(build(thisYear + 1))) return undefined;
    return isValidIsoDate(candidate) && candidate >= today ? candidate : build(thisYear + 1);
  }
  return undefined;
}

/**
 * Splits "tomorrow at 1pm" into its date and time phrases. Times are matched from the end so a
 * named time ("end of day") is never mistaken for part of a date phrase ("end of month").
 */
export function resolveLocalDate(input: string, today: string): ResolvedLocalDate {
  const text = input.trim().toLowerCase().replace(/\s+/gu, " ").replace(/,$/u, "");
  const isoDateTime = /^(\d{4}-\d{2}-\d{2})[t ](\d{2}:\d{2})(?::\d{2})?$/u.exec(text);
  if (isoDateTime && isValidIsoDate(isoDateTime[1]!)) {
    const time = parseTime(isoDateTime[2]!);
    if (time) return { date: isoDateTime[1]!, time };
  }
  const date = parseDate(text, today);
  if (date) return { date, time: text === "tonight" ? NAMED_TIMES.tonight! : null };

  const words = text.split(" ");
  for (let split = words.length - 1; split >= 1; split -= 1) {
    const datePart = words.slice(0, split).join(" ").replace(/\s+(?:at|by)$/u, "");
    const time = parseTime(words.slice(split).join(" "));
    if (!time) continue;
    const resolved = parseDate(datePart, today);
    if (resolved) return { date: resolved, time };
  }
  // A bare time ("3pm", "end of day") means today.
  const timeOnly = parseTime(text);
  if (timeOnly) return { date: today, time: timeOnly };
  throw new RelativeDateError(`Could not read the date "${input}". Use ${RELATIVE_DATE_FORMS}.`);
}

/**
 * Kanera due dates carry a named slot, not a free time. A time maps to the earliest slot whose
 * cut-off is not before it, so "1pm" is due by the afternoon cut-off and is never shown as late
 * before the moment the user named; anything after end of work day is the all-day slot.
 */
export function dueDateSlotForTime(time: LocalTime): CardDueDateSlot {
  const minutes = time.hour * 60 + time.minute;
  const ordered = CARD_DUE_DATE_SLOTS
    .filter((slot) => slot !== "anyTime")
    .sort((a, b) => DUE_DATE_SLOT_TIMES[a].hour * 60 + DUE_DATE_SLOT_TIMES[a].minute - (DUE_DATE_SLOT_TIMES[b].hour * 60 + DUE_DATE_SLOT_TIMES[b].minute));
  return ordered.find((slot) => DUE_DATE_SLOT_TIMES[slot].hour * 60 + DUE_DATE_SLOT_TIMES[slot].minute >= minutes) ?? "anyTime";
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second")) - instant;
}

/**
 * The UTC instant of a wall-clock time in an IANA zone. The offset is re-read at the first guess so
 * a time on a DST-change day lands on the zone's actual offset for that moment.
 */
function zonedInstant(date: string, time: LocalTime, timeZone: string): string {
  const wallClock = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), time.hour, time.minute);
  const firstGuess = wallClock - zoneOffsetMs(wallClock, timeZone);
  return new Date(wallClock - zoneOffsetMs(firstGuess, timeZone)).toISOString();
}

export type DateContext = { timeZone: string; today: string };

/** Local-date keys: values are stored as dates, so a phrase's time only selects a due slot. */
const LOCAL_DATE_KEYS = new Set(["dueDateLocalDate", "dueFrom", "dueTo", "valueDate"]);
/** Instant keys: a phrase without a time means the start of that day in the user's zone. */
const INSTANT_KEYS = new Set(["completedFrom", "completedTo", "lastActivityBefore", "lastMovedBefore", "from", "to"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

function needsResolution(key: string, value: unknown, parent: Record<string, unknown>): value is string {
  if (typeof value !== "string") return false;
  if (LOCAL_DATE_KEYS.has(key) || (key === "value" && parent.type === "date")) return !isValidIsoDate(value);
  return INSTANT_KEYS.has(key) && !ISO_INSTANT.test(value);
}

export function hasRelativeDates(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRelativeDates);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.entries(record).some(([key, child]) => needsResolution(key, child, record) || hasRelativeDates(child));
}

/**
 * Rewrites every date phrase in a tool's arguments to the ISO form the public API accepts. A due
 * date given with a time ("friday 3pm") also fills an omitted sibling dueDateSlot, so the card is
 * due by the moment the user named; an explicit slot always wins.
 */
export function resolveRelativeDates<T>(value: T, context: DateContext, path: Array<string | number> = []): T {
  if (Array.isArray(value)) return (value as unknown[]).map((child, index) => resolveRelativeDates(child, context, [...path, index])) as T;
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    // An explicitly-undefined dueDateSlot must not erase the slot a phrase's time just filled.
    if (child === undefined && key in next) continue;
    if (!needsResolution(key, child, record)) {
      next[key] = resolveRelativeDates(child, context, [...path, key]);
      continue;
    }
    let resolved: ResolvedLocalDate;
    try {
      resolved = resolveLocalDate(child, context.today);
    } catch (error) {
      if (error instanceof RelativeDateError) throw new RelativeDateError(`${[...path, key].join(".")}: ${error.message}`);
      throw error;
    }
    if (INSTANT_KEYS.has(key)) {
      next[key] = zonedInstant(resolved.date, resolved.time ?? { hour: 0, minute: 0 }, context.timeZone);
      continue;
    }
    next[key] = resolved.date;
    if (key === "dueDateLocalDate" && resolved.time && record.dueDateSlot === undefined) {
      next.dueDateSlot = dueDateSlotForTime(resolved.time);
    }
  }
  return next as T;
}
