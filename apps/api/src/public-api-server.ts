import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { fastifyRequestContext, requestContext } from "@fastify/request-context";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import scalarApiReference from "@scalar/fastify-api-reference";
import type { FastifyReply, FastifyRequest, FastifyServerOptions } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { OpenAPIV3 } from "openapi-types";
import { clients, users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import authPlugin from "./auth/plugin.js";
import { db } from "./db.js";
import { getPublicOpenApiDocument, publicWebhookEventTypes } from "./docs/public-openapi.js";
import { env } from "./env.js";
import { clientIpForRequest } from "./lib/client-ip.js";
import { registerErrorHandler } from "./lib/errors.js";
import mailerPlugin from "./lib/mailer-plugin.js";
import { registerMetrics } from "./lib/metrics.js";
import { registerPublicApiIdempotency } from "./lib/public-api-idempotency.js";
import { withSignedMedia } from "./lib/media-keys.js";
import { localParts } from "./lib/due-date.js";
import type { ApiRateTier } from "./lib/api-rate-limit.js";
import { AppError } from "./lib/errors.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter, tightestRateLimit, type RateLimitPolicy, type RateLimitResult } from "./lib/rate-limit.js";
import { helmetSecurityOptionsWithoutCsp, registerApiContentSecurityPolicy, registerSecurityHeaderFallbacks } from "./lib/security-headers.js";
import { resolveLocalUploadsRoot } from "./lib/storage/local.js";
import type { SweepScheduler } from "./lib/sweep-scheduler.js";
import { startWebhookDeliveryScheduler } from "./lib/webhooks.js";
import { activityRoutes } from "./modules/activity/routes.js";
import { agentWorkQueryRoutes, agentWorkRoutes } from "./modules/work/routes.js";
import { scratchpadRoutes } from "./modules/scratchpad/routes.js";
import { automationRoutes } from "./modules/automations/routes.js";
import { boardRoutes } from "./modules/boards/routes.js";
import { cardLabelRoutes } from "./modules/card-labels/routes.js";
import { cardPriorityRoutes } from "./modules/card-priorities/routes.js";
import { cardAttachmentRoutes } from "./modules/cards/attachments.routes.js";
import { attachmentUploadRoutes, uploadLinkRoutes } from "./modules/cards/upload-links.routes.js";
import { cardRoutes } from "./modules/cards/routes.js";
import { commentRoutes } from "./modules/comments/routes.js";
import { customFieldRoutes } from "./modules/custom-fields/routes.js";
import { agentRunRoutes } from "./modules/agent-runs/routes.js";
import { externalLinkRoutes } from "./modules/external-links/routes.js";
import { mcpEventRoutes } from "./modules/integrations/mcp-events.routes.js";
import type { McpWebhookRequest } from "./lib/mcp-event-webhooks.js";
import { webhookEndpointRoutes } from "./modules/integrations/webhook-endpoint.routes.js";
import { listRoutes } from "./modules/lists/routes.js";
import { mediaRoutes } from "./modules/media/routes.js";
import { noteRoutes } from "./modules/notes/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { separatorRoutes } from "./modules/separators/routes.js";
import { workspaceRoutes } from "./modules/workspaces/routes.js";
import { setRealtimeLogger } from "./realtime/metrics.js";
import { oauthPublicRoutes } from "./oauth/routes.js";
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
  apiKeyLimitPerSecond?: number;
  freeUserLimitPerSecond?: number;
  freeUserLimitPerMinute?: number;
  queueSize?: number;
  queueMaxWaitMs?: number;
}

type AgentRateLimits = { perSecond: number; perMinute: number };
type MeteredScope = { kind: "ceiling" } | { kind: "organisation"; tier: ApiRateTier; clientId: string };
type MeteredBucket = { key: string; limit: number; windowMs: number; scope: MeteredScope; window: "second" | "minute" };

const SECOND_MS = 1_000;

function meteredBuckets(prefix: string, limits: AgentRateLimits, scope: MeteredScope, minuteWindowMs: number): MeteredBucket[] {
  return [
    { key: `${prefix}:second`, limit: limits.perSecond, windowMs: SECOND_MS, scope, window: "second" },
    { key: `${prefix}:minute`, limit: limits.perMinute, windowMs: minuteWindowMs, scope, window: "minute" },
  ];
}

// Only a Free organisation's limit explains itself: the agent can then tell its user why it slowed
// down and that the organisation's plan, not the user, sets the limit. Ceiling and Pro rejections
// keep the plain shape.
function rateLimitedError(bucket: MeteredBucket): AppError {
  if (bucket.scope.kind !== "organisation" || bucket.scope.tier !== "free") return new AppError(429, "RATE_LIMITED", "rate limit exceeded");
  const queueFull = bucket.window === "second" ? ", and the request queue is full" : "";
  return new AppError(
    429,
    "RATE_LIMITED",
    `This organisation is on the Free plan, which allows your AI agents and API keys ${bucket.limit} requests per ${bucket.window} on its boards${queueFull}. Retry shortly; Kanera Pro raises these limits.`,
    {
      limit: bucket.window === "second" ? "apiRequestsPerSecond" : "apiRequestsPerMinute",
      max: bucket.limit,
      organisationId: bucket.scope.clientId,
      upgradePlan: "paid",
    },
  );
}

export interface BuildPublicApiServerOptions {
  logger?: FastifyServerOptions["logger"];
  uploadsDir?: string;
  enableWebhookDeliveryScheduler?: boolean;
  mcpWebhookRequest?: McpWebhookRequest;
  slowRequestLogMs?: number;
  rateLimit?: PublicApiRateLimitOptions;
}

function stripInternalCoverMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripInternalCoverMetadata);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return;
  const record = value as Record<string, unknown>;
  delete record.coverImageWidth;
  delete record.coverImageHeight;
  delete record.coverImageColor;
  Object.values(record).forEach(stripInternalCoverMetadata);
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
    apiKeyLimitPerSecond: options.rateLimit?.apiKeyLimitPerSecond ?? env.PUBLIC_API_KEY_RATE_LIMIT_PER_SECOND,
    freeUserLimitPerSecond: options.rateLimit?.freeUserLimitPerSecond ?? env.HOSTED_FREE_API_RATE_LIMIT_PER_SECOND,
    freeUserLimitPerMinute: options.rateLimit?.freeUserLimitPerMinute ?? env.HOSTED_FREE_API_RATE_LIMIT_PER_MINUTE,
    queueSize: options.rateLimit?.queueSize ?? env.PUBLIC_API_RATE_LIMIT_QUEUE_SIZE,
    queueMaxWaitMs: options.rateLimit?.queueMaxWaitMs ?? env.PUBLIC_API_RATE_LIMIT_QUEUE_MAX_WAIT_MS,
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

  const rateLimiter = rateLimitOptions.enabled ? new FixedWindowRateLimiter() : null;

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
    // Handler time as seen by this process. The MCP layer subtracts it from its own round-trip
    // measurement to separate API execution from network/proxy time when diagnosing agent latency.
    const startedAt = requestStartedAt.get(req) ?? requestContext.get("requestStartedAt");
    if (startedAt !== undefined) reply.header("Server-Timing", `app;dur=${(performance.now() - startedAt).toFixed(1)}`);
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
  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: env.ATTACHMENT_MAX_BYTES, files: 1 } });
  await app.register(authPlugin);
  await app.register(mailerPlugin);
  await app.register(oauthPublicRoutes);

  const checkRateLimit = async (
    key: string,
    policy: RateLimitPolicy,
    reply: FastifyReply,
  ) => {
    if (!rateLimiter) return false;
    const result = await rateLimiter.check(key, policy);
    applyRateLimitHeaders(reply, result);
    if (result.allowed) return false;
    reply.status(429).send({ code: "RATE_LIMITED", message: "rate limit exceeded" });
    return true;
  };
  const paidLimits: AgentRateLimits = { perSecond: rateLimitOptions.apiKeyLimitPerSecond, perMinute: rateLimitOptions.apiKeyLimitPerMinute };
  const freeLimits: AgentRateLimits = { perSecond: rateLimitOptions.freeUserLimitPerSecond, perMinute: rateLimitOptions.freeUserLimitPerMinute };
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
  // Single-use upload links: the link is the credential, so it sits beside media rather than inside
  // the bearer-authenticated /api/v1 scope, and is limited per uploader IP like other non-v1 routes.
  await app.register(attachmentUploadRoutes);

  const prefix = "/api/v1";
  await app.register(async (api) => {
    api.addHook("preSerialization", async (_req, _reply, payload) => {
      // App board summaries carry derivative metadata for stable rendering and cheap drag
      // previews. Public routes reuse those handlers, so remove the internal fields centrally
      // instead of relying on every current and future summary response to remember them.
      stripInternalCoverMetadata(payload);
      return payload;
    });
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
    // Credential (API key / agent) traffic is metered per user, per second and per minute, at the
    // plan limits of the organisation whose boards the request touches:
    //  - a ceiling per user at Pro limits on every request, so membership in many organisations
    //    cannot multiply the allowance (workspace/service credentials are metered per credential);
    //  - a bucket per user per organisation at that organisation's plan limits, charged by the
    //    access helpers as they resolve each board/workspace (see meterApiOrganisation). Requests
    //    that resolve no organisation (listings, search, session) charge the credential's default
    //    organisation instead.
    // Each bucket is a fixed window. Per-second buckets absorb bursts: an over-limit request waits in
    // a bounded queue for the next second rather than failing, and every charge of one request shares
    // a single deadline so its total wait stays under the MCP bridge's upstream timeout. Per-minute
    // buckets reject outright: waiting out a minute window would outlast that timeout anyway, and a
    // spent minute means sustained load, not a burst.
    const pendingMeters = new WeakMap<FastifyRequest, { charged: Set<string>; charge: (clientId: string, tier: ApiRateTier) => Promise<void>; defaultClientId: string; defaultTier: ApiRateTier }>();
    api.addHook("preHandler", async (req, reply) => {
      if (req.method === "OPTIONS") return;
      const apiKeyId = req.auth.apiKeyId;
      const isUpload = req.method === "POST"
        && /^\/api\/v1\/(?:cards|notes)\/[^/]+\/attachments(?:\?|$|\/)/.test(req.url);
      // Session-JWT callers fall back to the IP bucket, which stays a plain fixed window.
      if (!apiKeyId) {
        const policy = { limit: isUpload ? rateLimitOptions.uploadLimitPerMinute : rateLimitOptions.apiKeyLimitPerMinute, windowMs: rateLimitOptions.windowMs };
        if (await checkRateLimit(`ip:${clientIpForRequest(req)}`, policy, reply)) return reply;
        return;
      }
      if (!rateLimiter) return;

      const actor = req.auth.apiKeyKind === "personal" ? `user:${req.auth.sub}` : `key:${apiKeyId}`;
      const queue = { queueSize: rateLimitOptions.queueSize, expiresAt: Date.now() + rateLimitOptions.queueMaxWaitMs };
      const results: RateLimitResult[] = [];
      const reserve = async (buckets: MeteredBucket[]) => {
        // Buckets are charged in order (per-second before per-minute) and stop at the first
        // rejection, so a request queued out of its second does not also spend its minute.
        for (const bucket of buckets) {
          const policy = { limit: bucket.limit, windowMs: bucket.windowMs };
          const result = bucket.window === "second"
            ? await rateLimiter.queue(bucket.key, policy, queue)
            : await rateLimiter.check(bucket.key, policy);
          results.push(result);
          const headers = tightestRateLimit(results);
          if (headers) applyRateLimitHeaders(reply, headers);
          if (!result.allowed) throw rateLimitedError(bucket);
        }
      };
      const organisationBuckets = (clientId: string, tier: ApiRateTier) =>
        // The tier is part of the key so an upgrade lifts limits on the very next request, rather
        // than leaving the caller at a Free count measured against Pro limits until the window ends.
        meteredBuckets(`apiOrg:${clientId}:${tier}:${actor}`, tier === "free" ? freeLimits : paidLimits, { kind: "organisation", tier, clientId }, rateLimitOptions.windowMs);

      const meter = {
        charged: new Set<string>(),
        defaultClientId: req.auth.cid,
        // Workspace/service credentials only authenticate inside paid organisations.
        defaultTier: req.auth.apiRateTier ?? "paid",
        async charge(clientId: string, tier: ApiRateTier) {
          // A request touching the same organisation repeatedly (e.g. a move within one board)
          // pays once; touching two organisations pays in each.
          if (meter.charged.has(clientId)) return;
          meter.charged.add(clientId);
          await reserve(organisationBuckets(clientId, tier));
        },
      };
      pendingMeters.set(req, meter);
      requestContext.set("apiOrganisationMeter", meter);

      const ceiling = meteredBuckets(`apiActor:${actor}`, paidLimits, { kind: "ceiling" }, rateLimitOptions.windowMs);
      if (isUpload) ceiling.push({ key: `apiUpload:${actor}`, limit: rateLimitOptions.uploadLimitPerMinute, windowMs: rateLimitOptions.windowMs, scope: { kind: "ceiling" }, window: "minute" });
      // Routes without path parameters (listings, search, session) never resolve an organisation
      // through the access helpers, so charge the credential's default organisation up front, in
      // the same reservation as the ceiling.
      const resolvesOrganisation = (req.routeOptions.url ?? "").includes(":");
      if (resolvesOrganisation) {
        await reserve(ceiling);
      } else {
        meter.charged.add(meter.defaultClientId);
        await reserve([...ceiling, ...organisationBuckets(meter.defaultClientId, meter.defaultTier)]);
      }
    });
    api.addHook("onResponse", async (req) => {
      // Safety net for parameterised routes that never resolve an organisation (e.g. personal
      // scratchpad content): charge the default organisation after the fact so the traffic still
      // counts toward the next request's limit.
      const meter = pendingMeters.get(req);
      pendingMeters.delete(req);
      if (!meter || meter.charged.size > 0 || !rateLimiter) return;
      const actor = req.auth.apiKeyKind === "personal" ? `user:${req.auth.sub}` : `key:${req.auth.apiKeyId}`;
      const limits = meter.defaultTier === "free" ? freeLimits : paidLimits;
      const buckets = meteredBuckets(`apiOrg:${meter.defaultClientId}:${meter.defaultTier}:${actor}`, limits, { kind: "organisation", tier: meter.defaultTier, clientId: meter.defaultClientId }, rateLimitOptions.windowMs);
      await Promise.all(buckets.map((bucket) => rateLimiter.penalty(bucket.key, { limit: bucket.limit, windowMs: bucket.windowMs })));
    });
    // JSON mutations may opt into replay protection without changing the reused app route handlers.
    // The hook runs after authentication so keys are isolated by the resolved credential identity.
    registerPublicApiIdempotency(api);

    api.get("/session", async (req) => {
      const [[organisation], [user]] = await Promise.all([
        db.select({ name: clients.name, logoUrl: clients.logoUrl }).from(clients).where(eq(clients.id, req.auth.cid)).limit(1),
        db.select({ timezone: users.timezone }).from(users).where(eq(users.id, req.auth.sub)).limit(1),
      ]);
      // Agents resolve "today" and "tomorrow 1pm" against this zone, the same one the API stamps on
      // the due dates they set. For a workspace key the subject is the key's creator.
      const timeZone = user?.timezone || "UTC";
      return {
        userId: req.auth.sub,
        organisationId: req.auth.cid,
        organisationName: organisation?.name ?? null,
        organisationLogoUrl: organisation ? withSignedMedia(req.auth.cid, { logoUrl: organisation.logoUrl }).logoUrl : null,
        credentialKind: req.auth.apiKeyKind === "workspace" ? "workspace" : req.auth.apiKeyKind === "personal" ? "personal" : "user",
        organisationScope: req.auth.apiKeyKind === "workspace" ? "workspace-pinned" : "identity-wide",
        // Report the credential's actual scope. No hardcoded personal fallback: agents are told to
        // trust this value ("read-only credentials cannot mutate"), so it must reflect what the
        // access layer will really enforce.
        scope: req.auth.apiKeyScope ?? null,
        workspaceId: req.auth.apiKeyWorkspaceId ?? null,
        webUrl: env.WEB_ORIGIN,
        timeZone,
        today: localParts(new Date(), timeZone).date,
      };
    });

    await api.register((instance) => workspaceRoutes(instance, {
      exposeHomeBoardDirectory: false,
    }));
    await api.register(boardRoutes);
    await api.register(searchRoutes);
    await api.register(listRoutes);
    await api.register((instance) => noteRoutes(instance, { allowDeletes: false }));
    // The scratchpad doubles as the agent's personal inbox ("remind me to…" without a board). Pages
    // are owner-private, so the routes themselves refuse workspace-scoped keys.
    await api.register((instance) => scratchpadRoutes(instance, { allowDeletes: false, exposeAttachments: false }));
    // Public API card mutations intentionally reuse the app card routes, so
    // shared side effects such as activity, realtime outbox, and automations stay aligned.
    await api.register(cardRoutes);
    // Priority ("Up next") queues reuse the app routes so activity, the invalidation ping, and the
    // per-card write authorisation stay identical; the invalidation reaches connected web clients
    // through the realtime outbox like every other public API mutation.
    await api.register(cardPriorityRoutes);
    await api.register(separatorRoutes);
    await api.register((instance) => cardAttachmentRoutes(instance, { exposeCoverMetadata: false }));
    await api.register(uploadLinkRoutes);
    await api.register(customFieldRoutes);
    await api.register(externalLinkRoutes);
    // Agent runs are the "someone is working on this now" signal for AI agents; the same handlers
    // serve the web app so activity, realtime, and access checks stay identical.
    await api.register(agentRunRoutes);
    await api.register(cardLabelRoutes);
    await api.register(commentRoutes);
    await api.register(activityRoutes);
    // Automation administration is workspace-admin scoped inside the reused routes. Registering
    // the same handlers keeps validation, audit activity, realtime outbox writes, and plan limits
    // identical for MCP/public-API changes and first-party UI changes.
    await api.register(automationRoutes);
    // Webhook endpoint CRUD: workspace admins manage every endpoint; a write-capable non-admin
    // credential (workspace key, personal key, or OAuth agent grant) manages endpoints scoped to its
    // own connection. Delivery itself stays on the worker's webhook pipeline.
    await api.register(webhookEndpointRoutes);
    await api.register(mcpEventRoutes, { webhookRequest: options.mcpWebhookRequest });
    await api.register(agentWorkRoutes);
    await api.register(agentWorkQueryRoutes);
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

