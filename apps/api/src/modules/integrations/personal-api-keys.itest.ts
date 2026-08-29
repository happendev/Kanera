import "../../test/setup.integration.js";
import { activityEvents, boards, cards, clientMembers, clients, lists, oauthClients, oauthGrants, workspaceApiKeys, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

// Exercises the full personal-key stack over HTTP: the /me/api-keys management routes on the app
// server, the auth plugin's personal-key claim construction, activity attribution as the owner, and
// revocation. Board-content-only enforcement is proven precisely in lib/access.itest.ts.
async function seedOwnerWithBoardCard(testName: string) {
  const app = await buildIntegrationServer();
  const { user, auth: auth } = await signupOwner(app, { orgName: `Acme ${testName}`, email: `owner-${randomUUID()}@example.com`, displayName: "Owner" });

  const workspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({ listId: list.id, boardId: board!.id, title: "Original", position: "1000.0000000000", createdById: user.id }).returning();

  return { app, auth, userId: user.id, orgId: user.clientId, workspaceId: workspace.id, boardId: board!.id, cardId: card!.id };
}

async function createPersonalKey(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  auth: { authorization: string },
  label?: string,
  scope?: "read" | "write",
) {
  const created = await app.inject({
    method: "POST",
    url: "/me/api-keys",
    headers: auth,
    payload: { ...(label ? { label } : {}), ...(scope ? { scope } : {}) },
  });
  assert.equal(created.statusCode, 201);
  return created.json<{ id: string; kind: string; label: string | null; keyPrefix: string; scope: string; secret: string }>();
}

async function addOwnedOrganisation(userId: string, suffix: string) {
  const [client] = await db.insert(clients).values({ name: `Second org ${suffix}` }).returning();
  await db.insert(clientMembers).values({ clientId: client!.id, userId, clientRole: "owner" });
  const [workspace] = await db.insert(workspaces).values({
    clientId: client!.id,
    name: `Second workspace ${suffix}`,
    cardKeyPrefix: "SECOND",
  }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId, role: "admin" });
  const [list] = await db.insert(lists).values({ workspaceId: workspace!.id, name: "Queue", position: "1000.0000000000" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Second board", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({
    listId: list!.id,
    boardId: board!.id,
    title: "Second organisation card",
    position: "1000.0000000000",
    createdById: userId,
  }).returning();
  return { client: client!, workspace: workspace!, board: board!, card: card! };
}

const publicApiOptions = { enableWebhookDeliveryScheduler: false, logger: false, rateLimit: { enabled: false }, uploadsDir: testUploadsDir("test-personal-key-uploads") } as const;

void test("a personal key acts as its owner across the public API and revokes cleanly", async () => {
  const { app, auth, userId, workspaceId, cardId, boardId } = await seedOwnerWithBoardCard("personal-key");
  const key = await createPersonalKey(app, auth, "CI script");
  const second = await addOwnedOrganisation(userId, "personal-key");
  assert.equal(key.label, "CI script");
  // The response is self-describing: `kind` tells a consumer this is a personal key.
  assert.equal(key.kind, "personal");
  // Personal keys carry the distinct `u` marker so they are identifiable vs workspace keys at a glance.
  assert.match(key.secret, /^kanera_u_(?:live|stg|dev|test)_/);
  assert.match(key.keyPrefix, /^kanera_u_/);

  // The owner sees their new key in the personal list.
  const list = await app.inject({ method: "GET", url: "/me/api-keys", headers: auth });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json<{ id: string }[]>().filter((k) => k.id === key.id).length, 1);

  const publicApi = await buildPublicApiServer(publicApiOptions);
  const keyAuth = { authorization: `Bearer ${key.secret}` };
  try {
    // GET /workspaces resolves via the owner's real membership (not a workspace pin), including
    // the admin role assigned to the workspace creator.
    const workspaces = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: keyAuth });
    assert.equal(workspaces.statusCode, 200);
    const rows = workspaces.json<{ id: string; role: string }[]>();
    const ws = rows.find((r) => r.id === workspaceId);
    assert.ok(ws, "personal key should list the owner's workspace");
    assert.equal(ws.role, "admin");
    assert.ok(rows.some((row) => row.id === second.workspace.id), "one personal key should list workspaces from every active organisation");

    const secondOrgPatch = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${second.card.id}`,
      headers: keyAuth,
      payload: { title: "Edited in the second organisation" },
    });
    assert.equal(secondOrgPatch.statusCode, 200, secondOrgPatch.body);

    // Routes without a target resource can select an organisation per request without issuing a
    // new credential. The same key now creates the workspace under the second organisation.
    const selectedSession = await publicApi.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { ...keyAuth, "x-kanera-organisation-id": second.client.id },
    });
    assert.equal(selectedSession.statusCode, 200, selectedSession.body);
    assert.equal(selectedSession.json<{ organisationId: string }>().organisationId, second.client.id);
    const secondOrgWorkspace = await publicApi.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { ...keyAuth, "x-kanera-organisation-id": second.client.id },
      payload: { name: "Created with selected organisation" },
    });
    assert.equal(secondOrgWorkspace.statusCode, 201, secondOrgWorkspace.body);
    assert.equal(secondOrgWorkspace.json<{ clientId: string }>().clientId, second.client.id);

    // A board-content mutation succeeds (owner is org owner → editor everywhere).
    const patched = await publicApi.inject({ method: "PATCH", url: `/api/v1/cards/${cardId}`, headers: keyAuth, payload: { title: "Edited via personal key" } });
    assert.equal(patched.statusCode, 200);

    // Activity is attributed to the owning user, not to a key: actorKind 'user', no apiKeyId/name.
    const [activity] = await db
      .select({ actorKind: activityEvents.actorKind, actorId: activityEvents.actorId, apiKeyId: activityEvents.apiKeyId, apiKeyName: activityEvents.apiKeyName })
      .from(activityEvents)
      .where(and(eq(activityEvents.entityId, cardId), eq(activityEvents.action, "updated")))
      .orderBy(desc(activityEvents.createdAt))
      .limit(1);
    assert.ok(activity, "card update should record an activity event");
    assert.equal(activity.actorKind, "user");
    assert.equal(activity.actorId, userId);
    assert.equal(activity.apiKeyId, null);
    assert.equal(activity.apiKeyName, null);

    // Personal keys inherit their owner's current workspace-admin authority.
    const listCreate = await publicApi.inject({ method: "POST", url: `/api/v1/workspaces/${workspaceId}/lists`, headers: keyAuth, payload: { name: "New List" } });
    assert.equal(listCreate.statusCode, 201);

    // Board-management routes use the same owner permissions rather than workspace-key scopes.
    const boardDelete = await publicApi.inject({ method: "DELETE", url: `/api/v1/boards/${boardId}`, headers: keyAuth });
    assert.equal(boardDelete.statusCode, 204);

    // Revoke the key on the app server; the public API must reject it immediately.
    const revoke = await app.inject({ method: "DELETE", url: `/me/api-keys/${key.id}`, headers: auth });
    assert.equal(revoke.statusCode, 204);
    const afterRevoke = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: keyAuth });
    assert.equal(afterRevoke.statusCode, 401);
  } finally {
    await publicApi.close();
  }
});

void test("a user can only revoke their own personal keys", async () => {
  const a = await seedOwnerWithBoardCard("owner-a");
  const b = await seedOwnerWithBoardCard("owner-b");
  const key = await createPersonalKey(a.app, a.auth);

  // Owner B cannot revoke owner A's key (scoped by createdById), so it returns not found.
  const crossRevoke = await b.app.inject({ method: "DELETE", url: `/me/api-keys/${key.id}`, headers: b.auth });
  assert.equal(crossRevoke.statusCode, 404);
});

void test("an API key cannot mint or revoke personal keys", async () => {
  const owner = await seedOwnerWithBoardCard("personal-key-escalation");
  const sibling = await createPersonalKey(owner.app, owner.auth, "Sibling");
  const readKey = await createPersonalKey(owner.app, owner.auth, "Agent", "read");
  const readAuth = { authorization: `Bearer ${readKey.secret}` };

  // Two independent layers must keep every response here a non-2xx:
  //   1. authenticateApiKey only authenticates on the public API (the /api/v1 prefix), so the app
  //      server rejects the credential outright with 401;
  //   2. the route-level authKind guard backstops with 403 if a key ever authenticates here.
  // Layer 1 is a single URL check that is easy to miss or relax — the escalation (a read-scoped
  // key minting itself a write-scoped key, or revoking its siblings) must survive that happening.
  const mint = await owner.app.inject({ method: "POST", url: "/me/api-keys", headers: readAuth, payload: { scope: "write" } });
  assert.ok(mint.statusCode === 401 || mint.statusCode === 403, `expected 401/403, got ${mint.statusCode}`);
  const revoke = await owner.app.inject({ method: "DELETE", url: `/me/api-keys/${sibling.id}`, headers: readAuth });
  assert.ok(revoke.statusCode === 401 || revoke.statusCode === 403, `expected 401/403, got ${revoke.statusCode}`);

  // The interactive owner is unaffected.
  const ownerMint = await createPersonalKey(owner.app, owner.auth, "Owner minted", "write");
  assert.equal(ownerMint.scope, "write");
});

void test("an API key cannot revoke its owner's OAuth connections", async () => {
  const owner = await seedOwnerWithBoardCard("personal-key-oauth-revoke");
  const readKey = await createPersonalKey(owner.app, owner.auth, "Agent", "read");
  const readAuth = { authorization: `Bearer ${readKey.secret}` };

  // A minimal interactive OAuth client + grant so the route has a row to revoke.
  const [oauthClient] = await db.insert(oauthClients).values({
    clientId: `kanera_test_${randomUUID()}`,
    kind: "public",
    name: "Interactive agent",
    grantTypes: ["authorization_code", "refresh_token"],
    createdById: owner.userId,
  }).returning();
  const [grant] = await db.insert(oauthGrants).values({
    clientId: oauthClient!.clientId,
    userId: owner.userId,
    orgClientId: owner.orgId,
    scopes: ["kanera:read", "kanera:write"],
    resource: "http://localhost:3002/mcp",
  }).returning();

  // Same two-layer expectation as the /me/api-keys test above: 401 from the app server's URL gate,
  // 403 from the route guard if that gate ever changes — never a successful revoke.
  const revoke = await owner.app.inject({ method: "DELETE", url: `/me/oauth-connections/${grant!.id}`, headers: readAuth });
  assert.ok(revoke.statusCode === 401 || revoke.statusCode === 403, `expected 401/403, got ${revoke.statusCode}`);
  const ownerRevoke = await owner.app.inject({ method: "DELETE", url: `/me/oauth-connections/${grant!.id}`, headers: owner.auth });
  assert.equal(ownerRevoke.statusCode, 204);
});

void test("POST /me/api-keys persists the requested scope and defaults an absent scope to write", async () => {
  const owner = await seedOwnerWithBoardCard("personal-key-scope");
  const readOnly = await createPersonalKey(owner.app, owner.auth, "Agent (read-only)", "read");
  const defaulted = await createPersonalKey(owner.app, owner.auth, "CI script");
  assert.equal(readOnly.scope, "read");
  // Compatibility guarantee: a body without `scope` keeps the historical read-write behaviour.
  assert.equal(defaulted.scope, "write");

  // The owner sees each key's scope in their list.
  const list = await owner.app.inject({ method: "GET", url: "/me/api-keys", headers: owner.auth });
  assert.equal(list.statusCode, 200);
  const rows = list.json<{ id: string; scope: string }[]>();
  assert.equal(rows.find((key) => key.id === readOnly.id)?.scope, "read");
  assert.equal(rows.find((key) => key.id === defaulted.id)?.scope, "write");
});

void test("a read-scoped personal key reads but cannot mutate via the public API", async () => {
  const { app, auth, cardId } = await seedOwnerWithBoardCard("personal-key-readonly");
  const key = await createPersonalKey(app, auth, "Agent", "read");
  const publicApi = await buildPublicApiServer(publicApiOptions);
  const keyAuth = { authorization: `Bearer ${key.secret}` };
  try {
    // GET /api/v1/session reports the credential's real scope; agent tooling is told to trust it.
    const session = await publicApi.inject({ method: "GET", url: "/api/v1/session", headers: keyAuth });
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(session.json<{ scope: string | null }>().scope, "read");

    // Reads resolve through the owner's access.
    const detail = await publicApi.inject({ method: "GET", url: `/api/v1/cards/${cardId}/detail`, headers: keyAuth });
    assert.equal(detail.statusCode, 200, detail.body);

    // Writes are forbidden even though the owner is an org admin.
    const patched = await publicApi.inject({ method: "PATCH", url: `/api/v1/cards/${cardId}`, headers: keyAuth, payload: { title: "Nope" } });
    assert.equal(patched.statusCode, 403);

    // The regression that matters: a write-scoped key for the same owner still mutates.
    const writeKey = await createPersonalKey(app, auth, "CI script", "write");
    const writePatch = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${cardId}`,
      headers: { authorization: `Bearer ${writeKey.secret}` },
      payload: { title: "Edited via write key" },
    });
    assert.equal(writePatch.statusCode, 200, writePatch.body);
  } finally {
    await publicApi.close();
  }
});

void test("personal API keys are ordered by most recent use with unused keys last", async () => {
  const owner = await seedOwnerWithBoardCard("personal-key-order");
  const used = await createPersonalKey(owner.app, owner.auth, "Used key");
  const unused = await createPersonalKey(owner.app, owner.auth, "x".repeat(25));
  const recentlyUsed = await createPersonalKey(owner.app, owner.auth, "Recently used key");
  const overlong = await owner.app.inject({
    method: "POST",
    url: "/me/api-keys",
    headers: owner.auth,
    payload: { label: "x".repeat(26) },
  });
  assert.equal(overlong.statusCode, 400);
  await db.update(workspaceApiKeys)
    .set({ lastUsedAt: new Date("2026-07-16T12:00:00.000Z") })
    .where(eq(workspaceApiKeys.id, used.id));
  await db.update(workspaceApiKeys)
    .set({ lastUsedAt: new Date("2026-07-16T13:00:00.000Z") })
    .where(eq(workspaceApiKeys.id, recentlyUsed.id));

  const response = await owner.app.inject({ method: "GET", url: "/me/api-keys", headers: owner.auth });
  assert.equal(response.statusCode, 200);
  const keys = response.json<{ id: string; lastUsedAt: string | null }[]>();
  assert.deepEqual(keys.map((key) => key.id), [recentlyUsed.id, used.id, unused.id]);
  assert.equal(keys[0]?.lastUsedAt, "2026-07-16T13:00:00.000Z");
  assert.equal(keys[1]?.lastUsedAt, "2026-07-16T12:00:00.000Z");
  assert.equal(keys[2]?.lastUsedAt, null);
});
