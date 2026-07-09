import "../../test/setup.integration.js";
import { activityEvents, boards, cards, lists } from "@kanera/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

// Exercises the full personal-key stack over HTTP: the /me/api-keys management routes on the app
// server, the auth plugin's personal-key claim construction, activity attribution as the owner, and
// revocation. Board-content-only enforcement is proven precisely in lib/access.itest.ts.
async function seedOwnerWithBoardCard(testName: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: `Acme ${testName}`, email: `owner-${randomUUID()}@example.com`, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const workspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({ listId: list.id, boardId: board!.id, title: "Original", position: "1000.0000000000", createdById: user.id }).returning();

  return { app, auth, userId: user.id, workspaceId: workspace.id, boardId: board!.id, cardId: card!.id };
}

async function createPersonalKey(app: Awaited<ReturnType<typeof buildIntegrationServer>>, auth: { authorization: string }, label?: string) {
  const created = await app.inject({ method: "POST", url: "/me/api-keys", headers: auth, payload: label ? { label } : {} });
  assert.equal(created.statusCode, 201);
  return created.json<{ id: string; kind: string; label: string | null; keyPrefix: string; secret: string }>();
}

const publicApiOptions = { enableWebhookDeliveryScheduler: false, logger: false, rateLimit: { enabled: false }, uploadsDir: testUploadsDir("test-personal-key-uploads") } as const;

void test("a personal key acts as its owner across the public API and revokes cleanly", async () => {
  const { app, auth, userId, workspaceId, cardId, boardId } = await seedOwnerWithBoardCard("personal-key");
  const key = await createPersonalKey(app, auth, "CI script");
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
    // GET /workspaces resolves via the owner's real membership (not a workspace pin) at member role.
    const workspaces = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: keyAuth });
    assert.equal(workspaces.statusCode, 200);
    const rows = workspaces.json<{ id: string; role: string }[]>();
    const ws = rows.find((r) => r.id === workspaceId);
    assert.ok(ws, "personal key should list the owner's workspace");
    assert.equal(ws.role, "member");

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

    // Board-content only: a workspace-admin action (creating a list) is forbidden even for the owner.
    const listCreate = await publicApi.inject({ method: "POST", url: `/api/v1/workspaces/${workspaceId}/lists`, headers: keyAuth, payload: { name: "New List" } });
    assert.equal(listCreate.statusCode, 403);

    // Board management is forbidden too.
    const boardDelete = await publicApi.inject({ method: "DELETE", url: `/api/v1/boards/${boardId}`, headers: keyAuth });
    assert.equal(boardDelete.statusCode, 403);

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
