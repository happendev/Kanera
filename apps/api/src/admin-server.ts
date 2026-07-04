import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { fastifyRequestContext, requestContext } from "@fastify/request-context";
import fastifyStatic from "@fastify/static";
import sensible from "@fastify/sensible";
import type { FastifyReply, FastifyServerOptions } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import adminAuthPlugin from "./admin/plugin.js";
import { seedFirstAdmin } from "./admin/bootstrap.js";
import { adminAuthRoutes } from "./admin/auth.routes.js";
import { adminOrgRoutes } from "./admin/orgs.routes.js";
import { adminUserRoutes } from "./admin/users.routes.js";
import { adminOpsRoutes } from "./admin/ops.routes.js";
import { adminSupportRoutes } from "./admin/support.routes.js";
import { adminInvitePublicRoutes, adminManagementRoutes } from "./admin/admins.routes.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { clientIpForRequest } from "./lib/client-ip.js";
import { registerErrorHandler, tooManyRequests } from "./lib/errors.js";
import mailerPlugin from "./lib/mailer-plugin.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter } from "./lib/rate-limit.js";
import { helmetSecurityOptionsWithoutCsp, registerApiContentSecurityPolicy, registerSecurityHeaderFallbacks } from "./lib/security-headers.js";
import { initRedis } from "./redis.js";

declare module "@fastify/request-context" {
  interface RequestContextData {
    // Admin request tracing. Distinct from the tenant server's clientId/userId keys — an admin request
    // has an adminUserId, not a tenant identity.
    adminUserId?: string;
  }
}

const REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_LOG_LEVEL = env.NODE_ENV === "development" ? "debug" : "info";

export interface BuildAdminServerOptions {
  logger?: FastifyServerOptions["logger"];
  slowRequestLogMs?: number;
  // Skip the env-bootstrapped superadmin seed. Integration tests seed their own admins and control the
  // admin_users table directly, so they opt out.
  seedAdmin?: boolean;
  // Serve the built admin SPA from disk (production single-origin mode). Off by default so tests and dev
  // (where the SPA is served by ng serve on :4300) do not require a build artifact on disk.
  serveWebApp?: boolean;
}

export async function buildAdminServer(options: BuildAdminServerOptions = {}) {
  await initRedis();
  const slowRequestLogMs = options.slowRequestLogMs ?? env.SLOW_REQUEST_LOG_MS;
  const requestStartedAt = new WeakMap<object, number>();
  const app = Fastify({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    trustProxy: env.ADMIN_TRUST_PROXY,
    logger: options.logger ?? {
      level: DEFAULT_LOG_LEVEL,
      ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      // Redact the cookie header too: the admin refresh cookie is a bearer-equivalent credential and must
      // never reach the logs.
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", "*.secret", "*.token"], censor: "[REDACTED]" },
      mixin() {
        const requestId = requestContext.get("requestId");
        const adminUserId = requestContext.get("adminUserId");
        return {
          ...(requestId ? { requestId } : {}),
          ...(adminUserId ? { adminUserId } : {}),
        };
      },
    },
    genReqId: () => randomUUID(),
    requestIdHeader: REQUEST_ID_HEADER,
  });

  // Keyed by IP, used only to throttle unauthenticated login. Fails open on a Valkey outage (see limiter).
  const loginRateLimiter = new FixedWindowRateLimiter(env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, { log: app.log });
  app.addHook("onClose", async () => loginRateLimiter.close());

  await app.register(fastifyRequestContext, {
    defaultStoreValues: (req) => ({
      requestId: req.id,
      requestStartedAt: performance.now(),
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
    req.log.warn({
      durationMs: Math.round(durationMs),
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
    }, "slow request");
  });

  await app.register(helmet, helmetSecurityOptionsWithoutCsp);
  registerSecurityHeaderFallbacks(app);
  // Locks JSON API responses to `default-src 'none'`; HTML (the SPA shell) is left untouched so the app can load.
  registerApiContentSecurityPolicy(app);
  // Pinned to the admin web origin with credentials — never `true`. The admin cookie is only ever sent
  // same-origin (dev proxy / prod single-origin), so a permissive CORS origin would be a needless risk.
  await app.register(cors, { origin: env.ADMIN_WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(sensible);
  await app.register(adminAuthPlugin);
  await app.register(mailerPlugin);

  registerErrorHandler(app, { service: "admin-api" });
  app.get("/health", async () => ({ ok: true, service: "admin-api" }));

  const loginLimit = async (req: Parameters<typeof clientIpForRequest>[0], reply: FastifyReply) => {
    const result = await loginRateLimiter.check(`admin-login:${clientIpForRequest(req)}`, {
      limit: env.ADMIN_LOGIN_RATE_LIMIT_MAX,
      windowMs: env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
    });
    applyRateLimitHeaders(reply, result);
    if (!result.allowed) throw tooManyRequests();
  };

  // Auth routes own their per-route preHandlers (login is rate-limited; refresh/logout are cookie-based).
  await app.register(async (a) => adminAuthRoutes(a, { loginLimit }), { prefix: "/admin" });
  await app.register(adminInvitePublicRoutes, { prefix: "/admin" });

  // Business routes: authenticated by construction — the scope-level preHandler runs adminAuthenticate
  // before any handler, so a new route added here cannot accidentally be left unauthenticated.
  await app.register(async (g) => {
    g.addHook("preHandler", g.adminAuthenticate);
    await adminOrgRoutes(g);
    await adminUserRoutes(g);
    await adminOpsRoutes(g);
    await adminSupportRoutes(g);
    await adminManagementRoutes(g);
  }, { prefix: "/admin" });

  if (options.seedAdmin ?? true) {
    await seedFirstAdmin(app.log);
  }

  // Production single-origin mode: serve the built admin SPA from the same Fastify instance as the API,
  // with a history-API fallback so client-side routes resolve to index.html. The strongest isolation —
  // admin web + API are literally one process/origin behind the reverse proxy.
  if (options.serveWebApp ?? false) {
    const root = join(process.cwd(), "dist/admin-web");
    if (!existsSync(root)) {
      app.log.warn({ root }, "serveWebApp enabled but dist/admin-web not found; skipping static serve");
    } else {
      await app.register(fastifyStatic, { root, wildcard: false });
      // SPA fallback: any non-/admin, non-asset GET returns index.html so deep links work on refresh.
      app.setNotFoundHandler((req, reply) => {
        if (req.method !== "GET" || req.url.startsWith("/admin")) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "not found" });
        }
        return reply.sendFile("index.html");
      });
    }
  }

  return app;
}

export { db };
