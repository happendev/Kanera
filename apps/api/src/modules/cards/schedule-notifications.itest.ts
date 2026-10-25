import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityEvents, boardMembers, boards, cardAssignees, cardWatchers, lists, notifications, workspaceMembers } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { runScheduleRecheckSweep } from "../../lib/automations.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

/*
 * The conflict notification rides the schedule recheck worker's latch, which E2E cannot drive
 * deterministically (the worker sweeps on its own clock). Failure modes asserted here:
 *  1. A conflict is announced on every edit that keeps it open, not once per conflict.
 *  2. The person whose own date edit made the conflict is told about it.
 *  3. The blocked card's assignees, or its watchers, are not told; or the feed row is missing.
 *  4. A conflict that clears and comes back is not announced again.
 */
void test("a new scheduling conflict tells the blocked card's people once, never its author", async () => {
  const app = await buildIntegrationServer();
  try {
    const owner = await signupOwner(app, { seed: "schedule-conflict-notify" });
    const workspace = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Conflict notices" } });
    assert.equal(workspace.statusCode, 201, workspace.body);
    const workspaceId = workspace.json<{ id: string }>().id;
    const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).limit(1);
    const [board] = await db.insert(boards).values({ workspaceId, name: "Plan", position: "1000" }).returning();
    const [member] = await insertTestUsers(db, { clientId: owner.user.clientId, email: "schedule-conflict-member@example.com", passwordHash: "x", displayName: "Member" }).returning();
    await db.insert(workspaceMembers).values({ workspaceId, userId: member!.id, role: "member" });
    await db.insert(boardMembers).values({ boardId: board!.id, userId: member!.id, role: "editor" });
    const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member!.id, cid: owner.user.clientId, role: "member" })}` };

    const create = async (title: string, start: string, due: string) => {
      const response = await app.inject({ method: "POST", url: `/boards/${board!.id}/lists/${list!.id}/cards`, headers: owner.auth, payload: { title, startDateLocalDate: start, dueDateLocalDate: due } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ id: string; key: string }>();
    };
    const blocker = await create("Blocker", "2030-06-03", "2030-06-05");
    const waiting = await create("Waiting", "2030-06-10", "2030-06-12");
    const link = await app.inject({ method: "POST", url: `/cards/${blocker.id}/relations`, headers: owner.auth, payload: { targetCardId: waiting.id, direction: "blocks" } });
    assert.equal(link.statusCode, 201, link.body);
    await db.insert(cardAssignees).values({ cardId: waiting.id, userId: member!.id });
    await db.insert(cardWatchers).values({ cardId: waiting.id, userId: owner.user.id }).onConflictDoNothing(); // creators already watch
    await runScheduleRecheckSweep(); // first evaluation seeds the latch silently

    const patch = async (id: string, payload: object, headers = owner.auth) => {
      const response = await app.inject({ method: "PATCH", url: `/cards/${id}`, headers, payload });
      assert.equal(response.statusCode, 200, response.body);
      await runScheduleRecheckSweep();
    };
    const conflictRows = () => db.select().from(activityEvents).where(and(eq(activityEvents.entityId, waiting.id), eq(activityEvents.action, "schedule:conflict")));
    const inbox = async (userId: string) => (await db.select().from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.cardId, waiting.id), eq(notifications.reason, "dependency")))).length;

    // 2/3. The owner pushes the blocker past the waiting card's start: the assignee hears, the owner
    // (who made it, and watches the card) does not.
    await patch(blocker.id, { dueDateLocalDate: "2030-06-11" });
    const [first] = await conflictRows();
    assert.equal(first?.actorKind, "system");
    assert.equal((first?.payload as { otherCardKey?: string }).otherCardKey, blocker.key);
    assert.equal(await inbox(member!.id), 1);
    assert.equal(await inbox(owner.user.id), 0);

    // 1. Still in conflict after another edit: nothing new.
    await patch(blocker.id, { dueDateLocalDate: "2030-06-12" });
    assert.equal((await conflictRows()).length, 1);
    assert.equal(await inbox(member!.id), 1);

    // 4. It clears, then the assignee moves their own start into the blocker: announced again, this
    // time to the watching owner and not to the assignee who did it.
    await patch(blocker.id, { dueDateLocalDate: "2030-06-06" });
    await patch(waiting.id, { startDateLocalDate: "2030-06-05" }, memberAuth);
    assert.equal((await conflictRows()).length, 2);
    assert.equal(await inbox(owner.user.id), 1);
    assert.equal(await inbox(member!.id), 1);
  } finally {
    await app.close();
  }
});
