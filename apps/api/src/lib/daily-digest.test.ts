import assert from "node:assert/strict";
import { test } from "node:test";
import { delayToNextHour } from "./daily-digest.js";

void test("daily digest scheduler starts at the next hour boundary", () => {
  assert.equal(delayToNextHour(new Date("2026-05-26T08:15:30.000Z")), 44 * 60_000 + 30_000);
  assert.equal(delayToNextHour(new Date("2026-05-26T08:59:59.500Z")), 1_000);
});
