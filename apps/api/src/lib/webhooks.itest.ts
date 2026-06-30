import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { clients, users, webhookDeliveries, webhookEndpoints, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { encryptSecret } from "./secrets.js";
import { processWebhookDeliveries } from "./webhooks.js";

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
  return { workspace, endpoint };
}

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
  let releaseFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    globalThis.fetch = async () => {
      calls += 1;
      resolve();
      await new Promise<void>((release) => {
        releaseFetch = release;
      });
      return new Response("ok", { status: 200 });
    };
  });

  try {
    const firstSweep = processWebhookDeliveries();
    await fetchStarted;

    const [claimed] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    assert.ok(claimed);
    assert.equal(claimed.status, "delivering");
    assert.ok(claimed.nextAttemptAt.getTime() > Date.now());

    await processWebhookDeliveries();
    assert.equal(calls, 1);

    releaseFetch();
    await firstSweep;

    const [sent] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    assert.ok(sent);
    assert.equal(sent.status, "success");
    assert.equal(sent.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
