import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boards, cards, externalLinks, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer } from "../../test/integration.js";

async function setupWorkspace() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Sync me",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();

  return { app, accessToken, workspace, card: card! };
}

void test("public API keys can upsert, lookup, and delete external links", async () => {
  const { app, accessToken, workspace, card } = await setupWorkspace();

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Trello sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const secret = key.json<{ secret: string }>().secret;

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: ".tmp/test-public-uploads",
  });
  try {
    const created = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/external-links`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        provider: "trello",
        externalType: "card",
        externalId: "trello-card-123",
        entityType: "card",
        entityId: card.id,
      },
    });
    assert.equal(created.statusCode, 200);
    const link = created.json<{ id: string; entityId: string; provider: string }>();
    assert.equal(link.provider, "trello");
    assert.equal(link.entityId, card.id);

    const lookup = await publicApi.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspace.id}/external-links?provider=trello&externalType=card&externalId=trello-card-123`,
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(lookup.statusCode, 200);
    const links = lookup.json<Array<{ id: string; entityId: string }>>();
    assert.deepEqual(links.map((item) => item.id), [link.id]);
    assert.equal(links[0]?.entityId, card.id);

    const deleted = await publicApi.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}/external-links/${link.id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(deleted.statusCode, 204);

    const remaining = await db.select().from(externalLinks).where(eq(externalLinks.id, link.id));
    assert.equal(remaining.length, 0);
  } finally {
    await publicApi.close();
  }
});

void test("external links require write scope and target entities from the same workspace", async () => {
  const { app, accessToken, workspace, card } = await setupWorkspace();

  const readKey = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Read only", scope: "read" },
  });
  assert.equal(readKey.statusCode, 201);

  const otherWorkspace = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Other" },
  });
  assert.equal(otherWorkspace.statusCode, 201);
  const other = otherWorkspace.json<{ id: string }>();

  const writeKey = await app.inject({
    method: "POST",
    url: `/workspaces/${other.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Other write", scope: "write" },
  });
  assert.equal(writeKey.statusCode, 201);

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: ".tmp/test-public-uploads",
  });
  try {
    const forbidden = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/external-links`,
      headers: { authorization: `Bearer ${readKey.json<{ secret: string }>().secret}` },
      payload: {
        provider: "trello",
        externalType: "card",
        externalId: "trello-card-123",
        entityType: "card",
        entityId: card.id,
      },
    });
    assert.equal(forbidden.statusCode, 403);

    const wrongWorkspace = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${other.id}/external-links`,
      headers: { authorization: `Bearer ${writeKey.json<{ secret: string }>().secret}` },
      payload: {
        provider: "trello",
        externalType: "card",
        externalId: "trello-card-123",
        entityType: "card",
        entityId: card.id,
      },
    });
    assert.equal(wrongWorkspace.statusCode, 400);
    assert.equal(wrongWorkspace.json<{ message: string }>().message, "entityId is not a card in this workspace");
  } finally {
    await publicApi.close();
  }
});
