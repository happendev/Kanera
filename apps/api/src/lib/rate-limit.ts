import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { getRedis, type RedisClient } from "../redis.js";

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

const CHECK_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { count, ttl }
`;

export class FixedWindowRateLimiter {
  private readonly redis: RedisClient;
  private readonly log?: FastifyBaseLogger;

  constructor(private readonly defaultWindowMs = 60_000, options: { redis?: RedisClient; log?: FastifyBaseLogger } = {}) {
    this.redis = options.redis ?? getRedis();
    this.log = options.log;
  }

  async check(key: string, policy: RateLimitPolicy, now = Date.now()): Promise<RateLimitResult> {
    const redisKey = this.key(key, policy);
    try {
      const [countValue, ttlValue] = await this.redis.eval(CHECK_SCRIPT, 1, redisKey, policy.windowMs) as [number | string, number | string];
      const count = Number(countValue);
      const ttlMs = Math.max(0, Number(ttlValue));
      return this.result(policy, count, now + ttlMs, now);
    } catch (err) {
      // Fail open: a Valkey outage must not take down the request hot path. Treat the request as the
      // first in its window (allowed) and log so the degraded limiter is visible rather than silent.
      this.log?.warn({ err }, "rate limiter unavailable; allowing request (fail-open)");
      return this.result(policy, 1, now + policy.windowMs, now);
    }
  }

  async wouldLimit(key: string, policy: RateLimitPolicy, now = Date.now()): Promise<RateLimitResult> {
    const redisKey = this.key(key, policy);
    try {
      const [current, ttl] = await Promise.all([this.redis.get(redisKey), this.redis.pttl(redisKey)]);
      const count = Number(current ?? 0) + 1;
      const resetAt = ttl > 0 ? now + ttl : now + policy.windowMs;
      return this.result(policy, count, resetAt, now);
    } catch (err) {
      this.log?.warn({ err }, "rate limiter unavailable; allowing request (fail-open)");
      return this.result(policy, 1, now + policy.windowMs, now);
    }
  }

  async close(): Promise<void> {
    // The limiter uses the shared Valkey/Redis-protocol client, so individual route plugins do not own a connection.
  }

  private result(policy: RateLimitPolicy, count: number, resetAt: number, now: number): RateLimitResult {
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    const remaining = Math.max(0, policy.limit - count);
    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining,
      resetAt,
      retryAfterSeconds,
    };
  }

  private key(key: string, policy: RateLimitPolicy): string {
    return `rate-limit:v1:${policy.windowMs || this.defaultWindowMs}:${key}`;
  }
}

export function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult) {
  reply
    .header("RateLimit-Limit", result.limit)
    .header("RateLimit-Remaining", result.remaining)
    .header("RateLimit-Reset", Math.ceil(result.resetAt / 1000))
    .header("Retry-After", result.retryAfterSeconds);
}
