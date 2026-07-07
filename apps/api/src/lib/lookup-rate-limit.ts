import type { FastifyReply, FastifyRequest } from "fastify";
import { clientIpForRequest } from "./client-ip.js";
import { tooManyRequests } from "./errors.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter } from "./rate-limit.js";

const LOOKUP_LIMIT = 30;
const LOOKUP_WINDOW_MS = 60_000;

let limiter: FixedWindowRateLimiter | null = null;

function lookupRateLimiter(req: FastifyRequest) {
  if (!limiter) {
    limiter = new FixedWindowRateLimiter(LOOKUP_WINDOW_MS, { log: req.log });
  }
  return limiter;
}

export async function enforceUnauthenticatedLookupRateLimit(req: FastifyRequest, reply: FastifyReply) {
  // Org and board invite tokens are opaque, but unauthenticated lookup still gives an enumerable
  // existence oracle. Share one modest IP bucket across lookup routes so probing one drains both.
  const result = await lookupRateLimiter(req).check(`invite-lookup:${clientIpForRequest(req)}`, {
    limit: LOOKUP_LIMIT,
    windowMs: LOOKUP_WINDOW_MS,
  });
  applyRateLimitHeaders(reply, result);
  if (!result.allowed) throw tooManyRequests();
}
