import { describe, expect, it } from "vitest";
import { formatDate, formatDateRange, formatDateTime, formatFeedTime, formatRelativeTime, formatTime } from "./date-format";

// Expectations are computed through Intl rather than hardcoded so the suite passes under any
// browser locale; what is asserted is which fields each style shows, and when the year appears.
const d = (opts: Intl.DateTimeFormatOptions, date: Date) => new Intl.DateTimeFormat(undefined, opts).format(date);

describe("date-format", () => {
  const now = new Date(2026, 8, 6, 10, 0);
  const thisYear = new Date(2026, 2, 4, 14, 32);
  const lastYear = new Date(2025, 2, 4, 14, 32);

  it("short style drops the year only inside the current year", () => {
    expect(formatDate(thisYear, "short", { now })).toBe(d({ day: "numeric", month: "short" }, thisYear));
    expect(formatDate(lastYear, "short", { now })).toBe(d({ day: "numeric", month: "short", year: "numeric" }, lastYear));
  });

  it("medium, long, and monthYear always carry the year", () => {
    expect(formatDate(thisYear, "medium", { now })).toBe(d({ day: "numeric", month: "short", year: "numeric" }, thisYear));
    expect(formatDate(thisYear, "long", { now })).toBe(d({ weekday: "long", day: "numeric", month: "long", year: "numeric" }, thisYear));
    expect(formatDate(thisYear, "monthYear", { now })).toBe(d({ month: "long", year: "numeric" }, thisYear));
  });

  it("treats YYYY-MM-DD strings as local calendar days", () => {
    expect(formatDate("2026-03-04", "medium", { now })).toBe(d({ day: "numeric", month: "short", year: "numeric" }, new Date(2026, 2, 4)));
  });

  it("joins date and time with a comma", () => {
    expect(formatDateTime(thisYear, "short", { now })).toBe(`${formatDate(thisYear, "short", { now })}, ${formatTime(thisYear)}`);
    expect(formatDateTime(lastYear, "medium", { now })).toBe(`${formatDate(lastYear, "medium", { now })}, ${formatTime(lastYear)}`);
  });

  it("compact shows a time today and a date otherwise", () => {
    const today = new Date(2026, 8, 6, 8, 5);
    expect(formatDateTime(today, "compact", { now })).toBe(formatTime(today));
    expect(formatDateTime(thisYear, "compact", { now })).toBe(formatDate(thisYear, "short", { now }));
  });

  it("renders a day key as the same calendar day regardless of the requested zone", () => {
    expect(formatDate("2026-03-04", "medium", { now, timeZone: "Pacific/Kiritimati" })).toBe(formatDate("2026-03-04", "medium", { now }));
    expect(formatDate("2026-03-04", "medium", { now, timeZone: "Pacific/Pago_Pago" })).toBe(formatDate("2026-03-04", "medium", { now }));
  });

  it("applies the requested zone to instants", () => {
    const lateEvening = new Date("2026-12-31T23:30:00Z");
    expect(formatDateTime(lateEvening, "medium", { now, timeZone: "Asia/Tokyo" })).toBe(`${d({ day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Tokyo" }, lateEvening)}, ${d({ hour: "numeric", minute: "2-digit", timeZone: "Asia/Tokyo" }, lateEvening)}`);
    // Same instant, different calendar year across the two zones: the short style adds the year only where needed.
    expect(formatDate(lateEvening, "short", { now: new Date(2026, 11, 31), timeZone: "Asia/Tokyo" })).toContain("2027");
    expect(formatDate(lateEvening, "short", { now: new Date(2026, 11, 31), timeZone: "UTC" })).not.toContain("2027");
  });

  it("falls back to the browser zone for an unknown time zone", () => {
    expect(formatDateTime(thisYear, "medium", { now, timeZone: "Not/AZone" })).toBe(formatDateTime(thisYear, "medium", { now }));
  });

  it("returns an empty string for missing or invalid input", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDateTime("nope")).toBe("");
    expect(formatRelativeTime(undefined)).toBe("");
  });

  it("collapses ranges to the shortest unambiguous label", () => {
    expect(formatDateRange(new Date(2026, 2, 4), new Date(2026, 2, 9), { now })).toBe(`4 – ${formatDate(new Date(2026, 2, 9), "short", { now })}`);
    expect(formatDateRange(new Date(2026, 1, 28), new Date(2026, 2, 4), { now }))
      .toBe(`${d({ day: "numeric", month: "short" }, new Date(2026, 1, 28))} – ${formatDate(new Date(2026, 2, 4), "short", { now })}`);
    expect(formatDateRange(new Date(2025, 11, 28), new Date(2026, 0, 4), { now }))
      .toBe(`${formatDate(new Date(2025, 11, 28), "medium")} – ${formatDate(new Date(2026, 0, 4), "medium")}`);
    expect(formatDateRange(new Date(2026, 2, 4), new Date(2026, 2, 4), { now })).toBe(formatDate(new Date(2026, 2, 4), "short", { now }));
  });

  it("relative and feed times agree under an hour and diverge after", () => {
    const fiveMinutes = new Date(now.getTime() - 5 * 60_000);
    const threeDays = new Date(now.getTime() - 3 * 86_400_000);
    expect(formatRelativeTime(fiveMinutes, { now })).toBe("5m ago");
    expect(formatFeedTime(fiveMinutes, { now })).toBe("5m ago");
    expect(formatRelativeTime(threeDays, { now })).toBe("3d ago");
    expect(formatFeedTime(threeDays, { now })).toBe(formatDateTime(threeDays, "short", { now }));
  });
});
