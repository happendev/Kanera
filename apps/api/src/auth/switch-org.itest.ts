import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { clientMembers, clients, users } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";

type Session = {
  accessToken: string;
  user: { id: string; clientId: string; activeClientId: string };
};

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function refreshCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((candidate) => candidate.name === "kanera_rt");
  assert.ok(cookie, "expected refresh cookie");
  return cookie.value;
}

void test("switching and tab-local refresh resolve only active memberships", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Home Org", email: "switcher@example.com", password: "Abc12345", displayName: "Switcher" },
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const original = signup.json<Session>();
  const homeClientId = original.user.clientId;

  const [target, suspended, removed, unavailable] = await db.insert(clients).values([
    { name: "Target Org" },
    { name: "Suspended Membership Org" },
    { name: "Removed Membership Org" },
    { name: "No Membership Org" },
  ]).returning();
  await db.insert(clientMembers).values([
    { clientId: target!.id, userId: original.user.id, clientRole: "member" },
    { clientId: suspended!.id, userId: original.user.id, clientRole: "member", suspendedAt: new Date() },
    { clientId: removed!.id, userId: original.user.id, clientRole: "member", removedAt: new Date() },
  ]);

  for (const clientId of [suspended!.id, removed!.id, unavailable!.id]) {
    const denied = await app.inject({
      method: "POST",
      url: "/auth/switch-org",
      headers: bearer(original.accessToken),
      payload: { clientId },
    });
    assert.equal(denied.statusCode, 403, denied.body);
  }

  const switched = await app.inject({
    method: "POST",
    url: "/auth/switch-org",
    headers: bearer(original.accessToken),
    payload: { clientId: target!.id },
  });
  assert.equal(switched.statusCode, 200, switched.body);
  const switchedSession = switched.json<Session>();
  assert.equal(switchedSession.user.clientId, target!.id);
  assert.equal(switchedSession.user.activeClientId, target!.id);
  assert.equal((app.jwt.verify(switchedSession.accessToken) as { cid: string }).cid, target!.id);

  const refreshedDefault = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `kanera_rt=${refreshCookie(switched)}` },
    payload: {},
  });
  assert.equal(refreshedDefault.statusCode, 200, refreshedDefault.body);
  assert.equal(refreshedDefault.json<Session>().user.clientId, target!.id);

  const refreshedHomeTab = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `kanera_rt=${refreshCookie(refreshedDefault)}` },
    payload: { clientId: homeClientId },
  });
  assert.equal(refreshedHomeTab.statusCode, 200, refreshedHomeTab.body);
  assert.equal(refreshedHomeTab.json<Session>().user.clientId, homeClientId);

  await db.update(clientMembers).set({ removedAt: new Date() }).where(and(
    eq(clientMembers.clientId, target!.id),
    eq(clientMembers.userId, original.user.id),
  ));
  const fallback = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `kanera_rt=${refreshCookie(refreshedHomeTab)}` },
    payload: {},
  });
  assert.equal(fallback.statusCode, 200, fallback.body);
  assert.equal(fallback.json<Session>().user.clientId, homeClientId);
  const [identity] = await db.select({ activeClientId: users.activeClientId }).from(users).where(eq(users.id, original.user.id)).limit(1);
  assert.equal(identity?.activeClientId, homeClientId);
});
