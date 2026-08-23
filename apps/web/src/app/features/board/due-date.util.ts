export type DueDateSlot = "anyTime" | "morning" | "afternoon" | "endOfWorkDay";
export type DueDateSlotSelection = DueDateSlot;

const SLOT_TIME: Record<DueDateSlot, { hour: number; minute: number }> = {
  // Cards without an explicit slot remain actionable for the whole due date.
  anyTime: { hour: 21, minute: 0 },
  morning: { hour: 9, minute: 0 },
  afternoon: { hour: 13, minute: 0 },
  endOfWorkDay: { hour: 17, minute: 0 },
};

export const DUE_DATE_SLOT_OPTIONS: { value: DueDateSlot; label: string; shortLabel: string; timeLabel: string }[] = [
  { value: "anyTime", label: "No slot", shortLabel: "No slot", timeLabel: "" },
  { value: "morning", label: "Morning", shortLabel: "Morning", timeLabel: "09:00" },
  { value: "afternoon", label: "Afternoon", shortLabel: "Afternoon", timeLabel: "13:00" },
  { value: "endOfWorkDay", label: "End of work day", shortLabel: "EOD", timeLabel: "17:00" },
];

const PARTS_FORMAT_OPTIONS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
} as const satisfies Intl.DateTimeFormatOptions;

/**
 * One formatter per timezone, for the lifetime of the page.
 *
 * `Intl.DateTimeFormat` is among the most expensive constructions in the JS standard library, and
 * this is the hottest date path in the app: `zonedDateTimeToUtc` calls `formatParts` up to three
 * times, and `isOverdue`/`formatDueDate` run per row in the table view and Global Work. Constructing
 * a formatter per call cost ~23ms per change-detection pass over 200 rows — more than a whole frame
 * budget — against ~1.6ms cached. The set of distinct timezones in one workspace is tiny and
 * bounded, so this Map cannot grow unboundedly.
 */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatterFor(timezone: string): Intl.DateTimeFormat {
  const key = timezone || "UTC";
  const cached = partsFormatters.get(key);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: key, ...PARTS_FORMAT_OPTIONS });
  } catch {
    // An unknown or malformed zone must not be retried on every call, so the UTC fallback is cached
    // under the requested key as well as its own.
    formatter = partsFormatters.get("UTC")
      ?? new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...PARTS_FORMAT_OPTIONS });
    partsFormatters.set("UTC", formatter);
  }
  partsFormatters.set(key, formatter);
  return formatter;
}

function formatParts(date: Date, timezone: string) {
  const parts = partsFormatterFor(timezone).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
  };
}

function zonedDateTimeToUtc(localDate: string, slot: DueDateSlot, timezone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const time = SLOT_TIME[slot];
  const targetUtcMs = Date.UTC(year, month - 1, day, time.hour, time.minute);
  let guess = new Date(targetUtcMs);

  // Intl can tell us what wall-clock time a UTC instant has in the due-date
  // timezone. Iterate the guess until that wall-clock value matches the stored
  // local date and slot, which keeps DST and unusual offsets out of our code.
  for (let i = 0; i < 3; i += 1) {
    const parts = formatParts(guess, timezone);
    const actualUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const deltaMs = targetUtcMs - actualUtcMs;
    if (deltaMs === 0) break;
    guess = new Date(guess.getTime() + deltaMs);
  }

  return guess;
}

export function dueDateTimestamp(
  localDate: string | null | undefined,
  slot: DueDateSlot | null | undefined,
  timezone: string | null | undefined,
): number | null {
  if (!localDate) return null;
  return zonedDateTimeToUtc(localDate, dueDateSlotFor(slot), timezone || "UTC").getTime();
}

export function isOverdue(
  localDate: string | null | undefined,
  slot: DueDateSlot | null | undefined,
  timezone: string | null | undefined,
  now = new Date(),
): boolean {
  const dueAt = dueDateTimestamp(localDate, slot, timezone);
  return dueAt !== null && now.getTime() >= dueAt;
}

export function isDueSoon(
  localDate: string | null | undefined,
  slot: DueDateSlot | null | undefined,
  timezone: string | null | undefined,
  now = new Date(),
): boolean {
  if (!localDate) return false;
  const selectedSlot = slot ?? "anyTime";
  const dueMs = zonedDateTimeToUtc(localDate, selectedSlot, timezone || "UTC").getTime();
  // Due soon is intentionally a rolling 24-hour window before the exact slot.
  return now.getTime() < dueMs && dueMs - now.getTime() <= 24 * 60 * 60 * 1000;
}

// `toLocaleDateString`/`toLocaleTimeString` construct a formatter internally on every call, so these
// carry the same per-row cost as formatParts above. Both variants are hoisted for the same reason:
// formatShortDate and formatDueDate run once per rendered row, per change-detection pass.
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const SHORT_DATE_WITH_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const SLOT_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export function formatShortDate(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  const now = new Date();
  // A date outside the current year is spelled out with it, so "Jan 3" can never read as this year.
  return (d.getFullYear() !== now.getFullYear() ? SHORT_DATE_WITH_YEAR_FORMAT : SHORT_DATE_FORMAT).format(d);
}

export function dueDateSlotFor(
  slot: DueDateSlot | null | undefined,
): DueDateSlot {
  return slot ?? "anyTime";
}

export function formatDueDate(
  localDate: string | null | undefined,
  slot: DueDateSlot | null | undefined,
  timezone: string | null | undefined,
): string {
  if (!localDate) return "";
  const selectedSlot = dueDateSlotFor(slot);
  if (selectedSlot === "anyTime") return formatShortDate(localDate);
  const dueAt = zonedDateTimeToUtc(localDate, selectedSlot, timezone || "UTC");
  const date = formatShortDate(`${dueAt.getFullYear()}-${String(dueAt.getMonth() + 1).padStart(2, "0")}-${String(dueAt.getDate()).padStart(2, "0")}`);
  const time = SLOT_TIME_FORMAT.format(dueAt);
  return `${date} · ${time}`;
}

export function dueDateInputValue(localDate: string | null | undefined): string {
  return localDate ?? "";
}
