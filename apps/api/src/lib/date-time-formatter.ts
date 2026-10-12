/**
 * Locale for dates in emails. Users have no stored locale and an email has no browser to ask, so
 * emails use day-first dates with a named month ("12 Oct 2026"), which no reader misreads; US
 * month-first order confuses most of the world. Replace with a per-user locale if one is added.
 */
export const EMAIL_DATE_LOCALE = "en-GB";

/**
 * Reuse ICU formatters across rows and requests, never the date-dependent formatted output.
 *
 * The locale is required: display callers pass the reader's locale (or an explicit fallback), and
 * internal calculations use `wallClockParts` below instead of relying on any locale's `.format()`
 * output shape.
 */
export function dateTimeFormatter(options: Intl.DateTimeFormatOptions, locale: string) {
  const formatters = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(timeZone);
    if (existing) return existing;
    const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    // Zones may come from imports or profiles. Bound retained ICU objects even when inputs vary;
    // failed construction is not cached so callers retain their existing fallback behavior.
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, formatter);
    return formatter;
  };
}

// Only the numeric parts are read, never the joined string, so locale date order and punctuation
// cannot leak into keys. Gregorian/Latin digits are pinned because a locale's default calendar or
// numbering system would otherwise change the part values; h23 keeps midnight as 00, not 24.
const wallClockFormatter = dateTimeFormatter({
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
}, "en-US");

export interface WallClockParts {
  /** YYYY-MM-DD */
  date: string;
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in `timeZone`. Throws RangeError for an unknown zone. */
export function wallClockParts(date: Date, timeZone: string): WallClockParts {
  const parts = wallClockFormatter(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year").padStart(4, "0");
  const month = value("month");
  const day = value("day");
  return {
    date: `${year}-${month}-${day}`,
    year,
    month,
    day,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
  };
}

/**
 * Like `wallClockParts`, but an unknown, malformed or empty zone falls back to UTC: a bad stored
 * zone must degrade, not take down a read path.
 */
export function wallClockPartsOrUtc(date: Date, timeZone: string): WallClockParts {
  try {
    return wallClockParts(date, timeZone || "UTC");
  } catch {
    return wallClockParts(date, "UTC");
  }
}
