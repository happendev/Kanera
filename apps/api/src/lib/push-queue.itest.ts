import "../test/setup.integration.js";
import { clients, pushQueue, users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { enqueuePush, runPushQueueSweep } from "./push-queue.js";
import { ensureSystemWebPushConfig } from "./web-push.js";

void test("push queue records zero-subscription deliveries as errors", async () => {
  const app = await buildIntegrationServer();
  await ensureSystemWebPushConfig();
  const [client] = await db
    .insert(clients)
    .values({ name: "Push delivery", pushEnabled: true })
    .returning();
  const [user] = await db
    .insert(users)
    .values({
      clientId: client!.id,
      email: `push-${randomUUID()}@example.com`,
      passwordHash: "x",
      displayName: "Push recipient",
    })
    .returning();
  const queued = await enqueuePush(db, {
    clientId: client!.id,
    userId: user!.id,
    reason: "mentioned",
    payload: {
      kind: "comment_mentioned",
      title: "Mentioned in a comment",
      body: "Someone mentioned you",
      url: "/boards/board-id?card=card-id",
    },
  });

  assert.equal(await runPushQueueSweep({ db, log: app.log }), 1);

  const [processed] = await db.select().from(pushQueue).where(eq(pushQueue.id, queued.id)).limit(1);
  assert.equal(processed?.status, "error");
  assert.equal(processed?.sentAt, null);
  assert.equal(processed?.lastError, "no active push subscriptions");
});
