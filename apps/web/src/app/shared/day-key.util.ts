/**
 * Local calendar-day helpers shared by every surface that groups timestamps into days.
 *
 * Day keys are always YYYY-MM-DD in the *viewer's* zone, matching the `timeZone` the work-done and
 * portfolio queries send to the server. Grouping must never go through `toISOString()`, which is
 * UTC: an evening event would jump to the next day for anyone east of UTC.
 */

/** Local YYYY-MM-DD key for a Date. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses a YYYY-MM-DD key back to a Date anchored at local noon.
 *
 * Noon rather than midnight so a DST transition — which can shift a local midnight onto the previous
 * day — cannot move the date the caller reads back out.
 */
export function parseDateKey(key: string): Date {
  return new Date(`${key}T12:00:00`);
}

/** The viewer's IANA zone, as sent to any server query that buckets by calendar day. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Start of a local day (midnight), for range boundaries sent to the server. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Adds (or subtracts) whole days, staying on local calendar days across DST shifts. */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * "Today" / "Yesterday" / "Mon, 4 Mar" for a day key, relative to `today`.
 *
 * `today` is injectable so tests are not tied to the wall clock.
 */
export function dayGroupLabel(key: string, today: Date = new Date()): string {
  const todayKey = localDateKey(today);
  if (key === todayKey) return "Today";
  if (key === localDateKey(addDays(today, -1))) return "Yesterday";
  const date = parseDateKey(key);
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full-sentence day label, e.g. "Sunday, 26 July 2026". */
export function dayFullLabel(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
