import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { fastifyRequestContext, requestContext } from "@fastify/request-context";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import scalarApiReference from "@scalar/fastify-api-reference";
import type { FastifyReply, FastifyServerOptions } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { OpenAPIV3 } from "openapi-types";
import authPlugin from "./auth/plugin.js";
import { db } from "./db.js";
import { getPublicOpenApiDocument, publicWebhookEventTypes } from "./docs/public-openapi.js";
import { env } from "./env.js";
import { clientIpForRequest } from "./lib/client-ip.js";
import { registerErrorHandler } from "./lib/errors.js";
import mailerPlugin from "./lib/mailer-plugin.js";
import { registerMetrics } from "./lib/metrics.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter, type RateLimitPolicy } from "./lib/rate-limit.js";
import { helmetSecurityOptionsWithoutCsp, registerApiContentSecurityPolicy, registerSecurityHeaderFallbacks } from "./lib/security-headers.js";
import { resolveLocalUploadsRoot } from "./lib/storage/local.js";
import type { SweepScheduler } from "./lib/sweep-scheduler.js";
import { startWebhookDeliveryScheduler } from "./lib/webhooks.js";
import { activityRoutes } from "./modules/activity/routes.js";
import { assignedWorkRoutes } from "./modules/assigned-work/routes.js";
import { assignedWorkSeparatorRoutes } from "./modules/assigned-work-separators/routes.js";
import { boardRoutes } from "./modules/boards/routes.js";
import { cardLabelRoutes } from "./modules/card-labels/routes.js";
import { cardAttachmentRoutes } from "./modules/cards/attachments.routes.js";
import { cardRoutes } from "./modules/cards/routes.js";
import { commentRoutes } from "./modules/comments/routes.js";
import { customFieldRoutes } from "./modules/custom-fields/routes.js";
import { externalLinkRoutes } from "./modules/external-links/routes.js";
import { listRoutes } from "./modules/lists/routes.js";
import { mediaRoutes } from "./modules/media/routes.js";
import { noteRoutes } from "./modules/notes/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { separatorRoutes } from "./modules/separators/routes.js";
import { workspaceRoutes } from "./modules/workspaces/routes.js";
import { setRealtimeLogger } from "./realtime/metrics.js";
import { initRedis } from "./redis.js";

declare module "@fastify/request-context" {
  interface RequestContextData {
    requestId: string;
    requestStartedAt?: number;
    clientId?: string;
    userId?: string;
    workspaceId?: string;
    realtimeOutboxOnly?: boolean;
  }
}

const REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_LOG_LEVEL = env.NODE_ENV === "development" ? "debug" : "info";

export interface PublicApiRateLimitOptions {
  enabled?: boolean;
  windowMs?: number;
  ipLimitPerMinute?: number;
  failedApiKeyLimitPerMinute?: number;
  apiKeyLimitPerMinute?: number;
  uploadLimitPerMinute?: number;
}

export interface BuildPublicApiServerOptions {
  logger?: FastifyServerOptions["logger"];
  uploadsDir?: string;
  enableWebhookDeliveryScheduler?: boolean;
  slowRequestLogMs?: number;
  rateLimit?: PublicApiRateLimitOptions;
}

export async function buildPublicApiServer(options: BuildPublicApiServerOptions = {}) {
  await initRedis();
  const slowRequestLogMs = options.slowRequestLogMs ?? env.SLOW_REQUEST_LOG_MS;
  const rateLimitOptions = {
    enabled: options.rateLimit?.enabled ?? env.PUBLIC_API_RATE_LIMIT_ENABLED,
    windowMs: options.rateLimit?.windowMs ?? env.PUBLIC_API_RATE_LIMIT_WINDOW_MS,
    ipLimitPerMinute: options.rateLimit?.ipLimitPerMinute ?? env.PUBLIC_API_IP_RATE_LIMIT_PER_MINUTE,
    failedApiKeyLimitPerMinute: options.rateLimit?.failedApiKeyLimitPerMinute ?? env.PUBLIC_API_FAILED_KEY_RATE_LIMIT_PER_MINUTE,
    apiKeyLimitPerMinute: options.rateLimit?.apiKeyLimitPerMinute ?? env.PUBLIC_API_KEY_RATE_LIMIT_PER_MINUTE,
    uploadLimitPerMinute: options.rateLimit?.uploadLimitPerMinute ?? env.PUBLIC_API_UPLOAD_RATE_LIMIT_PER_MINUTE,
  };
  const requestStartedAt = new WeakMap<object, number>();
  const app = Fastify({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    trustProxy: env.PUBLIC_API_TRUST_PROXY,
    logger: options.logger ?? {
      level: DEFAULT_LOG_LEVEL,
      ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      redact: { paths: ["req.headers.authorization", "*.secret", "*.token"], censor: "[REDACTED]" },
      mixin() {
        const requestId = requestContext.get("requestId");
        const clientId = requestContext.get("clientId");
        const userId = requestContext.get("userId");
        return {
          ...(requestId ? { requestId } : {}),
          ...(clientId ? { clientId } : {}),
          ...(userId ? { userId } : {}),
        };
      },
    },
    genReqId: () => randomUUID(),
    requestIdHeader: REQUEST_ID_HEADER,
  });
  setRealtimeLogger(app.log);

  // Constructed after the app so the limiter can fail open and log against the request logger when
  // Valkey is unavailable, instead of letting an outage 500 every request on this hot path.
  const rateLimiter = rateLimitOptions.enabled ? new FixedWindowRateLimiter(rateLimitOptions.windowMs, { log: app.log }) : null;

  await app.register(fastifyRequestContext, {
    defaultStoreValues: (req) => ({
      requestId: req.id,
      requestStartedAt: performance.now(),
      // The public API does not host Socket.IO. Reused app routes should persist realtime rows for
      // the app/worker dispatcher instead of treating another in-process test server's io as inline delivery.
      realtimeOutboxOnly: true,
    }),
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    return payload;
  });
  app.addHook("onRequest", async (req) => {
    requestStartedAt.set(req, performance.now());
  });
  app.addHook("onResponse", async (req, reply) => {
    if (slowRequestLogMs === 0) return;
    const startedAt = requestStartedAt.get(req) ?? requestContext.get("requestStartedAt");
    requestStartedAt.delete(req);
    if (startedAt === undefined) return;
    const durationMs = performance.now() - startedAt;
    if (durationMs < slowRequestLogMs) return;
    // Per-request forensic record (exact url + requestId), shipped to Loki by Alloy. Aggregate latency
    // alerting lives in Grafana (p95 rule) — we deliberately do NOT also fire a per-request ops webhook.
    req.log.warn({
      durationMs: Math.round(durationMs),
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
    }, "slow request");
  });

  await app.register(helmet, helmetSecurityOptionsWithoutCsp);
  registerSecurityHeaderFallbacks(app);
  registerApiContentSecurityPolicy(app);
  await app.register(cors, { origin: true, credentials: false, methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"] });
  await app.register(cookie);
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: env.ATTACHMENT_MAX_BYTES, files: 1 } });
  await app.register(authPlugin);
  await app.register(mailerPlugin);

  const checkRateLimit = async (key: string, policy: RateLimitPolicy, reply: FastifyReply) => {
    if (!rateLimiter) return false;
    const result = await rateLimiter.check(key, policy);
    applyRateLimitHeaders(reply, result);
    if (result.allowed) return false;
    reply.status(429).send({ code: "RATE_LIMITED", message: "rate limit exceeded" });
    return true;
  };
  const wouldRateLimit = async (key: string, policy: RateLimitPolicy, reply: FastifyReply) => {
    if (!rateLimiter) return false;
    const result = await rateLimiter.wouldLimit(key, policy);
    if (result.allowed) return false;
    applyRateLimitHeaders(reply, result);
    reply.status(429).send({ code: "RATE_LIMITED", message: "rate limit exceeded" });
    return true;
  };

  app.addHook("preHandler", async (req, reply) => {
    // Docs and discovery helpers are unauthenticated, so protect them by client IP.
    // /metrics is exempt: it is token-gated (not IP-gated) and scraped on a fixed interval by Prometheus.
    if (req.method === "OPTIONS" || req.url === "/health" || req.url === "/metrics" || req.url.startsWith("/api/v1/")) return;
    if (await checkRateLimit(`ip:${clientIpForRequest(req)}`, { limit: rateLimitOptions.ipLimitPerMinute, windowMs: rateLimitOptions.windowMs }, reply)) return reply;
  });

  await app.register(swagger, {
    mode: "static",
    specification: { document: getPublicOpenApiDocument() as unknown as OpenAPIV3.Document },
  });
  await app.register(scalarApiReference, {
    routePrefix: "/docs",
    configuration: {
      title: "Kanera Public API",
      url: "/openapi.json",
      layout: "modern",
      theme: "default",
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/swagger",
    uiConfig: {
      deepLinking: true,
      displayOperationId: true,
      docExpansion: "list",
    },
  });

  const uploadsRoot = resolveLocalUploadsRoot(options.uploadsDir ?? env.UPLOADS_DIR);
  await mkdir(uploadsRoot, { recursive: true });

  registerErrorHandler(app, { service: "public-api" });
  app.addHook("onClose", async () => rateLimiter?.close());
  app.get("/health", async () => ({ ok: true, service: "public-api" }));
  // Token-gated inside registerMetrics: this server is the internet-facing one, so /metrics must not be
  // anonymously scrapeable. It is registered before the /api/v1 rate-limit scope so scrapes are not throttled.
  registerMetrics(app);
  app.get("/openapi.json", async () => getPublicOpenApiDocument());
  app.get("/webhook-event-types", async () => ({ eventTypes: publicWebhookEventTypes }));
  await app.register(mediaRoutes);

  const prefix = "/api/v1";
  await app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => {
      // Missing or non-API-key auth cannot be keyed by workspace key yet.
      if (req.method === "OPTIONS") return;
      const authorization = req.headers.authorization;
      if (authorization?.startsWith("Bearer kanera_")) {
        const failedKeyPolicy = { limit: rateLimitOptions.failedApiKeyLimitPerMinute, windowMs: rateLimitOptions.windowMs };
        // Once an IP exhausts failed key auth, block before validation; avoiding the DB lookup means
        // we cannot know whether the next kanera_* token would have been valid.
        if (await wouldRateLimit(`failedApiKey:${clientIpForRequest(req)}`, failedKeyPolicy, reply)) return reply;
        return;
      }
      if (await checkRateLimit(`ip:${clientIpForRequest(req)}`, { limit: rateLimitOptions.ipLimitPerMinute, windowMs: rateLimitOptions.windowMs }, reply)) return reply;
    });
    api.addHook("preHandler", async (req, reply) => {
      const authorization = req.headers.authorization;
      try {
        await api.authenticate(req, reply);
      } catch (error) {
        if (req.method === "OPTIONS" || !authorization?.startsWith("Bearer kanera_")) throw error;
        const failedKeyPolicy = { limit: rateLimitOptions.failedApiKeyLimitPerMinute, windowMs: rateLimitOptions.windowMs };
        if (await checkRateLimit(`failedApiKey:${clientIpForRequest(req)}`, failedKeyPolicy, reply)) return reply;
        throw error;
      }
    });
    api.addHook("preHandler", async (req, reply) => {
      // Valid API-key requests get their own bucket after authentication resolves the key id.
      if (req.method === "OPTIONS") return;
      const apiKeyId = req.auth.apiKeyId;
      const key = apiKeyId ? `apiKey:${apiKeyId}` : `ip:${clientIpForRequest(req)}`;
      const isUpload = req.method === "POST" && /^\/api\/v1\/cards\/[^/]+\/attachments(?:\?|$|\/)/.test(req.url);
      const policy = {
        limit: isUpload ? rateLimitOptions.uploadLimitPerMinute : rateLimitOptions.apiKeyLimitPerMinute,
        windowMs: rateLimitOptions.windowMs,
      };
      if (await checkRateLimit(key, policy, reply)) return reply;
    });

    await api.register(workspaceRoutes);
    await api.register(boardRoutes);
    await api.register(assignedWorkRoutes);
    await api.register(assignedWorkSeparatorRoutes);
    await api.register(searchRoutes);
    await api.register(listRoutes);
    await api.register(noteRoutes);
    // Public API card mutations intentionally reuse the app card routes, so
    // shared side effects such as activity, realtime outbox, and automations stay aligned.
    await api.register(cardRoutes);
    await api.register(separatorRoutes);
    await api.register(cardAttachmentRoutes);
    await api.register(customFieldRoutes);
    await api.register(externalLinkRoutes);
    await api.register(cardLabelRoutes);
    await api.register(commentRoutes);
    await api.register(activityRoutes);
  }, { prefix });

  let webhookDeliveryScheduler: SweepScheduler | null = null;
  app.addHook("onClose", async () => webhookDeliveryScheduler?.stop());
  app.ready(() => {
    if (options.enableWebhookDeliveryScheduler ?? false) {
      webhookDeliveryScheduler = startWebhookDeliveryScheduler({ log: app.log });
    }
  });

  return app;
}

export { db };
