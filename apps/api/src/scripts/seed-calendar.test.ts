import assert from "node:assert/strict";
import { test } from "node:test";
import { seedActivityTime, seedCalendar, seedNotificationTime } from "./seed-calendar.js";

// Pure calendar failures: weekend resets stamping work on Sunday, moving future plans back to
// Friday, DST changing the London cut-off, and weekend projection reversing event order.
for (const [reference, workDate, planningDate] of [
  ["2026-10-23", "2026-10-23", "2026-10-23"],
  ["2026-10-24", "2026-10-23", "2026-10-26"],
  ["2026-10-25", "2026-10-23", "2026-10-26"],
  ["2026-10-26", "2026-10-26", "2026-10-26"],
] as const) {
  test(`seed work and planning dates for ${reference}`, () => {
    const calendar = seedCalendar(reference);
    assert.equal(calendar.date, reference);
    assert.equal(calendar.activityInstant.toISOString().slice(0, 10), workDate);
    assert.equal(calendar.business(0), planningDate);
    assert.ok(calendar.activityInstant <= calendar.instant);
  });
}

test("weekend history ends on Friday in London across both DST changes", () => {
  assert.equal(seedActivityTime(new Date("2026-03-29T10:00:00Z")).toISOString(), "2026-03-27T17:00:00.000Z");
  assert.equal(seedActivityTime(new Date("2026-10-25T10:00:00Z")).toISOString(), "2026-10-23T16:00:00.000Z");
  // This is already Saturday in London, despite still being Friday in UTC.
  assert.equal(seedActivityTime(new Date("2026-10-23T23:30:00Z")).toISOString(), "2026-10-23T16:00:00.000Z");
});

test("projected history preserves order and leaves weekday work untouched", () => {
  const times = ["2026-10-23T15:30:00Z", "2026-10-23T20:00:00Z", "2026-10-24T01:00:00Z", "2026-10-25T10:00:00Z", "2026-10-26T09:00:00Z"];
  const projected = times.map((value) => seedActivityTime(new Date(value)).getTime());
  assert.deepEqual(projected, [...projected].sort((a, b) => a - b));
  const original = new Date(times[0]!);
  assert.equal(seedActivityTime(original).getTime(), original.getTime());
  assert.equal(original.toISOString(), "2026-10-23T15:30:00.000Z");
});

// An E2E run cannot choose its wall-clock weekday or DST offset. Keep these clock boundaries deterministic.
test("notification history uses prior working days, distinct times and London daylight saving", () => {
  for (const reference of ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]) {
    const recent = seedNotificationTime(reference, { workingDaysAgo: 1, hour: 9, minute: 17 });
    const conversation = seedNotificationTime(reference, { workingDaysAgo: 2, hour: 12, minute: 9 });
    assert.ok(conversation < recent);
    assert.ok(recent < seedCalendar(reference).instant);
    assert.ok(![0, 6].includes(recent.getUTCDay()));
    assert.ok(![0, 6].includes(conversation.getUTCDay()));
  }
  assert.equal(seedNotificationTime("2026-10-25", { workingDaysAgo: 1, hour: 12, minute: 9 }).toISOString(), "2026-10-23T11:09:00.000Z");
  assert.equal(seedNotificationTime("2026-10-26", { workingDaysAgo: 2, hour: 12, minute: 9 }).toISOString(), "2026-10-22T11:09:00.000Z");
  assert.equal(seedNotificationTime("2026-03-30", { workingDaysAgo: 1, hour: 12, minute: 9 }).toISOString(), "2026-03-27T12:09:00.000Z");
});
