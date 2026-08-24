import "../test/setup.integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import { clients, notificationSettings, pushQueue, pushSubscriptions } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mock, test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildIntegrationServer } from "../test/integration.js";
import { encryptSecret } from "./secrets.js";
import { deliverPersonalNotificationTestRow, enqueuePersonalNotification, enqueuePush, runPushQueueCleanup, runPushQueueSweep } from "./push-queue.js";
import { ensureSystemWebPushConfig, webPushClient } from "./web-push.js";

void test("hosted Free cancels personal destination delivery while Trial can send", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const originalFetch = globalThis.fetch;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  try {
    const [client] = await db.insert(clients).values({ name: "Personal channel plan gate", plan: "free", billingStatus: "none" }).returning();
    const [user] = await insertTestUsers(db, {
      clientId: client!.id,
      email: `personal-plan-${randomUUID()}@example.com`,
      passwordHash: "x",
      displayName: "Personal plan recipient",
    }).returning();
    await db.insert(notificationSettings).values({
      userId: user!.id,
      webhookEnabled: true,
      webhookUrl: "http://localhost:18080/webhook",
      encryptedWebhookSecret: encryptSecret("whsec_personal-plan"),
    });
    const args = {
      clientId: client!.id,
      userId: user!.id,
      reason: "test" as const,
      channel: "webhook" as const,
      payload: { kind: "test", title: "Test", body: "Plan gate" },
    };
    const freeRow = await enqueuePersonalNotification(db, args, true);
    assert.deepEqual(await deliverPersonalNotificationTestRow(db, freeRow), {
      delivered: false,
      error: "unavailable on current plan",
    });
    assert.equal(calls, 0);

    await db.update(clients).set({ plan: "paid", billingStatus: "trialing" }).where(eq(clients.id, client!.id));
    const trialRow = await enqueuePersonalNotification(db, args, true);
    assert.deepEqual(await deliverPersonalNotificationTestRow(db, trialRow), { delivered: true, error: null });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("push queue records zero-subscription deliveries as errors", async () => {
  const app = await buildIntegrationServer();
  await ensureSystemWebPushConfig();
  const [client] = await db
    .insert(clients)
    .values({ name: "Push delivery", pushEnabled: true })
    .returning();
  const [user] = await insertTestUsers(db, {
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

void test("push queue sweep drains every queued row across bounded batches", async () => {
  const app = await buildIntegrationServer();
  await ensureSystemWebPushConfig();
  const [client] = await db
    .insert(clients)
    .values({ name: "Push batch drain", pushEnabled: true })
    .returning();
  const [user] = await insertTestUsers(db, {
    clientId: client!.id,
    email: `push-batch-${randomUUID()}@example.com`,
    passwordHash: "x",
    displayName: "Push batch recipient",
  }).returning();

  const rows = await Promise.all(Array.from({ length: 51 }, (_, index) => enqueuePush(db, {
    clientId: client!.id,
    userId: user!.id,
    reason: "mentioned",
    payload: {
      kind: "comment_mentioned",
      title: "Mentioned in a comment",
      body: `Queued mention ${index}`,
    },
  })));

  assert.equal(await runPushQueueSweep({ db, log: app.log }), 51);
  const processed = await db.select().from(pushQueue).where(inArray(pushQueue.id, rows.map((row) => row.id)));
  assert.equal(processed.length, 51);
  assert.ok(processed.every((row) => row.status === "error" && row.lastError === "no active push subscriptions"));
});

void test("partial multi-device failure retries only the failed subscription", async () => {
  const app = await buildIntegrationServer();
  await ensureSystemWebPushConfig();
  const [client] = await db.insert(clients).values({ name: "Partial push", pushEnabled: true }).returning();
  const [user] = await insertTestUsers(db, {
    clientId: client!.id,
    email: `partial-push-${randomUUID()}@example.com`,
    passwordHash: "x",
    displayName: "Partial push recipient",
  }).returning();
  const [desktop, phone] = await db.insert(pushSubscriptions).values([
    { clientId: client!.id, userId: user!.id, endpoint: "https://push.example.test/desktop", keyP256dh: "desktop-key", keyAuth: "desktop-auth" },
    { clientId: client!.id, userId: user!.id, endpoint: "https://push.example.test/phone", keyP256dh: "phone-key", keyAuth: "phone-auth" },
  ]).returning();
  const attempts = new Map<string, number>();
  const send = mock.method(webPushClient, "sendNotification", async (subscription: { endpoint: string }) => {
    const count = (attempts.get(subscription.endpoint) ?? 0) + 1;
    attempts.set(subscription.endpoint, count);
    if (subscription.endpoint.endsWith("/phone") && count === 1) {
      throw Object.assign(new Error("temporary provider failure"), { statusCode: 503 });
    }
    return undefined as never;
  });
  try {
    const row = await enqueuePush(db, {
      clientId: client!.id,
      userId: user!.id,
      reason: "mentioned",
      payload: { kind: "comment_mentioned", title: "Mentioned", body: "Please review" },
    });

    assert.equal(await runPushQueueSweep({ db, log: app.log }), 2);
    assert.equal(attempts.get(desktop!.endpoint), 1);
    assert.equal(attempts.get(phone!.endpoint), 2);
    const [processed] = await db.select().from(pushQueue).where(eq(pushQueue.id, row.id));
    assert.equal(processed!.status, "success");
    assert.equal(processed!.retries, 1);
    assert.ok(processed!.sentAt);
  } finally {
    send.mock.restore();
  }
});

void test("expired push processing leases are reclaimed but active leases are left alone", async () => {
  const app = await buildIntegrationServer();
  await ensureSystemWebPushConfig();
  const [client] = await db.insert(clients).values({ name: "Push lease", pushEnabled: true }).returning();
  const [user] = await insertTestUsers(db, {
    clientId: client!.id,
    email: `push-lease-${randomUUID()}@example.com`,
    passwordHash: "x",
    displayName: "Push lease recipient",
  }).returning();
  const payload = { notification: { title: "Lease", body: "Lease", data: { kind: "test" } } };
  const [expired, active] = await db.insert(pushQueue).values([
    { clientId: client!.id, userId: user!.id, reason: "test", payload, status: "immediate", processingLeaseExpiresAt: new Date(Date.now() - 1_000) },
    { clientId: client!.id, userId: user!.id, reason: "test", payload, status: "immediate", processingLeaseExpiresAt: new Date(Date.now() + 60_000) },
  ]).returning();

  assert.equal(await runPushQueueSweep({ db, log: app.log }), 1);
  const rows = await db.select().from(pushQueue).where(inArray(pushQueue.id, [expired!.id, active!.id]));
  assert.equal(rows.find((row) => row.id === expired!.id)?.status, "error");
  assert.equal(rows.find((row) => row.id === active!.id)?.status, "immediate");
});

void test("push cleanup keeps unresolved rows even after the audit retention window", async () => {
  const [client] = await db.insert(clients).values({ name: "Push cleanup" }).returning();
  const [user] = await insertTestUsers(db, {
    clientId: client!.id,
    email: `push-cleanup-${randomUUID()}@example.com`,
    passwordHash: "x",
    displayName: "Push cleanup recipient",
  }).returning();
  const payload = { notification: { title: "Cleanup", body: "Cleanup", data: { kind: "test" } } };
  const [terminal, pending] = await db.insert(pushQueue).values([
    { clientId: client!.id, userId: user!.id, reason: "test", payload, status: "success", createdAt: new Date("2026-01-01T00:00:00Z") },
    { clientId: client!.id, userId: user!.id, reason: "test", payload, status: "queued", createdAt: new Date("2026-01-01T00:00:00Z") },
  ]).returning();

  assert.equal(await runPushQueueCleanup({ db, log: (await buildIntegrationServer()).log }, new Date("2026-02-01T00:00:00Z")), 1);
  assert.equal(await db.$count(pushQueue, eq(pushQueue.id, terminal!.id)), 0);
  assert.equal(await db.$count(pushQueue, eq(pushQueue.id, pending!.id)), 1);
});

void test("personal channel adapters send provider contracts, sign webhooks, cancel disabled rows, and retry failures", async () => {
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let failWebhook = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = failWebhook && req.url === "/failing" ? 500 : 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const app = await buildIntegrationServer();
  try {
    const [client] = await db.insert(clients).values({ name: "Personal delivery" }).returning();
    const [user] = await insertTestUsers(db, {
      clientId: client!.id,
      email: `personal-${randomUUID()}@example.com`,
      passwordHash: "x",
      displayName: "Personal recipient",
    }).returning();
    const webhookSecret = "whsec_test-personal-delivery";
    await db.insert(notificationSettings).values({
      userId: user!.id,
      ntfyEnabled: true,
      ntfyServerUrl: `${origin}/ntfy`,
      ntfyTopic: "kanera topic",
      encryptedNtfyToken: encryptSecret("ntfy-token"),
      gotifyEnabled: true,
      gotifyServerUrl: `${origin}/gotify`,
      encryptedGotifyToken: encryptSecret("gotify-token"),
      webhookEnabled: true,
      webhookUrl: `${origin}/hook`,
      encryptedWebhookSecret: encryptSecret(webhookSecret),
    });
    const payload = {
      kind: "comment_mentioned",
      title: "Mentioned in a comment",
      body: "Someone mentioned you",
      url: "http://web.test/boards/board-id?card=card-id",
      tag: "card:card-id:mentioned",
    };

    for (const channel of ["ntfy", "gotify", "webhook"] as const) {
      const row = await enqueuePersonalNotification(db, { clientId: client!.id, userId: user!.id, reason: "mentioned", channel, payload }, true);
      assert.deepEqual(await deliverPersonalNotificationTestRow(db, row), { delivered: true, error: null });
    }

    assert.equal(requests[0]!.url, "/ntfy/kanera%20topic");
    assert.equal(requests[0]!.headers.authorization, "Bearer ntfy-token");
    assert.equal(requests[0]!.headers.title, payload.title);
    assert.equal(requests[0]!.headers.click, payload.url);
    assert.equal(requests[0]!.body, payload.body);

    assert.equal(requests[1]!.url, "/gotify/message");
    assert.equal(requests[1]!.headers["x-gotify-key"], "gotify-token");
    assert.deepEqual(JSON.parse(requests[1]!.body), {
      title: payload.title,
      message: payload.body,
      priority: 5,
      extras: { "client::notification": { click: { url: payload.url } }, "client::display": { contentType: "text/plain" } },
    });

    assert.equal(requests[2]!.url, "/hook");
    const timestamp = String(requests[2]!.headers["x-kanera-timestamp"]);
    assert.equal(
      requests[2]!.headers["x-kanera-signature"],
      `sha256=${createHmac("sha256", webhookSecret).update(`${timestamp}.${requests[2]!.body}`).digest("hex")}`,
    );
    const webhookBody = JSON.parse(requests[2]!.body);
    assert.equal(webhookBody.type, "notification");
    assert.equal(webhookBody.notification.reason, "mentioned");
    assert.equal(webhookBody.notification.kind, payload.kind);

    await db.update(notificationSettings).set({ ntfyEnabled: false }).where(eq(notificationSettings.userId, user!.id));
    const cancelled = await enqueuePersonalNotification(db, { clientId: client!.id, userId: user!.id, reason: "mentioned", channel: "ntfy", payload });
    assert.equal(await runPushQueueSweep({ db, log: app.log }), 1);
    const [cancelledRow] = await db.select().from(pushQueue).where(eq(pushQueue.id, cancelled.id)).limit(1);
    assert.equal(cancelledRow?.status, "cancelled");

    failWebhook = true;
    await db.update(notificationSettings).set({ webhookUrl: `${origin}/failing` }).where(eq(notificationSettings.userId, user!.id));
    const failing = await enqueuePersonalNotification(db, { clientId: client!.id, userId: user!.id, reason: "mentioned", channel: "webhook", payload });
    // A drain keeps claiming queued work, including retryable failures, until every row reaches a
    // terminal state. The scheduler only starts its 30-second wait after all three attempts finish.
    assert.equal(await runPushQueueSweep({ db, log: app.log }), 3);
    const [failedRow] = await db.select().from(pushQueue).where(eq(pushQueue.id, failing.id)).limit(1);
    assert.equal(failedRow?.status, "error");
    assert.equal(failedRow?.retries, 3);
    assert.equal(requests.filter((request) => request.url === "/failing").length, 3);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
