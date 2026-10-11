import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeRedis, initRedis } from "../redis.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

async function limiter() {
  await initRedis();
  return new FixedWindowRateLimiter();
}

void test("wouldLimit reports the next request without consuming the bucket", async () => {
  const rateLimiter = await limiter();
  const key = `api-key-failure:${randomUUID()}`;

  try {
    const policy = { limit: 1, windowMs: 60_000 };
    const preview = await rateLimiter.wouldLimit(key, policy);
    assert.equal(preview.allowed, true);
    assert.equal(preview.remaining, 0);

    const first = await rateLimiter.check(key, policy);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 0);

    const second = await rateLimiter.check(key, policy);
    assert.equal(second.allowed, false);
    assert.equal(second.remaining, 0);
  } finally {
    await rateLimiter.close();
  }
});

void test("wouldLimit reports exhausted buckets without incrementing them", async () => {
  const rateLimiter = await limiter();
  const key = `api-key-failure:${randomUUID()}`;

  try {
    const policy = { limit: 1, windowMs: 60_000 };
    const first = await rateLimiter.check(key, policy);
    assert.equal(first.allowed, true);

    const preview = await rateLimiter.wouldLimit(key, policy);
    assert.equal(preview.allowed, false);
    assert.equal(preview.remaining, 0);

    const stillSecond = await rateLimiter.check(key, policy);
    assert.equal(stillSecond.allowed, false);
    assert.equal(stillSecond.remaining, 0);
  } finally {
    await rateLimiter.close();
  }
});

// Queue failures this guards against: a burst within the limit being delayed, over-limit requests
// failing instead of waiting for the next window, the queue growing past its size (or an overflow
// request waiting before it fails), and a queued request outliving its deadline (beyond the MCP
// bridge's upstream timeout).
void test("queue admits the burst, holds the next requests for the following window, then rejects", async () => {
  const rateLimiter = await limiter();
  const key = `queued:${randomUUID()}`;
  const policy = { limit: 2, windowMs: 1_000 };
  const startedAt = Date.now();
  const outcomes = await Promise.all(Array.from({ length: 5 }, async () => {
    const result = await rateLimiter.queue(key, policy, { queueSize: 2, expiresAt: startedAt + 10_000 });
    return { allowed: result.allowed, ms: Date.now() - startedAt, retryAfterSeconds: result.retryAfterSeconds };
  }));
  const immediate = outcomes.filter((outcome) => outcome.allowed && outcome.ms < 500);
  const waited = outcomes.filter((outcome) => outcome.allowed && outcome.ms >= 500);
  const rejected = outcomes.filter((outcome) => !outcome.allowed);
  assert.equal(immediate.length, 2, JSON.stringify(outcomes));
  assert.equal(waited.length, 2, JSON.stringify(outcomes));
  assert.equal(rejected.length, 1, JSON.stringify(outcomes));
  assert.ok(rejected[0]!.ms < 500, "the overflow request fails fast rather than waiting");
  assert.equal(rejected[0]!.retryAfterSeconds, 1);
});

void test("queue rejects a waiting request once its deadline passes", async () => {
  const rateLimiter = await limiter();
  const key = `queued:${randomUUID()}`;
  const policy = { limit: 1, windowMs: 2_000 };
  assert.equal((await rateLimiter.queue(key, policy, { queueSize: 5, expiresAt: Date.now() + 10_000 })).allowed, true);
  // The window frees up in ~2s, after this request's deadline. Deadlines are checked whenever the
  // queue wakes for a new window, so with per-second windows they hold to within a second.
  const startedAt = Date.now();
  const late = await rateLimiter.queue(key, policy, { queueSize: 5, expiresAt: startedAt + 500 });
  assert.equal(late.allowed, false);
});

void test("a queue size of zero rejects over-limit requests immediately", async () => {
  const rateLimiter = await limiter();
  const key = `queued:${randomUUID()}`;
  const policy = { limit: 1, windowMs: 1_000 };
  const options = { queueSize: 0, expiresAt: Date.now() + 10_000 };
  assert.equal((await rateLimiter.queue(key, policy, options)).allowed, true);
  assert.equal((await rateLimiter.queue(key, policy, options)).allowed, false);
});

void test("penalty counts a request without rejecting it", async () => {
  const rateLimiter = await limiter();
  const key = `penalty:${randomUUID()}`;
  const policy = { limit: 1, windowMs: 60_000 };
  await rateLimiter.penalty(key, policy);
  await rateLimiter.penalty(key, policy);
  assert.equal((await rateLimiter.check(key, policy)).allowed, false);
});

after(async () => {
  await closeRedis();
});
