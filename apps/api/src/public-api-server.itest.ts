import "./test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  boardMembers,
  boards,
  cardAssignees,
  cards,
  lists,
  workspaceApiKeys,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import type { WorkPrioritiesResponse } from "@kanera/shared/dto";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { hashOpaqueToken } from "./lib/tokens.js";
import { buildPublicApiServer } from "./public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "./test/integration.js";
import { insertTestUsers } from "./test/user-fixtures.js";

async function createWorkspaceApiKey() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Rate Limit Co",
      email: `rate-limit-${randomUUID()}@example.com`,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<{ accessToken: string }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Rate Limits" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  // The management response is self-describing: `kind` distinguishes workspace keys from personal keys.
  assert.equal(key.json<{ kind: string }>().kind, "workspace");

  return key.json<{ secret: string }>().secret;
}

async function loadApiKey(secret: string) {
  const [row] = await db
    .select({ id: workspaceApiKeys.id, lastUsedAt: workspaceApiKeys.lastUsedAt, updatedAt: workspaceApiKeys.updatedAt })
    .from(workspaceApiKeys)
    .where(eq(workspaceApiKeys.keyHash, hashOpaqueToken(secret)))
    .limit(1);
  assert.ok(row);
  return row;
}

void test("public API keys are rate limited by API key id", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { apiKeyLimitPerMinute: 1, ipLimitPerMinute: 100, uploadLimitPerMinute: 100, windowMs: 60_000 },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["ratelimit-limit"], "1");
    assert.equal(first.headers["ratelimit-remaining"], "0");

    const limited = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { code: "RATE_LIMITED", message: "rate limit exceeded" });
    assert.equal(limited.headers["ratelimit-limit"], "1");
    assert.ok(limited.headers["ratelimit-reset"]);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await publicApi.close();
  }
});

void test("failed public API key auth is rate limited by IP", async () => {
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: {
      apiKeyLimitPerMinute: 100,
      failedApiKeyLimitPerMinute: 1,
      ipLimitPerMinute: 100,
      uploadLimitPerMinute: 100,
      windowMs: 60_000,
    },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: "Bearer kanera_guess" },
    });
    assert.equal(first.statusCode, 401);
    assert.equal(first.headers["ratelimit-limit"], "1");
    assert.equal(first.headers["ratelimit-remaining"], "0");
    assert.ok(first.headers["ratelimit-reset"]);
    assert.ok(first.headers["retry-after"]);

    const limited = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: "Bearer kanera_guess" },
    });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { code: "RATE_LIMITED", message: "rate limit exceeded" });
    assert.equal(limited.headers["ratelimit-limit"], "1");
    assert.equal(limited.headers["ratelimit-remaining"], "0");
    assert.ok(limited.headers["ratelimit-reset"]);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await publicApi.close();
  }
});

void test("public API key lastUsedAt writes are throttled", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(first.statusCode, 200);
    const afterFirst = await loadApiKey(secret);
    assert.ok(afterFirst.lastUsedAt);

    const second = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(second.statusCode, 200);
    const afterSecond = await loadApiKey(secret);

    assert.equal(afterSecond.lastUsedAt?.toISOString(), afterFirst.lastUsedAt.toISOString());
    assert.equal(afterSecond.updatedAt.toISOString(), afterFirst.updatedAt.toISOString());
  } finally {
    await publicApi.close();
  }
});

void test("public board reads reject unbounded card hydration", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: testUploadsDir("test-public-board-pagination"),
  });
  const boardId = randomUUID();

  try {
    const unbounded = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${boardId}/open`,
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(unbounded.statusCode, 400);
    assert.match(unbounded.json<{ message: string }>().message, /require listId and cardLimit/i);

    const oversized = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${boardId}/open?listId=${randomUUID()}&cardLimit=101`,
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(oversized.statusCode, 400);
    assert.match(oversized.json<{ message: string }>().message, /between 1 and 100/i);
  } finally {
    await publicApi.close();
  }
});

// The whole priority-queue lifecycle over the public surface, plus the scope rule the app API never
// exercises: priority writes require only "observer" card access, so the usual scope-to-rank mapping
// cannot stop a read-scoped key — the dedicated guard in assertPriorityWriteAccess must.
void test("public API priority queues support the full lifecycle and read-scoped keys cannot mutate them", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Priorities Co",
      email: `priorities-${randomUUID()}@example.com`,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Priorities" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const createKey = async (scope: "read" | "write") => {
    const key = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/api-keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: `Queue ${scope}`, scope },
    });
    assert.equal(key.statusCode, 201);
    return key.json<{ secret: string }>().secret;
  };
  const writeSecret = await createKey("write");
  const readSecret = await createKey("read");

  // A ranked card must be assigned to the queue's target, and the actor needs board access; seed
  // the content rows directly the way the module integration tests do.
  const [list] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Doing", position: "1000.0000000000" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Delivery", position: "1000.0000000000" }).returning();
  await db.insert(boardMembers).values({ boardId: board!.id, userId: user.id, role: "editor" });
  const [cardOne, cardTwo] = await db.insert(cards).values([
    { boardId: board!.id, listId: list!.id, title: "Ship the queue", position: "1000.0000000000", createdById: user.id },
    { boardId: board!.id, listId: list!.id, title: "Then this one", position: "2000.0000000000", createdById: user.id },
  ]).returning();
  await db.insert(cardAssignees).values([
    { cardId: cardOne!.id, userId: user.id },
    { cardId: cardTwo!.id, userId: user.id },
  ]);

  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const empty = await publicApi.inject({
      method: "GET",
      url: `/api/v1/work/priorities/${user.id}`,
      headers: { authorization: `Bearer ${readSecret}` },
    });
    assert.equal(empty.statusCode, 200);
    const emptyQueue = empty.json<WorkPrioritiesResponse>();
    assert.deepEqual(emptyQueue.items, []);
    assert.equal(emptyQueue.canReorder, false);
    assert.deepEqual(emptyQueue.reorderableWorkspaceIds, []);

    const targets = await publicApi.inject({
      method: "GET",
      url: "/api/v1/work/priority-targets",
      headers: { authorization: `Bearer ${readSecret}` },
    });
    assert.equal(targets.statusCode, 200);
    assert.ok(targets.json<{ targets: Array<{ userId: string; self: boolean }> }>()
      .targets.some((row) => row.userId === user.id && row.self));

    const readDenied = await publicApi.inject({
      method: "POST",
      url: `/api/v1/work/priorities/${user.id}/cards`,
      headers: { authorization: `Bearer ${readSecret}` },
      payload: { cardId: cardOne!.id, beforeId: null },
    });
    assert.equal(readDenied.statusCode, 403);

    const addFirst = await publicApi.inject({
      method: "POST",
      url: `/api/v1/work/priorities/${user.id}/cards`,
      headers: { authorization: `Bearer ${writeSecret}` },
      payload: { cardId: cardOne!.id, beforeId: null },
    });
    assert.equal(addFirst.statusCode, 201);
    const addSecond = await publicApi.inject({
      method: "POST",
      url: `/api/v1/work/priorities/${user.id}/cards`,
      headers: { authorization: `Bearer ${writeSecret}` },
      payload: { cardId: cardTwo!.id, beforeId: null },
    });
    assert.equal(addSecond.statusCode, 201);
    const afterAdds = addSecond.json<WorkPrioritiesResponse>();
    assert.deepEqual(afterAdds.items.map((item) => item.card?.id), [cardOne!.id, cardTwo!.id]);
    assert.equal(afterAdds.totalCount, 2);

    const moved = await publicApi.inject({
      method: "POST",
      url: `/api/v1/card-priorities/${afterAdds.items[1]!.id}/move`,
      headers: { authorization: `Bearer ${writeSecret}` },
      payload: { afterId: null },
    });
    assert.equal(moved.statusCode, 200);
    assert.deepEqual(moved.json<WorkPrioritiesResponse>().items.map((item) => item.card?.id), [cardTwo!.id, cardOne!.id]);

    const removeDenied = await publicApi.inject({
      method: "DELETE",
      url: `/api/v1/card-priorities/${afterAdds.items[0]!.id}`,
      headers: { authorization: `Bearer ${readSecret}` },
    });
    assert.equal(removeDenied.statusCode, 403);

    const removed = await publicApi.inject({
      method: "DELETE",
      url: `/api/v1/card-priorities/${afterAdds.items[0]!.id}`,
      headers: { authorization: `Bearer ${writeSecret}` },
    });
    assert.equal(removed.statusCode, 200);
    const afterRemove = removed.json<WorkPrioritiesResponse>();
    assert.deepEqual(afterRemove.items.map((item) => item.card?.id), [cardTwo!.id]);
    assert.equal(afterRemove.totalCount, 1);
  } finally {
    await publicApi.close();
  }
});

void test("public API workspace key scopes isolate teammate queues to the pinned admin workspace", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Priority Scope Co",
      email: `priority-scope-${randomUUID()}@example.com`,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const createWorkspace = async (name: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name },
    });
    assert.equal(response.statusCode, 201);
    return response.json<{ id: string }>();
  };
  const pinnedWorkspace = await createWorkspace("Pinned delivery");
  const otherWorkspace = await createWorkspace("Other delivery");
  const [workspaceRow] = await db
    .select({ clientId: workspaces.clientId })
    .from(workspaces)
    .where(eq(workspaces.id, pinnedWorkspace.id))
    .limit(1);
  assert.ok(workspaceRow);

  const [teammate] = await insertTestUsers(db, {
    clientId: workspaceRow.clientId,
    email: `priority-teammate-${randomUUID()}@example.com`,
    passwordHash: "x",
    displayName: "Queue Teammate",
    clientRole: "member",
  }).returning();
  assert.ok(teammate);
  await db.insert(workspaceMembers).values([
    { workspaceId: pinnedWorkspace.id, userId: teammate.id, role: "member" },
    { workspaceId: otherWorkspace.id, userId: teammate.id, role: "member" },
  ]);

  const createKey = async (scope: "read" | "write" | "admin") => {
    const response = await app.inject({
      method: "POST",
      url: `/workspaces/${pinnedWorkspace.id}/api-keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: `Queue ${scope}`, scope },
    });
    assert.equal(response.statusCode, 201);
    return response.json<{ secret: string }>().secret;
  };
  const readSecret = await createKey("read");
  const writeSecret = await createKey("write");
  const adminSecret = await createKey("admin");

  const [pinnedList, otherList] = await db.insert(lists).values([
    { workspaceId: pinnedWorkspace.id, name: "Doing", position: "1000.0000000000" },
    { workspaceId: otherWorkspace.id, name: "Doing", position: "1000.0000000000" },
  ]).returning();
  const [pinnedBoard, otherBoard] = await db.insert(boards).values([
    { workspaceId: pinnedWorkspace.id, name: "Pinned board", position: "1000.0000000000" },
    { workspaceId: otherWorkspace.id, name: "Other board", position: "1000.0000000000" },
  ]).returning();
  assert.ok(pinnedList && otherList && pinnedBoard && otherBoard);
  const [pinnedCard, otherCard] = await db.insert(cards).values([
    { boardId: pinnedBoard.id, listId: pinnedList.id, title: "Pinned work", position: "1000.0000000000", createdById: user.id },
    { boardId: otherBoard.id, listId: otherList.id, title: "Other work", position: "1000.0000000000", createdById: user.id },
  ]).returning();
  assert.ok(pinnedCard && otherCard);
  await db.insert(cardAssignees).values([
    { cardId: pinnedCard.id, userId: teammate.id },
    { cardId: otherCard.id, userId: teammate.id },
  ]);

  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: testUploadsDir("test-public-priority-scopes"),
  });
  const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });

  try {
    for (const secret of [readSecret, writeSecret]) {
      const teammateQueueStatus: number = (await publicApi.inject({
        method: "GET",
        url: `/api/v1/work/priorities/${teammate.id}`,
        headers: auth(secret),
      })).statusCode;
      assert.equal(teammateQueueStatus, 403);

      const targets = await publicApi.inject({
        method: "GET",
        url: "/api/v1/work/priority-targets",
        headers: auth(secret),
      });
      assert.equal(targets.statusCode, 200);
      assert.deepEqual(
        targets.json<{ targets: Array<{ userId: string }> }>().targets.map((target) => target.userId),
        [user.id],
      );
    }

    const targets = await publicApi.inject({
      method: "GET",
      url: "/api/v1/work/priority-targets",
      headers: auth(adminSecret),
    });
    assert.equal(targets.statusCode, 200);
    const teammateTarget = targets.json<{
      targets: Array<{ userId: string; workspaceIds: string[] }>;
    }>().targets.find((target) => target.userId === teammate.id);
    assert.deepEqual(teammateTarget?.workspaceIds, [pinnedWorkspace.id]);

    const emptyQueue = await publicApi.inject({
      method: "GET",
      url: `/api/v1/work/priorities/${teammate.id}`,
      headers: auth(adminSecret),
    });
    assert.equal(emptyQueue.statusCode, 200);
    assert.equal(emptyQueue.json<WorkPrioritiesResponse>().canReorder, true);
    assert.deepEqual(emptyQueue.json<WorkPrioritiesResponse>().reorderableWorkspaceIds, [pinnedWorkspace.id]);

    const addPinned = await publicApi.inject({
      method: "POST",
      url: `/api/v1/work/priorities/${teammate.id}/cards`,
      headers: auth(adminSecret),
      payload: { cardId: pinnedCard.id, beforeId: null },
    });
    assert.equal(addPinned.statusCode, 201);

    const addOutsidePin = await publicApi.inject({
      method: "POST",
      url: `/api/v1/work/priorities/${teammate.id}/cards`,
      headers: auth(adminSecret),
      payload: { cardId: otherCard.id, beforeId: null },
    });
    assert.equal(addOutsidePin.statusCode, 403);
  } finally {
    await publicApi.close();
  }
});

void test("public API attachment uploads use the lower upload rate limit", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { apiKeyLimitPerMinute: 100, ipLimitPerMinute: 100, uploadLimitPerMinute: 1, windowMs: 60_000 },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "POST",
      url: "/api/v1/cards/00000000-0000-0000-0000-000000000001/attachments",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.notEqual(first.statusCode, 429);

    const limited = await publicApi.inject({
      method: "POST",
      url: "/api/v1/cards/00000000-0000-0000-0000-000000000001/attachments",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["ratelimit-limit"], "1");
  } finally {
    await publicApi.close();
  }
});
