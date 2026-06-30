import { dto } from "@kanera/shared";
import { users, webhookDeliveries, webhookEndpoints, workspaceApiKeys } from "@kanera/shared/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
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

function newApiKeySecret(): string {
  const prefix = {
    production: "kanera_live_",
    staging: "kanera_stg_",
    development: "kanera_dev_",
    test: "kanera_test_",
  }[env.KANERA_ENVIRONMENT];
  return `${prefix}${randomBytes(32).toString("base64url")}`;
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

function shapeApiKey(row: ApiKeyWithCreator) {
  return {
    id: row.id,
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

function shapeEndpoint(row: typeof webhookEndpoints.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    url: row.url,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:id/api-keys", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const rows = await db
      .select({
        id: workspaceApiKeys.id,
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
      .orderBy(desc(workspaceApiKeys.createdAt));
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

  app.get("/workspaces/:id/webhooks", async (req) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.workspaceId, workspaceId))
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
