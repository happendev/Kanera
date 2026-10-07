import assert from "node:assert/strict";
import { test } from "node:test";
import { isCardInactive } from "@kanera/shared/card-timing";

// The only test of the shared inactivity boundary; card indicators and the board overview both
// rely on it, so the day boundary is pinned here rather than in a web spec.
void test("card inactivity uses the same fourteen-day boundary as card indicators", () => {
  const now = new Date("2026-08-19T12:00:00.000Z").getTime();
  assert.equal(isCardInactive("2026-08-05T12:00:00.000Z", now), true);
  assert.equal(isCardInactive("2026-08-05T12:00:00.001Z", now), false);
});

void test("card inactivity accepts a workspace-specific boundary", () => {
  const now = new Date("2026-08-19T12:00:00.000Z").getTime();
  assert.equal(isCardInactive("2026-08-09T12:00:00.000Z", now, 10), true);
  assert.equal(isCardInactive("2026-08-09T12:00:00.001Z", now, 10), false);
});
