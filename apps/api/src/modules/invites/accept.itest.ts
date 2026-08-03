import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { boardMembers, boards, clientMembers, clients, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";

type Session = { accessToken: string; user: { id: string; clientId: string; email: string } };

async function signup(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string, orgName: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Session>();
}

async function createInvite(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  accessToken: string,
  payload: { orgRole: "admin" | "member"; workspaces?: Array<{ workspaceId: string; role: "admin" | "member" }> },
) {
  const response = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { ...payload, workspaces: payload.workspaces ?? [] },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ token: string }>().token;
}

void test("an existing owner accepts an organisation invite and can create another independently owned organisation", async () => {
  const app = await buildIntegrationServer();
  const existing = await signup(app, "existing-owner@example.com", "Personal Org");
  const host = await signup(app, "host-owner@example.com", "Host Org");
  const [workspace] = await db.insert(workspaces).values({ clientId: host.user.clientId, name: "Granted workspace" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Pinned board", position: "1000.0000000000" }).returning();
  const token = await createInvite(app, host.accessToken, {
    orgRole: "admin",
    workspaces: [{ workspaceId: workspace!.id, role: "admin" }],
  });

  const accepted = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${existing.accessToken}` },
    payload: { token },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptedSession = accepted.json<Session>();
  assert.equal(acceptedSession.user.clientId, host.user.clientId);

  const [identity] = await db.select({ email: users.email, homeClientId: users.clientId, activeClientId: users.activeClientId })
    .from(users).where(eq(users.id, existing.user.id)).limit(1);
  assert.equal(identity?.email, "existing-owner@example.com");
  assert.equal(identity?.homeClientId, existing.user.clientId);
  assert.equal(identity?.activeClientId, host.user.clientId);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, existing.user.clientId),
    eq(clientMembers.userId, existing.user.id),
    eq(clientMembers.clientRole, "owner"),
    isNull(clientMembers.removedAt),
  )), 1);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, host.user.clientId),
    eq(clientMembers.userId, existing.user.id),
    eq(clientMembers.clientRole, "admin"),
  )), 1);
  assert.equal(await db.$count(workspaceMembers, and(
    eq(workspaceMembers.workspaceId, workspace!.id),
    eq(workspaceMembers.userId, existing.user.id),
    eq(workspaceMembers.role, "admin"),
  )), 1);
  const [pinned] = await db.select({ role: boardMembers.role, pinned: boardMembers.pinned }).from(boardMembers).where(and(
    eq(boardMembers.boardId, board!.id),
    eq(boardMembers.userId, existing.user.id),
  )).limit(1);
  assert.deepEqual(pinned, { role: "editor", pinned: true });

  const additionalOrg = await app.inject({
    method: "POST",
    url: "/clients",
    headers: { authorization: `Bearer ${acceptedSession.accessToken}` },
    payload: { name: "Another organisation" },
  });
  assert.equal(additionalOrg.statusCode, 200, additionalOrg.body);
  const additionalSession = additionalOrg.json<Session>();
  assert.notEqual(additionalSession.user.clientId, existing.user.clientId);
  assert.notEqual(additionalSession.user.clientId, host.user.clientId);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, additionalSession.user.clientId),
    eq(clientMembers.userId, existing.user.id),
    eq(clientMembers.clientRole, "owner"),
    isNull(clientMembers.removedAt),
  )), 1);
});

void test("parallel invite acceptances serialize at the paid seat cap", async () => {
  const app = await buildIntegrationServer();
  const host = await signup(app, "seat-host@example.com", "Seat Host");
  const first = await signup(app, "seat-first@example.com", "First Personal");
  const second = await signup(app, "seat-second@example.com", "Second Personal");
  await db.update(clients).set({ plan: "paid", billingStatus: "active", seatLimit: 2 }).where(eq(clients.id, host.user.clientId));

  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const token = await createInvite(app, host.accessToken, { orgRole: "member" });
    const responses = await Promise.all([first, second].map((candidate) => app.inject({
      method: "POST",
      url: "/invites/accept",
      headers: { authorization: `Bearer ${candidate.accessToken}` },
      payload: { token },
    })));
    assert.deepEqual(responses.map((response) => response.statusCode).sort((a, b) => a - b), [200, 402]);
    assert.equal(await db.$count(clientMembers, and(
      eq(clientMembers.clientId, host.user.clientId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    )), 2);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});
