import type { Locale } from "@kanera/shared/locales";

/**
 * Dates and numbers for mail and push, in the recipient's locale. The `Locale` tag is a BCP 47 tag,
 * so `Intl` picks the right order and names ("12 Oct 2026" for en-GB, "Oct 12, 2026" for en-US,
 * "12. Okt. 2026" for de). Machine formatting (keys, comparisons) uses `wallClockParts` in
 * ../date-time-formatter.ts instead, never these.
 */

// ICU formatters are expensive to build and digests format thousands of dates, so reuse them per
// locale, options and zone. Zones come from user data, so the cache is bounded.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_FORMATTERS = 256;

function dateFormatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\0${JSON.stringify(options)}`;
  const existing = dateFormatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (dateFormatters.size >= MAX_CACHED_FORMATTERS) dateFormatters.delete(dateFormatters.keys().next().value!);
  dateFormatters.set(key, formatter);
  return formatter;
}

/** An instant as the recipient reads it. Throws RangeError for an unknown `timeZone`. */
export function formatDate(locale: Locale, date: Date, options: Intl.DateTimeFormatOptions): string {
  return dateFormatter(locale, options).format(date);
}

/**
 * A calendar date ("YYYY-MM-DD", no time) as the recipient reads it. A calendar date has no zone:
 * it is formatted as that day in UTC, so it reads the same day for every reader (formatting noon UTC
 * in the date's own zone used to show the next day for UTC+13/+14 zones).
 */
export function formatLocalDate(locale: Locale, localDate: string, options: Omit<Intl.DateTimeFormatOptions, "timeZone">): string {
  return formatDate(locale, new Date(`${localDate}T12:00:00Z`), { ...options, timeZone: "UTC" });
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(locale: Locale, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}\0${JSON.stringify(options)}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatNumber(locale: Locale, value: number): string {
  return numberFormatter(locale).format(value);
}

/** Storage sizes ("208.4 MB", "208,4 MB" in de). Units stay as written, as the glossary asks. */
export function formatBytes(locale: Locale, bytes: number): string {
  if (bytes < 1024) return `${formatNumber(locale, bytes)} B`;
  const oneDecimal = numberFormatter(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < 1024 * 1024) return `${oneDecimal.format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${oneDecimal.format(bytes / 1024 / 1024)} MB`;
  return `${oneDecimal.format(bytes / 1024 / 1024 / 1024)} GB`;
}
