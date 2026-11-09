import type { FastifyReply, FastifyRequest } from "fastify";
import { clientIpForRequest } from "./client-ip.js";
import { tooManyRequests } from "./errors.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter } from "./rate-limit.js";

const LOOKUP_LIMIT = 30;
const LOOKUP_WINDOW_MS = 60_000;

let limiter: FixedWindowRateLimiter | null = null;

function lookupRateLimiter() {
  if (!limiter) {
    limiter = new FixedWindowRateLimiter();
  }
  return limiter;
}

export async function enforceUnauthenticatedLookupRateLimit(req: FastifyRequest, reply: FastifyReply) {
  // Org and board invite tokens are opaque, but unauthenticated lookup still gives an enumerable
  // existence oracle. Share one modest IP bucket across lookup routes so probing one drains both.
  await enforceIpBucket(req, reply, "invite-lookup");
}

export async function enforcePushSubscriptionRefreshRateLimit(req: FastifyRequest, reply: FastifyReply) {
  // The service worker rotates a push subscription rarely (one pushsubscriptionchange per device),
  // but the endpoint is unauthenticated and every call costs a subscription lookup. The old auth
  // secret already blocks forged updates; this bucket only caps the lookup volume one IP can cause.
  await enforceIpBucket(req, reply, "push-subscription-refresh");
}

async function enforceIpBucket(req: FastifyRequest, reply: FastifyReply, bucket: string) {
  const result = await lookupRateLimiter().check(`${bucket}:${clientIpForRequest(req)}`, {
    limit: LOOKUP_LIMIT,
    windowMs: LOOKUP_WINDOW_MS,
  });
  applyRateLimitHeaders(reply, result);
  if (!result.allowed) throw tooManyRequests();
}
