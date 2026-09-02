import assert from "node:assert/strict";
import { test } from "node:test";
import { inferDateOrder, parseCsvDate, toInstant, toLocalDate } from "./dates.js";

void test("parseCsvDate accepts ISO, named, Jira, numeric, and Excel dates", () => {
  assert.equal(toLocalDate(parseCsvDate("2025-01-01", "dmy")!, "UTC"), "2025-01-01");
  assert.equal(toLocalDate(parseCsvDate("2025/01/01", "dmy")!, "UTC"), "2025-01-01");
  assert.equal(toLocalDate(parseCsvDate("1 Jan 2025", "dmy")!, "UTC"), "2025-01-01");
  assert.equal(toLocalDate(parseCsvDate("Jan 1, 2025", "mdy")!, "UTC"), "2025-01-01");
  assert.equal(parseCsvDate("01/Jan/25 1:30 pm", "dmy")?.hour, 13);
  assert.equal(toLocalDate(parseCsvDate("45658", "dmy")!, "UTC"), "2025-01-01");
  assert.equal(parseCsvDate("1/1/70", "dmy")?.year, 1970);
  assert.equal(parseCsvDate("1/1/69", "dmy")?.year, 2069);
});

void test("inferDateOrder identifies dmy, mdy, and ambiguous columns", () => {
  assert.deepEqual(inferDateOrder(["31/01/2025"]), { order: "dmy", ambiguous: false });
  assert.deepEqual(inferDateOrder(["01/31/2025"]), { order: "mdy", ambiguous: false });
  assert.deepEqual(inferDateOrder(["01/02/2025"]), { order: "dmy", ambiguous: true });
});

void test("offset ISO instants use the selected timezone for the local day", () => {
  const parsed = parseCsvDate("2025-01-01T23:30:00Z", "dmy")!;
  assert.equal(toLocalDate(parsed, "Pacific/Auckland"), "2025-01-02");
});

void test("date-only timestamps resolve at noon in the selected timezone", () => {
  assert.equal(toInstant(parseCsvDate("2025-01-01", "dmy")!, "Pacific/Auckland").toISOString(), "2024-12-31T23:00:00.000Z");
});
