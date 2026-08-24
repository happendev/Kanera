import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clients,
  emailQueue,
  EMAIL_QUEUE_STATUS,
  eventOutbox,
  PUSH_QUEUE_STATUS,
  pushQueue,
  type NewEventOutbox,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { buildAdminIntegrationServer, buildIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";
import { insertTestUsers } from "../test/user-fixtures.js";

async function adminSession() {
  const app = await buildAdminIntegrationServer();
  await createAdmin("ops-admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(app, "ops-admin@test.local", "admin-password");
  return { app, headers: adminAuthHeader(accessToken) };
}

async function tenantWorkspace() {
  const tenantApp = await buildIntegrationServer();
  const signup = await tenantApp.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Ops Queue Co", email: "ops-owner@test.local", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { user } = signup.json<{ user: { id: string; clientId: string } }>();
  const [workspace] = await db.insert(workspaces).values({ clientId: user.clientId, name: "Ops Workspace" }).returning({ id: workspaces.id });
  return { clientId: user.clientId, userId: user.id, workspaceId: workspace!.id };
}

void test("ops health reports purchased Pro seats instead of paid-organisation member headcount", async () => {
  const { app, headers } = await adminSession();
  const { clientId } = await tenantWorkspace();
  await db
    .update(clients)
    .set({ plan: "paid", billingStatus: "active", seatLimit: 10 })
    .where(eq(clients.id, clientId));
  await insertTestUsers(
    db,
    Array.from({ length: 21 }, (_, index) => ({
      clientId,
      email: `ops-pro-member-${index}@test.local`,
      passwordHash: "x",
      displayName: `Pro Member ${index}`,
    })),
  );

  const response = await app.inject({ method: "GET", url: "/admin/ops/health?days=30", headers });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json<{ planAccess: { proSeats: number } }>().planAccess.proSeats, 10);
  assert.ok(response.json<{ pushQueue: Record<string, unknown> }>().pushQueue);
});

void test("ops queue actions reject terminal success rows", async () => {
  const { app, headers } = await adminSession();
  const { clientId, userId, workspaceId } = await tenantWorkspace();

  const [email] = await db
    .insert(emailQueue)
    .values({
      toEmail: "delivered@test.local",
      subject: "Delivered",
      type: "welcome",
      data: { displayName: "Owner", loginUrl: "https://example.test/login" },
      status: EMAIL_QUEUE_STATUS.success,
      sentAt: new Date(),
    })
    .returning({ id: emailQueue.id });

  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({ workspaceId, createdById: userId, name: "Ops Hook", url: "https://example.test/hook", encryptedSecret: "secret", enabled: true })
    .returning({ id: webhookEndpoints.id });
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: endpoint!.id,
      workspaceId,
      eventType: "card:created",
      payload: { id: "evt-success", type: "card:created", workspaceId, occurredAt: new Date().toISOString(), data: {} },
      status: "success",
      deliveredAt: new Date(),
    })
    .returning({ id: webhookDeliveries.id });
  const [push] = await db.insert(pushQueue).values({
    clientId,
    userId,
    reason: "test",
    payload: { notification: { title: "Delivered", body: "Delivered", data: { kind: "test" } } },
    status: PUSH_QUEUE_STATUS.success,
    sentAt: new Date(),
  }).returning({ id: pushQueue.id });

  const now = new Date();
  const deliveredOutboxRow = {
    scope: "workspace",
    scopeId: workspaceId,
    workspaceId,
    eventType: "card:created",
    payload: {
      boardId: workspaceId,
      card: {
        id: workspaceId,
        workspaceId,
        organisationKey: "0123456789ABCDEF",
        number: 1,
        key: "OPS-1",
        listId: workspaceId,
        boardId: workspaceId,
        title: "Delivered",
        position: "1000.0000000000",
        createdById: userId,
        createdAt: now,
        updatedAt: now,
      },
    },
    realtimeDispatched: true,
    webhooksEnqueued: true,
  } satisfies NewEventOutbox;

  const [outbox] = await db
    .insert(eventOutbox)
    .values(deliveredOutboxRow)
    .returning({ id: eventOutbox.id });

  const cases = [
    `/admin/ops/email-queue/${email!.id}/retry`,
    `/admin/ops/email-queue/${email!.id}/cancel`,
    `/admin/ops/webhook-deliveries/${delivery!.id}/retry`,
    `/admin/ops/webhook-deliveries/${delivery!.id}/cancel`,
    `/admin/ops/event-outbox/${outbox!.id}/retry`,
    `/admin/ops/event-outbox/${outbox!.id}/cancel`,
    `/admin/ops/push-queue/${push!.id}/retry`,
    `/admin/ops/push-queue/${push!.id}/cancel`,
  ];

  for (const url of cases) {
    const res = await app.inject({ method: "POST", url, headers });
    assert.equal(res.statusCode, 400, url);
  }
});
