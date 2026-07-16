import { dto } from "@kanera/shared";
import { oauthClients, oauthTokens, users, webhookDeliveries, webhookEndpoints, workspaceApiKeys } from "@kanera/shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { encryptSecret } from "../../lib/secrets.js";
import { assertWebhookUrlAllowed } from "../../lib/ssrf.js";
import { hashOpaqueToken } from "../../lib/tokens.js";
import { assertApiKeysAllowed, assertWebhooksAllowed } from "../../lib/tier-limits.js";
import { deliverWebhookDelivery } from "../../lib/webhooks.js";
import { newServiceClientId, newServiceClientSecret } from "../../oauth/routes.js";

const API_KEY_ENV_TOKEN = {
  production: "live",
  staging: "stg",
  development: "dev",
  test: "test",
} as const;

function newApiKeySecret(): string {
  return `kanera_${API_KEY_ENV_TOKEN[env.KANERA_ENVIRONMENT]}_${randomBytes(32).toString("base64url")}`;
}

// Personal keys carry a `u` (user) marker after the vendor prefix — e.g. kanera_u_live_… — so a key
// is identifiable as personal vs workspace at a glance (and in stored prefixes/logs) without a DB
// lookup. Workspace keys keep their original kanera_<env>_ shape; they are already issued and in use.
function newPersonalApiKeySecret(): string {
  return `kanera_u_${API_KEY_ENV_TOKEN[env.KANERA_ENVIRONMENT]}_${randomBytes(32).toString("base64url")}`;
}

function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function keyPrefix(secret: string): string {
  return secret.slice(0, 18);
}

type ApiKeyWithCreator = typeof workspaceApiKeys.$inferSelect & {
  createdByName: string;
  createdByEmail: string;
};

type WebhookEndpointWithStats = typeof webhookEndpoints.$inferSelect & {
  lastSuccessfulAt?: Date | string | null;
};

function shapeApiKey(row: ApiKeyWithCreator) {
  return {
    id: row.id,
    kind: row.kind,
    workspaceId: row.workspaceId,
    createdById: row.createdById,
    createdByName: row.createdByName,
    createdByEmail: row.createdByEmail,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scope: row.scope,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Personal keys are always the caller's own and inherit their permissions, so the shape omits
// workspace/scope/creator fields the workspace-key shape carries. `name` is the optional label.
function shapePersonalApiKey(row: typeof workspaceApiKeys.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.name,
    keyPrefix: row.keyPrefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function shapeEndpoint(row: WebhookEndpointWithStats) {
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
    lastSuccessfulAt: safeLastSuccessfulAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Personal API keys — user-scoped, not workspace-scoped. Any authenticated user may manage their
  // own (subject to the paid-tier gate); there is no admin check. A personal key acts as its owner
  // across every organisation/workspace/board scope the owner can reach (see access.ts).
  app.get("/me/api-keys", async (req) => {
    const rows = await db
      .select()
      .from(workspaceApiKeys)
      .where(and(
        eq(workspaceApiKeys.createdById, req.auth.sub),
        eq(workspaceApiKeys.kind, "personal"),
        isNull(workspaceApiKeys.revokedAt),
      ))
      .orderBy(sql`${workspaceApiKeys.lastUsedAt} desc nulls last`, desc(workspaceApiKeys.createdAt));
    return rows.map(shapePersonalApiKey);
  });

  app.post("/me/api-keys", async (req, reply) => {
    // Gate on the owner's org plan, mirroring workspace keys (both are paid-only).
    await assertApiKeysAllowed(req.auth.cid);
    const body = dto.createPersonalApiKeyBody.parse(req.body ?? {});
    const secret = newPersonalApiKeySecret();
    const [row] = await db
      .insert(workspaceApiKeys)
      .values({
        kind: "personal",
        workspaceId: null,
        createdById: req.auth.sub,
        name: body.label ?? null,
        keyPrefix: keyPrefix(secret),
        keyHash: hashOpaqueToken(secret),
      })
      .returning();
    return reply.status(201).send({ ...shapePersonalApiKey(row!), secret });
  });

  app.delete("/me/api-keys/:keyId", async (req, reply) => {
    const { keyId } = req.params as { keyId: string };
    // Scope the revoke by owner + kind so a user can only ever revoke their own personal keys.
    const [row] = await db
      .update(workspaceApiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(workspaceApiKeys.id, keyId),
        eq(workspaceApiKeys.createdById, req.auth.sub),
        eq(workspaceApiKeys.kind, "personal"),
        isNull(workspaceApiKeys.revokedAt),
      ))
      .returning();
    if (!row) throw notFound("api key not found");
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/api-keys", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const rows = await db
      .select({
        id: workspaceApiKeys.id,
        kind: workspaceApiKeys.kind,
        workspaceId: workspaceApiKeys.workspaceId,
        createdById: workspaceApiKeys.createdById,
        createdByName: users.displayName,
        createdByEmail: users.email,
        name: workspaceApiKeys.name,
        keyPrefix: workspaceApiKeys.keyPrefix,
        keyHash: workspaceApiKeys.keyHash,
        scope: workspaceApiKeys.scope,
        lastUsedAt: workspaceApiKeys.lastUsedAt,
        revokedAt: workspaceApiKeys.revokedAt,
        createdAt: workspaceApiKeys.createdAt,
        updatedAt: workspaceApiKeys.updatedAt,
      })
      .from(workspaceApiKeys)
      .innerJoin(users, eq(users.id, workspaceApiKeys.createdById))
      .where(and(eq(workspaceApiKeys.workspaceId, workspaceId), isNull(workspaceApiKeys.revokedAt)))
      .orderBy(sql`${workspaceApiKeys.lastUsedAt} desc nulls last`, desc(workspaceApiKeys.createdAt));
    return rows.map(shapeApiKey);
  });

  app.post("/workspaces/:id/api-keys", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertApiKeysAllowed(clientId);
    const body = dto.createWorkspaceApiKeyBody.parse(req.body);
    const secret = newApiKeySecret();
    const [row] = await db
      .insert(workspaceApiKeys)
      .values({
        workspaceId,
        createdById: req.auth.sub,
        name: body.name,
        scope: body.scope,
        keyPrefix: keyPrefix(secret),
        keyHash: hashOpaqueToken(secret),
      })
      .returning();
    const [created] = await db
      .select({
        id: workspaceApiKeys.id,
        kind: workspaceApiKeys.kind,
        workspaceId: workspaceApiKeys.workspaceId,
        createdById: workspaceApiKeys.createdById,
        createdByName: users.displayName,
        createdByEmail: users.email,
        name: workspaceApiKeys.name,
        keyPrefix: workspaceApiKeys.keyPrefix,
        keyHash: workspaceApiKeys.keyHash,
        scope: workspaceApiKeys.scope,
        lastUsedAt: workspaceApiKeys.lastUsedAt,
        revokedAt: workspaceApiKeys.revokedAt,
        createdAt: workspaceApiKeys.createdAt,
        updatedAt: workspaceApiKeys.updatedAt,
      })
      .from(workspaceApiKeys)
      .innerJoin(users, eq(users.id, workspaceApiKeys.createdById))
      .where(eq(workspaceApiKeys.id, row!.id))
      .limit(1);
    return reply.status(201).send({ ...shapeApiKey(created!), secret });
  });

  app.patch("/workspaces/:workspaceId/api-keys/:keyId", async (req) => {
    const { workspaceId, keyId } = req.params as { workspaceId: string; keyId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.updateWorkspaceApiKeyBody.parse(req.body);
    const [row] = await db
      .update(workspaceApiKeys)
      .set({ name: body.name, updatedAt: new Date() })
      // Keep the workspace in the predicate so an admin can never rename a key from another
      // workspace, and exclude revoked keys because they are no longer manageable in the UI.
      .where(and(
        eq(workspaceApiKeys.id, keyId),
        eq(workspaceApiKeys.workspaceId, workspaceId),
        isNull(workspaceApiKeys.revokedAt),
      ))
      .returning({ id: workspaceApiKeys.id });
    if (!row) throw notFound("api key not found");

    const [updated] = await db
      .select({
        id: workspaceApiKeys.id,
        kind: workspaceApiKeys.kind,
        workspaceId: workspaceApiKeys.workspaceId,
        createdById: workspaceApiKeys.createdById,
        createdByName: users.displayName,
        createdByEmail: users.email,
        name: workspaceApiKeys.name,
        keyPrefix: workspaceApiKeys.keyPrefix,
        keyHash: workspaceApiKeys.keyHash,
        scope: workspaceApiKeys.scope,
        lastUsedAt: workspaceApiKeys.lastUsedAt,
        revokedAt: workspaceApiKeys.revokedAt,
        createdAt: workspaceApiKeys.createdAt,
        updatedAt: workspaceApiKeys.updatedAt,
      })
      .from(workspaceApiKeys)
      .innerJoin(users, eq(users.id, workspaceApiKeys.createdById))
      .where(eq(workspaceApiKeys.id, row.id))
      .limit(1);
    return shapeApiKey(updated!);
  });

  app.delete("/workspaces/:workspaceId/api-keys/:keyId", async (req, reply) => {
    const { workspaceId, keyId } = req.params as { workspaceId: string; keyId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [row] = await db
      .update(workspaceApiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workspaceApiKeys.id, keyId), eq(workspaceApiKeys.workspaceId, workspaceId)))
      .returning();
    if (!row) throw notFound("api key not found");
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/agent-connections", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    return db.select({
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      maxScope: oauthClients.maxScope,
      lastUsedAt: oauthClients.lastUsedAt,
      createdAt: oauthClients.createdAt,
    }).from(oauthClients).where(and(
      eq(oauthClients.workspaceId, workspaceId),
      eq(oauthClients.kind, "service"),
      isNull(oauthClients.revokedAt),
    )).orderBy(desc(oauthClients.createdAt));
  });

  app.post("/workspaces/:id/agent-connections", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertApiKeysAllowed(clientId);
    const body = dto.createAgentConnectionBody.parse(req.body);
    const serviceClientId = newServiceClientId();
    const secret = newServiceClientSecret();
    const [created] = await db.transaction(async (tx) => {
      // Reuse the established workspace-key authorization and activity-attribution path underneath
      // the OAuth client; the raw key secret is never issued or stored for a service connection.
      const internalKey = newApiKeySecret();
      const [apiKey] = await tx.insert(workspaceApiKeys).values({
        workspaceId,
        createdById: req.auth.sub,
        name: body.name,
        scope: body.scope,
        keyPrefix: `oauth:${serviceClientId.slice(-8)}`,
        keyHash: hashOpaqueToken(internalKey),
      }).returning();
      return tx.insert(oauthClients).values({
        clientId: serviceClientId,
        kind: "service",
        name: body.name,
        clientSecretHash: secret.hash,
        grantTypes: ["client_credentials"],
        workspaceId,
        apiKeyId: apiKey!.id,
        createdById: req.auth.sub,
        maxScope: body.scope,
      }).returning();
    });
    return reply.header("cache-control", "no-store").status(201).send({
      clientId: created!.clientId,
      clientSecret: secret.raw,
      name: created!.name,
      maxScope: created!.maxScope,
      lastUsedAt: created!.lastUsedAt,
      tokenEndpoint: `${env.PUBLIC_API_OAUTH_ISSUER}/oauth/token`,
      createdAt: created!.createdAt,
    });
  });

  app.delete("/workspaces/:workspaceId/agent-connections/:clientId", async (req, reply) => {
    const { workspaceId, clientId } = req.params as { workspaceId: string; clientId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [connection] = await db.update(oauthClients).set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.workspaceId, workspaceId), isNull(oauthClients.revokedAt))).returning();
    if (!connection) throw notFound("agent connection not found");
    await db.transaction(async (tx) => {
      await tx.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.clientId, clientId));
      if (connection.apiKeyId) await tx.update(workspaceApiKeys).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(workspaceApiKeys.id, connection.apiKeyId));
    });
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/webhooks", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const rows = await db
      .select({
        id: webhookEndpoints.id,
        workspaceId: webhookEndpoints.workspaceId,
        createdById: webhookEndpoints.createdById,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        encryptedSecret: webhookEndpoints.encryptedSecret,
        eventTypes: webhookEndpoints.eventTypes,
        enabled: webhookEndpoints.enabled,
        createdAt: webhookEndpoints.createdAt,
        updatedAt: webhookEndpoints.updatedAt,
        lastSuccessfulAt: sql<Date | null>`max(${webhookDeliveries.deliveredAt})`,
      })
      .from(webhookEndpoints)
      .leftJoin(webhookDeliveries, and(
        eq(webhookDeliveries.endpointId, webhookEndpoints.id),
        eq(webhookDeliveries.status, "success"),
      ))
      .where(eq(webhookEndpoints.workspaceId, workspaceId))
      .groupBy(
        webhookEndpoints.id,
        webhookEndpoints.workspaceId,
        webhookEndpoints.createdById,
        webhookEndpoints.name,
        webhookEndpoints.url,
        webhookEndpoints.encryptedSecret,
        webhookEndpoints.eventTypes,
        webhookEndpoints.enabled,
        webhookEndpoints.createdAt,
        webhookEndpoints.updatedAt,
      )
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map(shapeEndpoint);
  });

  app.post("/workspaces/:id/webhooks", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertWebhooksAllowed(clientId);
    const body = dto.createWebhookEndpointBody.parse(req.body);
    assertWebhookUrlAllowed(body.url);
    const secret = newWebhookSecret();
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        workspaceId,
        createdById: req.auth.sub,
        name: body.name,
        url: body.url,
        eventTypes: body.eventTypes,
        enabled: body.enabled,
        encryptedSecret: encryptSecret(secret),
      })
      .returning();
    return reply.status(201).send({ ...shapeEndpoint(row!), secret });
  });

  app.patch("/workspaces/:workspaceId/webhooks/:endpointId", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.updateWebhookEndpointBody.parse(req.body);
    if (body.url !== undefined) assertWebhookUrlAllowed(body.url);
    // Webhooks are a paid-only feature. A downgrade disables existing endpoints; gate the enable
    // transition so a free org cannot turn a disabled endpoint back on (mirrors the automations gate).
    if (body.enabled === true) await assertWebhooksAllowed(clientId);
    const [row] = await db
      .update(webhookEndpoints)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.eventTypes !== undefined && { eventTypes: body.eventTypes }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: new Date(),
      })
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)))
      .returning();
    if (!row) throw notFound("webhook not found");
    return shapeEndpoint(row);
  });

  app.post("/workspaces/:workspaceId/webhooks/:endpointId/secret", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const secret = newWebhookSecret();
    const [row] = await db
      .update(webhookEndpoints)
      .set({ encryptedSecret: encryptSecret(secret), updatedAt: new Date() })
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)))
      .returning();
    if (!row) throw notFound("webhook not found");
    return { ...shapeEndpoint(row), secret };
  });

  app.delete("/workspaces/:workspaceId/webhooks/:endpointId", async (req, reply) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)));
    return reply.status(204).send();
  });

  app.get("/workspaces/:workspaceId/webhooks/:endpointId/deliveries", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const query = dto.listWebhookDeliveriesQuery.parse(req.query ?? {});
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [endpoint] = await db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)))
      .limit(1);
    if (!endpoint) throw notFound("webhook not found");
    return db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(query.limit);
  });

  app.post("/workspaces/:workspaceId/webhooks/:endpointId/deliveries/:deliveryId/retry", async (req) => {
    const { workspaceId, endpointId, deliveryId } = req.params as { workspaceId: string; endpointId: string; deliveryId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)))
      .limit(1);
    if (!endpoint) throw notFound("webhook not found");
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
