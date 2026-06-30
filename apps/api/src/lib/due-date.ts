import type { CardDueDateSlot } from "@kanera/shared/schema";

const SLOT_TIME: Record<CardDueDateSlot, { hour: number; minute: number }> = {
  anyTime: { hour: 21, minute: 0 },
  morning: { hour: 9, minute: 0 },
  afternoon: { hour: 13, minute: 0 },
  endOfWorkDay: { hour: 17, minute: 0 },
};

export interface DueDateCandidate {
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

function localParts(now: Date, timezone: string): { date: string; hour: number; minute: number } {
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
    }).formatToParts(now);
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
    }).formatToParts(now);
  }

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const rawHour = Number(value("hour"));
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(value("minute")),
  };
}

export function isDueDateOverdue(candidate: DueDateCandidate, now = new Date()): boolean {
  const dueDate = candidate.dueDateLocalDate;
  if (!dueDate) return false;
  const local = localParts(now, candidate.dueDateTimezone || "UTC");
  if (local.date > dueDate) return true;
  if (local.date < dueDate) return false;
  const boundary = SLOT_TIME[candidate.dueDateSlot ?? "anyTime"];
  return local.hour > boundary.hour || (local.hour === boundary.hour && local.minute >= boundary.minute);
}

