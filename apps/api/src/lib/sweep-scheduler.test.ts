import assert from "node:assert/strict";
import { test } from "node:test";
import { startSweepScheduler, type SweepScheduler } from "./sweep-scheduler.js";

// Yield through a full timer phase so the scheduler's setTimeout-based reschedules fire.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

void test("never overlaps: at most one run in flight even when a run outlives its interval", async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const scheduler: SweepScheduler = startSweepScheduler({
    name: "no-overlap",
    nextDelayMs: 0, // continue ASAP — the worst case for overlap
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs += 1;
      await tick(); // work that spans the (zero) interval
      active -= 1;
      if (runs >= 5) void scheduler.stop();
    },
  });

  for (let i = 0; i < 30 && runs < 5; i += 1) await tick();
  await scheduler.stop();

  assert.equal(maxActive, 1);
  assert.ok(runs >= 5);
});

void test("schedules the next run only after the current one settles", async () => {
  let starts = 0;
  let release!: () => void;
  const gate = () => new Promise<void>((resolve) => (release = resolve));
  const scheduler = startSweepScheduler({
    name: "after-settle",
    nextDelayMs: 0,
    task: async () => {
      starts += 1;
      await gate();
    },
  });

  await tick();
  assert.equal(starts, 1); // first run started
  await tick();
  assert.equal(starts, 1); // still 1 — the next run is blocked until this one settles

  release();
  await tick();
  await tick();
  assert.equal(starts, 2); // second run started only after the first resolved

  const stopped = scheduler.stop();
  release(); // unblock the in-flight second run
  await stopped;
});

void test("trigger() coalesces to a single rerun while a run is in flight", async () => {
  let starts = 0;
  let release!: () => void;
  const gate = () => new Promise<void>((resolve) => (release = resolve));
  const scheduler = startSweepScheduler({
    name: "coalesce",
    nextDelayMs: 60_000, // long window so only triggers can cause reruns
    task: async () => {
      starts += 1;
      await gate();
    },
  });

  await tick();
  assert.equal(starts, 1);

  scheduler.trigger();
  scheduler.trigger();
  scheduler.trigger();
  await tick();
  assert.equal(starts, 1); // run still in flight — no overlap

  release();
  await tick();
  await tick();
  assert.equal(starts, 2); // exactly one coalesced rerun, not three

  release();
  await tick();
  await tick();
  assert.equal(starts, 2); // pending was cleared; no extra stacked rerun

  const stopped = scheduler.stop();
  release();
  await stopped;
});

void test("trigger() runs immediately when idle instead of waiting the window", async () => {
  let runs = 0;
  const scheduler = startSweepScheduler({
    name: "idle-trigger",
    nextDelayMs: 60_000,
    runImmediately: false, // would otherwise wait a full window before the first run
    task: async () => {
      runs += 1;
    },
  });

  await tick();
  assert.equal(runs, 0); // waiting the window

  scheduler.trigger();
  await tick();
  assert.equal(runs, 1); // trigger woke it now

  await scheduler.stop();
});

void test("result-driven nextDelayMs of 0 drains a backlog back-to-back without overlap", async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const scheduler = startSweepScheduler({
    name: "drain",
    // Mimic a batch drainer: continue immediately while batches are full, otherwise idle.
    nextDelayMs: (result) => (result?.drainedFull ? 0 : 60_000),
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs += 1;
      await tick();
      active -= 1;
      return { drainedFull: runs < 4 };
    },
  });

  for (let i = 0; i < 30 && runs < 4; i += 1) await tick();

  assert.equal(maxActive, 1);
  assert.equal(runs, 4); // three full-batch continuations, then one idle-scheduling run
  await scheduler.stop();
});

void test("stop() during a run prevents the next run", async () => {
  let runs = 0;
  const scheduler: SweepScheduler = startSweepScheduler({
    name: "stop",
    nextDelayMs: 0,
    task: async () => {
      runs += 1;
      await tick(); // let construction finish so `scheduler` is assigned before we stop it
      void scheduler.stop();
    },
  });

  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(runs, 1);
  await scheduler.stop();
});

void test("stop() waits for an in-flight run to settle", async () => {
  let release!: () => void;
  let stopped = false;
  const scheduler = startSweepScheduler({
    name: "drain-on-stop",
    nextDelayMs: 60_000,
    task: () => new Promise<void>((resolve) => {
      release = resolve;
    }),
  });

  await tick();
  const stopPromise = scheduler.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(stopped, false);

  release();
  await stopPromise;
  assert.equal(stopped, true);
});
