import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { boardMembers, boards, clientMembers, refreshTokens, users, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { assertBoardAccess } from "../../lib/access.js";
import { countActiveSeats } from "../../lib/billing.js";
import { buildIntegrationServer } from "../../test/integration.js";

type Session = { accessToken: string; user: { id: string; clientId: string; email: string } };

async function signup(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string, orgName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.cookies.find((candidate) => candidate.name === "kanera_rt");
  assert.ok(cookie);
  return { session: response.json<Session>(), refresh: cookie.value };
}

void test("removing a member affects only that organisation and leaves the identity refreshable and re-invitable", async () => {
  const app = await buildIntegrationServer();
  const actor = await signup(app, "removal-actor@example.com", "Organisation A");
  const member = await signup(app, "removal-member@example.com", "Organisation B");
  const orgA = actor.session.user.clientId;
  const orgB = member.session.user.clientId;
  await db.insert(clientMembers).values({ clientId: orgA, userId: member.session.user.id, clientRole: "member", createdById: actor.session.user.id });
  await db.update(users).set({ activeClientId: orgA }).where(eq(users.id, member.session.user.id));

  const [workspaceB] = await db.insert(workspaces).values({ clientId: orgB, name: "B workspace" }).returning();
  const [boardB] = await db.insert(boards).values({ workspaceId: workspaceB!.id, name: "B board", position: "1000.0000000000" }).returning();
  await db.insert(boardMembers).values({ boardId: boardB!.id, userId: member.session.user.id, role: "editor" });
  const beforeRefreshRows = await db.$count(refreshTokens, eq(refreshTokens.userId, member.session.user.id));
  assert.equal(await countActiveSeats(orgA), 2);
  assert.equal(await countActiveSeats(orgB), 1);

  const removed = await app.inject({
    method: "DELETE",
    url: `/clients/me/users/${member.session.user.id}`,
    headers: { authorization: `Bearer ${actor.session.accessToken}` },
  });
  assert.equal(removed.statusCode, 204, removed.body);
  const [identity] = await db.select({ email: users.email, activeClientId: users.activeClientId }).from(users)
    .where(eq(users.id, member.session.user.id)).limit(1);
  const [removedMembership] = await db.select({ removedAt: clientMembers.removedAt }).from(clientMembers).where(and(
    eq(clientMembers.clientId, orgA),
    eq(clientMembers.userId, member.session.user.id),
  )).limit(1);
  assert.ok(removedMembership?.removedAt);
  assert.equal(identity?.email, "removal-member@example.com");
  assert.equal(identity?.activeClientId, orgB);
  assert.equal(await db.$count(refreshTokens, and(eq(refreshTokens.userId, member.session.user.id), isNull(refreshTokens.revokedAt))), beforeRefreshRows);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, boardB!.id), eq(boardMembers.userId, member.session.user.id))), 1);
  assert.equal((await assertBoardAccess({ sub: member.session.user.id, cid: orgB, role: "owner" }, boardB!.id)).role, "editor");
  assert.equal(await countActiveSeats(orgA), 1);
  assert.equal(await countActiveSeats(orgB), 1);

  const refreshed = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `kanera_rt=${member.refresh}` },
    payload: {},
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const refreshedSession = refreshed.json<Session>();
  assert.equal(refreshedSession.user.clientId, orgB);

  const invite = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: { authorization: `Bearer ${actor.session.accessToken}` },
    payload: { orgRole: "member", workspaces: [] },
  });
  assert.equal(invite.statusCode, 201, invite.body);
  const reaccepted = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${refreshedSession.accessToken}` },
    payload: { token: invite.json<{ token: string }>().token },
  });
  assert.equal(reaccepted.statusCode, 200, reaccepted.body);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, orgA),
    eq(clientMembers.userId, member.session.user.id),
    isNull(clientMembers.suspendedAt),
    isNull(clientMembers.removedAt),
  )), 1);
});
