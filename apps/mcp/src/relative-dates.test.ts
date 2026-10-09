import assert from "node:assert/strict";
import test from "node:test";
import { dueDateSlotForTime, RelativeDateError, resolveLocalDate } from "./relative-dates.js";

// 2026-10-09 is a Friday.
const TODAY = "2026-10-09";

void test("relative dates resolve against the caller's local today", () => {
  const cases: Array<[string, string, string | null]> = [
    ["2026-12-01", "2026-12-01", null],
    ["2026-12-01T14:30", "2026-12-01", "14:30"],
    ["today", TODAY, null],
    ["Tomorrow 1pm", "2026-10-10", "13:00"],
    ["tomorrow at 9:30am", "2026-10-10", "09:30"],
    ["yesterday", "2026-10-08", null],
    ["friday", TODAY, null],
    ["next friday", "2026-10-16", null],
    ["mon", "2026-10-12", null],
    ["monday noon", "2026-10-12", "12:00"],
    ["in 3 days", "2026-10-12", null],
    ["in 2 weeks", "2026-10-23", null],
    ["in a month", "2026-11-09", null],
    ["+2d", "2026-10-11", null],
    ["next week", "2026-10-12", null],
    ["next month", "2026-11-01", null],
    ["end of week", TODAY, null],
    ["end of month", "2026-10-31", null],
    ["oct 12", "2026-10-12", null],
    ["12 October", "2026-10-12", null],
    ["oct 1", "2027-10-01", null],
    ["march 3 2027", "2027-03-03", null],
    ["3pm", TODAY, "15:00"],
    ["tomorrow end of day", "2026-10-10", "17:00"],
    ["tonight", TODAY, "21:00"],
    ["12am", TODAY, "00:00"],
  ];
  for (const [input, date, time] of cases) {
    const resolved = resolveLocalDate(input, TODAY);
    assert.equal(resolved.date, date, input);
    const label = resolved.time ? `${String(resolved.time.hour).padStart(2, "0")}:${String(resolved.time.minute).padStart(2, "0")}` : null;
    assert.equal(label, time, input);
  }
});

void test("month arithmetic clamps to the target month", () => {
  assert.equal(resolveLocalDate("in 1 month", "2027-01-31").date, "2027-02-28");
});

void test("unreadable or impossible dates are rejected with the accepted forms", () => {
  for (const input of ["someday", "2026-02-30", "feb 30", "13pm", "25:00", "next blursday", "in 3 fortnights"]) {
    assert.throws(() => resolveLocalDate(input, TODAY), (error) => error instanceof RelativeDateError && error.message.includes("YYYY-MM-DD"), input);
  }
});

void test("a time maps to the earliest due slot that is not before it", () => {
  assert.equal(dueDateSlotForTime({ hour: 8, minute: 0 }), "morning");
  assert.equal(dueDateSlotForTime({ hour: 9, minute: 0 }), "morning");
  assert.equal(dueDateSlotForTime({ hour: 13, minute: 0 }), "afternoon");
  assert.equal(dueDateSlotForTime({ hour: 13, minute: 1 }), "endOfWorkDay");
  assert.equal(dueDateSlotForTime({ hour: 18, minute: 0 }), "anyTime");
});
