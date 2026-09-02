import { localDateParts } from "../../../lib/local-date.js";

export interface CsvDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  hasTime: boolean;
  instant?: Date;
}

function valid(parts: CsvDateParts): CsvDateParts | null {
  const test = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  return test.getUTCFullYear() === parts.year && test.getUTCMonth() === parts.month - 1 && test.getUTCDate() === parts.day
    ? parts
    : null;
}

function year(value: number): number {
  if (value >= 100) return value;
  return value >= 70 ? 1900 + value : 2000 + value;
}

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);

function timeParts(hourRaw?: string, minuteRaw?: string, secondRaw?: string, meridiemRaw?: string) {
  let hour = Number(hourRaw ?? 0);
  const meridiem = meridiemRaw?.toLocaleLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { hour, minute: Number(minuteRaw ?? 0), second: Number(secondRaw ?? 0), hasTime: hourRaw !== undefined };
}

export function parseCsvDate(raw: string, order: "dmy" | "mdy"): CsvDateParts | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const serial = Number(value);
    if (serial > 0 && serial < 2_958_466) {
      const millis = Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000);
      const date = new Date(millis);
      return {
        year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(),
        hasTime: serial % 1 !== 0,
      };
    }
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*(am|pm))?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(value);
  if (iso) {
    const parts = valid({ year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), ...timeParts(iso[4], iso[5], iso[6], iso[7]) });
    if (!parts) return null;
    if (iso[8]) {
      const instant = new Date(value.replace(" ", "T"));
      if (!Number.isNaN(instant.getTime())) parts.instant = instant;
    }
    return parts;
  }

  const ymd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(value);
  if (ymd) return valid({ year: Number(ymd[1]), month: Number(ymd[2]), day: Number(ymd[3]), ...timeParts(ymd[4], ymd[5], ymd[6], ymd[7]) });

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(value);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const resolved = a > 12 ? { day: a, month: b } : b > 12 ? { day: b, month: a } : order === "dmy" ? { day: a, month: b } : { day: b, month: a };
    return valid({ year: year(Number(numeric[3])), ...resolved, ...timeParts(numeric[4], numeric[5], numeric[6], numeric[7]) });
  }

  const dayMonth = /^(\d{1,2})[ /-]([A-Za-z]{3,9})[ /-](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(value);
  if (dayMonth) {
    const month = MONTHS.get(dayMonth[2]!.slice(0, 3).toLocaleLowerCase());
    return month ? valid({ year: year(Number(dayMonth[3])), month, day: Number(dayMonth[1]), ...timeParts(dayMonth[4], dayMonth[5], dayMonth[6], dayMonth[7]) }) : null;
  }
  const monthDay = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(value);
  if (monthDay) {
    const month = MONTHS.get(monthDay[1]!.slice(0, 3).toLocaleLowerCase());
    return month ? valid({ year: year(Number(monthDay[3])), month, day: Number(monthDay[2]), ...timeParts(monthDay[4], monthDay[5], monthDay[6], monthDay[7]) }) : null;
  }
  return null;
}

export function inferDateOrder(values: string[]): { order: "dmy" | "mdy"; ambiguous: boolean } {
  let dmy = 0;
  let mdy = 0;
  let ambiguous = false;
  for (const value of values) {
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](?:\d{2}|\d{4})/.exec(value.trim());
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a > 12 && b <= 12) dmy += 1;
    else if (b > 12 && a <= 12) mdy += 1;
    else if (a <= 12 && b <= 12) ambiguous = true;
  }
  if (dmy > mdy) return { order: "dmy", ambiguous: false };
  if (mdy > dmy) return { order: "mdy", ambiguous: false };
  return { order: "dmy", ambiguous };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function toLocalDate(parts: CsvDateParts, timezone: string): string {
  if (parts.instant) return localDateParts(parts.instant, timezone).date;
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const map = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(map.get("hour")) % 24;
  const rendered = Date.UTC(Number(map.get("year")), Number(map.get("month")) - 1, Number(map.get("day")), hour, Number(map.get("minute")), Number(map.get("second")));
  return rendered - date.getTime();
}

export function toInstant(parts: CsvDateParts, timezone: string): Date {
  if (parts.instant) return parts.instant;
  // Noon avoids a date-only value changing calendar day around DST or timezone boundaries while
  // still preserving an explicitly supplied time of day for created/completed/archive timestamps.
  const hour = parts.hasTime ? parts.hour : 12;
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  const first = new Date(utc - timezoneOffsetMs(new Date(utc), timezone));
  return new Date(utc - timezoneOffsetMs(first, timezone));
}
