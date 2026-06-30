import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeRedis, initRedis } from "../redis.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

async function limiter() {
  await initRedis();
  return new FixedWindowRateLimiter(60_000);
}

void test("wouldLimit reports the next request without consuming the bucket", async () => {
  const rateLimiter = await limiter();
  const key = `api-key-failure:${randomUUID()}`;

  try {
    const policy = { limit: 1, windowMs: 60_000 };
    const preview = await rateLimiter.wouldLimit(key, policy, 1_000);
    assert.equal(preview.allowed, true);
    assert.equal(preview.remaining, 0);

    const first = await rateLimiter.check(key, policy, 1_000);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 0);

    const second = await rateLimiter.check(key, policy, 1_000);
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
    const first = await rateLimiter.check(key, policy, 1_000);
    assert.equal(first.allowed, true);

    const preview = await rateLimiter.wouldLimit(key, policy, 1_000);
    assert.equal(preview.allowed, false);
    assert.equal(preview.remaining, 0);

    const stillSecond = await rateLimiter.check(key, policy, 1_000);
    assert.equal(stillSecond.allowed, false);
    assert.equal(stillSecond.remaining, 0);
  } finally {
    await rateLimiter.close();
  }
});

after(async () => {
  await closeRedis();
});
