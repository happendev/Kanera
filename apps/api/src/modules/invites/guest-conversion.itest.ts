import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { boardMembers, boards, clientGuestSeats, clientMembers, clients, eventOutbox, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { countActiveSeats } from "../../lib/billing.js";
import { buildIntegrationServer } from "../../test/integration.js";

type Session = { accessToken: string; user: { id: string; clientId: string } };

async function signup(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string, orgName: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Session>();
}

void test("accepting an org invite converts a paid guest without double-counting or changing board permissions", async () => {
  const app = await buildIntegrationServer();
  const host = await signup(app, "conversion-host@example.com", "Conversion Host");
  const guest = await signup(app, "conversion-guest@example.com", "Guest Personal");
  const invite = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: { authorization: `Bearer ${host.accessToken}` },
    payload: { orgRole: "member", workspaces: [] },
  });
  assert.equal(invite.statusCode, 201, invite.body);
  const token = invite.json<{ token: string }>().token;

  const [workspace] = await db.insert(workspaces).values({ clientId: host.user.clientId, name: "Host workspace" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Guest board", position: "1000.0000000000" }).returning();
  await db.insert(boardMembers).values({
    boardId: board!.id,
    userId: guest.user.id,
    role: "observer",
    assignedItemsOnly: true,
  });
  await db.insert(clientGuestSeats).values({ clientId: host.user.clientId, userId: guest.user.id, createdById: host.user.id });
  await db.update(clients).set({ plan: "paid", billingStatus: "active", seatLimit: 2 }).where(eq(clients.id, host.user.clientId));

  const beforeSeats = await countActiveSeats(host.user.clientId);
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const accepted = await app.inject({
      method: "POST",
      url: "/invites/accept",
      headers: { authorization: `Bearer ${guest.accessToken}` },
      payload: { token },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }

  assert.equal(beforeSeats, 2);
  assert.equal(await countActiveSeats(host.user.clientId), beforeSeats);
  assert.equal(await db.$count(clientGuestSeats, and(
    eq(clientGuestSeats.clientId, host.user.clientId),
    eq(clientGuestSeats.userId, guest.user.id),
  )), 0);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, host.user.clientId),
    eq(clientMembers.userId, guest.user.id),
    isNull(clientMembers.suspendedAt),
    isNull(clientMembers.removedAt),
  )), 1);
  const [preserved] = await db.select({ role: boardMembers.role, assignedItemsOnly: boardMembers.assignedItemsOnly })
    .from(boardMembers).where(and(eq(boardMembers.boardId, board!.id), eq(boardMembers.userId, guest.user.id))).limit(1);
  assert.deepEqual(preserved, { role: "observer", assignedItemsOnly: true });
  const [classificationEvent] = await db.select({ payload: eventOutbox.payload }).from(eventOutbox).where(and(
    eq(eventOutbox.boardId, board!.id),
    eq(eventOutbox.eventType, "board:member:updated"),
  )).limit(1);
  assert.equal((classificationEvent?.payload as { user?: { isOrganisationMember?: boolean } } | undefined)?.user?.isOrganisationMember, true);
});
