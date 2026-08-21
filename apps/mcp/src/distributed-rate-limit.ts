import { Redis } from "ioredis";

const CHECK_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { count, ttl }
`;

export type DistributedRateLimitResult = { count: number; resetAt: number };

export class McpDistributedRateLimiter {
  private readonly redis: Redis;
  private lastErrorLoggedAt = 0;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
    });
    this.redis.on("error", (error) => this.logUnavailable(error));
  }

  async check(key: string, limit: number, windowMs: number, now = Date.now()): Promise<DistributedRateLimitResult | null> {
    try {
      const redisKey = `rate-limit:v1:${windowMs}:mcp:${limit}:${key}`;
      const [countValue, ttlValue] = await this.redis.eval(CHECK_SCRIPT, 1, redisKey, windowMs) as [number | string, number | string];
      return { count: Number(countValue), resetAt: now + Math.max(0, Number(ttlValue)) };
    } catch (error) {
      // The bounded in-process limiter remains active during a Valkey outage, so this fallback
      // degrades replica-wide coordination without leaving the public endpoint unprotected.
      this.logUnavailable(error);
      return null;
    }
  }

  close() {
    this.redis.disconnect();
  }

  private logUnavailable(error: unknown) {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < 30_000) return;
    this.lastErrorLoggedAt = now;
    console.warn(`[mcp-rate-limit] Valkey unavailable; using bounded local limiter: ${error instanceof Error ? error.message : String(error)}`);
  }
}
