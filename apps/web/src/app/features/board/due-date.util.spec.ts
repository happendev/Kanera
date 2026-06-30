import { afterEach, describe, expect, it, vi } from "vitest";
import { dueDateInputValue, dueDateSlotFor, formatDueDate, isOverdue } from "./due-date.util";

describe("due date helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks anyTime overdue at 21:00 in the due date timezone", () => {
    vi.setSystemTime(new Date("2026-05-21T20:59:00Z"));
    expect(isOverdue("2026-05-21", "anyTime", "UTC")).toBe(false);

    vi.setSystemTime(new Date("2026-05-21T21:00:00Z"));
    expect(isOverdue("2026-05-21", "anyTime", "UTC")).toBe(true);
  });

  it("marks morning overdue at 09:00 in the due date timezone", () => {
    vi.setSystemTime(new Date("2026-05-21T08:59:00Z"));
    expect(isOverdue("2026-05-21", "morning", "UTC")).toBe(false);

    vi.setSystemTime(new Date("2026-05-21T09:00:00Z"));
    expect(isOverdue("2026-05-21", "morning", "UTC")).toBe(true);
  });

  it("marks afternoon overdue at 13:00 in the due date timezone", () => {
    vi.setSystemTime(new Date("2026-05-21T12:59:00Z"));
    expect(isOverdue("2026-05-21", "afternoon", "UTC")).toBe(false);

    vi.setSystemTime(new Date("2026-05-21T13:00:00Z"));
    expect(isOverdue("2026-05-21", "afternoon", "UTC")).toBe(true);
  });

  it("marks endOfWorkDay overdue at 17:00 in the due date timezone", () => {
    vi.setSystemTime(new Date("2026-05-21T16:59:00Z"));
    expect(isOverdue("2026-05-21", "endOfWorkDay", "UTC")).toBe(false);

    vi.setSystemTime(new Date("2026-05-21T17:00:00Z"));
    expect(isOverdue("2026-05-21", "endOfWorkDay", "UTC")).toBe(true);
  });

  it("formats due times in the viewer timezone from the due date timezone", () => {
    const expected = new Date("2026-01-21T14:00:00Z");
    const date = expected.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const time = expected.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    expect(formatDueDate("2026-01-21", "morning", "America/New_York")).toBe(`${date} · ${time}`);
  });

  it("does not show the internal anytime due time", () => {
    expect(formatDueDate("2026-01-21", "anyTime", "UTC")).toBe("Jan 21");
  });

  it("returns empty values for unset due dates", () => {
    expect(dueDateInputValue(null)).toBe("");
    expect(dueDateSlotFor(null)).toBe("anyTime");
    expect(isOverdue(null, null, null)).toBe(false);
  });
});
