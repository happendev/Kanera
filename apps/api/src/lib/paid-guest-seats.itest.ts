import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { boardMembers, boards, clientGuestSeats, clients, workspaces } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";
import "../test/integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import { countActiveSeats } from "./billing.js";
import { ensureGuestBoardCapacity } from "./paid-guest-seats.js";

void test("guest status is absence of membership in the host org, independent of the user's home org", async () => {
  const [orgA, orgB] = await db.insert(clients).values([{ name: "Member Org" }, { name: "Guest Host Org" }]).returning();
  const [user] = await insertTestUsers(db, {
    clientId: orgA!.id,
    clientRole: "member",
    email: "member-a-guest-b@example.com",
    passwordHash: "hash",
    displayName: "A member, B guest",
  }).returning();
  const [host] = await insertTestUsers(db, {
    clientId: orgB!.id,
    clientRole: "owner",
    email: "guest-host@example.com",
    passwordHash: "hash",
    displayName: "Guest Host",
  }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: orgB!.id, name: "Host workspace" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Guest board", position: "1000.0000000000" }).returning();
  await db.insert(boardMembers).values({ boardId: board!.id, userId: user!.id, role: "observer" });

  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeBoards = env.HOSTED_FREE_MAX_GUEST_BOARDS;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_MAX_GUEST_BOARDS = 0;
  try {
    const capacity = await ensureGuestBoardCapacity({
      hostClientId: orgB!.id,
      boardId: board!.id,
      userId: user!.id,
      targetClientId: orgA!.id,
      createdById: host!.id,
    });
    assert.equal(capacity.paidGuestSeatCreated, true);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_MAX_GUEST_BOARDS = previousFreeBoards;
  }

  assert.equal(await db.$count(clientGuestSeats, and(
    eq(clientGuestSeats.clientId, orgB!.id),
    eq(clientGuestSeats.userId, user!.id),
  )), 1);
  assert.equal(await countActiveSeats(orgA!.id), 1);
  assert.equal(await countActiveSeats(orgB!.id), 2);
});
