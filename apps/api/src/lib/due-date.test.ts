import assert from "node:assert/strict";
import { test } from "node:test";
import { isDueDateOverdue, localDateInTimezone, resolveDueDatePatch } from "./due-date.js";
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
  // Whole-day comparison comes before the slot boundary: yesterday is overdue at any hour, tomorrow never is.
  const dated = { dueDateLocalDate: "2026-05-24", dueDateSlot: "morning" as const, dueDateTimezone: "UTC" };
  assert.equal(isDueDateOverdue(dated, new Date("2026-05-25T00:00:00Z")), true);
  assert.equal(isDueDateOverdue(dated, new Date("2026-05-23T23:59:00Z")), false);
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

// Failure modes this guards: (1) a slot-only patch coalescing the omitted date to null and wiping
// the due date; (2) clearing the slot wiping the date the same way; (3) a slot being attached to an
// undated card; (4) a full date patch no longer defaulting the slot or capturing the actor's zone.
test("resolveDueDatePatch keeps the stored date when only the slot changes", () => {
  const current = { dueDateLocalDate: "2026-10-20", dueDateSlot: "morning" as const, dueDateTimezone: "Europe/London" };
  assert.deepEqual(resolveDueDatePatch({ dueDateSlot: "afternoon" }, current, "UTC"), {
    kind: "write", dueDateLocalDate: "2026-10-20", dueDateSlot: "afternoon", dueDateTimezone: "Europe/London",
  });
  // Clearing the slot resets it to the default for a dated card rather than deleting the date.
  assert.deepEqual(resolveDueDatePatch({ dueDateSlot: null }, current, "UTC"), {
    kind: "write", dueDateLocalDate: "2026-10-20", dueDateSlot: "anyTime", dueDateTimezone: "Europe/London",
  });
  // A stored date without a zone (legacy rows) borrows the actor's zone.
  assert.deepEqual(resolveDueDatePatch({ dueDateSlot: "afternoon" }, { ...current, dueDateTimezone: null }, "Asia/Tokyo"), {
    kind: "write", dueDateLocalDate: "2026-10-20", dueDateSlot: "afternoon", dueDateTimezone: "Asia/Tokyo",
  });
});

test("resolveDueDatePatch rejects a slot for an undated card and ignores clearing one", () => {
  const undated = { dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null };
  assert.deepEqual(resolveDueDatePatch({ dueDateSlot: "afternoon" }, undated, "UTC"), {
    kind: "rejected", reason: "provide dueDateLocalDate when setting dueDateSlot",
  });
  assert.deepEqual(resolveDueDatePatch({ dueDateSlot: null }, undated, "UTC"), { kind: "unchanged" });
  assert.deepEqual(resolveDueDatePatch({}, undated, "UTC"), { kind: "unchanged" });
});

test("resolveDueDatePatch sets and clears whole due dates as before", () => {
  const current = { dueDateLocalDate: "2026-10-20", dueDateSlot: "morning" as const, dueDateTimezone: "Europe/London" };
  assert.deepEqual(resolveDueDatePatch({ dueDateLocalDate: "2026-11-01" }, current, "Asia/Tokyo"), {
    kind: "write", dueDateLocalDate: "2026-11-01", dueDateSlot: "anyTime", dueDateTimezone: "Asia/Tokyo",
  });
  assert.deepEqual(resolveDueDatePatch({ dueDateLocalDate: "2026-11-01", dueDateSlot: "endOfWorkDay" }, current, "Asia/Tokyo"), {
    kind: "write", dueDateLocalDate: "2026-11-01", dueDateSlot: "endOfWorkDay", dueDateTimezone: "Asia/Tokyo",
  });
  assert.deepEqual(resolveDueDatePatch({ dueDateLocalDate: null }, current, "Asia/Tokyo"), {
    kind: "write", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null,
  });
  // Explicit null date wins over a slot sent alongside it.
  assert.deepEqual(resolveDueDatePatch({ dueDateLocalDate: null, dueDateSlot: "morning" }, current, "UTC"), {
    kind: "write", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null,
  });
});
