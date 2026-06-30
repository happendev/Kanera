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

function formatParts(date: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(date);
  }

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

export function isOverdue(
  localDate: string | null | undefined,
  slot: DueDateSlot | null | undefined,
  timezone: string | null | undefined,
  now = new Date(),
): boolean {
  if (!localDate) return false;
  const selectedSlot = slot ?? "anyTime";
  return now.getTime() >= zonedDateTimeToUtc(localDate, selectedSlot, timezone || "UTC").getTime();
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

export function formatShortDate(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
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
  const time = dueAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

export function dueDateInputValue(localDate: string | null | undefined): string {
  return localDate ?? "";
}
