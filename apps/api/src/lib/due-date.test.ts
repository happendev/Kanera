import assert from "node:assert/strict";
import { test } from "node:test";
import { isDueDateOverdue, localDateInTimezone } from "./due-date.js";
import { localDateParts } from "./local-date.js";
import { dateTimeFormatter } from "./date-time-formatter.js";

test("due-date cutoffs stay current across calls and zones", () => {
  for (const [slot, hour] of [["morning", 9], ["afternoon", 13], ["endOfWorkDay", 17], ["anyTime", 21]] as const) {
    const candidate = { dueDateLocalDate: "2026-09-05", dueDateSlot: slot, dueDateTimezone: "UTC" };
    assert.equal(isDueDateOverdue(candidate, new Date(`2026-09-05T${String(hour - 1).padStart(2, "0")}:59:00Z`)), false);
    assert.equal(isDueDateOverdue(candidate, new Date(`2026-09-05T${String(hour).padStart(2, "0")}:00:00Z`)), true);
    assert.equal(isDueDateOverdue({ ...candidate, dueDateTimezone: "America/New_York" }, new Date(`2026-09-05T${String(hour).padStart(2, "0")}:00:00Z`)), false);
  }
  assert.equal(isDueDateOverdue({ dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null }), false);
});

test("local dates preserve midnight, DST, fractional offsets and invalid-zone fallback", () => {
  for (const zone of ["UTC", "America/New_York", "Europe/London", "Asia/Kathmandu", "Pacific/Kiritimati", "invalid", ""]) {
    for (const instant of ["2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z", "2026-11-01T06:01:00Z", "2026-09-05T00:00:00Z"]) {
      const date = new Date(instant);
      const validZone = zone && zone !== "invalid" ? zone : "UTC";
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: validZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(date);
      const value = (type: string) => parts.find((part) => part.type === type)!.value;
      const expectedDate = `${value("year")}-${value("month")}-${value("day")}`;
      assert.equal(localDateInTimezone(date, zone), expectedDate);
      assert.equal(localDateParts(date, zone).date, expectedDate);
      assert.equal(localDateParts(date, zone).hour, zone === "invalid" || zone === "" ? date.getUTCHours() : Number(value("hour")));
      assert.equal(isDueDateOverdue({ dueDateLocalDate: expectedDate, dueDateSlot: "morning", dueDateTimezone: zone }, date), Number(value("hour")) % 24 >= 9);
    }
  }
});

test("formatter retention is bounded and failed zones do not poison valid entries", () => {
  const formatter = dateTimeFormatter({ year: "numeric" });
  const original = formatter("UTC");
  assert.equal(formatter("UTC"), original);
  assert.throws(() => formatter("invalid"), RangeError);
  assert.equal(formatter("UTC"), original);
  for (const zone of Intl.supportedValuesOf("timeZone").slice(0, 128)) formatter(zone);
  assert.notEqual(formatter("UTC"), original);
  assert.equal(formatter("UTC").format(new Date("2026-01-01Z")), "2026");
});
