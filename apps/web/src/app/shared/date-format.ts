/**
 * The one place dates and times are turned into text for the UI.
 *
 * Every surface — board cards, activity feeds, notes, notifications, home, settings — reads a
 * timestamp through these named styles so the same instant never renders as "Mar 4" in one panel and
 * "4 March 2026, 14:32" in the next. Add a style here rather than reaching for `toLocaleDateString`
 * or `new Intl.DateTimeFormat(...)` in a component.
 *
 * Conventions:
 * - The interface language (`appLocale()`), so day/month order, month names and the 12/24-hour clock
 *   follow the language the viewer chose: "4 Mar" in UK English, "Mar 4" in US English, "4 mars" in
 *   French, "3月4日" in Japanese.
 * - Times are always `hour: "numeric", minute: "2-digit"` ("14:32" / "2:32 PM").
 * - "short" styles drop the year when it is the current year; every other style spells it out.
 * - A YYYY-MM-DD string is a local calendar day (anchored at noon, see `parseDateKey`), not UTC.
 * - Invalid or missing input formats to "" so callers can substitute their own placeholder.
 *
 * Formatters are cached per style and zone. `Intl.DateTimeFormat` construction is expensive enough
 * that per-row formatting in the table view and Global Work would otherwise cost most of a frame per
 * change-detection pass (see the measurements in `due-date.util.ts`).
 */

import { appLocale } from "../core/i18n/locale";
import { addDays, localDateKey, parseDateKey } from "./day-key.util";

export type DateStyle =
  /** "4 Mar", or "4 Mar 2025" outside the current year. Chips, badges, compact rows. */
  | "short"
  /** "4 Mar 2026". Pickers, range labels, anything that must stand alone. */
  | "medium"
  /** "Wednesday, 4 March 2026". Tooltips, aria labels, day headers. */
  | "long"
  /** "Wed, 4 Mar", or "Wed, 4 Mar 2025" outside the current year. Day group headings. */
  | "weekday"
  /** "March 2026". Calendar and picker month headers. */
  | "monthYear"
  /** "Mar". Axis ticks. */
  | "month";

export type DateTimeStyle =
  /** "4 Mar, 14:32", or "4 Mar 2025, 14:32" outside the current year. Feeds and last-used columns. */
  | "short"
  /** "4 Mar 2026, 14:32". Build stamps, exports, tooltips. */
  | "medium"
  /** "14:32" for today, otherwise "4 Mar". Dense stamps where the day is usually today. */
  | "compact"
  /** "Wed, 4 Mar, 14:32". Scheduled moments (reminders), where the weekday is how people plan. */
  | "weekday";

export interface FormatOptions {
  /** IANA zone to render in. Falls back to the browser zone when the zone is unknown to it. */
  timeZone?: string | null;
  /** Injectable "now" for the current-year check and relative labels, so tests are not clock-bound. */
  now?: Date;
}

type DateInput = Date | string | number | null | undefined;

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: "numeric", month: "short" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  weekday: { weekday: "short", day: "numeric", month: "short" },
  monthYear: { month: "long", year: "numeric" },
  month: { month: "short" },
};

const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

// "short" and "weekday" gain a year when the date is not in the current year, so "Jan 3" can never
// be read as this year's January. These are the with-year variants.
const WITH_YEAR: Partial<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  short: DATE_OPTIONS.medium,
  weekday: { ...DATE_OPTIONS.weekday, year: "numeric" },
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(key: string, options: Intl.DateTimeFormatOptions, timeZone: string | null | undefined): Intl.DateTimeFormat {
  const cacheKey = `${key}|${timeZone ?? ""}`;
  const cached = formatters.get(cacheKey);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(appLocale(), timeZone ? { ...options, timeZone } : options);
  } catch {
    // A profile can carry a zone this browser does not know. Rendering in the browser zone beats
    // hiding the timestamp, and caching under the requested key stops the throw repeating per row.
    formatter = formatterFor(key, options, null);
  }
  formatters.set(cacheKey, formatter);
  return formatter;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Coerces any supported input to a Date, or null when it is missing or unparseable. */
function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = typeof value === "string" && DATE_KEY.test(value) ? parseDateKey(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function yearIn(date: Date, timeZone: string | null | undefined): number {
  if (!timeZone) return date.getFullYear();
  return Number(formatterFor("year", { year: "numeric" }, timeZone).format(date));
}

function needsYear(style: DateStyle | DateTimeStyle, date: Date, opts: FormatOptions): boolean {
  if (!(style in WITH_YEAR)) return false;
  const now = opts.now ?? new Date();
  return yearIn(date, opts.timeZone) !== yearIn(now, opts.timeZone);
}

/** Calendar date only, in one of the named styles. */
export function formatDate(value: DateInput, style: DateStyle = "short", opts: FormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  // A YYYY-MM-DD key is a calendar day with no zone. It is anchored at local noon, so rendering it in
  // a distant zone could move it a day; the zone only applies to instants.
  if (typeof value === "string" && DATE_KEY.test(value) && opts.timeZone) opts = { ...opts, timeZone: null };
  const withYear = needsYear(style, date, opts);
  return formatterFor(`${style}${withYear ? "+y" : ""}`, withYear ? WITH_YEAR[style]! : DATE_OPTIONS[style], opts.timeZone).format(date);
}

/** Wall-clock time only, e.g. "14:32" or "2:32 PM". */
export function formatTime(value: DateInput, opts: FormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  return formatterFor("time", TIME_OPTIONS, opts.timeZone).format(date);
}

/**
 * Minutes a zone is ahead of UTC at `at` (negative west of Greenwich), or null for a zone this
 * browser does not know. Lives here so "local time" lines reuse the cached formatters above.
 */
export function timeZoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  try {
    new Intl.DateTimeFormat(appLocale(), { timeZone });
  } catch {
    return null;
  }
  const part = formatterFor("offset", { timeZoneName: "longOffset" }, timeZone)
    .formatToParts(at)
    .find((entry) => entry.type === "timeZoneName")?.value ?? "";
  // "GMT" alone is UTC; otherwise "GMT+05:30" / "GMT-04:00".
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  if (!match) return part === "GMT" ? 0 : null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** Date and time together. */
export function formatDateTime(value: DateInput, style: DateTimeStyle = "short", opts: FormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  if (style === "compact") {
    const now = opts.now ?? new Date();
    const sameDay = formatDate(date, "medium", opts) === formatDate(now, "medium", opts);
    return sameDay ? formatTime(date, opts) : formatDate(date, "short", opts);
  }
  // One formatter for both halves, so each language joins date and time its own way
  // ("4 Mar, 14:32", "Mar 4, 2:32 PM", "3月4日 14:32").
  const withYear = needsYear(style, date, opts);
  const dateOptions = withYear ? WITH_YEAR[style as DateStyle]! : DATE_OPTIONS[style as DateStyle];
  return formatterFor(`dt:${style}${withYear ? "+y" : ""}`, { ...dateOptions, ...TIME_OPTIONS }, opts.timeZone).format(date);
}

/**
 * "4–9 Mar", "28 Feb – 4 Mar", or "28 Dec 2025 – 4 Jan 2026": the shortest label that still
 * reads unambiguously. Used by the calendar, work-done, and completed-cards range controls.
 */
export function formatDateRange(from: DateInput, to: DateInput, opts: FormatOptions = {}): string {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end) return formatDate(start ?? end, "medium", opts);
  if (formatDate(start, "medium", opts) === formatDate(end, "medium", opts)) return formatDate(start, "short", opts);
  // formatRange collapses the shared month and year in each language's own order ("4–9 Mar",
  // "Mar 4–9", "3月4日～9日"). The year shows when the range spans years or is not this year.
  const thisYear = yearIn(opts.now ?? new Date(), opts.timeZone);
  const withYear = yearIn(start, opts.timeZone) !== thisYear || yearIn(end, opts.timeZone) !== thisYear;
  return formatterFor(withYear ? "medium" : "short", withYear ? DATE_OPTIONS.medium : DATE_OPTIONS.short, opts.timeZone).formatRange(start, end);
}

/**
 * Compact age: "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago".
 *
 * Shared by list/table columns, offline banners, and automation stats so the same timestamp never
 * reads two different ways depending on which view you opened.
 */
export function formatRelativeTime(value: DateInput, opts: FormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  const now = (opts.now ?? new Date()).getTime();
  const mins = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  // Hand-written rather than Intl.RelativeTimeFormat: its "narrow" style is inconsistent across
  // languages (French renders "-5 min"), and these labels sit in narrow columns.
  if (mins < 1) return $localize`:Relative time under a minute:just now`;
  if (mins < 60) return $localize`:Compact relative time in minutes:${mins}:count:m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return $localize`:Compact relative time in hours:${hours}:count:h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return $localize`:Compact relative time in days:${days}:count:d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return $localize`:Compact relative time in months:${months}:count:mo ago`;
  return $localize`:Compact relative time in years:${Math.round(months / 12)}:count:y ago`;
}

/**
 * Feed timestamp: relative while it is under an hour old, then the short date-time.
 *
 * Feeds (card activity, comments, notifications) want "5m ago" for what just happened but an exact
 * timestamp for anything older, where "3d ago" hides which day it actually was.
 */
export function formatFeedTime(value: DateInput, opts: FormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  const now = (opts.now ?? new Date()).getTime();
  const mins = Math.floor((now - date.getTime()) / 60_000);
  if (mins < 60) return formatRelativeTime(date, opts);
  return formatDateTime(date, "short", opts);
}

/**
 * "Today" / "Yesterday" / "Mon, 4 Mar" for a YYYY-MM-DD day key, relative to `now`.
 */
export function dayGroupLabel(key: string, now: Date = new Date()): string {
  if (key === localDateKey(now)) return $localize`:Day group heading:Today`;
  if (key === localDateKey(addDays(now, -1))) return $localize`:Day group heading:Yesterday`;
  return formatDate(key, "weekday", { now });
}

/** Full-sentence day label for a YYYY-MM-DD day key, e.g. "Sunday, 26 July 2026". */
export function dayFullLabel(key: string): string {
  return formatDate(key, "long");
}

/**
 * Short weekday names in the interface language, Monday first ("Mon"…"Sun", "lun."…"dim.", "月"…"日").
 * Calendar grids always start on Monday (see week-start.ts), whatever the language's own first day.
 */
export function weekdayLabels(): string[] {
  const format = formatterFor("weekdayShort", { weekday: "short" }, null);
  // 1 Jan 2024 was a Monday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2024, 0, 1 + i)));
}
