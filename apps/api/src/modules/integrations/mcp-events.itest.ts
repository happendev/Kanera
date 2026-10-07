import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { boardMembers, cardAssignees, eventOutbox, lists, oauthClients, oauthGrants, mcpEventDeliveries, mcpEventSubscriptions, workspaceApiKeys, workspaceMembers } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { encryptSecret } from "../../lib/secrets.js";
import { enqueueMcpEventDeliveries, processMcpEventDeliveries } from "../../lib/mcp-events.js";
import { McpCallbackError, postMcpWebhook, verifyMcpCallback, type McpWebhookRequest } from "../../lib/mcp-event-webhooks.js";
import { processRealtimeOutbox } from "../../realtime/outbox.js";
import { createMcpHttpHandler } from "../../../../mcp/src/http.js";

const secret = () => `whsec_${randomBytes(32).toString("base64")}`;
const actor = { kind: "system", userId: null, self: false } as const;
async function fixture() {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { seed: randomUUID() });
  const createdWorkspace = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Events" } });
  assert.equal(createdWorkspace.statusCode, 201, createdWorkspace.body);
  const workspaceId = createdWorkspace.json<{ id: string }>().id;
  const createdBoard = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/boards`, headers: owner.auth, payload: { name: "Event Board" } });
  assert.equal(createdBoard.statusCode, 201, createdBoard.body);
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId));
  assert.ok(list);
  const workspace = { id: workspaceId, boardId: createdBoard.json<{ id: string }>().id, listId: list.id };
  const key = await app.inject({ method: "POST", url: `/workspaces/${workspace.id}/api-keys`, headers: owner.auth, payload: { name: "Events", scope: "write" } });
  assert.equal(key.statusCode, 201, key.body);
  return { app, owner, workspace, key: key.json<{ id: string; secret: string }>() };
}
function checkSignature(headers: Record<string, string>, body: string, signingSecret: string) {
  const value = createHmac("sha256", Buffer.from(signingSecret.slice(6), "base64"))
    .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
  assert.ok(headers["webhook-signature"]!.split(" ").includes(`v1,${value}`));
}

void test("MCP HTTP lifecycle persists, filters, rotates keys, retries and stops after revoke/unsubscribe", async () => {
  const f = await fixture();
  const s1 = secret();
  const s2 = secret();
  const verified: string[] = [];
  const delivered: Array<{ body: string; headers: Record<string, string> }> = [];
  let status = 204;
  const send: McpWebhookRequest = async (_url, body, headers) => {
    const payload = JSON.parse(body) as { type?: string; challenge?: string; eventId?: string };
    if (payload.type === "verification") {
      checkSignature(headers, body, s1);
      verified.push(payload.challenge!);
      return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    }
    checkSignature(headers, body, s2);
    checkSignature(headers, body, s1);
    assert.equal(headers["webhook-id"], payload.eventId);
    delivered.push({ body, headers });
    return { status, body: "" };
  };
  const publicApi = await buildPublicApiServer({ logger: false, enableWebhookDeliveryScheduler: false, rateLimit: { enabled: false }, mcpWebhookRequest: send });
  const publicApiUrl = await publicApi.listen({ port: 0, host: "127.0.0.1" });
  let mcp = createServer(createMcpHttpHandler({ publicApiUrl }));
  const listen = async () => {
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const addr = mcp.address();
    assert.ok(addr && typeof addr !== "string");
    return `http://127.0.0.1:${addr.port}/mcp`;
  };
  let url = await listen();
  const rpc = async (method: string, params: Record<string, unknown> = {}, key = f.key.secret) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": method };
    if (method === "tools/call") headers["mcp-name"] = String(params.name);
    const _meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta } }) });
    return { status: response.status, ...await response.json() as { result?: Record<string, unknown>; error?: { code: number; data?: { reason: string } } } };
  };
  const params = { name: "card.created", arguments: { workspaceId: f.workspace.id, boardId: f.workspace.boardId }, delivery: { mode: "webhook", url: "https://receiver.example/callback", secret: s1 }, cursor: null, maxAgeMs: 300_000 };
  try {
    const discovery = await rpc("server/discover");
    assert.deepEqual(discovery.result?.supportedVersions, ["2026-07-28"]);
    assert.equal((await rpc("tools/call", { name: "session.get", arguments: {} })).result?.isError, undefined);
    const subscription = await rpc("events/subscribe", params);
    assert.ok(subscription.result, JSON.stringify(subscription));
    const id = String(subscription.result.id);
    assert.equal(verified.length, 1);
    // Recreate the HTTP server to demonstrate that subscriptions belong to durable storage.
    await new Promise<void>((resolve) => mcp.close(() => resolve()));
    mcp = createServer(createMcpHttpHandler({ publicApiUrl }));
    url = await listen();
    const refreshed = await rpc("events/subscribe", { ...params, arguments: { boardId: f.workspace.boardId, workspaceId: f.workspace.id }, delivery: { ...params.delivery, secret: s2 }, ttlMs: 60_000 });
    assert.equal(refreshed.result?.id, id);
    assert.equal(verified.length, 1, "verification cache spans restart and event identities");
    const rows = await db.select().from(mcpEventSubscriptions);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.encryptedSecret, s2);
    assert.ok(new Date(String(refreshed.result?.refreshBefore)).getTime() <= Date.now() + 60_000);
    const created = await publicApi.inject({ method: "POST", url: `/api/v1/boards/${f.workspace.boardId}/lists/${f.workspace.listId}/cards`, headers: { authorization: `Bearer ${f.key.secret}` }, payload: { title: "MCP event card" } });
    assert.equal(created.statusCode, 201, created.body);
    const card = created.json<{ id: string }>();
    const events = await db.select().from(eventOutbox).where(eq(eventOutbox.eventType, "card:created"));
    assert.equal(events.length, 1);
    await processRealtimeOutbox({ limit: 100 });
    await enqueueMcpEventDeliveries(events[0]!);
    assert.equal((await db.select().from(mcpEventDeliveries)).length, 1);
    status = 503;
    await processMcpEventDeliveries(send);
    assert.equal(delivered.length, 1);
    assert.equal((await db.select().from(mcpEventDeliveries))[0]?.status, "queued");
    await db.update(mcpEventDeliveries).set({ nextAttemptAt: new Date(0) });
    status = 204;
    await processMcpEventDeliveries(send);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0]!.body, delivered[1]!.body, "stable occurrence bytes and event ID across retries");
    assert.equal((await db.select().from(mcpEventDeliveries))[0]?.status, "success");
    const deliveredData = (JSON.parse(delivered[0]!.body) as { data: { cardId: string; actor: { kind: string; userId: string; self: boolean } } }).data;
    assert.equal(deliveredData.cardId, card.id);
    assert.deepEqual(deliveredData.actor, { kind: "apiKey", userId: f.owner.user.id, self: true }, "the subscribing key's own write is marked self");
    // The refresh reports the 503 that preceded the successful retry as cleared.
    const health = await rpc("events/subscribe", { ...params, delivery: { ...params.delivery, secret: s2 } });
    assert.equal((health.result?.deliveryStatus as { active: boolean; lastError: string | null }).lastError, null);
    assert.ok((health.result?.deliveryStatus as { lastDeliveryAt: string | null }).lastDeliveryAt);
    const filtered = await rpc("events/subscribe", { ...params, name: "comment.created", arguments: { ...params.arguments, cardId: card.id }, delivery: { ...params.delivery, secret: s2 } });
    assert.ok(filtered.result);
    await enqueueMcpEventDeliveries({ ...events[0]!, id: randomUUID(), eventType: "comment:created", payload: { boardId: f.workspace.boardId, cardId: randomUUID(), comment: { id: randomUUID(), body: "Other card" } } as never });
    assert.equal((await db.select().from(mcpEventDeliveries)).length, 1, "unrelated card does not enqueue");
    // card:moved carries no card object; the destination list must still reach the subscriber.
    const moved = await rpc("events/subscribe", { ...params, name: "card.moved", delivery: { ...params.delivery, secret: s2 } });
    assert.ok(moved.result);
    await enqueueMcpEventDeliveries({ ...events[0]!, occurredAt: new Date(), eventType: "card:moved", payload: { boardId: f.workspace.boardId, cardId: card.id, fromListId: f.workspace.listId, toListId: f.workspace.listId, position: "2", prevPosition: "1" } as never });
    const movedDelivery = (await db.select().from(mcpEventDeliveries)).find((row) => row.payload.name === "card.moved");
    const movedData = movedDelivery?.payload.name === "card.moved" ? movedDelivery.payload.data : undefined;
    assert.deepEqual({ listId: movedData?.listId, prevPosition: movedData?.prevPosition }, { listId: f.workspace.listId, prevPosition: "1" });
    assert.ok(movedData?.url, "moved occurrences resolve the canonical card URL from the database");
    await db.delete(mcpEventDeliveries).where(eq(mcpEventDeliveries.id, movedDelivery!.id));
    await rpc("events/unsubscribe", { name: "card.moved", arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } });
    // Expiration prevents queued data being sent; restarting/refreshing cannot replay missed history.
    await db.update(mcpEventSubscriptions).set({ expiresAt: new Date(0) }).where(eq(mcpEventSubscriptions.id, id));
    await db.update(mcpEventDeliveries).set({ status: "queued", nextAttemptAt: new Date(0) });
    await processMcpEventDeliveries(send);
    assert.equal(delivered.length, 2);
    await rpc("events/subscribe", { ...params, delivery: { ...params.delivery, secret: s2 } });
    await db.update(mcpEventDeliveries).set({ status: "queued", nextAttemptAt: new Date(0) });
    await processMcpEventDeliveries(send);
    assert.equal(delivered.length, 2, "no replay after expired refresh");
    const unsubscribe = { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } };
    const secondKeyResponse = await f.app.inject({ method: "POST", url: `/workspaces/${f.workspace.id}/api-keys`, headers: f.owner.auth, payload: { name: "Other", scope: "write" } });
    const secondKey = secondKeyResponse.json<{ secret: string }>().secret;
    await rpc("events/unsubscribe", unsubscribe, secondKey);
    assert.equal((await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, id))).length, 1);
    await rpc("events/unsubscribe", unsubscribe);
    await rpc("events/unsubscribe", unsubscribe);
    assert.equal((await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, id))).length, 0);
    // Revocation is checked by the worker even while no bearer request is running.
    await db.update(workspaceApiKeys).set({ revokedAt: new Date() }).where(eq(workspaceApiKeys.id, f.key.id));
    const stored = (await db.select().from(mcpEventSubscriptions))[0]!;
    await db.insert(mcpEventDeliveries).values({ subscriptionId: stored.id, payload: { eventId: "evt_revoke", name: "comment.created", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId: card.id, actor }, cursor: null } });
    await processMcpEventDeliveries(send);
    assert.equal(delivered.length, 2);
    assert.equal((await rpc("server/discover")).status, 401, "a revoked credential gets the auth challenge, not a capability list");
  } finally {
    await new Promise<void>((resolve) => mcp.close(() => resolve()));
    await publicApi.close();
  }
});

void test("callback failure and lost membership never deliver application data", async () => {
  const f = await fixture();
  const publicApi = await buildPublicApiServer({ logger: false, enableWebhookDeliveryScheduler: false, rateLimit: { enabled: false }, mcpWebhookRequest: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
  try {
    const payload = { name: "card.created", arguments: { workspaceId: f.workspace.id }, delivery: { mode: "webhook", url: "https://receiver.example/hook", secret: secret() } };
    const headers = { authorization: `Bearer ${f.key.secret}` };
    const failed = await publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/subscribe", headers, payload });
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.json<{ reason: string }>().reason, "challenge_failed");
    assert.equal((await db.select().from(mcpEventSubscriptions)).length, 0);
    for (const delivery of [ { ...payload.delivery, secret: "whsec_short" }, { ...payload.delivery, url: "http://127.0.0.1/hook" }, { ...payload.delivery, url: "https://user:pass@receiver.example/hook" } ]) {
      const invalid = await publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/subscribe", headers, payload: { ...payload, delivery } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json<{ code: string }>().code, "VALIDATION");
    }
    await db.insert(mcpEventSubscriptions).values({ id: "sub_access", workspaceId: f.workspace.id, userId: f.owner.user.id, ownerApiKeyId: f.key.id, name: payload.name, arguments: payload.arguments, url: payload.delivery.url, encryptedSecret: encryptSecret(payload.delivery.secret), verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(mcpEventDeliveries).values({ subscriptionId: "sub_access", payload: { eventId: "evt_access", name: "card.created", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId: randomUUID(), actor }, cursor: null } });
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, f.owner.user.id));
    let attempts = 0;
    await processMcpEventDeliveries(async () => { attempts++; return { status: 204, body: "" }; });
    assert.equal(attempts, 0);
  } finally { await publicApi.close(); }
});

void test("strict callback transport rejects nonpublic addresses and verification requires a matching challenge", async () => {
  for (const url of ["https://127.0.0.1/hook", "https://10.0.0.1/hook", "https://169.254.169.254/hook", "https://[::1]/hook", "https://[::ffff:7f00:1]/hook", "https://[64:ff9b::7f00:1]/hook", "https://[2002:7f00:1::]/hook"]) {
    await assert.rejects(postMcpWebhook(url, "{}", {}), (error: unknown) => error instanceof McpCallbackError && error.reason === "blocked_address");
  }
  await assert.rejects(verifyMcpCallback("https://receiver.example/hook", secret(), "sub_test", async () => ({ status: 302, body: "" })), McpCallbackError);
  await assert.rejects(verifyMcpCallback("https://receiver.example/hook", secret(), "sub_test", async () => ({ status: 200, body: "bad json" })), McpCallbackError);
});

void test("410 and 413 stop individual retries, and disconnected OAuth connections stop delivery", async () => {
  const f = await fixture();
  const cardCreated = await f.app.inject({ method: "POST", url: `/boards/${f.workspace.boardId}/lists/${f.workspace.listId}/cards`, headers: f.owner.auth, payload: { title: "Terminal events" } });
  assert.equal(cardCreated.statusCode, 201, cardCreated.body);
  const cardId = cardCreated.json<{ id: string }>().id;
  const insertSubscription = async (id: string, extra: Partial<typeof mcpEventSubscriptions.$inferInsert> = {}) => {
    await db.insert(mcpEventSubscriptions).values({
      id, workspaceId: f.workspace.id, userId: f.owner.user.id, ownerApiKeyId: f.key.id,
      name: "card.updated", arguments: { workspaceId: f.workspace.id, boardId: f.workspace.boardId },
      url: "https://receiver.example/hook", encryptedSecret: encryptSecret(secret()),
      verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), ...extra,
    });
  };
  const queue = async (id: string) => {
    await db.insert(mcpEventDeliveries).values({ subscriptionId: id, payload: { eventId: randomUUID(), name: "card.updated", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId, actor }, cursor: null } });
  };
  await insertSubscription("sub_gone");
  await insertSubscription("sub_large");
  await queue("sub_gone");
  await queue("sub_large");
  let attempts = 0;
  const send: McpWebhookRequest = async (_url, _body, headers) => {
    attempts++;
    return { status: headers["X-MCP-Subscription-Id"] === "sub_gone" ? 410 : 413, body: "" };
  };
  await processMcpEventDeliveries(send);
  assert.equal(attempts, 2);
  assert.ok((await db.select().from(mcpEventDeliveries)).every((row) => row.status === "failed"));
  await queue("sub_gone");
  await processMcpEventDeliveries(send);
  assert.equal(attempts, 3, "410 only rejects its event; future events still reach the receiver");
  // A deleted card rejects only its queued occurrence; watching the rest of the board continues.
  await insertSubscription("sub_missing");
  await db.insert(mcpEventDeliveries).values({ subscriptionId: "sub_missing", payload: { eventId: randomUUID(), name: "card.updated", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId: randomUUID(), actor }, cursor: null } });
  await processMcpEventDeliveries(send);
  assert.equal(attempts, 3);
  const [remaining] = await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, "sub_missing"));
  assert.ok(remaining!.expiresAt > new Date(), "an inaccessible occurrence must not expire a board-wide subscription");
  const serviceId = `service_${randomUUID()}`;
  await db.insert(oauthClients).values({ clientId: serviceId, kind: "service", name: "Service", grantTypes: ["client_credentials"], apiKeyId: f.key.id, workspaceId: f.workspace.id, createdById: f.owner.user.id, revokedAt: new Date() });
  await insertSubscription("sub_service", { ownerServiceClientId: serviceId });
  await queue("sub_service");
  const interactiveId = `interactive_${randomUUID()}`;
  await db.insert(oauthClients).values({ clientId: interactiveId, kind: "public", name: "Agent", grantTypes: ["authorization_code"] });
  const [grant] = await db.insert(oauthGrants).values({ clientId: interactiveId, userId: f.owner.user.id, orgClientId: f.owner.user.clientId, scopes: ["kanera:read", "kanera:write"], resource: "https://mcp.example/mcp", revokedAt: new Date() }).returning();
  await insertSubscription("sub_agent", { ownerApiKeyId: null, ownerAgentGrantId: grant!.id });
  await queue("sub_agent");
  await processMcpEventDeliveries(send);
  assert.equal(attempts, 3, "revoked service and interactive connections cannot deliver");
});

void test("restricted cross-organisation guests only subscribe to visible assigned cards", async () => {
  const f = await fixture();
  const guest = await signupOwner(f.app, { seed: randomUUID() });
  await db.insert(boardMembers).values({ boardId: f.workspace.boardId, userId: guest.user.id, role: "observer", assignedItemsOnly: true });
  const key = await f.app.inject({ method: "POST", url: "/me/api-keys", headers: guest.auth, payload: { label: "Guest observer", scope: "read" } });
  assert.equal(key.statusCode, 201, key.body);
  const headers = { authorization: `Bearer ${key.json<{ secret: string }>().secret}` };
  const cardCreated = await f.app.inject({ method: "POST", url: `/boards/${f.workspace.boardId}/lists/${f.workspace.listId}/cards`, headers: f.owner.auth, payload: { title: "Assigned guest" } });
  const cardId = cardCreated.json<{ id: string }>().id;
  let callbacks = 0;
  const publicApi = await buildPublicApiServer({ logger: false, enableWebhookDeliveryScheduler: false, rateLimit: { enabled: false }, mcpWebhookRequest: async (_url, body) => {
    callbacks++;
    const { challenge } = JSON.parse(body) as { challenge: string };
    return { status: 200, body: JSON.stringify({ challenge }) };
  } });
  const payload = { name: "comment.created", delivery: { mode: "webhook", url: "https://receiver.example/guest", secret: secret() } };
  const subscribe = (args: { workspaceId: string; boardId?: string; cardId?: string }) => publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/subscribe", headers, payload: { ...payload, arguments: args } });
  try {
    assert.equal((await subscribe({ workspaceId: f.workspace.id })).statusCode, 403);
    assert.equal((await subscribe({ workspaceId: f.workspace.id, boardId: f.workspace.boardId })).statusCode, 403);
    const args = { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId };
    assert.equal((await subscribe(args)).statusCode, 403);
    assert.equal(callbacks, 0, "authorization precedes callback I/O");
    await db.insert(cardAssignees).values({ cardId, userId: guest.user.id });
    const accepted = await subscribe(args);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(callbacks, 1);
    await db.insert(mcpEventDeliveries).values({ subscriptionId: accepted.json<{ id: string }>().id, payload: { eventId: randomUUID(), name: "comment.created", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId, actor }, cursor: null } });
    await db.delete(cardAssignees).where(eq(cardAssignees.cardId, cardId));
    await processMcpEventDeliveries(async () => { callbacks++; return { status: 204, body: "" }; });
    assert.equal(callbacks, 1, "losing assignment stops delivery during the subscription lifetime");
  } finally { await publicApi.close(); }
});

void test("retries stop after the bounded budget and record endpoint health without raw responses", async () => {
  const f = await fixture();
  const cardCreated = await f.app.inject({ method: "POST", url: `/boards/${f.workspace.boardId}/lists/${f.workspace.listId}/cards`, headers: f.owner.auth, payload: { title: "Flaky receiver" } });
  const cardId = cardCreated.json<{ id: string }>().id;
  await db.insert(mcpEventSubscriptions).values({
    id: "sub_flaky", workspaceId: f.workspace.id, userId: f.owner.user.id, ownerApiKeyId: f.key.id,
    name: "card.updated", arguments: { workspaceId: f.workspace.id }, url: "https://receiver.example/flaky",
    encryptedSecret: encryptSecret(secret()), verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(mcpEventDeliveries).values({ subscriptionId: "sub_flaky", payload: { eventId: "evt_flaky", name: "card.updated", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId, actor }, cursor: null } });
  let attempts = 0;
  const send: McpWebhookRequest = async () => { attempts++; return { status: 503, body: "upstream secret detail" }; };
  // A row whose secret cannot be decrypted must not abort the batch for the healthy rows beside it.
  await db.insert(mcpEventSubscriptions).values({
    id: "sub_corrupt", workspaceId: f.workspace.id, userId: f.owner.user.id, ownerApiKeyId: f.key.id,
    name: "card.updated", arguments: { workspaceId: f.workspace.id }, url: "https://receiver.example/corrupt",
    encryptedSecret: "encv1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA", verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(mcpEventDeliveries).values({ subscriptionId: "sub_corrupt", payload: { eventId: "evt_corrupt", name: "card.updated", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId, actor }, cursor: null } });
  for (let i = 0; i < 8; i++) {
    await db.update(mcpEventDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(mcpEventDeliveries.subscriptionId, "sub_flaky"));
    await processMcpEventDeliveries(send);
  }
  assert.equal(attempts, 5, "the draft bounds webhook retries to 3-5 attempts");
  const [corrupt] = await db.select().from(mcpEventDeliveries).where(eq(mcpEventDeliveries.subscriptionId, "sub_corrupt"));
  assert.equal(corrupt?.status, "delivering", "the undecryptable row keeps its lease instead of failing the drain");
  const [delivery] = await db.select().from(mcpEventDeliveries).where(eq(mcpEventDeliveries.subscriptionId, "sub_flaky"));
  assert.equal(delivery?.status, "failed");
  const [health] = await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, "sub_flaky"));
  assert.equal(health?.lastError, "http_5xx");
  assert.ok(health?.failedSince);
  assert.equal(health?.lastDeliveryAt, null);
  // A connection failure is categorised, never echoed.
  await db.insert(mcpEventDeliveries).values({ subscriptionId: "sub_flaky", payload: { eventId: "evt_timeout", name: "card.updated", timestamp: new Date().toISOString(), data: { workspaceId: f.workspace.id, boardId: f.workspace.boardId, cardId, actor }, cursor: null } });
  await processMcpEventDeliveries(async () => { throw new McpCallbackError("timeout"); });
  const [timedOut] = await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, "sub_flaky"));
  assert.equal(timedOut?.lastError, "timeout");
  assert.equal(timedOut?.failedSince?.getTime(), health?.failedSince?.getTime(), "failedSince marks the start of the failing streak");
});


// Local callbacks are deliberately blocked in production and E2E. Substitute only outbound
// HTTPS I/O here to verify real route mutations, durable matching, signatures and delivery.
void test("list subscriptions deliver arrivals and departures, exclude reorders and isolate list identity", async () => {
  const f = await fixture();
  const signingSecret = secret();
  const delivered: Array<{ eventId: string; name: string; data: { cardId: string; listId?: string; fromListId?: string } }> = [];
  const send: McpWebhookRequest = async (_url, body, headers) => {
    checkSignature(headers, body, signingSecret);
    const payload = JSON.parse(body) as { type: "verification"; challenge: string } | (typeof delivered)[number];
    if ("type" in payload) return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    delivered.push(payload);
    return { status: 204, body: "" };
  };
  const publicApi = await buildPublicApiServer({ logger: false, enableWebhookDeliveryScheduler: false, rateLimit: { enabled: false }, mcpWebhookRequest: send });
  const headers = { authorization: `Bearer ${f.key.secret}` };
  const argumentsFor = (listId: string) => ({ workspaceId: f.workspace.id, listId });
  const subscribe = (name: string, listId: string) => publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/subscribe", headers, payload: { name, arguments: argumentsFor(listId), delivery: { mode: "webhook", url: "https://receiver.example/list", secret: signingSecret } } });
  try {
    const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, f.workspace.id));
    const watched = workspaceLists[0]!.id;
    const outside = workspaceLists[1]!.id;
    const other = workspaceLists[2]!.id;
    const invalid = await subscribe("card.moved", randomUUID());
    assert.equal(invalid.statusCode, 400, invalid.body);
    const foreignWorkspace = await f.app.inject({ method: "POST", url: "/workspaces", headers: f.owner.auth, payload: { name: "Other list scope" } });
    assert.equal(foreignWorkspace.statusCode, 201, foreignWorkspace.body);
    const [foreignList] = await db.select().from(lists).where(eq(lists.workspaceId, foreignWorkspace.json<{ id: string }>().id));
    assert.equal((await subscribe("card.moved", foreignList!.id)).statusCode, 400);
    const stream = await subscribe("card.moved", watched);
    assert.equal(stream.statusCode, 200, stream.body);
    const id = stream.json<{ id: string }>().id;
    const renewed = await subscribe("card.moved", watched);
    assert.equal(renewed.json<{ id: string }>().id, id);
    const second = await subscribe("card.moved", outside);
    assert.notEqual(second.json<{ id: string }>().id, id);
    const unsubscribe = await publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/unsubscribe", headers, payload: { name: "card.moved", arguments: argumentsFor(outside), delivery: { mode: "webhook", url: "https://receiver.example/list" } } });
    assert.equal(unsubscribe.statusCode, 200, unsubscribe.body);
    assert.equal((await db.select().from(mcpEventSubscriptions).where(eq(mcpEventSubscriptions.id, id))).length, 1);
    for (const name of ["card.created", "card.updated", "comment.created"]) assert.equal((await subscribe(name, watched)).statusCode, 200);
    const create = async (listId: string) => {
      const response = await f.app.inject({ method: "POST", url: `/boards/${f.workspace.boardId}/lists/${listId}/cards`, headers: f.owner.auth, payload: { title: "List event card" } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ id: string }>().id;
    };
    const cardId = await create(outside);
    const watchedCard = await create(watched);
    const move = async (listId: string, beforeCardId?: string) => {
      const response = await f.app.inject({ method: "POST", url: `/cards/${cardId}/move`, headers: f.owner.auth, payload: { listId, beforeCardId: beforeCardId ?? null } });
      assert.equal(response.statusCode, 200, response.body);
    };
    await move(watched);
    const updated = await f.app.inject({ method: "PATCH", url: `/cards/${cardId}`, headers: f.owner.auth, payload: { title: "Changed while in watched list" } });
    assert.equal(updated.statusCode, 200, updated.body);
    await move(watched, watchedCard);
    await move(outside);
    await move(other);
    // Drain after all moves: arrival/departure matching must use the event's lists even though
    // the live card is now elsewhere. Updates likewise retain their event-time card snapshot.
    const moveEvents = (await db.select().from(eventOutbox)).filter((event) => event.eventType === "card:moved" && (event.payload as { cardId?: string }).cardId === cardId);
    assert.equal(moveEvents.length, 4, "the fixture actually emitted the reorder and unrelated move");
    await processRealtimeOutbox({ limit: 100 });
    while (await processMcpEventDeliveries(send)) { /* drain the bounded batches */ }
    const moves = delivered.filter((event) => event.name === "card.moved");
    assert.deepEqual(moves.map((event) => [event.data.fromListId, event.data.listId]), [[outside, watched], [watched, outside]]);
    assert.equal(new Set(moves.map((event) => event.eventId)).size, 2, "only arrivals and departures deliver; same-list reorders are excluded");
    assert.deepEqual(delivered.filter((event) => event.name === "card.created").map((event) => event.data.cardId), [watchedCard]);
    assert.equal(delivered.filter((event) => event.name === "card.updated" && event.data.cardId === cardId).length, 1);
    await f.app.inject({ method: "PATCH", url: `/cards/${cardId}`, headers: f.owner.auth, payload: { title: "Changed outside watched list" } });
    await processRealtimeOutbox({ limit: 100 });
    await processMcpEventDeliveries(send);
    assert.equal(delivered.filter((event) => event.name === "card.updated" && event.data.cardId === cardId).length, 1);
  } finally {
    await publicApi.close();
    await f.app.close();
  }
});

// Failure modes covered: a subscription can name someone else's queue (via arguments or a stored
// row); one user's queue change reaches another user's subscription, even a workspace admin's; a
// queue change from a direct add or an indirect completion does not enqueue; the occurrence leaks
// queue content; actor.self misreports the subscriber's own write.
void test("priorities.changed only ever reports the subscriber's own Up next queue", async () => {
  const f = await fixture();
  const signingSecret = secret();
  const delivered: Array<{ subscriptionId: string; name: string; data: Record<string, unknown> }> = [];
  const send: McpWebhookRequest = async (_url, body, headers) => {
    const payload = JSON.parse(body) as { type?: string; challenge?: string; name: string; data: Record<string, unknown> };
    if (payload.type === "verification") return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    checkSignature(headers, body, signingSecret);
    delivered.push({ subscriptionId: headers["X-MCP-Subscription-Id"]!, name: payload.name, data: payload.data });
    return { status: 204, body: "" };
  };
  const publicApi = await buildPublicApiServer({ logger: false, enableWebhookDeliveryScheduler: false, rateLimit: { enabled: false }, mcpWebhookRequest: send });
  try {
    const keyHeaders = { authorization: `Bearer ${f.key.secret}` };
    const subscribe = (args: Record<string, unknown>, headers = keyHeaders) => publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/subscribe", headers,
      payload: { name: "priorities.changed", arguments: args, delivery: { mode: "webhook", url: "https://receiver.example/queue", secret: signingSecret } } });
    const catalog = await publicApi.inject({ method: "GET", url: "/api/v1/mcp-events", headers: keyHeaders });
    assert.ok(catalog.json<{ events: Array<{ name: string }> }>().events.some((event) => event.name === "priorities.changed"));

    // A workspace admin in the same organisation: the most privileged watcher there could be.
    const [teammateUser] = await insertTestUsers(db, { clientId: f.owner.user.clientId, email: `teammate-${randomUUID()}@example.test`, passwordHash: "x", displayName: "Teammate" }).returning();
    assert.ok(teammateUser);
    await db.insert(workspaceMembers).values({ workspaceId: f.workspace.id, userId: teammateUser.id, role: "admin" });
    await db.insert(boardMembers).values({ boardId: f.workspace.boardId, userId: teammateUser.id, role: "editor" });
    const teammateAuth = { authorization: `Bearer ${f.app.jwt.sign({ sub: teammateUser.id, cid: teammateUser.clientId, role: "member" })}` };
    const teammateKey = await f.app.inject({ method: "POST", url: "/me/api-keys", headers: teammateAuth, payload: { label: "Teammate", scope: "write" } });
    assert.equal(teammateKey.statusCode, 201, teammateKey.body);
    const teammateHeaders = { authorization: `Bearer ${teammateKey.json<{ secret: string }>().secret}` };

    assert.equal((await subscribe({ targetUserId: f.owner.user.id }, teammateHeaders)).statusCode, 400, "there is no way to name another user's queue");
    const mine = await subscribe({});
    assert.equal(mine.statusCode, 200, mine.body);
    const theirs = await subscribe({}, teammateHeaders);
    assert.equal(theirs.statusCode, 200, theirs.body);
    const ownerSubscriptionId = mine.json<{ id: string }>().id;
    const teammateSubscriptionId = theirs.json<{ id: string }>().id;
    const stored = await db.select().from(mcpEventSubscriptions);
    assert.deepEqual(stored.map((row) => row.targetUserId === row.userId && row.workspaceId === null), [true, true]);
    await assert.rejects(db.insert(mcpEventSubscriptions).values({
      id: "sub_foreign_queue", userId: teammateUser.id, targetUserId: f.owner.user.id, ownerApiKeyId: f.key.id, name: "priorities.changed", arguments: {},
      url: "https://receiver.example/queue", encryptedSecret: encryptSecret(signingSecret), verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    }), "the database refuses a subscription to someone else's queue");

    // The owner queues a card; only the owner's subscription hears about it.
    const created = await f.app.inject({ method: "POST", url: `/boards/${f.workspace.boardId}/lists/${f.workspace.listId}/cards`, headers: f.owner.auth, payload: { title: "Queued work" } });
    assert.equal(created.statusCode, 201, created.body);
    const cardId = created.json<{ id: string }>().id;
    await db.insert(cardAssignees).values([{ cardId, userId: f.owner.user.id }, { cardId, userId: teammateUser.id }]);
    const added = await publicApi.inject({ method: "POST", url: `/api/v1/work/priorities/${f.owner.user.id}/cards`, headers: keyHeaders, payload: { cardId, beforeId: null } });
    assert.equal(added.statusCode, 201, added.body);
    await processMcpEventDeliveries(send);
    assert.deepEqual(delivered, [{ subscriptionId: ownerSubscriptionId, name: "priorities.changed", data: { targetUserId: f.owner.user.id, actor: { kind: "apiKey", userId: f.owner.user.id, self: true } } }], "content-free, own subscription only, and the key's own write is self");

    // The teammate queues the same card; only the teammate's subscription hears about it.
    const teammateAdded = await publicApi.inject({ method: "POST", url: `/api/v1/work/priorities/${teammateUser.id}/cards`, headers: teammateHeaders, payload: { cardId, beforeId: null } });
    assert.equal(teammateAdded.statusCode, 201, teammateAdded.body);
    await processMcpEventDeliveries(send);
    assert.deepEqual(delivered.slice(1).map((event) => [event.subscriptionId, event.data.targetUserId]), [[teammateSubscriptionId, teammateUser.id]]);

    // Completing a queued card drops it from both live queues without touching card_priorities;
    // each watcher hears about their own queue once.
    const completed = await f.app.inject({ method: "PATCH", url: `/cards/${cardId}/completion`, headers: f.owner.auth, payload: { completed: true } });
    assert.equal(completed.statusCode, 200, completed.body);
    await processMcpEventDeliveries(send);
    const afterCompletion = delivered.slice(2);
    assert.deepEqual(afterCompletion.map((event) => [event.subscriptionId, event.data.targetUserId]).sort(), [[ownerSubscriptionId, f.owner.user.id], [teammateSubscriptionId, teammateUser.id]].sort());
    assert.deepEqual(afterCompletion.find((event) => event.subscriptionId === ownerSubscriptionId)!.data.actor, { kind: "user", userId: f.owner.user.id, self: false });

    const unsubscribed = await publicApi.inject({ method: "POST", url: "/api/v1/mcp-events/unsubscribe", headers: keyHeaders, payload: { name: "priorities.changed", arguments: {}, delivery: { mode: "webhook", url: "https://receiver.example/queue" } } });
    assert.equal(unsubscribed.statusCode, 200, unsubscribed.body);
    assert.deepEqual((await db.select().from(mcpEventSubscriptions)).map((row) => row.id), [teammateSubscriptionId], "unsubscribe removes only the caller's stream");
  } finally { await publicApi.close(); }
});
