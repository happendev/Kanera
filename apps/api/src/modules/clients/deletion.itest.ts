import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardMembers, boards, cardAttachments, cards, clientMembers, clients, lists, users, workspaces } from "@kanera/shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { setStripeClientForTests } from "../../lib/billing.js";
import { unsignedMediaUrl } from "../../lib/media-keys.js";
import { purgeOrganisation, runOrganisationDeletionSweep } from "../../lib/organisation-delete.js";
import { configureOpsAlertsForTests } from "../../lib/ops-alerts.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { buildIntegrationServer } from "../../test/integration.js";

type Session = {
  accessToken: string;
  user: { id: string; clientId: string; orgName: string; organisations: Array<{ clientId: string }> };
};

async function signup(email: string, orgName: string) {
  const app = await buildIntegrationServer();
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, orgName, password: "Abc12345", displayName: "Deletion owner" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { app, session: response.json<Session>() };
}

void test("organisation deletion requires the exact name and immediately signs out a final-org owner", async () => {
  const { app, session } = await signup("delete-final@example.com", "Final Company");
  const auth = { authorization: `Bearer ${session.accessToken}` };

  const mismatch = await app.inject({ method: "DELETE", url: "/clients/me", headers: auth, payload: { confirmationName: "final company" } });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal(await db.$count(clients, and(eq(clients.id, session.user.clientId), isNotNull(clients.permanentDeletionRequestedAt))), 0);

  const deleted = await app.inject({ method: "DELETE", url: "/clients/me", headers: auth, payload: { confirmationName: "Final Company" } });
  assert.equal(deleted.statusCode, 202, deleted.body);
  assert.deepEqual(deleted.json(), { status: "logged_out" });
  assert.equal(await db.$count(clientMembers, eq(clientMembers.clientId, session.user.clientId)), 0);
  const [identity] = await db.select({ needsOrganisationOnLoginAt: users.needsOrganisationOnLoginAt })
    .from(users).where(eq(users.id, session.user.id)).limit(1);
  assert.ok(identity?.needsOrganisationOnLoginAt);

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "delete-final@example.com", password: "Abc12345" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const replacement = login.json<Session>();
  assert.notEqual(replacement.user.clientId, session.user.clientId);
  assert.equal(replacement.user.orgName, "Private");
  assert.deepEqual(replacement.user.organisations.map((organisation) => organisation.clientId), [replacement.user.clientId]);
});

void test("a Pro organisation remains intact unless Stripe confirms its billing identity is deleted", async () => {
  const { app, session } = await signup("delete-pro@example.com", "Pro Company");
  const clientId = session.user.clientId;
  const auth = { authorization: `Bearer ${session.accessToken}` };
  await db.update(clients).set({
    plan: "paid",
    billingStatus: "active",
    stripeCustomerId: "cus_delete_pro",
    stripeSubscriptionId: "sub_delete_pro",
  }).where(eq(clients.id, clientId));

  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousSecret = env.STRIPE_SECRET_KEY;
  const opsAlerts: string[] = [];
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_delete_pro";
  configureOpsAlertsForTests({
    env: {
      NODE_ENV: "test",
      OPS_ALERTS_ENABLED: true,
      OPS_ALERT_THROTTLE_MS: 0,
      ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
    },
    fetch: async (_input, init) => {
      opsAlerts.push(typeof init?.body === "string" ? init.body : "");
      return new Response(null, { status: 200 });
    },
  });
  try {
    setStripeClientForTests({
      customers: { del: async () => { throw new Error("Stripe unavailable"); } },
      subscriptions: { cancel: async () => ({ id: "sub_delete_pro", status: "canceled" }) },
    } as unknown as Stripe);
    const failed = await app.inject({
      method: "DELETE",
      url: "/clients/me",
      headers: auth,
      payload: { confirmationName: "Pro Company" },
    });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(failed.json<{ code: string }>().code, "BILLING_CANCELLATION_FAILED");
    assert.equal(await db.$count(clients, and(eq(clients.id, clientId), isNotNull(clients.permanentDeletionRequestedAt))), 0);
    assert.equal(await db.$count(clientMembers, eq(clientMembers.clientId, clientId)), 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opsAlerts.length, 1);
    assert.match(opsAlerts[0]!, /Organisation billing cancellation failed/);
    assert.match(opsAlerts[0]!, new RegExp(`Stripe billing cancellation failed before deleting organisation ${clientId}`));

    const deletedCustomers: string[] = [];
    const canceledSubscriptions: string[] = [];
    setStripeClientForTests({
      customers: {
        del: async (id: string) => {
          deletedCustomers.push(id);
          return { id, deleted: true };
        },
      },
      subscriptions: {
        cancel: async (id: string) => {
          canceledSubscriptions.push(id);
          return { id, status: "canceled" };
        },
      },
    } as unknown as Stripe);
    const deleted = await app.inject({
      method: "DELETE",
      url: "/clients/me",
      headers: auth,
      payload: { confirmationName: "Pro Company" },
    });
    assert.equal(deleted.statusCode, 202, deleted.body);
    assert.deepEqual(deletedCustomers, ["cus_delete_pro"]);
    assert.deepEqual(canceledSubscriptions, ["sub_delete_pro"]);

    const staleCheckout = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: auth,
      payload: { interval: "monthly", seatLimit: 1 },
    });
    assert.equal(staleCheckout.statusCode, 400, staleCheckout.body);
    assert.equal(staleCheckout.json<{ message: string }>().message, "organisation is unavailable for billing");

    const missing = () => Object.assign(new Error("already deleted"), { code: "resource_missing" });
    setStripeClientForTests({
      customers: { del: async () => { throw missing(); } },
      subscriptions: { cancel: async () => { throw missing(); } },
    } as unknown as Stripe);
    assert.equal(await purgeOrganisation(clientId, app.log), true, "the worker safely repeats confirmed cancellation before purging");
  } finally {
    configureOpsAlertsForTests(null);
    setStripeClientForTests(null);
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.STRIPE_SECRET_KEY = previousSecret;
  }
});

void test("failed and stuck background organisation deletion sends throttled ops alerts", async () => {
  const { app, session } = await signup("delete-alerts@example.com", "Alert Company");
  const clientId = session.user.clientId;
  const requestedAt = new Date(Date.now() - 16 * 60_000);
  await db.update(clients).set({
    deletedAt: requestedAt,
    permanentDeletionRequestedAt: requestedAt,
    stripeCustomerId: "cus_delete_alert",
  }).where(eq(clients.id, clientId));

  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousSecret = env.STRIPE_SECRET_KEY;
  const opsAlerts: string[] = [];
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_delete_alert";
  configureOpsAlertsForTests({
    env: {
      NODE_ENV: "test",
      OPS_ALERTS_ENABLED: true,
      OPS_ALERT_THROTTLE_MS: 0,
      ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
    },
    fetch: async (_input, init) => {
      opsAlerts.push(typeof init?.body === "string" ? init.body : "");
      return new Response(null, { status: 200 });
    },
  });
  setStripeClientForTests({
    customers: { del: async () => { throw new Error("Stripe unavailable"); } },
  } as unknown as Stripe);
  try {
    assert.equal(await runOrganisationDeletionSweep(app.log), 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opsAlerts.length, 2);
    assert.ok(opsAlerts.some((body) => body.includes("Organisation deletion stuck")));
    assert.ok(opsAlerts.some((body) => body.includes("Organisation deletion failed")));
    assert.ok(opsAlerts.some((body) => body.includes(`Organisation deletion has remained incomplete for at least 15 minutes: ${clientId}`)));
    assert.ok(opsAlerts.some((body) => body.includes(`Organisation deletion purge failed for ${clientId}`)));
  } finally {
    configureOpsAlertsForTests(null);
    setStripeClientForTests(null);
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.STRIPE_SECRET_KEY = previousSecret;
  }
});

void test("deleting one of several organisations rotates the owner directly into a remaining organisation", async () => {
  const { app, session: first } = await signup("delete-one@example.com", "Keep Company");
  const created = await app.inject({
    method: "POST",
    url: "/clients",
    headers: { authorization: `Bearer ${first.accessToken}` },
    payload: { name: "Delete Company" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const second = created.json<Session>();
  const [standalone] = await db.insert(workspaces).values({
    clientId: second.user.clientId,
    name: "Temporary standalone",
    kind: "board",
  }).returning();
  await db.insert(lists).values({
    workspaceId: standalone!.id,
    name: "Cards",
    position: "1000.0000000000",
  });
  const [standaloneBoard] = await db.insert(boards).values({
    workspaceId: standalone!.id,
    name: "Temporary board",
    position: "1000.0000000000",
  }).returning();
  await db.insert(boardMembers).values({
    boardId: standaloneBoard!.id,
    userId: second.user.id,
    role: "editor",
  });

  const deleted = await app.inject({
    method: "DELETE",
    url: "/clients/me",
    headers: { authorization: `Bearer ${second.accessToken}` },
    payload: { confirmationName: "Delete Company" },
  });
  assert.equal(deleted.statusCode, 202, deleted.body);
  const switched = deleted.json<Session & { status: "authenticated" }>();
  assert.equal(switched.status, "authenticated");
  assert.equal(switched.user.clientId, first.user.clientId);
  assert.deepEqual(switched.user.organisations.map((organisation) => organisation.clientId), [first.user.clientId]);

  // The graph still exists until the worker runs, but its old board_member row must not be
  // reinterpreted as cross-organisation guest access after synchronous membership removal.
  assert.equal(await db.$count(workspaces, eq(workspaces.id, standalone!.id)), 1);
  const home = await app.inject({
    method: "GET",
    url: "/home/boards",
    headers: { authorization: `Bearer ${switched.accessToken}` },
  });
  assert.equal(home.statusCode, 200, home.body);
  const guestBoardIds = home.json<{ guestGroups: Array<{ boards: Array<{ id: string }> }> }>()
    .guestGroups.flatMap((group) => group.boards.map((board) => board.id));
  assert.ok(!guestBoardIds.includes(standaloneBoard!.id));
  const today = await app.inject({
    method: "GET",
    url: "/home/today",
    headers: { authorization: `Bearer ${switched.accessToken}` },
  });
  assert.equal(today.statusCode, 200, today.body);
  assert.equal(today.json<{ boardCount: number }>().boardCount, 0);
});

void test("the background purge removes owned rows and the complete storage namespace", async () => {
  const { app, session } = await signup("delete-purge@example.com", "Purge Company");
  const clientId = session.user.clientId;
  const [workspace] = await db.insert(workspaces).values({ clientId, name: "Remove me" }).returning();
  const storage = await getStorageForClient(clientId);
  await storage.put("orphaned/remove-me.txt", Buffer.from("tenant data"), "text/plain");

  const deleted = await app.inject({
    method: "DELETE",
    url: "/clients/me",
    headers: { authorization: `Bearer ${session.accessToken}` },
    payload: { confirmationName: "Purge Company" },
  });
  assert.equal(deleted.statusCode, 202, deleted.body);
  assert.equal(await purgeOrganisation(clientId, app.log), true);

  assert.equal(await db.$count(workspaces, eq(workspaces.id, workspace!.id)), 0);
  await assert.rejects(storage.get("orphaned/remove-me.txt"));
  const [tombstone] = await db.select({ completedAt: clients.permanentDeletionCompletedAt, storageConfig: clients.storageConfig })
    .from(clients).where(eq(clients.id, clientId)).limit(1);
  assert.ok(tombstone?.completedAt);
  assert.equal(tombstone.storageConfig, null);
});

void test("the background purge relocates attachments owned by a surviving organisation", async () => {
  const { app, session: deleting } = await signup("delete-uploader@example.com", "Uploader Company");
  const { app: survivingApp, session: surviving } = await signup("keep-attachment@example.com", "Surviving Company");
  const [workspace] = await db.insert(workspaces).values({
    clientId: surviving.user.clientId,
    name: "Surviving workspace",
    cardKeyPrefix: "SURVIVE",
  }).returning();
  const [list] = await db.insert(lists).values({
    workspaceId: workspace!.id,
    name: "Queue",
    position: "1000.0000000000",
  }).returning();
  const [board] = await db.insert(boards).values({
    workspaceId: workspace!.id,
    name: "Surviving board",
    position: "1000.0000000000",
  }).returning();
  const fileKey = "attachments/cross-org.txt";
  const oldUrl = unsignedMediaUrl(deleting.user.clientId, fileKey)!;
  const [card] = await db.insert(cards).values({
    boardId: board!.id,
    listId: list!.id,
    title: "Keep guest upload",
    description: `![attachment](${oldUrl})`,
    position: "1000.0000000000",
    createdById: surviving.user.id,
  }).returning();
  const [attachment] = await db.insert(cardAttachments).values({
    cardId: card!.id,
    clientId: surviving.user.clientId,
    uploadedById: deleting.user.id,
    fileName: "cross-org.txt",
    mimeType: "text/plain",
    byteSize: 17,
    fileKey,
    url: oldUrl,
    source: "description",
  }).returning();
  const deletingStorage = await getStorageForClient(deleting.user.clientId);
  await deletingStorage.put(fileKey, Buffer.from("surviving content"), "text/plain");

  const deleted = await app.inject({
    method: "DELETE",
    url: "/clients/me",
    headers: { authorization: `Bearer ${deleting.accessToken}` },
    payload: { confirmationName: "Uploader Company" },
  });
  assert.equal(deleted.statusCode, 202, deleted.body);
  assert.equal(await purgeOrganisation(deleting.user.clientId, app.log), true);

  const nextUrl = unsignedMediaUrl(surviving.user.clientId, fileKey)!;
  const [relocated] = await db.select({ url: cardAttachments.url })
    .from(cardAttachments).where(eq(cardAttachments.id, attachment!.id)).limit(1);
  const [updatedCard] = await db.select({ description: cards.description })
    .from(cards).where(eq(cards.id, card!.id)).limit(1);
  assert.equal(relocated?.url, nextUrl);
  assert.equal(updatedCard?.description, `![attachment](${nextUrl})`);
  const survivingStorage = await getStorageForClient(surviving.user.clientId);
  assert.equal((await survivingStorage.get(fileKey)).toString(), "surviving content");
  await assert.rejects(deletingStorage.get(fileKey));

  await survivingApp.close();
});
