import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAuditLogs, cardAttachments, cards, clients, oauthClients, oauthGrants, users, workspaceApiKeys } from "@kanera/shared/schema";
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

  const invalid = await app.inject({
    method: "POST",
    url: "/admin/demo/reset",
    headers,
    payload: { password: "short" },
  });
  assert.equal(invalid.statusCode, 400);

  const demoPassword = "stable-marketing-demo-password";
  const first = await app.inject({ method: "POST", url: "/admin/demo/reset", headers, payload: { password: demoPassword } });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json<{
    primaryEmail: string;
    password: string;
    loginEmails: string[];
    clientIds: string[];
    summary: { attachments: number; cardCovers: number };
  }>();
  assert.equal(firstBody.primaryEmail, "amelia@kanera.test");
  assert.equal(firstBody.password, demoPassword);
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

  const seededDueDates = await db
    .select({ dueDate: cards.dueDateLocalDate })
    .from(cards)
    .where(isNotNull(cards.dueDateLocalDate));
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const futureCutoff = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 45))
    .toISOString()
    .slice(0, 10);
  const upcomingDueDates = seededDueDates.flatMap(({ dueDate }) => dueDate !== null && dueDate >= todayKey ? [dueDate] : []);
  assert.ok(upcomingDueDates.length > 0);
  assert.ok(upcomingDueDates.every((dueDate) => dueDate <= futureCutoff));
  assert.ok(upcomingDueDates.includes(todayKey), "upcoming dates begin on the seed date");
  assert.ok(upcomingDueDates.includes(futureCutoff), "upcoming dates reach 45 days after the seed date");
  assert.ok(new Set(upcomingDueDates).size >= 10, "upcoming dates are spread across the 45-day window");
  assert.ok(seededDueDates.some(({ dueDate }) => dueDate !== null && dueDate < todayKey), "intentional overdue examples remain");

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
    clientId: owner.clientId,
    createdById: owner.id,
    name: null,
    keyPrefix: "kanera_demo_personal",
    keyHash: "demo-personal-key-hash",
    scope: "read",
  });
  const [unrelatedUser] = await db.insert(users).values({
    clientId: unrelatedClient!.id,
    activeClientId: unrelatedClient!.id,
    email: "demo-reset-survivor@test.local",
    passwordHash: owner.passwordHash,
    displayName: "Demo reset survivor",
  }).returning({ id: users.id });
  const [crossOrganisationKey] = await db.insert(workspaceApiKeys).values({
    kind: "personal",
    workspaceId: null,
    clientId: owner.clientId,
    createdById: unrelatedUser!.id,
    name: null,
    keyPrefix: "kanera_demo_cross_org",
    keyHash: "demo-cross-org-key-hash",
    scope: "read",
  }).returning({ id: workspaceApiKeys.id });
  await db.insert(oauthClients).values({
    clientId: "demo-reset-cross-org-client",
    kind: "public",
    name: "Demo reset cross-org client",
    redirectUris: ["https://example.test/callback"],
    grantTypes: ["authorization_code"],
    createdById: unrelatedUser!.id,
  });
  const [crossOrganisationGrant] = await db.insert(oauthGrants).values({
    clientId: "demo-reset-cross-org-client",
    userId: unrelatedUser!.id,
    orgClientId: owner.clientId,
    scopes: ["read"],
    resource: "https://api.kanera.test",
  }).returning({ id: oauthGrants.id });

  const second = await app.inject({ method: "POST", url: "/admin/demo/reset", headers, payload: { password: demoPassword } });
  assert.equal(second.statusCode, 200, second.body);
  const secondBody = second.json<{ password: string; clientIds: string[] }>();
  assert.equal(secondBody.password, firstBody.password);
  assert.ok(secondBody.clientIds.every((id) => !oldClientIds.includes(id)));

  assert.equal(
    await db.$count(clients, inArray(clients.id, oldClientIds)),
    0,
    "old demo client rows must be hard-deleted",
  );
  assert.equal(await db.$count(clients, eq(clients.id, unrelatedClient!.id)), 1);
  assert.equal(await db.$count(workspaceApiKeys, eq(workspaceApiKeys.keyHash, "demo-personal-key-hash")), 0);
  assert.equal(await db.$count(workspaceApiKeys, eq(workspaceApiKeys.id, crossOrganisationKey!.id)), 0);
  assert.equal(await db.$count(oauthGrants, eq(oauthGrants.id, crossOrganisationGrant!.id)), 0);
  assert.equal(await db.$count(users, eq(users.id, unrelatedUser!.id)), 1);
  await assert.rejects(oldPrimaryStorage.get("orphaned/reset-me.png"), "the old client storage namespace must be gone");

  const [newOwner] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, firstBody.primaryEmail))
    .limit(1);
  assert.ok(newOwner);
  assert.equal(await verifyPassword(newOwner.passwordHash, secondBody.password), true);
  assert.equal(await verifyPassword(newOwner.passwordHash, firstBody.password), true);
  assert.equal(await db.$count(adminAuditLogs, eq(adminAuditLogs.action, "demo.reset.started")), 2);
  assert.equal(await db.$count(adminAuditLogs, eq(adminAuditLogs.action, "demo.reset")), 2);
});
