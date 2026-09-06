import assert from "node:assert/strict";
import { test } from "node:test";
import { ExpiringCache } from "./expiring-cache.js";

void test("sweeps expired cold entries without reads or writes and restarts after becoming empty", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  const cache = new ExpiringCache<string>(10, 100);
  t.after(() => cache.clear());
  cache.set("cold", "metadata", 1_050);
  t.mock.timers.tick(100);
  assert.equal(cache.size, 0);
  cache.set("next", "token", 1_150);
  t.mock.timers.tick(100);
  assert.equal(cache.size, 0);
});

void test("capacity evicts expired entries before live entries and stays bounded on unique-key churn", (t) => {
  const cache = new ExpiringCache<number>(3);
  t.after(() => cache.clear());
  cache.set("live", 1, 100, 0);
  cache.set("expired", 2, 10, 0);
  cache.set("live-2", 3, 100, 0);
  cache.set("new", 4, 100, 20);
  assert.equal(cache.get("live", 20), 1);
  assert.equal(cache.get("expired", 20), undefined);
  assert.equal(cache.size, 3);
  for (let i = 0; i < 100; i++) cache.set(String(i), i, 100, 20);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("live", 20), undefined);
  assert.equal(cache.get("99", 20), 99);
});

void test("refreshing a key replaces its deadline without evicting another entry", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  const cache = new ExpiringCache<string>(2, 100);
  t.after(() => cache.clear());
  cache.set("a", "old", 1_050);
  cache.set("b", "other", 1_500);
  cache.set("a", "new", 1_500);
  t.mock.timers.tick(100);
  assert.equal(cache.get("a"), "new");
  assert.equal(cache.get("b"), "other");
  assert.equal(cache.size, 2);
});

void test("expired and invalid deadlines never produce a cache hit; clear releases all entries", (t) => {
  const cache = new ExpiringCache<string>(3);
  t.after(() => cache.clear());
  cache.set("a", "value", 100, 0);
  assert.equal(cache.get("a", 100), undefined);
  cache.set("a", "expired", 100, 100);
  cache.set("b", "invalid", NaN, 100);
  assert.equal(cache.size, 0);
  cache.set("a", "value", 200, 100);
  cache.clear();
  assert.equal(cache.get("a", 100), undefined);
  assert.equal(cache.size, 0);
});
