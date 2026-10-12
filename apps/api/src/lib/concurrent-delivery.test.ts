import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachConcurrent } from "./concurrent-delivery.js";

// E2E cannot deterministically pause individual outbound connections. These gates catch unused
// capacity behind a slow recipient and early rejection that would break scheduler single-flight.
void test("a slow delivery does not idle other slots, and errors wait for every claimed item", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let reachedLast!: () => void;
  const progressed = new Promise<void>((resolve) => { reachedLast = resolve; });
  const failure = new Error("delivery failed");
  let active = 0;
  let peak = 0;
  let settled = false;
  const started: number[] = [];
  const run = forEachConcurrent([0, 1, 2, 3, 4], 2, async (id) => {
    active++;
    peak = Math.max(peak, active);
    started.push(id);
    try {
      if (id === 0) await blocked;
      if (id === 1) throw failure;
      if (id === 4) reachedLast();
    } finally { active--; }
  });
  const outcome = run.then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([progressed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Free slot did not advance beyond a blocked delivery")), 1000);
    })]);
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
    assert.equal(settled, false);
  } finally { clearTimeout(timer); release(); }
  const error = await outcome;
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [failure]);
  assert.equal(active, 0);
});
