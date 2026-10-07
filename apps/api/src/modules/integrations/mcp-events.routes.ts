import { MCP_EVENT_NAMES, MCP_PRIORITY_EVENT_NAME, mcpEventCatalog, mcpEventSubscribe, mcpEventUnsubscribe, type McpEventArguments } from "@kanera/shared/dto";
import { mcpEventSubscriptions } from "@kanera/shared/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { db } from "../../db.js";
import { assertMcpEventAccess, mcpSubscriptionOwner } from "../../lib/mcp-events.js";
import { AppError } from "../../lib/errors.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { McpCallbackError, verifyMcpCallback, type McpWebhookRequest } from "../../lib/mcp-event-webhooks.js";

// Hash ordered scalar fields rather than raw JSON: argument key order never changes identity.
// A priorities.changed subscription takes no arguments; the principal already names its user.
function subscriptionId(principal: string, url: string, name: string, args: McpEventArguments | Record<string, never>) {
  if (name === MCP_PRIORITY_EVENT_NAME || !("workspaceId" in args)) return `sub_${createHash("sha256").update(JSON.stringify([principal, url, name])).digest("hex")}`;
  return `sub_${createHash("sha256").update(JSON.stringify([principal, url, name, args.workspaceId, args.boardId ?? null, args.cardId ?? null,
    // Preserve existing IDs for unfiltered subscriptions while making each list a distinct stream.
    ...(args.listId ? [args.listId] : []),
  ])).digest("hex")}`;
}
const DEFAULT_TTL = 24 * 60 * 60_000;
const VERIFICATION_CACHE_MS = 5 * 60_000;
const MAX_SUBSCRIPTIONS = 100;
export async function mcpEventRoutes(app: FastifyInstance, options: { webhookRequest?: McpWebhookRequest } = {}) {
  app.get("/mcp-events", async (req) => {
    mcpSubscriptionOwner(req.auth);
    return { events: mcpEventCatalog };
  });
  app.post("/mcp-events/subscribe", async (req) => {
    const proposed = req.body as { name?: unknown; delivery?: { mode?: unknown } } | undefined;
    if (typeof proposed?.name === "string" && !(MCP_EVENT_NAMES as readonly string[]).includes(proposed.name)) throw new AppError(404, "MCP_EVENT_NOT_FOUND", "unknown event");
    if (typeof proposed?.delivery?.mode === "string" && proposed.delivery.mode !== "webhook") throw new AppError(400, "MCP_EVENT_UNSUPPORTED", "unsupported delivery mode", { feature: "deliveryMode", value: proposed.delivery.mode });
    const body = mcpEventSubscribe.parse(req.body);
    const owner = mcpSubscriptionOwner(req.auth);
    await assertMcpEventAccess(req.auth, body.name, body.arguments);
    const id = subscriptionId(owner.principal, body.delivery.url, body.name, body.arguments);
    const ownerCondition = and(
      owner.ownerAgentGrantId ? eq(mcpEventSubscriptions.ownerAgentGrantId, owner.ownerAgentGrantId) : eq(mcpEventSubscriptions.ownerApiKeyId, owner.ownerApiKeyId!),
      owner.ownerServiceClientId ? eq(mcpEventSubscriptions.ownerServiceClientId, owner.ownerServiceClientId) : isNull(mcpEventSubscriptions.ownerServiceClientId),
    );
    const assertWithinLimit = async (tx: Pick<typeof db, "select">, now: Date) => {
      const [existing] = await tx.select({ expiresAt: mcpEventSubscriptions.expiresAt }).from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, id));
      if (existing && existing.expiresAt > now) return;
      const active = await tx.select({ id: mcpEventSubscriptions.id }).from(mcpEventSubscriptions).where(and(ownerCondition, gt(mcpEventSubscriptions.expiresAt, now))).limit(MAX_SUBSCRIPTIONS);
      if (active.length >= MAX_SUBSCRIPTIONS) throw new AppError(429, "MCP_SUBSCRIPTION_LIMIT", "subscription limit reached", { max: MAX_SUBSCRIPTIONS });
    };
    // Verification is outbound network I/O to a client-chosen host (up to the transport timeout),
    // so it runs before the transaction: holding a pooled connection and this principal's advisory
    // lock across it would let one slow callback stall every other subscribe for the principal.
    // A cheap limit pre-check keeps an over-limit caller from triggering verification POSTs.
    await assertWithinLimit(db, new Date());
    // Verification is cached per (principal, url), as the events draft specifies, so varying
    // arguments or refreshing cannot multiply challenge POSTs at the callback host.
    const [cached] = await db.select({ verifiedAt: mcpEventSubscriptions.verifiedAt }).from(mcpEventSubscriptions).where(and(
      ownerCondition,
      eq(mcpEventSubscriptions.url, body.delivery.url),
      gt(mcpEventSubscriptions.verifiedAt, new Date(Date.now() - VERIFICATION_CACHE_MS)),
    )).limit(1);
    const verifiedAt = cached?.verifiedAt ?? new Date();
    if (!cached) {
      try { await verifyMcpCallback(body.delivery.url, body.delivery.secret, id, options.webhookRequest); }
      catch (error) {
        // Only the draft's fixed categories leave the server; anything else (including blocked
        // destinations) reads as challenge_failed so errors cannot map the private network.
        throw new AppError(400, "MCP_CALLBACK_ENDPOINT", "callback verification failed", { reason: error instanceof McpCallbackError && ["connection_refused", "timeout", "tls_error", "http_4xx", "http_5xx", "challenge_failed"].includes(error.reason) ? error.reason : "challenge_failed" });
      }
    }
    // Lock the identity for the read-modify-write below so concurrent refreshes cannot overwrite
    // the rotation key or both pass the limit check. An unsubscribe that lands between verification
    // and this transaction simply serialises before this subscribe, which then re-creates the row.
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner.principal}, 0))`);
      const now = new Date();
      await assertWithinLimit(tx, now);
      const [existing] = await tx.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, id));
      const active = !!existing && existing.expiresAt > now;
      const changed = !!existing && decryptSecret(existing.encryptedSecret) !== body.delivery.secret;
      const expiresAt = new Date(now.getTime() + Math.min(body.ttlMs ?? DEFAULT_TTL, DEFAULT_TTL));
      const rotation = changed ? {
        previousEncryptedSecret: existing.encryptedSecret,
        secretRotationUntil: new Date(now.getTime() + VERIFICATION_CACHE_MS),
      } : { previousEncryptedSecret: existing?.previousEncryptedSecret ?? null, secretRotationUntil: existing?.secretRotationUntil ?? null };
      // Renewing an expired subscription is a fresh stream: no replay and no stale health report.
      const health = active ? {} : { lastDeliveryAt: null, lastError: null, failedSince: null };
      await tx.insert(mcpEventSubscriptions).values({
        id, userId: req.auth.sub,
        // Your own queue only: the target is always the subscribing user (also a database check).
        ...(body.name === MCP_PRIORITY_EVENT_NAME ? { targetUserId: req.auth.sub } : { workspaceId: body.arguments.workspaceId, boardId: body.arguments.boardId }),
        ownerApiKeyId: owner.ownerApiKeyId, ownerAgentGrantId: owner.ownerAgentGrantId, ownerServiceClientId: owner.ownerServiceClientId,
        name: body.name, arguments: body.arguments, url: body.delivery.url,
        encryptedSecret: encryptSecret(body.delivery.secret), verifiedAt, expiresAt, ...rotation,
      }).onConflictDoUpdate({ target: mcpEventSubscriptions.id, set: {
        encryptedSecret: encryptSecret(body.delivery.secret), verifiedAt, expiresAt, ...rotation, ...health,
        // Renewing an expired subscription begins at now; this catalog promises no replay.
        startsAt: active ? existing.startsAt : now,
      } });
      return {
        id, refreshBefore: expiresAt.toISOString(), cursor: null, truncated: body.cursor != null,
        // Refresh-only health report. Kanera never suspends delivery (retries are bounded per
        // occurrence instead), so `active` is always true; lastError/failedSince expose an
        // endpoint that keeps failing so the client can fix or replace its receiver.
        ...(active ? { deliveryStatus: {
          active: true,
          lastDeliveryAt: existing.lastDeliveryAt?.toISOString() ?? null,
          lastError: existing.lastError ?? null,
          ...(existing.failedSince ? { failedSince: existing.failedSince.toISOString() } : {}),
        } } : {}),
      };
    });
  });
  app.post("/mcp-events/unsubscribe", async (req) => {
    const body = mcpEventUnsubscribe.parse(req.body);
    const owner = mcpSubscriptionOwner(req.auth);
    const id = subscriptionId(owner.principal, body.delivery.url, body.name, body.arguments);
    // Ownership is the authorization boundary for cleanup, even after resource access is lost.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      await tx.delete(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, id));
    });
    return {};
  });
}
