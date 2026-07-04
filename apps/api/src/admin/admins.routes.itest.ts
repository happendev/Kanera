import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { adminInvites, adminUsers } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildAdminIntegrationServer } from "../test/integration.js";
import { createAdmin } from "../test/admin-fixtures.js";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// Insert a pending invite directly (the raw token is normally only emailed, not returned by the create
// route) so acceptance can be exercised end-to-end with a known token.
async function seedInvite(invitedById: string, email: string, role: "superadmin" | "staff", raw: string) {
  await db.insert(adminInvites).values({
    email,
    displayName: "Invited Admin",
    role,
    tokenHash: tokenHash(raw),
    invitedById,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

void test("accepting a staff invite creates a staff account (role flows through acceptance)", async () => {
  const app = await buildAdminIntegrationServer();
  const inviter = await createAdmin("owner@kanera.dev", "admin-password", "superadmin");
  await seedInvite(inviter, "newstaff@kanera.dev", "staff", "staff-invite-token");

  const res = await app.inject({ method: "POST", url: "/admin/invites/accept", payload: { token: "staff-invite-token", password: "new-password-123" } });
  assert.equal(res.statusCode, 200);

  const [account] = await db.select().from(adminUsers).where(eq(adminUsers.email, "newstaff@kanera.dev"));
  assert.ok(account);
  assert.equal(account.role, "staff");
});

void test("accepting a superadmin invite creates a superadmin account", async () => {
  const app = await buildAdminIntegrationServer();
  const inviter = await createAdmin("owner@kanera.dev", "admin-password", "superadmin");
  await seedInvite(inviter, "newsuper@kanera.dev", "superadmin", "super-invite-token");

  const res = await app.inject({ method: "POST", url: "/admin/invites/accept", payload: { token: "super-invite-token", password: "new-password-123" } });
  assert.equal(res.statusCode, 200);

  const [account] = await db.select().from(adminUsers).where(eq(adminUsers.email, "newsuper@kanera.dev"));
  assert.ok(account);
  assert.equal(account.role, "superadmin");
});

void test("accepting an unknown invite token is rejected without creating an account", async () => {
  const app = await buildAdminIntegrationServer();

  const res = await app.inject({ method: "POST", url: "/admin/invites/accept", payload: { token: "does-not-exist", password: "some-password-123" } });
  assert.equal(res.statusCode, 401);

  const count = await db.select().from(adminUsers);
  assert.equal(count.length, 0);
});
