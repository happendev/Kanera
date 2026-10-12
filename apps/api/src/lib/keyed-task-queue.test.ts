import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyedTaskQueue } from "./keyed-task-queue.js";

// Browser timing cannot hold exactly one task between enqueue and settlement. Catch same-key
// overlap, lost final hide/update state, cross-key head-of-line blocking, and failure wedging idle.
void test("keys serialize, pending snapshots coalesce, other keys progress, and failure drains", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let progressed!: () => void;
  const otherDone = new Promise<void>((resolve) => { progressed = resolve; });
  const calls: string[] = [], errors: unknown[] = [];
  const failure = new Error("injected failure");
  let active = 0, peak = 0, idle = false;
  const queue = createKeyedTaskQueue<string>(2, async (value) => {
    calls.push(value); active++; peak = Math.max(peak, active);
    try {
      if (value === "a:create") await blocked;
      if (value === "b:create") { progressed(); throw failure; }
    } finally { active--; }
  }, (error) => { errors.push(error); });
  queue.enqueue("a", "a:create");
  queue.enqueue("a", "a:update");
  queue.enqueue("a", "a:hide");
  queue.enqueue("b", "b:create");
  const settled = queue.idle().then(() => { idle = true; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([otherDone, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("unrelated key did not progress")), 1000);
    })]);
    assert.deepEqual(calls, ["a:create", "b:create"]);
    assert.equal(idle, false);
  } finally { clearTimeout(timer); release(); }
  await settled;
  assert.deepEqual(calls, ["a:create", "b:create", "a:hide"]);
  assert.deepEqual(errors, [failure]);
  assert.equal(peak, 2);
  await queue.idle();
});
