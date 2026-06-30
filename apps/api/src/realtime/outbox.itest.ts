import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boards, cards, directRealtimeOutbox, eventOutbox, lists, webhookDeliveries, webhookEndpoints } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { encryptSecret } from "../lib/secrets.js";
import { buildIntegrationServer } from "../test/integration.js";
import { processDirectRealtimeOutbox, processRealtimeOutbox, publishDirectRealtimeEvent, publishRealtimeEvent, setRealtimeOutboxDependenciesForTests } from "./outbox.js";

void test("public-api style board events are persisted then fan out to webhook delivery", async () => {
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

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "External update",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();
  assert.ok(card);

  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      workspaceId: workspace.id,
      createdById: user.id,
      name: "Events",
      url: "https://example.test/webhook",
      encryptedSecret: encryptSecret("secret"),
      eventTypes: ["card:deleted"],
    })
    .returning();
  assert.ok(endpoint);

  const event = await publishRealtimeEvent("board", board.id, "card:deleted", {
    boardId: board.id,
    cardId: card.id,
  });
  assert.ok(event);
  assert.equal(event.workspaceId, workspace.id);
  assert.equal(event.boardId, board.id);
  assert.equal(event.realtimeDispatched, false);
  assert.equal(event.webhooksEnqueued, false);

  await processRealtimeOutbox({ limit: 10 });

  const [processed] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, event.id));
  assert.equal(processed?.realtimeDispatched, true);
  assert.equal(processed?.webhooksEnqueued, true);
  assert.equal(processed?.lastError, null);

  const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.outboxEventId, event.id));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.endpointId, endpoint.id);
  assert.equal(deliveries[0]?.eventType, "card:deleted");
  assert.equal(deliveries[0]?.payload.id, event.id);
  assert.equal(deliveries[0]?.payload.boardId, board.id);
  assert.equal(deliveries[0]?.payload.cardId, card.id);

  await processRealtimeOutbox({ limit: 10 });

  const duplicateCheck = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.outboxEventId, event.id));
  assert.equal(duplicateCheck.length, 1);
});

void test("a multi-event drain marks every row processed via the batched update", async () => {
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

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Batch" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "External update",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();
  assert.ok(card);

  const published = [];
  for (let i = 0; i < 5; i += 1) {
    const event = await publishRealtimeEvent("board", board.id, "card:deleted", { boardId: board.id, cardId: card.id });
    assert.ok(event);
    published.push(event);
  }

  const result = await processRealtimeOutbox({ limit: 10 });
  assert.equal(result.processed, 5);

  for (const event of published) {
    const [processed] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, event.id));
    assert.equal(processed?.realtimeDispatched, true);
    assert.equal(processed?.webhooksEnqueued, true);
    assert.equal(processed?.lastError, null);
    assert.equal(processed?.processingLeaseExpiresAt, null);
  }
});

void test("outbox retry does not rebroadcast after webhook enqueue fails", async () => {
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

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Retry Delivery" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "External update",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();
  assert.ok(card);

  const event = await publishRealtimeEvent("board", board.id, "card:deleted", {
    boardId: board.id,
    cardId: card.id,
  });
  assert.ok(event);

  let broadcastCount = 0;
  let enqueueAttempts = 0;
  const restoreDependencies = setRealtimeOutboxDependenciesForTests({
    broadcastToBoard: () => {
      broadcastCount += 1;
      return true;
    },
    enqueueWebhookDeliveriesForOutboxEvent: async () => {
      enqueueAttempts += 1;
      if (enqueueAttempts === 1) throw new Error("webhook enqueue unavailable");
    },
  });

  try {
    await processRealtimeOutbox({ limit: 10 });

    const [failed] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, event.id));
    assert.equal(broadcastCount, 1);
    assert.equal(enqueueAttempts, 1);
    assert.equal(failed?.realtimeDispatched, true);
    assert.equal(failed?.webhooksEnqueued, false);
    assert.equal(failed?.lastError, "webhook enqueue unavailable");

    await processRealtimeOutbox({ limit: 10 });

    const [processed] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, event.id));
    assert.equal(broadcastCount, 1);
    assert.equal(enqueueAttempts, 2);
    assert.equal(processed?.realtimeDispatched, true);
    assert.equal(processed?.webhooksEnqueued, true);
    assert.equal(processed?.lastError, null);
  } finally {
    restoreDependencies();
  }
});

void test("direct realtime outbox dispatches user and client events without webhooks", async () => {
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
  const { user } = signup.json<{ user: { id: string; clientId: string } }>();

  const userEvent = await publishDirectRealtimeEvent("user", user.id, "notification:read", {
    notificationIds: ["11111111-1111-1111-1111-111111111111"],
    readAt: "2026-05-21T01:00:00.000Z",
  });
  const clientEvent = await publishDirectRealtimeEvent("client", user.clientId, "client:updated", {
    clientId: user.clientId,
    name: "Acme",
    logoUrl: null,
  });
  assert.ok(userEvent);
  assert.ok(clientEvent);

  const broadcasts: Array<{ scope: string; id: string; event: string }> = [];
  const restoreDependencies = setRealtimeOutboxDependenciesForTests({
    broadcastToUser: (id, event) => {
      broadcasts.push({ scope: "user", id, event });
      return true;
    },
    broadcastToClient: (id, event) => {
      broadcasts.push({ scope: "client", id, event });
      return true;
    },
  });

  try {
    const result = await processDirectRealtimeOutbox({ limit: 10 });
    assert.equal(result.processed, 2);
    assert.deepEqual(
      broadcasts.sort((a, b) => a.scope.localeCompare(b.scope)),
      [
        { scope: "client", id: user.clientId, event: "client:updated" },
        { scope: "user", id: user.id, event: "notification:read" },
      ],
    );

    const rows = await db.select().from(directRealtimeOutbox);
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.realtimeDispatched && row.lastError === null), true);
  } finally {
    restoreDependencies();
  }
});

void test("direct realtime outbox skips rows when inline broadcast already succeeded", async () => {
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
  const { user } = signup.json<{ user: { id: string } }>();

  const event = await publishDirectRealtimeEvent("user", user.id, "notification:allRead", {
    readAt: "2026-05-21T02:00:00.000Z",
  }, { realtimeDispatched: true });
  assert.equal(event, null);

  const rows = await db.select().from(directRealtimeOutbox);
  assert.equal(rows.length, 0);

  const result = await processDirectRealtimeOutbox({ limit: 10 });
  assert.equal(result.processed, 0);
});

void test("direct realtime outbox retries failed broadcasts", async () => {
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
  const { user } = signup.json<{ user: { id: string } }>();

  const event = await publishDirectRealtimeEvent("user", user.id, "notification:allRead", {
    readAt: "2026-05-21T02:00:00.000Z",
  });
  assert.ok(event);

  let attempts = 0;
  const restoreDependencies = setRealtimeOutboxDependenciesForTests({
    broadcastToUser: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket adapter unavailable");
      return true;
    },
  });

  try {
    await processDirectRealtimeOutbox({ limit: 10 });

    const [failed] = await db.select().from(directRealtimeOutbox).where(eq(directRealtimeOutbox.id, event.id));
    assert.equal(attempts, 1);
    assert.equal(failed?.realtimeDispatched, false);
    assert.equal(failed?.lastError, "socket adapter unavailable");
    assert.equal(failed?.processingLeaseExpiresAt, null);

    await processDirectRealtimeOutbox({ limit: 10 });

    const [processed] = await db.select().from(directRealtimeOutbox).where(eq(directRealtimeOutbox.id, event.id));
    assert.equal(attempts, 2);
    assert.equal(processed?.realtimeDispatched, true);
    assert.equal(processed?.lastError, null);
  } finally {
    restoreDependencies();
  }
});
