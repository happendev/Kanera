// Register the shared database reset and resource teardown; env setup alone leaves the
// PostgreSQL pool open, causing Node's test-file promise to remain pending after this test passes.
import "../test/integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { boards, cards, clients, customFields, eventOutbox, lists, users, webhookDeliveries, webhookEndpoints, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { encryptSecret } from "./secrets.js";
import { encryptChatDestinationConfig } from "./chat-destinations.js";
import { deliverWebhookDelivery, enqueueWebhookDeliveriesForOutboxEvent, processWebhookDeliveries } from "./webhooks.js";

async function seedFixture() {
  const id = randomUUID();
  const [client] = await db.insert(clients).values({ name: `Acme ${id}` }).returning();
  assert.ok(client);
  const [actor] = await db
    .insert(users)
    .values({
      clientId: client.id,
      email: `owner-${id}@example.com`,
      passwordHash: "x",
      displayName: "Owner",
    })
    .returning();
  assert.ok(actor);
  const [workspace] = await db.insert(workspaces).values({ clientId: client.id, name: "Delivery" }).returning();
  assert.ok(workspace);
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      workspaceId: workspace.id,
      createdById: actor.id,
      name: "Events",
      url: "https://example.test/webhook",
      encryptedSecret: encryptSecret("secret"),
      eventTypes: ["card:created"],
    })
    .returning();
  assert.ok(endpoint);
  return { client, workspace, endpoint };
}

void test("hosted webhook fanout and delivery require trial or Pro", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const originalFetch = globalThis.fetch;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  };
  try {
    for (const state of [
      { plan: "free" as const, billingStatus: "none" as const, expected: 0 },
      { plan: "paid" as const, billingStatus: "trialing" as const, expected: 1 },
      { plan: "paid" as const, billingStatus: "active" as const, expected: 1 },
      // Plan is authoritative too: a malformed free/active row must not leak a paid feature.
      { plan: "free" as const, billingStatus: "active" as const, expected: 0 },
    ]) {
      const { client, workspace, endpoint } = await seedFixture();
      await db.update(clients).set({ plan: state.plan, billingStatus: state.billingStatus }).where(eq(clients.id, client.id));
      const [event] = await db.insert(eventOutbox).values({
        scope: "workspace",
        scopeId: workspace.id,
        workspaceId: workspace.id,
        eventType: "card:created",
        payload: { workspaceId: workspace.id },
      }).returning();
      await enqueueWebhookDeliveriesForOutboxEvent(event!);
      const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.outboxEventId, event!.id));
      assert.equal(deliveries.length, state.expected, `${state.plan}/${state.billingStatus}`);
      if (state.expected === 1) {
        const delivered = await deliverWebhookDelivery(deliveries[0]!, endpoint);
        assert.equal(delivered.status, "success", `${state.plan}/${state.billingStatus} fires`);
      }
    }
    assert.equal(calls, 2, "trial and Pro each reached the outbound provider");
  } finally {
    globalThis.fetch = originalFetch;
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("the outbound delivery boundary does not fire stale enabled endpoints for hosted Free", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const originalFetch = globalThis.fetch;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const { client, workspace, endpoint } = await seedFixture();
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, client.id));
    const [delivery] = await db.insert(webhookDeliveries).values({
      endpointId: endpoint.id,
      workspaceId: workspace.id,
      eventType: "card:created",
      payload: {
        id: randomUUID(),
        type: "card:created",
        workspaceId: workspace.id,
        occurredAt: new Date().toISOString(),
        data: {},
      },
    }).returning();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("ok");
    };
    const result = await deliverWebhookDelivery(delivery!, endpoint);
    assert.equal(result.status, "failed");
    assert.equal(result.lastError, "webhooks are unavailable on the current plan");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("concurrent webhook sweeps do not deliver the same queued row twice", async () => {
  const { workspace, endpoint } = await seedFixture();
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      workspaceId: workspace.id,
      eventType: "card:created",
      payload: {
        id: randomUUID(),
        type: "card:created",
        workspaceId: workspace.id,
        occurredAt: new Date().toISOString(),
        data: { workspaceId: workspace.id },
      },
    })
    .returning();
  assert.ok(delivery);

  const originalFetch = globalThis.fetch;
  let calls = 0;
  let releaseFetch: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    globalThis.fetch = async () => {
      const callNumber = ++calls;
      resolve();
      // Only the first delivery stays in flight. If a second sweep incorrectly reclaims the
      // leased row, let it finish so the assertion reports the duplicate instead of hanging.
      if (callNumber === 1) {
        await new Promise<void>((release) => {
          releaseFetch = release;
        });
      }
      return new Response("ok", { status: 200 });
    };
  });

  let firstSweep: ReturnType<typeof processWebhookDeliveries> | undefined;
  try {
    firstSweep = processWebhookDeliveries();
    await fetchStarted;

    const [claimed] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    assert.ok(claimed);
    assert.equal(claimed.status, "delivering");
    assert.ok(claimed.nextAttemptAt.getTime() > Date.now());

    await processWebhookDeliveries();
    assert.equal(calls, 1);

    releaseFetch?.();
    await firstSweep;

    const [sent] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    assert.ok(sent);
    assert.equal(sent.status, "success");
    assert.equal(sent.attempts, 1);
  } finally {
    // Keep assertion failures from leaving the first mocked request pending, which otherwise
    // makes Node report a file-level pending-promise failure instead of the useful assertion.
    releaseFetch?.();
    await firstSweep?.catch(() => undefined);
    globalThis.fetch = originalFetch;
  }
});

void test("card events enqueue a formatted chat snapshot alongside generic webhook fanout", async () => {
  const { workspace, endpoint: generic } = await seedFixture();
  const [actor] = await db.select().from(users).where(eq(users.id, generic.createdById));
  assert.ok(actor);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" }).returning();
  const [list] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Backlog", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({
    boardId: board!.id,
    listId: list!.id,
    title: "Ship chat destinations",
    description: "**Notify** the team <!channel>",
    position: "1000.0000000000",
    createdById: actor.id,
  }).returning();
  const [chat] = await db.insert(webhookEndpoints).values({
    workspaceId: workspace.id,
    createdById: actor.id,
    provider: "slack",
    name: "Product chat",
    encryptedConfig: encryptChatDestinationConfig("slack", { webhookUrl: "https://hooks.slack.com/services/T/B/secret" }),
    eventTypes: ["card_created"],
  }).returning();
  const [event] = await db.insert(eventOutbox).values({
    scope: "board",
    scopeId: board!.id,
    workspaceId: workspace.id,
    boardId: board!.id,
    eventType: "card:created",
    payload: { boardId: board!.id, card: card! },
  }).returning();
  assert.ok(event);

  await enqueueWebhookDeliveriesForOutboxEvent(event);
  const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.outboxEventId, event.id));
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.endpointId === generic.id && row.eventType === "card:created"));
  const chatDelivery = rows.find((row) => row.endpointId === chat!.id);
  assert.equal(chatDelivery?.eventType, "card_created");
  assert.equal("kind" in chatDelivery!.payload ? chatDelivery!.payload.kind : null, "chat");
  if ("kind" in chatDelivery!.payload) {
    assert.equal(chatDelivery.payload.cardTitle, "Ship chat destinations");
    assert.equal(chatDelivery.payload.cardUrl, `${env.WEB_ORIGIN}/o/${card!.organisationKey}/c/${card!.key}`);
    assert.equal(chatDelivery.payload.boardName, "Roadmap");
    assert.equal(chatDelivery.payload.excerpt, "Notify the team <!channel>");
  }

  const [inProgress] = await db.insert(lists).values({ workspaceId: workspace.id, name: "In progress", position: "2000.0000000000" }).returning();
  const [priority] = await db.insert(customFields).values({ workspaceId: workspace.id, name: "Priority", type: "select", position: "1000.0000000000" }).returning();
  await db.update(webhookEndpoints).set({
    eventTypes: ["status_changed", "priority_changed"],
    priorityFieldId: priority!.id,
  }).where(eq(webhookEndpoints.id, chat!.id));
  const activityBase = {
    id: randomUUID(),
    boardId: board!.id,
    clientId: null,
    workspaceId: workspace.id,
    actorId: actor.id,
    actorKind: "user" as const,
    apiKeyId: null,
    apiKeyName: null,
    supportSessionId: null,
    supportActorEmail: null,
    entityType: "card" as const,
    entityId: card!.id,
    feedVisible: true,
    coalesceKey: null,
    coalescedCount: 1,
    coalescedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    actorName: "Owner",
    actorAvatarUrl: null,
  };
  const [moveEvent] = await db.insert(eventOutbox).values({
      scope: "board" as const,
      scopeId: board!.id,
      workspaceId: workspace.id,
      boardId: board!.id,
      eventType: "card:feedItem:created" as const,
      payload: {
        boardId: board!.id,
        cardId: card!.id,
        item: { type: "activity", data: { ...activityBase, action: "moved", payload: { fromListId: list!.id, toListId: inProgress!.id } } },
      },
    }).returning();
  const [priorityEvent] = await db.insert(eventOutbox).values({
      scope: "board" as const,
      scopeId: board!.id,
      workspaceId: workspace.id,
      boardId: board!.id,
      eventType: "card:feedItem:created" as const,
      payload: {
        boardId: board!.id,
        cardId: card!.id,
        item: { type: "activity", data: { ...activityBase, id: randomUUID(), action: "customFieldValue:set", payload: { fieldId: priority!.id, fromValue: "Low", toValue: "High" } } },
      },
    }).returning();
  await enqueueWebhookDeliveriesForOutboxEvent(moveEvent!);
  await enqueueWebhookDeliveriesForOutboxEvent(priorityEvent!);
  const semanticRows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, chat!.id));
  const statusDelivery = semanticRows.find((row) => row.eventType === "status_changed");
  const priorityDelivery = semanticRows.find((row) => row.eventType === "priority_changed");
  assert.ok(statusDelivery && "kind" in statusDelivery.payload);
  assert.equal(statusDelivery.payload.fromValue, "Backlog");
  assert.equal(statusDelivery.payload.toValue, "In progress");
  assert.ok(priorityDelivery && "kind" in priorityDelivery.payload);
  assert.equal(priorityDelivery.payload.fromValue, "Low");
  assert.equal(priorityDelivery.payload.toValue, "High");
});
