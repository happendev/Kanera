import type { FastifyReply } from "fastify";
import { RateLimiterMemory, RateLimiterQueue, RateLimiterQueueError, RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { getRedis, type RedisClient } from "../redis.js";

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface QueueOptions {
  /** Over-limit requests that may wait for capacity instead of failing. 0 disables queueing. */
  queueSize: number;
  /** Epoch ms after which a still-queued request is rejected instead of waiting longer. */
  expiresAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiting on rate-limiter-flexible's `RateLimiterRedis`, shared across API
 * replicas through Valkey. Callers pass a policy per check, so one limiter instance is kept per
 * (limit, window). Counters are keyed by window, not limit, so a caller whose limit changes (a plan
 * change) keeps its current window's count.
 *
 * When Valkey is unavailable the library falls back to a per-process in-memory limiter of the same
 * shape, so an outage neither 500s the request hot path nor removes limiting entirely.
 */
export class FixedWindowRateLimiter {
  private readonly redis: RedisClient;
  private readonly limiters = new Map<string, RateLimiterRedis>();
  private readonly queues = new Map<string, RateLimiterQueue>();

  constructor(options: { redis?: RedisClient } = {}) {
    this.redis = options.redis ?? getRedis();
  }

  /** Consume one request, rejecting once the window is spent. */
  async check(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    try {
      return result(policy, await this.limiter(policy).consume(key), true);
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) return result(policy, rejection, false);
      throw rejection;
    }
  }

  /** Report whether the next request would be limited, without consuming anything. */
  async wouldLimit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const current = await this.limiter(policy).get(key);
    if (!current) return { allowed: true, limit: policy.limit, remaining: policy.limit - 1, resetAt: Date.now() + policy.windowMs, retryAfterSeconds: retryAfter(policy.windowMs) };
    const next = current.consumedPoints + 1;
    const msBeforeNext = Math.max(0, current.msBeforeNext);
    return { allowed: next <= policy.limit, limit: policy.limit, remaining: Math.max(0, policy.limit - next), resetAt: Date.now() + msBeforeNext, retryAfterSeconds: retryAfter(msBeforeNext) };
  }

  /** Count a request that has already been served, without rejecting it. */
  async penalty(key: string, policy: RateLimitPolicy): Promise<void> {
    await this.limiter(policy).penalty(key);
  }

  /**
   * Consume one request, waiting in a FIFO queue for the next window instead of failing when the
   * current one is spent. The queue (rate-limiter-flexible's `RateLimiterQueue`) is per key and per
   * process, so each API replica holds at most `queueSize` waiters per key; requests beyond that,
   * or still queued at `expiresAt`, are rejected.
   */
  async queue(key: string, policy: RateLimitPolicy, options: QueueOptions): Promise<RateLimitResult> {
    const limiter = this.limiter(policy);
    const id = `${limiterId(policy)}:${options.queueSize}`;
    let queue = this.queues.get(id);
    if (!queue) {
      queue = new RateLimiterQueue(limiter, { maxQueueSize: options.queueSize });
      this.queues.set(id, queue);
    }
    try {
      const remaining = await queue.removeTokens(1, key, Math.ceil(options.expiresAt / 1000));
      return { allowed: true, limit: policy.limit, remaining, resetAt: Date.now() + policy.windowMs, retryAfterSeconds: retryAfter(policy.windowMs) };
    } catch (error) {
      if (!(error instanceof RateLimiterQueueError)) throw error;
      return { allowed: false, limit: policy.limit, remaining: 0, resetAt: Date.now() + policy.windowMs, retryAfterSeconds: retryAfter(policy.windowMs) };
    }
  }

  async close(): Promise<void> {
    // The limiter uses the shared Valkey/Redis-protocol client, so individual route plugins do not own a connection.
  }

  private limiter(policy: RateLimitPolicy): RateLimiterRedis {
    const id = limiterId(policy);
    let limiter = this.limiters.get(id);
    if (!limiter) {
      const duration = windowSeconds(policy);
      limiter = new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: `rate-limit:${duration}s`,
        points: policy.limit,
        duration,
        // Go straight to the in-memory insurance limiter while the client is reconnecting, rather
        // than holding requests until the command timeout.
        rejectIfRedisNotReady: true,
        insuranceLimiter: new RateLimiterMemory({ points: policy.limit, duration }),
      });
      this.limiters.set(id, limiter);
    }
    return limiter;
  }
}

// rate-limiter-flexible windows are whole seconds.
function windowSeconds(policy: RateLimitPolicy): number {
  return Math.max(1, Math.ceil(policy.windowMs / 1000));
}

function limiterId(policy: RateLimitPolicy): string {
  return `${policy.limit}:${windowSeconds(policy)}`;
}

function retryAfter(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function result(policy: RateLimitPolicy, res: RateLimiterRes, allowed: boolean): RateLimitResult {
  const msBeforeNext = Math.max(0, res.msBeforeNext);
  return { allowed, limit: policy.limit, remaining: res.remainingPoints, resetAt: Date.now() + msBeforeNext, retryAfterSeconds: retryAfter(msBeforeNext) };
}

/** The result whose RateLimit-* headers best describe the caller's headroom: the fewest remaining. */
export function tightestRateLimit(results: RateLimitResult[]): RateLimitResult | null {
  return results.reduce<RateLimitResult | null>((tightest, result) => {
    if (!tightest) return result;
    if (!result.allowed && tightest.allowed) return result;
    if (result.allowed !== tightest.allowed) return tightest;
    return result.remaining < tightest.remaining ? result : tightest;
  }, null);
}

export function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult) {
  reply
    .header("RateLimit-Limit", result.limit)
    .header("RateLimit-Remaining", result.remaining)
    .header("RateLimit-Reset", Math.ceil(result.resetAt / 1000));
  // Retry-After describes an active throttle, not the lifetime of the current rate-limit window.
  // Sending it on allowed requests made unrelated 4xx responses look transient to MCP clients.
  if (!result.allowed) reply.header("Retry-After", result.retryAfterSeconds);
}
