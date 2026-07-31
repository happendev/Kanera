import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAuditLogs, cardAttachments, clients, users, workspaceApiKeys } from "@kanera/shared/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { verifyPassword } from "../auth/password.js";
import { db } from "../db.js";
import { storageKeyFromMediaUrl } from "../lib/media-keys.js";
import { getStorageForClient } from "../lib/storage/index.js";
import { buildAdminIntegrationServer } from "../test/integration.js";
import { adminAuthHeader, createAdmin, loginAdmin } from "../test/admin-fixtures.js";

void test("demo endpoints require a superadmin", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("demo-staff@test.local", "staff-password", "staff");
  const { accessToken } = await loginAdmin(app, "demo-staff@test.local", "staff-password");

  const status = await app.inject({
    method: "GET",
    url: "/admin/demo",
    headers: adminAuthHeader(accessToken),
  });
  assert.equal(status.statusCode, 403);

  const reset = await app.inject({
    method: "POST",
    url: "/admin/demo/reset",
    headers: adminAuthHeader(accessToken),
  });
  assert.equal(reset.statusCode, 403);
});

void test("demo reset creates paid seed data with images and hard-purges the previous demo", async () => {
  const app = await buildAdminIntegrationServer();
  await createAdmin("demo-admin@test.local", "admin-password");
  const { accessToken } = await loginAdmin(app, "demo-admin@test.local", "admin-password");
  const headers = adminAuthHeader(accessToken);

  const [unrelatedClient] = await db
    .insert(clients)
    .values({ name: "Keep Me", storageConfig: { kind: "local" } })
    .returning({ id: clients.id });

  const first = await app.inject({ method: "POST", url: "/admin/demo/reset", headers });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json<{
    primaryEmail: string;
    password: string;
    loginEmails: string[];
    clientIds: string[];
    summary: { attachments: number; cardCovers: number };
  }>();
  assert.equal(firstBody.primaryEmail, "amelia@kanera.test");
  assert.equal(firstBody.password.length, 32);
  assert.notEqual(firstBody.password, "Abc12345");
  assert.equal(firstBody.loginEmails.length, 11);
  assert.equal(firstBody.clientIds.length, 2);
  assert.ok(firstBody.summary.attachments > 0);
  assert.ok(firstBody.summary.cardCovers > 0);

  const demoClients = await db
    .select({
      id: clients.id,
      plan: clients.plan,
      billingStatus: clients.billingStatus,
      analyticsExcluded: clients.analyticsExcluded,
    })
    .from(clients)
    .where(and(
      eq(clients.analyticsExcluded, true),
      eq(clients.plan, "paid"),
      eq(clients.billingStatus, "active"),
    ));
  assert.equal(demoClients.length, 2);

  const [owner] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, clientId: users.clientId, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.email, firstBody.primaryEmail))
    .limit(1);
  assert.ok(owner);
  assert.equal(await verifyPassword(owner.passwordHash, firstBody.password), true);

  const ownerStorage = await getStorageForClient(owner.clientId);
  const avatarKey = storageKeyFromMediaUrl(owner.avatarUrl, owner.clientId);
  assert.ok(avatarKey);
  assert.ok((await ownerStorage.get(avatarKey)).byteLength > 0);

  const [imageAttachment] = await db
    .select({
      clientId: cardAttachments.clientId,
      fileKey: cardAttachments.fileKey,
      thumbnailFileKey: cardAttachments.thumbnailFileKey,
      coverImageFileKey: cardAttachments.coverImageFileKey,
    })
    .from(cardAttachments)
    .where(isNotNull(cardAttachments.coverImageFileKey))
    .limit(1);
  assert.ok(imageAttachment?.thumbnailFileKey);
  assert.ok(imageAttachment.coverImageFileKey);
  const attachmentStorage = await getStorageForClient(imageAttachment.clientId);
  await Promise.all([
    attachmentStorage.get(imageAttachment.fileKey),
    attachmentStorage.get(imageAttachment.thumbnailFileKey),
    attachmentStorage.get(imageAttachment.coverImageFileKey),
  ]);

  const oldClientIds = [...firstBody.clientIds];
  const oldPrimaryStorage = await getStorageForClient(owner.clientId);
  await oldPrimaryStorage.put("orphaned/reset-me.png", Buffer.from("old demo orphan"), "image/png");
  await db.insert(workspaceApiKeys).values({
    kind: "personal",
    workspaceId: null,
    createdById: owner.id,
    name: null,
    keyPrefix: "kanera_demo_personal",
    keyHash: "demo-personal-key-hash",
    scope: "read",
  });

  const second = await app.inject({ method: "POST", url: "/admin/demo/reset", headers });
  assert.equal(second.statusCode, 200, second.body);
  const secondBody = second.json<{ password: string; clientIds: string[] }>();
  assert.notEqual(secondBody.password, firstBody.password);
  assert.ok(secondBody.clientIds.every((id) => !oldClientIds.includes(id)));

  assert.equal(
    await db.$count(clients, inArray(clients.id, oldClientIds)),
    0,
    "old demo client rows must be hard-deleted",
  );
  assert.equal(await db.$count(clients, eq(clients.id, unrelatedClient!.id)), 1);
  assert.equal(await db.$count(workspaceApiKeys, eq(workspaceApiKeys.keyHash, "demo-personal-key-hash")), 0);
  await assert.rejects(oldPrimaryStorage.get("orphaned/reset-me.png"), "the old client storage namespace must be gone");

  const [newOwner] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, firstBody.primaryEmail))
    .limit(1);
  assert.ok(newOwner);
  assert.equal(await verifyPassword(newOwner.passwordHash, secondBody.password), true);
  assert.equal(await verifyPassword(newOwner.passwordHash, firstBody.password), false);
  assert.equal(await db.$count(adminAuditLogs, eq(adminAuditLogs.action, "demo.reset.started")), 2);
  assert.equal(await db.$count(adminAuditLogs, eq(adminAuditLogs.action, "demo.reset")), 2);
});
