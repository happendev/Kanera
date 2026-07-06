import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emailQueue,
  EMAIL_QUEUE_STATUS,
  eventOutbox,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
} from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildAdminIntegrationServer, buildIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";

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
  return { userId: user.id, workspaceId: workspace!.id };
}

void test("ops queue actions reject terminal success rows", async () => {
  const { app, headers } = await adminSession();
  const { userId, workspaceId } = await tenantWorkspace();

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

  const [outbox] = await db
    .insert(eventOutbox)
    .values({
      scope: "workspace",
      scopeId: workspaceId,
      workspaceId,
      eventType: "card:created",
      payload: {
        boardId: workspaceId,
        card: {
          id: workspaceId,
          listId: workspaceId,
          boardId: workspaceId,
          title: "Delivered",
          position: "1000.0000000000",
          createdById: userId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      realtimeDispatched: true,
      webhooksEnqueued: true,
    })
    .returning({ id: eventOutbox.id });

  const cases = [
    `/admin/ops/email-queue/${email!.id}/retry`,
    `/admin/ops/email-queue/${email!.id}/cancel`,
    `/admin/ops/webhook-deliveries/${delivery!.id}/retry`,
    `/admin/ops/webhook-deliveries/${delivery!.id}/cancel`,
    `/admin/ops/event-outbox/${outbox!.id}/retry`,
    `/admin/ops/event-outbox/${outbox!.id}/cancel`,
  ];

  for (const url of cases) {
    const res = await app.inject({ method: "POST", url, headers });
    assert.equal(res.statusCode, 400, url);
  }
});
