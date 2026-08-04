import { dto } from "@kanera/shared";
import { clients, customFields, oauthClients, oauthTokens, users, webhookDeliveries, webhookEndpoints, workspaceApiKeys, workspaces, type ChatDestinationProvider } from "@kanera/shared/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { encryptSecret } from "../../lib/secrets.js";
import { assertWebhookUrlAllowed } from "../../lib/ssrf.js";
import { newWebhookSecret } from "../../lib/webhook-signing.js";
import { hashOpaqueToken } from "../../lib/tokens.js";
import { assertApiKeysAllowed, assertWebhooksAllowed } from "../../lib/tier-limits.js";
import { deliverWebhookDelivery } from "../../lib/webhooks.js";
import { chatDestinationConnectionSummary, encryptChatDestinationConfig, testChatPayload, validateChatDestinationConfig, type ChatDestinationConfig } from "../../lib/chat-destinations.js";
import { newServiceClientId, newServiceClientSecret } from "../../oauth/routes.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { capturePremiumFeatureUsed } from "../../lib/product-analytics.js";

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
function shapePersonalApiKey(row: typeof workspaceApiKeys.$inferSelect & { orgName?: string; orgLogoUrl?: string | null }) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.name,
    clientId: row.clientId,
    orgName: row.orgName ?? null,
    orgLogoUrl: row.clientId ? withSignedMedia(row.clientId, { logoUrl: row.orgLogoUrl ?? null }).logoUrl : null,
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

function shapeChatDestination(row: WebhookEndpointWithStats) {
  const lastSuccessfulAt = row.lastSuccessfulAt
    ? row.lastSuccessfulAt instanceof Date ? row.lastSuccessfulAt : new Date(row.lastSuccessfulAt)
    : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider,
    name: row.name,
    eventTypes: row.eventTypes,
    priorityFieldId: row.priorityFieldId,
    enabled: row.enabled,
    connectionSummary: chatDestinationConnectionSummary(row),
    lastSuccessfulAt: lastSuccessfulAt && !Number.isNaN(lastSuccessfulAt.getTime()) ? lastSuccessfulAt : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function credentialsForProvider(provider: ChatDestinationProvider, credentials: unknown): ChatDestinationConfig {
  if (!credentials || typeof credentials !== "object") throw badRequest("destination credentials are required");
  if (provider === "telegram") {
    const value = credentials as { botToken?: unknown; chatId?: unknown; threadId?: unknown };
    if (typeof value.botToken !== "string" || typeof value.chatId !== "string") throw badRequest("invalid Telegram credentials");
    return { botToken: value.botToken, chatId: value.chatId, threadId: typeof value.threadId === "number" ? value.threadId : null };
  }
  const value = credentials as { webhookUrl?: unknown };
  if (typeof value.webhookUrl !== "string") throw badRequest(`invalid ${provider} credentials`);
  return { webhookUrl: value.webhookUrl };
}

async function assertPriorityField(
  workspaceId: string,
  eventTypes: string[],
  priorityFieldId: string | null,
): Promise<string | null> {
  if (!eventTypes.includes("priority_changed")) return null;
  if (!priorityFieldId) throw badRequest("choose a priority custom field");
  const [field] = await db
    .select({ id: customFields.id })
    .from(customFields)
    .where(and(
      eq(customFields.id, priorityFieldId),
      eq(customFields.workspaceId, workspaceId),
      inArray(customFields.type, ["select", "text"]),
      isNull(customFields.archivedAt),
    ))
    .limit(1);
  if (!field) throw badRequest("priority field must be an active select or text field in this workspace");
  return field.id;
}

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Personal API keys are identity-wide rather than workspace- or organisation-scoped. Any user
  // may manage their own (subject to the paid-tier gate); the stored client id records where the
  // key was issued and supplies a stable default, while live memberships authorize every request.
  app.get("/me/api-keys", async (req) => {
    const rows = await db
      .select({
        id: workspaceApiKeys.id,
        kind: workspaceApiKeys.kind,
        workspaceId: workspaceApiKeys.workspaceId,
        clientId: workspaceApiKeys.clientId,
        createdById: workspaceApiKeys.createdById,
        name: workspaceApiKeys.name,
        keyPrefix: workspaceApiKeys.keyPrefix,
        keyHash: workspaceApiKeys.keyHash,
        scope: workspaceApiKeys.scope,
        lastUsedAt: workspaceApiKeys.lastUsedAt,
        revokedAt: workspaceApiKeys.revokedAt,
        createdAt: workspaceApiKeys.createdAt,
        updatedAt: workspaceApiKeys.updatedAt,
        orgName: clients.name,
        orgLogoUrl: clients.logoUrl,
      })
      .from(workspaceApiKeys)
      .innerJoin(clients, eq(clients.id, workspaceApiKeys.clientId))
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
        clientId: req.auth.cid,
        createdById: req.auth.sub,
        name: body.label ?? null,
        keyPrefix: keyPrefix(secret),
        keyHash: hashOpaqueToken(secret),
      })
      .returning();
    const [organisation] = await db.select({ orgName: clients.name, orgLogoUrl: clients.logoUrl }).from(clients).where(eq(clients.id, req.auth.cid)).limit(1);
    void capturePremiumFeatureUsed({
      organizationId: req.auth.cid,
      workspaceId: req.auth.cid,
      actorId: req.auth.sub,
      premiumFeature: "api",
      supportSession: req.auth.authKind === "support",
    });
    return reply.status(201).send({ ...shapePersonalApiKey({ ...row!, ...organisation }), secret });
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
        clientId: workspaceApiKeys.clientId,
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
        clientId: workspaceApiKeys.clientId,
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
    void capturePremiumFeatureUsed({
      organizationId: clientId,
      workspaceId,
      actorId: req.auth.sub,
      premiumFeature: "api",
      supportSession: req.auth.authKind === "support",
    });
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
        clientId: workspaceApiKeys.clientId,
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
        provider: webhookEndpoints.provider,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        encryptedSecret: webhookEndpoints.encryptedSecret,
        encryptedConfig: webhookEndpoints.encryptedConfig,
        priorityFieldId: webhookEndpoints.priorityFieldId,
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
      .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic")))
      .groupBy(
        webhookEndpoints.id,
        webhookEndpoints.workspaceId,
        webhookEndpoints.createdById,
        webhookEndpoints.provider,
        webhookEndpoints.name,
        webhookEndpoints.url,
        webhookEndpoints.encryptedSecret,
        webhookEndpoints.encryptedConfig,
        webhookEndpoints.priorityFieldId,
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
        provider: "generic",
        name: body.name,
        url: body.url,
        eventTypes: body.eventTypes,
        enabled: body.enabled,
        encryptedSecret: encryptSecret(secret),
      })
      .returning();
    void capturePremiumFeatureUsed({
      organizationId: clientId,
      workspaceId,
      actorId: req.auth.sub,
      premiumFeature: "integrations",
      supportSession: req.auth.authKind === "support",
    });
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
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic")))
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
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic")))
      .returning();
    if (!row) throw notFound("webhook not found");
    return { ...shapeEndpoint(row), secret };
  });

  app.delete("/workspaces/:workspaceId/webhooks/:endpointId", async (req, reply) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic")));
    return reply.status(204).send();
  });

  app.get("/workspaces/:workspaceId/webhooks/:endpointId/deliveries", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const query = dto.listWebhookDeliveriesQuery.parse(req.query ?? {});
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [endpoint] = await db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic")))
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
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertWebhooksAllowed(clientId);
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.provider, "generic")))
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

  app.get("/workspaces/:id/chat-destinations", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const rows = await db
      .select({
        id: webhookEndpoints.id,
        workspaceId: webhookEndpoints.workspaceId,
        createdById: webhookEndpoints.createdById,
        provider: webhookEndpoints.provider,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        encryptedSecret: webhookEndpoints.encryptedSecret,
        encryptedConfig: webhookEndpoints.encryptedConfig,
        priorityFieldId: webhookEndpoints.priorityFieldId,
        eventTypes: webhookEndpoints.eventTypes,
        enabled: webhookEndpoints.enabled,
        createdAt: webhookEndpoints.createdAt,
        updatedAt: webhookEndpoints.updatedAt,
        lastSuccessfulAt: sql<Date | null>`max(${webhookDeliveries.deliveredAt})`,
      })
      .from(webhookEndpoints)
      .leftJoin(webhookDeliveries, and(eq(webhookDeliveries.endpointId, webhookEndpoints.id), eq(webhookDeliveries.status, "success")))
      .where(and(eq(webhookEndpoints.workspaceId, workspaceId), inArray(webhookEndpoints.provider, ["slack", "discord", "telegram", "zulip"])))
      .groupBy(webhookEndpoints.id)
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map(shapeChatDestination);
  });

  app.post("/workspaces/:id/chat-destinations", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertWebhooksAllowed(clientId);
    const body = dto.createChatDestinationBody.parse(req.body);
    const priorityFieldId = await assertPriorityField(workspaceId, body.eventTypes, body.priorityFieldId);
    const credentials = credentialsForProvider(body.provider, body.credentials);
    const [row] = await db.insert(webhookEndpoints).values({
      workspaceId,
      createdById: req.auth.sub,
      provider: body.provider,
      name: body.name,
      url: null,
      encryptedSecret: null,
      encryptedConfig: encryptChatDestinationConfig(body.provider, credentials),
      priorityFieldId,
      eventTypes: body.eventTypes,
      enabled: body.enabled,
    }).returning();
    void capturePremiumFeatureUsed({
      organizationId: clientId,
      workspaceId,
      actorId: req.auth.sub,
      premiumFeature: "integrations",
      supportSession: req.auth.authKind === "support",
    });
    return reply.status(201).send(shapeChatDestination(row!));
  });

  app.patch("/workspaces/:workspaceId/chat-destinations/:endpointId", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const body = dto.updateChatDestinationBody.parse(req.body);
    const [current] = await db.select().from(webhookEndpoints)
      .where(and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.workspaceId, workspaceId),
        inArray(webhookEndpoints.provider, ["slack", "discord", "telegram", "zulip"]),
      )).limit(1);
    if (!current || current.provider === "generic") throw notFound("chat destination not found");
    if (body.enabled === true) await assertWebhooksAllowed(clientId);
    const eventTypes = body.eventTypes ?? current.eventTypes;
    const priorityFieldId = await assertPriorityField(
      workspaceId,
      eventTypes,
      body.priorityFieldId === undefined ? current.priorityFieldId : body.priorityFieldId,
    );
    let encryptedConfig: string | undefined;
    if (body.credentials !== undefined) {
      const credentials = credentialsForProvider(current.provider, body.credentials);
      validateChatDestinationConfig(current.provider, credentials);
      encryptedConfig = encryptChatDestinationConfig(current.provider, credentials);
    }
    const [updated] = await db.update(webhookEndpoints).set({
      ...(body.name !== undefined && { name: body.name }),
      eventTypes,
      priorityFieldId,
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(encryptedConfig !== undefined && { encryptedConfig }),
      updatedAt: new Date(),
    }).where(eq(webhookEndpoints.id, current.id)).returning();
    return shapeChatDestination(updated!);
  });

  app.delete("/workspaces/:workspaceId/chat-destinations/:endpointId", async (req, reply) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const deleted = await db.delete(webhookEndpoints).where(and(
      eq(webhookEndpoints.id, endpointId),
      eq(webhookEndpoints.workspaceId, workspaceId),
      inArray(webhookEndpoints.provider, ["slack", "discord", "telegram", "zulip"]),
    )).returning({ id: webhookEndpoints.id });
    if (deleted.length === 0) throw notFound("chat destination not found");
    return reply.status(204).send();
  });

  app.get("/workspaces/:workspaceId/chat-destinations/:endpointId/deliveries", async (req) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const query = dto.listWebhookDeliveriesQuery.parse(req.query ?? {});
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const [endpoint] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(
      eq(webhookEndpoints.id, endpointId),
      eq(webhookEndpoints.workspaceId, workspaceId),
      inArray(webhookEndpoints.provider, ["slack", "discord", "telegram", "zulip"]),
    )).limit(1);
    if (!endpoint) throw notFound("chat destination not found");
    return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpointId))
      .orderBy(desc(webhookDeliveries.createdAt)).limit(query.limit);
  });

  app.post("/workspaces/:workspaceId/chat-destinations/:endpointId/test", async (req, reply) => {
    const { workspaceId, endpointId } = req.params as { workspaceId: string; endpointId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertWebhooksAllowed(clientId);
    const [[endpoint], [workspace]] = await Promise.all([
      db.select().from(webhookEndpoints).where(and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.workspaceId, workspaceId),
        inArray(webhookEndpoints.provider, ["slack", "discord", "telegram", "zulip"]),
      )).limit(1),
      db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
    ]);
    if (!endpoint || endpoint.provider === "generic") throw notFound("chat destination not found");
    if (!endpoint.enabled) throw badRequest("enable the destination before sending a test");
    const payload = testChatPayload(workspaceId, workspace?.name ?? "Workspace");
    const [delivery] = await db.insert(webhookDeliveries).values({
      endpointId,
      workspaceId,
      eventType: "chat:test",
      payload,
    }).returning();
    const result = await deliverWebhookDelivery(delivery!, endpoint);
    return reply.status(201).send(result);
  });

  app.post("/workspaces/:workspaceId/chat-destinations/:endpointId/deliveries/:deliveryId/retry", async (req) => {
    const { workspaceId, endpointId, deliveryId } = req.params as { workspaceId: string; endpointId: string; deliveryId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await assertWebhooksAllowed(clientId);
    const [endpoint] = await db.select().from(webhookEndpoints).where(and(
      eq(webhookEndpoints.id, endpointId),
      eq(webhookEndpoints.workspaceId, workspaceId),
      inArray(webhookEndpoints.provider, ["slack", "discord", "telegram", "zulip"]),
    )).limit(1);
    if (!endpoint || endpoint.provider === "generic") throw notFound("chat destination not found");
    const [delivery] = await db.select().from(webhookDeliveries).where(and(
      eq(webhookDeliveries.id, deliveryId),
      eq(webhookDeliveries.endpointId, endpointId),
    )).limit(1);
    if (!delivery) throw notFound("delivery not found");
    if (delivery.status !== "failed") throw badRequest("only failed deliveries can be retried");
    return deliverWebhookDelivery(delivery, endpoint);
  });
}
