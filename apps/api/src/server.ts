import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { fastifyRequestContext, requestContext } from "@fastify/request-context";
import sensible from "@fastify/sensible";
import { clients } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import rawBody from "fastify-raw-body";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions, RawServerDefault } from "fastify";
import type { ResSerializerReply } from "fastify/types/logger.js";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import authPlugin from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { startCompletedPriorityCleanupScheduler } from "./lib/completed-priority-cleanup.js";
import { registerErrorHandler } from "./lib/errors.js";
import { registerMetrics } from "./lib/metrics.js";
import mailerPlugin from "./lib/mailer-plugin.js";
import { helmetSecurityOptions, registerSecurityHeaderFallbacks } from "./lib/security-headers.js";
import { startSeatReconcileScheduler } from "./lib/seat-reconcile.js";
import { resolveLocalUploadsRoot } from "./lib/storage/local.js";
import { productAnalytics } from "./lib/product-analytics.js";
import { ensureSystemWebPushConfig } from "./lib/web-push.js";
import { activityRoutes } from "./modules/activity/routes.js";
import { automationRoutes } from "./modules/automations/routes.js";
import { boardInvitationRoutes } from "./modules/board-invitations/routes.js";
import { boardMirrorRoutes } from "./modules/board-mirrors/routes.js";
import { billingRoutes } from "./modules/billing/routes.js";
import { boardRoutes } from "./modules/boards/routes.js";
import { cardLabelRoutes } from "./modules/card-labels/routes.js";
import { cardAttachmentRoutes } from "./modules/cards/attachments.routes.js";
import { cardRoutes } from "./modules/cards/routes.js";
import { clientRoutes } from "./modules/clients/routes.js";
import { checklistTemplateRoutes } from "./modules/checklist-templates/routes.js";
import { clientUserRoutes } from "./modules/clients/users.js";
import { commentRoutes } from "./modules/comments/routes.js";
import { customFieldRoutes } from "./modules/custom-fields/routes.js";
import { agentRunRoutes } from "./modules/agent-runs/routes.js";
import { externalLinkRoutes } from "./modules/external-links/routes.js";
import { githubLinkRoutes } from "./modules/github-links/routes.js";
import { importRoutes } from "./modules/imports/routes.js";
import { inviteRoutes } from "./modules/invites/routes.js";
import { integrationRoutes } from "./modules/integrations/routes.js";
import { oauthUserRoutes } from "./oauth/routes.js";
import { internalLinkRoutes } from "./modules/internal-links/routes.js";
import { listRoutes } from "./modules/lists/routes.js";
import { mediaRoutes } from "./modules/media/routes.js";
import { noteRoutes } from "./modules/notes/routes.js";
import { emailPreferencePublicRoutes, notificationsRoutes, pushPublicRoutes } from "./modules/notifications/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { separatorRoutes } from "./modules/separators/routes.js";
import { workspaceRoutes } from "./modules/workspaces/routes.js";
import { homeRoutes } from "./modules/home/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { scratchpadRoutes } from "./modules/scratchpad/routes.js";
import { agentWorkRoutes, workRoutes } from "./modules/work/routes.js";
import { globalWorkSeparatorRoutes } from "./modules/global-work-separators/routes.js";
import { cardPriorityRoutes } from "./modules/card-priorities/routes.js";
import { setupIo } from "./realtime/io.js";
import { setRealtimeLogger } from "./realtime/metrics.js";
import { initRedis } from "./redis.js";

declare module "@fastify/request-context" {
  interface RequestContextData {
    requestId: string;
    requestStartedAt?: number;
    clientId?: string;
    userId?: string;
    workspaceId?: string;
  }
}

const REQUEST_ID_HEADER = "x-request-id";
const LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.token",
  "*.refreshToken",
  "*.resetUrl",
  "*.code",
  "*.secret",
  "*.generatedWebhookSecret",
  "*.otpauthUri",
  "*.recoveryCodes",
] as const;
const DEFAULT_LOG_LEVEL = env.NODE_ENV === "development" ? "debug" : "info";

const DEVELOPMENT_LOG_SERIALIZERS = {
  err(error: FastifyError) {
    return {
      type: error.name,
      message: error.message,
      stack: error.stack ?? "",
      ...(error.code ? { code: error.code } : {}),
      ...(error.statusCode ? { statusCode: error.statusCode } : {}),
    };
  },
  req(request: FastifyRequest) {
    return {
      method: request.method,
      url: request.url,
    };
  },
  res(reply: ResSerializerReply<RawServerDefault, FastifyReply>) {
    return {
      statusCode: reply.statusCode,
      method: reply.request?.method,
      url: reply.request?.url,
    };
  },
};

function buildLoggerOptions(logger: BuildServerOptions["logger"]) {
  if (logger !== undefined) return logger;

  return {
    level: DEFAULT_LOG_LEVEL,
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty" }, serializers: DEVELOPMENT_LOG_SERIALIZERS }
      : {}),
    redact: { paths: [...LOGGER_REDACT_PATHS], censor: "[REDACTED]" },
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
  } satisfies Exclude<BuildServerOptions["logger"], boolean>;
}

export interface BuildServerOptions {
  enableRealtime?: boolean;
  enableCompletedPriorityCleanupScheduler?: boolean;
  enableSeatReconcileScheduler?: boolean;
  logger?: FastifyServerOptions["logger"];
  slowRequestLogMs?: number;
  uploadsDir?: string;
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

async function bootstrapHostedPushMessaging(log: FastifyInstance["log"]) {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return;

  // Hosted deployments own push centrally: keep every tenant enabled and make sure the shared
  // VAPID config exists before clients ask for browser subscription details.
  const vapid = await ensureSystemWebPushConfig();
  const enabledClients = await db
    .update(clients)
    .set({ pushEnabled: true, updatedAt: new Date() })
    .where(eq(clients.pushEnabled, false))
    .returning({ id: clients.id });
  log.info({
    enabledClientCount: enabledClients.length,
    vapidSubject: vapid.subject,
  }, "hosted push messaging bootstrapped");
}

export async function buildServer(options: BuildServerOptions = {}) {
  await initRedis();
  const enableRealtime = options.enableRealtime ?? true;
  const enableCompletedPriorityCleanupScheduler = options.enableCompletedPriorityCleanupScheduler ?? true;
  const enableSeatReconcileScheduler = options.enableSeatReconcileScheduler ?? true;
  const slowRequestLogMs = options.slowRequestLogMs ?? env.SLOW_REQUEST_LOG_MS;
  const requestStartedAt = new WeakMap<FastifyRequest, number>();
  const app = Fastify({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    trustProxy: env.API_TRUST_PROXY,
    logger: buildLoggerOptions(options.logger),
    genReqId: () => randomUUID(),
    requestIdHeader: REQUEST_ID_HEADER,
  });
  setRealtimeLogger(app.log);

  await app.register(fastifyRequestContext, {
    defaultStoreValues: (req) => ({ requestId: req.id, requestStartedAt: performance.now() }),
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
    // alerting lives in Grafana (p95 rule) — we deliberately do NOT also fire a per-request ops webhook,
    // which would be noisy and overlap the metric. See DEPLOY.md "Monitoring".
    req.log.warn({
      durationMs: Math.round(durationMs),
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
    }, "slow request");
  });

  await app.register(helmet, helmetSecurityOptions);
  registerSecurityHeaderFallbacks(app);
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(sensible);
  await app.register(rawBody, { global: false, encoding: "utf8", runFirst: true });
  await app.register(multipart, { limits: { fileSize: env.ATTACHMENT_MAX_BYTES, files: 1 } });
  await app.register(authPlugin);
  await app.register(mailerPlugin);

  const uploadsRoot = resolveLocalUploadsRoot(options.uploadsDir ?? env.UPLOADS_DIR);
  await mkdir(uploadsRoot, { recursive: true });
  await bootstrapHostedPushMessaging(app.log);

  registerErrorHandler(app);

  app.get("/health", { config: { logLevel: "silent" } }, async () => ({ ok: true }));
  registerMetrics(app);

  await app.register(mediaRoutes);
  await app.register(authRoutes);
  await app.register(billingRoutes);
  await app.register(workspaceRoutes);
  await app.register(boardRoutes);
  await app.register(importRoutes);
  await app.register(boardInvitationRoutes);
  await app.register(boardMirrorRoutes);
  await app.register(workRoutes);
  await app.register(agentWorkRoutes);
  // Internal Global Work layout API. Public integrations continue to use board separators only.
  await app.register(globalWorkSeparatorRoutes);
  // Priority queues serve both the first-party UI and the public API/MCP through the same handlers,
  // keeping access rules, audit activity and realtime invalidation identical on every surface.
  await app.register(cardPriorityRoutes);
  // Internal only: deliberately not registered on public-api-server.ts, and absent from the
  // hand-maintained public OpenAPI document. Home is a personal view, not a published contract.
  await app.register(homeRoutes);
  // Internal only, like Home: the avatar profile card is a first-party UI projection. Its access
  // rules lean on the interactive session (shared boards, current organisation), not on a key scope.
  await app.register(userRoutes);
  // Internal only, and more strongly than Home: a scratchpad is private to one user, so it is
  // deliberately absent from public-api-server.ts, docs/public-openapi.ts, and the MCP surface.
  // Exposing it on a workspace-scoped credential would hand an org's integration key a member's
  // private pages.
  await app.register(scratchpadRoutes);
  await app.register(listRoutes);
  await app.register(noteRoutes);
  await app.register(cardRoutes, { allowGlobalWorkLayoutMoves: true });
  await app.register(separatorRoutes);
  await app.register(cardAttachmentRoutes);
  await app.register(customFieldRoutes);
  await app.register(checklistTemplateRoutes);
  await app.register(automationRoutes);
  await app.register(externalLinkRoutes);
  await app.register(agentRunRoutes);
  await app.register(githubLinkRoutes);
  await app.register(cardLabelRoutes);
  await app.register(inviteRoutes);
  await app.register(commentRoutes);
  await app.register(activityRoutes);
  await app.register(notificationsRoutes);
  await app.register(pushPublicRoutes);
  await app.register(emailPreferencePublicRoutes);
  await app.register(clientRoutes);
  await app.register(clientUserRoutes);
  await app.register(integrationRoutes);
  await app.register(oauthUserRoutes);
  await app.register(internalLinkRoutes);
  await app.register(searchRoutes);

  let stopCompletedPriorityCleanupScheduler: (() => Promise<void>) | null = null;
  let stopSeatReconcileScheduler: (() => Promise<void>) | null = null;
  app.addHook("onClose", async () => stopCompletedPriorityCleanupScheduler?.());
  app.addHook("onClose", async () => stopSeatReconcileScheduler?.());
  app.addHook("onClose", async () => productAnalytics.shutdown());
  app.addHook("onReady", async () => {
    if (enableRealtime) await setupIo(app);
    // Every other background job (outbox dispatch, webhooks, digests, queues, cleanups, expiry) runs
    // only in the worker process; see worker-server.ts. The two below stay here because they guard
    // state this process writes and are cheap enough to run alongside the request path.
    if (enableCompletedPriorityCleanupScheduler) {
      stopCompletedPriorityCleanupScheduler = startCompletedPriorityCleanupScheduler({ db, log: app.log });
    }
    // Safety net that repairs any Stripe seat-quantity drift left by a failed inline removal sync.
    if (enableSeatReconcileScheduler) {
      stopSeatReconcileScheduler = startSeatReconcileScheduler(app.log);
    }
  });

  return app;
}
