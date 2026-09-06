import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import { activityEvents, boards, eventOutbox } from "@kanera/shared/schema";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

void test("standalone ordering persists across hidden workspaces and rejects foreign anchors", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { seed: "nav-order" });
  const ids: string[] = [];
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    const response = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth,
      payload: { kind: "board", name, initialBoard: { name }, lists: [{ name: "Todo" }, { name: "Done" }] } });
    assert.equal(response.statusCode, 201, response.body);
    ids.push(response.json<{ initialBoard: { id: string } }>().initialBoard.id);
  }
  const [alpha, beta, gamma] = ids;
  assert.ok(alpha && beta && gamma);
  // Older boards share an identical initial position, which must not make anchor moves ambiguous.
  await db.update(boards).set({ position: "1000" }).where(inArray(boards.id, ids));
  const move = async (id: string, body: object) => app.inject({ method: "POST", url: `/boards/${id}/move`, headers: owner.auth, payload: body });
  const order = async () => (await db.select({ id: boards.id }).from(boards).where(inArray(boards.id, ids)).orderBy(asc(boards.position))).map((row) => row.id);
  const moved = await move(gamma, { beforeBoardId: beta });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(await order(), [alpha, gamma, beta]);
  assert.equal((await move(alpha, { afterBoardId: beta })).statusCode, 200);
  assert.deepEqual(await order(), [gamma, beta, alpha]);
  const createStandard = async (auth: typeof owner.auth) => {
    const response = await app.inject({ method: "POST", url: "/workspaces", headers: auth,
      payload: { name: "Standard", initialBoard: { name: "Standard board" } } });
    assert.equal(response.statusCode, 201, response.body);
    return { boardId: response.json<{ initialBoard: { id: string } }>().initialBoard.id };
  };
  const standard = await createStandard(owner.auth);
  assert.equal((await move(alpha, { afterBoardId: standard.boardId })).statusCode, 400);
  const foreign = await signupOwner(app, { seed: "nav-order-foreign" });
  const other = await createStandard(foreign.auth);
  assert.equal((await move(alpha, { beforeBoardId: other.boardId })).statusCode, 400);
  const forbidden = await app.inject({ method: "POST", url: `/boards/${alpha}/move`, headers: foreign.auth, payload: { beforeBoardId: beta } });
  assert.ok([403, 404].includes(forbidden.statusCode));
  const [member] = await insertTestUsers(db, { clientId: owner.user.clientId, email: "nav-member@example.com",
    passwordHash: "hash", displayName: "Member", clientRole: "member" }).returning();
  assert.ok(member);
  const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" })}` };
  const denied = await app.inject({ method: "POST", url: `/boards/${alpha}/move`, headers: memberAuth, payload: { beforeBoardId: beta } });
  assert.equal(denied.statusCode, 403);
  const activity = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, gamma), eq(activityEvents.action, "moved")));
  assert.equal(activity.length, 1);
  const outbox = await db.select().from(eventOutbox);
  assert.ok(outbox.some((row) => JSON.stringify(row).includes('board:moved') && JSON.stringify(row).includes(gamma)));
  await app.close();
});
