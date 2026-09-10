import "../../test/setup.integration.js";
import { webhookEndpoints } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

type EndpointResponse = { id: string; name: string; scope: "workspace" | "connection"; secret?: string };

/**
 * Agents subscribe over the public API. Workspace admins manage every endpoint; a write-scoped
 * credential without admin authority gets a private, connection-scoped view; read-scoped keys stay out.
 */
void test("public API webhook endpoints are admin-wide or connection-scoped by credential", async () => {
  const app = await buildIntegrationServer();
  const { accessToken } = await signupOwner(app, { orgName: "Agent Subscriptions", email: `webhook-scope-${randomUUID()}@example.com`, displayName: "Owner" });
  const auth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Subscriptions" } });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  async function workspaceKey(scope: "read" | "write" | "admin") {
    const created = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/api-keys`, headers: auth, payload: { name: `${scope} key`, scope } });
    assert.equal(created.statusCode, 201);
    return { authorization: `Bearer ${created.json<{ secret: string }>().secret}` };
  }
  const [readKey, writeKey, otherWriteKey, adminKey] = await Promise.all([workspaceKey("read"), workspaceKey("write"), workspaceKey("write"), workspaceKey("admin")]);

  // An admin-created endpoint from the app server, which the connection must never see.
  const adminEndpoint = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/webhooks`,
    headers: auth,
    payload: { name: "Admin CRM sync", url: "https://example.com/admin", eventTypes: [], enabled: true },
  });
  assert.equal(adminEndpoint.statusCode, 201);
  assert.equal(adminEndpoint.json<EndpointResponse>().scope, "workspace");

  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { apiKeyLimitPerMinute: 1000, ipLimitPerMinute: 1000, uploadLimitPerMinute: 100, windowMs: 60_000 },
    uploadsDir: testUploadsDir("test-public-uploads-webhooks"),
  });
  try {
    const base = `/api/v1/workspaces/${workspace.id}/webhooks`;

    // Read-scoped credentials cannot see or create endpoints.
    assert.equal((await publicApi.inject({ method: "GET", url: base, headers: readKey })).statusCode, 403);
    assert.equal((await publicApi.inject({ method: "POST", url: base, headers: readKey, payload: { name: "Nope", url: "https://example.com/nope" } })).statusCode, 403);

    // A write-scoped key registers a connection-scoped endpoint and receives the secret once.
    const created = await publicApi.inject({
      method: "POST",
      url: base,
      headers: writeKey,
      payload: { name: "Agent callback", url: "https://example.com/agent", eventTypes: ["card:updated"], enabled: true },
    });
    assert.equal(created.statusCode, 201);
    const agentEndpoint = created.json<EndpointResponse>();
    assert.equal(agentEndpoint.scope, "connection");
    assert.ok(agentEndpoint.secret);
    const [stored] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, agentEndpoint.id));
    assert.ok(stored?.ownerApiKeyId);
    assert.equal(stored.ownerAgentGrantId, null);

    // The connection lists only its own endpoint; a different write key sees nothing; admins see all.
    const ownList = await publicApi.inject({ method: "GET", url: base, headers: writeKey });
    assert.equal(ownList.statusCode, 200);
    assert.deepEqual(ownList.json<EndpointResponse[]>().map((row) => row.id), [agentEndpoint.id]);
    const otherList = await publicApi.inject({ method: "GET", url: base, headers: otherWriteKey });
    assert.equal(otherList.statusCode, 200);
    assert.deepEqual(otherList.json<EndpointResponse[]>(), []);
    const adminList = await publicApi.inject({ method: "GET", url: base, headers: adminKey });
    assert.equal(adminList.statusCode, 200);
    assert.deepEqual(adminList.json<EndpointResponse[]>().map((row) => row.id).sort(), [agentEndpoint.id, adminEndpoint.json<EndpointResponse>().id].sort());

    // The connection manages its own endpoint but cannot reach the admin's or another connection's.
    const renamed = await publicApi.inject({ method: "PATCH", url: `${base}/${agentEndpoint.id}`, headers: writeKey, payload: { name: "Agent callback v2" } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json<EndpointResponse>().name, "Agent callback v2");
    assert.equal((await publicApi.inject({ method: "PATCH", url: `${base}/${adminEndpoint.json<EndpointResponse>().id}`, headers: writeKey, payload: { name: "Hijack" } })).statusCode, 404);
    assert.equal((await publicApi.inject({ method: "PATCH", url: `${base}/${agentEndpoint.id}`, headers: otherWriteKey, payload: { name: "Hijack" } })).statusCode, 404);
    assert.equal((await publicApi.inject({ method: "GET", url: `${base}/${agentEndpoint.id}/deliveries`, headers: otherWriteKey })).statusCode, 404);
    const deliveries = await publicApi.inject({ method: "GET", url: `${base}/${agentEndpoint.id}/deliveries`, headers: writeKey });
    assert.equal(deliveries.statusCode, 200);
    assert.deepEqual(deliveries.json<unknown[]>(), []);

    const rotated = await publicApi.inject({ method: "POST", url: `${base}/${agentEndpoint.id}/secret`, headers: writeKey });
    assert.equal(rotated.statusCode, 200);
    assert.notEqual(rotated.json<EndpointResponse>().secret, agentEndpoint.secret);

    // Deleting outside the connection's scope is a silent no-op (204), never a leak or a removal.
    assert.equal((await publicApi.inject({ method: "DELETE", url: `${base}/${adminEndpoint.json<EndpointResponse>().id}`, headers: writeKey })).statusCode, 204);
    assert.equal((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.workspaceId, workspace.id))).length, 2);
    assert.equal((await publicApi.inject({ method: "DELETE", url: `${base}/${agentEndpoint.id}`, headers: writeKey })).statusCode, 204);
    assert.equal((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, agentEndpoint.id))).length, 0);
  } finally {
    await publicApi.close();
  }
});

void test("a revoked connection loses access to its endpoints while admins keep managing them", async () => {
  const app = await buildIntegrationServer();
  const { accessToken } = await signupOwner(app, { orgName: "Agent Cleanup", email: `webhook-cleanup-${randomUUID()}@example.com`, displayName: "Owner" });
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspace = (await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Cleanup" } })).json<{ id: string }>();
  const key = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/api-keys`, headers: auth, payload: { name: "agent", scope: "write" } });
  assert.equal(key.statusCode, 201);
  const { id: keyId, secret } = key.json<{ id: string; secret: string }>();

  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { apiKeyLimitPerMinute: 1000, ipLimitPerMinute: 1000, uploadLimitPerMinute: 100, windowMs: 60_000 },
    uploadsDir: testUploadsDir("test-public-uploads-webhooks-cleanup"),
  });
  try {
    const created = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/webhooks`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { name: "Agent callback", url: "https://example.com/agent" },
    });
    assert.equal(created.statusCode, 201);
    const endpointId = created.json<{ id: string }>().id;

    // Revocation is soft (revoked_at), so the row stays until the key is purged; what matters is that
    // the credential can no longer touch it and an admin still can, from either server.
    const revoked = await app.inject({ method: "DELETE", url: `/workspaces/${workspace.id}/api-keys/${keyId}`, headers: auth });
    assert.equal(revoked.statusCode, 204);
    assert.equal((await publicApi.inject({ method: "GET", url: `/api/v1/workspaces/${workspace.id}/webhooks`, headers: { authorization: `Bearer ${secret}` } })).statusCode, 401);

    const adminList = await app.inject({ method: "GET", url: `/workspaces/${workspace.id}/webhooks`, headers: auth });
    assert.equal(adminList.statusCode, 200);
    assert.deepEqual(adminList.json<EndpointResponse[]>().map((row) => [row.id, row.scope]), [[endpointId, "connection"]]);
    assert.equal((await app.inject({ method: "DELETE", url: `/workspaces/${workspace.id}/webhooks/${endpointId}`, headers: auth })).statusCode, 204);
    assert.equal((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId))).length, 0);
  } finally {
    await publicApi.close();
  }
});
