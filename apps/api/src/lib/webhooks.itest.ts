// Register the shared database reset and resource teardown; env setup alone leaves the
// PostgreSQL pool open, causing Node's test-file promise to remain pending after this test passes.
import "../test/integration.js";
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
