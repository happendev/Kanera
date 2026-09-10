import { dto } from "@kanera/shared";
import { webhookDeliveries, webhookEndpoints, type WebhookEndpoint } from "@kanera/shared/schema";
import { and, desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { capturePremiumFeatureUsed } from "../../lib/product-analytics.js";
import { encryptSecret } from "../../lib/secrets.js";
import { assertWebhookUrlAllowed } from "../../lib/ssrf.js";
import { assertWebhooksAllowed } from "../../lib/tier-limits.js";
import { newWebhookSecret } from "../../lib/webhook-signing.js";
import { deliverWebhookDelivery } from "../../lib/webhooks.js";

type WebhookEndpointWithStats = WebhookEndpoint & {
  lastSuccessfulAt?: Date | string | null;
};

type WebhookEndpointOwner = { ownerApiKeyId: string; ownerAgentGrantId: null } | { ownerApiKeyId: null; ownerAgentGrantId: string };

/**
 * Who may manage which endpoints in a workspace.
 *
 * - `workspace`: workspace admins (or admin-scoped workspace keys) see and manage every generic
 *   endpoint, as before.
 * - `connection`: a non-admin write-capable API credential — a write-scoped workspace or personal
 *   key, or an interactive OAuth agent grant — may subscribe to a workspace it is a member of, but
 *   only ever sees the endpoints its own connection created. This is what lets an agent register
 *   its callback without being handed workspace-admin authority.
 *
 * Read-scoped credentials and plain non-admin users keep the historical 403.
 */
type WebhookManagementScope =
  | { kind: "workspace"; clientId: string; owner: null }
  | { kind: "connection"; clientId: string; owner: WebhookEndpointOwner };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function connectionOwner(claims: AuthClaims): WebhookEndpointOwner | null {
  // An interactive OAuth grant carries a synthetic apiKeyId (a rate-limit bucket, not a row), so the
  // grant is the owner. Service-connection OAuth tokens and plain API keys resolve to a real key row.
  if (claims.agentGrantId) return { ownerApiKeyId: null, ownerAgentGrantId: claims.agentGrantId };
  if (claims.apiKeyId && UUID_PATTERN.test(claims.apiKeyId)) return { ownerApiKeyId: claims.apiKeyId, ownerAgentGrantId: null };
  return null;
}

async function resolveWebhookManagementScope(claims: AuthClaims, workspaceId: string): Promise<WebhookManagementScope> {
  try {
    const { clientId } = await assertWorkspaceAccess(claims, workspaceId, "admin");
    return { kind: "workspace", clientId, owner: null };
  } catch (err) {
    // Only an authorisation failure falls through to connection scope; "not found" and org-mismatch
    // errors are the caller's answer regardless of credential kind.
    if (!(err instanceof AppError && err.statusCode === 403)) throw err;
    if (claims.authKind !== "apiKey" || claims.apiKeyScope === "read") throw err;
    const owner = connectionOwner(claims);
    if (!owner) throw err;
    const { clientId } = await assertWorkspaceAccess(claims, workspaceId, "member");
    return { kind: "connection", clientId, owner };
  }
}

/** WHERE fragment restricting rows to what the scope may see. Admins see all generic endpoints. */
function scopeCondition(workspaceId: string, scope: WebhookManagementScope): SQL {
  const base = and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic"))!;
  if (scope.kind === "workspace") return base;
  return scope.owner.ownerAgentGrantId
    ? and(base, eq(webhookEndpoints.ownerAgentGrantId, scope.owner.ownerAgentGrantId))!
    : and(base, eq(webhookEndpoints.ownerApiKeyId, scope.owner.ownerApiKeyId!))!;
}

export function shapeWebhookEndpoint(row: WebhookEndpointWithStats) {
  const lastSuccessfulAt = row.lastSuccessfulAt
    ? row.lastSuccessfulAt instanceof Date
      ? row.lastSuccessfulAt
      : new Date(row.lastSuccessfulAt)
    : null;
  const safeLastSuccessfulAt = lastSuccessfulAt && !Number.isNaN(lastSuccessfulAt.getTime()) ? lastSuccessfulAt : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    url: row.url,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    // "connection" endpoints were registered by an agent credential and are visible to that
    // connection plus workspace admins; "workspace" endpoints are admin-managed.
    scope: row.ownerApiKeyId || row.ownerAgentGrantId ? ("connection" as const) : ("workspace" as const),
    lastSuccessfulAt: safeLastSuccessfulAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findScopedEndpoint(workspaceId: string, endpointId: string, scope: WebhookManagementScope): Promise<WebhookEndpoint> {
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, endpointId), scopeCondition(workspaceId, scope)))
    .limit(1);
  if (!endpoint) throw notFound("webhook not found");
  return endpoint;
}

export async function webhookEndpointRoutes(app: FastifyInstance) {
  app.get("/workspaces/:id/webhooks", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    const rows = await db
      .select({
        ...getTableColumns(webhookEndpoints),
        lastSuccessfulAt: sql<Date | null>`max(${webhookDeliveries.deliveredAt})`,
      })
      .from(webhookEndpoints)
      .leftJoin(webhookDeliveries, and(
        eq(webhookDeliveries.endpointId, webhookEndpoints.id),
        eq(webhookDeliveries.status, "success"),
      ))
      .where(scopeCondition(workspaceId, scope))
      .groupBy(webhookEndpoints.id)
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map(shapeWebhookEndpoint);
  });

  app.post("/workspaces/:id/webhooks", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    await assertWebhooksAllowed(scope.clientId);
    const body = dto.createWebhookEndpointBody.parse(req.body);
    assertWebhookUrlAllowed(body.url);
    const secret = newWebhookSecret();
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        workspaceId,
        createdById: req.auth.sub,
        provider: "generic",
        name: body.name,
        url: body.url,
        eventTypes: body.eventTypes,
        enabled: body.enabled,
        encryptedSecret: encryptSecret(secret),
        ...(scope.owner ?? {}),
      })
      .returning();
    void capturePremiumFeatureUsed({
      organizationId: scope.clientId,
      workspaceId,
      actorId: req.auth.sub,
      premiumFeature: "integrations",
      supportSession: req.auth.authKind === "support",
    });
    return reply.status(201).send({ ...shapeWebhookEndpoint(row!), secret });
  });

  app.patch("/workspaces/:workspaceId/webhooks/:endpointId", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    const body = dto.updateWebhookEndpointBody.parse(req.body);
    if (body.url !== undefined) assertWebhookUrlAllowed(body.url);
    // Webhooks are a paid-only feature. A downgrade disables existing endpoints; gate the enable
    // transition so a free org cannot turn a disabled endpoint back on (mirrors the automations gate).
    if (body.enabled === true) await assertWebhooksAllowed(scope.clientId);
    const [row] = await db
      .update(webhookEndpoints)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.eventTypes !== undefined && { eventTypes: body.eventTypes }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: new Date(),
      })
      .where(and(eq(webhookEndpoints.id, endpointId), scopeCondition(workspaceId, scope)))
      .returning();
    if (!row) throw notFound("webhook not found");
    return shapeWebhookEndpoint(row);
  });

  app.post("/workspaces/:workspaceId/webhooks/:endpointId/secret", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    const secret = newWebhookSecret();
    const [row] = await db
      .update(webhookEndpoints)
      .set({ encryptedSecret: encryptSecret(secret), updatedAt: new Date() })
      .where(and(eq(webhookEndpoints.id, endpointId), scopeCondition(workspaceId, scope)))
      .returning();
    if (!row) throw notFound("webhook not found");
    return { ...shapeWebhookEndpoint(row), secret };
  });

  app.delete("/workspaces/:workspaceId/webhooks/:endpointId", async (req, reply) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    await db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), scopeCondition(workspaceId, scope)));
    return reply.status(204).send();
  });

  app.get("/workspaces/:workspaceId/webhooks/:endpointId/deliveries", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const query = dto.listWebhookDeliveriesQuery.parse(req.query ?? {});
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    await findScopedEndpoint(workspaceId, endpointId, scope);
    return db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(query.limit);
  });

  app.post("/workspaces/:workspaceId/webhooks/:endpointId/deliveries/:deliveryId/retry", async (req) => {
    const { workspaceId, endpointId, deliveryId } = req.params as { workspaceId: string; endpointId: string; deliveryId: string };
    const scope = await resolveWebhookManagementScope(req.auth, workspaceId);
    await assertWebhooksAllowed(scope.clientId);
    const endpoint = await findScopedEndpoint(workspaceId, endpointId, scope);
    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.endpointId, endpointId)))
      .limit(1);
    if (!delivery) throw notFound("delivery not found");
    if (delivery.status !== "failed") throw badRequest("only failed webhook deliveries can be retried");
    return deliverWebhookDelivery(delivery, endpoint);
  });
}

