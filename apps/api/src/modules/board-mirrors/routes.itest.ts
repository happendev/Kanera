import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardMirrors, boards, cards, eventOutbox, externalLinks, lists } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

async function setup() {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Mirror Org", email: "mirror-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();
  const workspaceResponse = await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${accessToken}` }, payload: { name: "Delivery" } });
  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json<{ id: string }>();
  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).orderBy(lists.position);
  assert.ok(workspaceLists.length >= 2);
  const createdBoards = await db.insert(boards).values([
    { workspaceId: workspace.id, name: "Source", position: "1000.0000000000" },
    { workspaceId: workspace.id, name: "Target", position: "2000.0000000000" },
    { workspaceId: workspace.id, name: "Third", position: "3000.0000000000" },
  ]).returning();
  return { app, accessToken, user, workspace, source: createdBoards[0]!, target: createdBoards[1]!, third: createdBoards[2]!, sourceList: workspaceLists[0]!, otherList: workspaceLists[1]! };
}

void test("board mirror routes enforce pair/chain invariants and independent governance switches", async () => {
  const fixture = await setup();
  const auth = { authorization: `Bearer ${fixture.accessToken}` };
  const created = await fixture.app.inject({
    method: "POST",
    url: `/boards/${fixture.source.id}/mirrors`,
    headers: auth,
    payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const mirror = created.json<{ id: string; lists: Array<{ sourceListId: string; targetListId: string }> }>();
  assert.deepEqual(mirror.lists, [{ sourceListId: fixture.sourceList.id, sourceListName: fixture.sourceList.name, targetListId: fixture.sourceList.id, targetListName: fixture.sourceList.name, targetListArchived: false }]);
  const createdEvents = (await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.eventType, "boardMirror:created"),
    inArray(eventOutbox.scopeId, [fixture.source.id, fixture.target.id]),
  ))).filter((event) => (event.payload as { mirror?: { id?: string } }).mirror?.id === mirror.id);
  assert.deepEqual(new Set(createdEvents.map((event) => event.scopeId)), new Set([fixture.source.id, fixture.target.id]));

  const duplicate = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(duplicate.statusCode, 409);
  const sourceAlreadyTarget = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.target.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.third.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(sourceAlreadyTarget.statusCode, 409);
  const reverse = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.target.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.source.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(reverse.statusCode, 409);
  const targetAlreadySource = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.third.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.source.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(targetAlreadySource.statusCode, 409);

  const mirrorTargetOptions = await fixture.app.inject({ method: "GET", url: `/mirror-target-boards?sourceBoardId=${fixture.target.id}`, headers: auth });
  assert.equal(mirrorTargetOptions.statusCode, 200, mirrorTargetOptions.body);
  assert.deepEqual(mirrorTargetOptions.json(), { targets: [], sourceBlockedByIncomingMirror: true }, "a mirror target cannot also be offered as a source");
  const sourceTargets = await fixture.app.inject({ method: "GET", url: `/mirror-target-boards?sourceBoardId=${fixture.source.id}`, headers: auth });
  assert.equal(sourceTargets.statusCode, 200, sourceTargets.body);
  const sourceTargetBody = sourceTargets.json<{ targets: Array<{ id: string }>; sourceBlockedByIncomingMirror: boolean }>();
  assert.equal(sourceTargetBody.sourceBlockedByIncomingMirror, false);
  assert.deepEqual(sourceTargetBody.targets.map((board) => board.id), [fixture.third.id], "the existing target is not offered twice");
  const sourceStatus = await fixture.app.inject({ method: "GET", url: `/boards/${fixture.source.id}/mirror-status`, headers: auth });
  const targetStatus = await fixture.app.inject({ method: "GET", url: `/boards/${fixture.target.id}/mirror-status`, headers: auth });
  assert.deepEqual(sourceStatus.json(), { count: 1, inboundCount: 0, outboundCount: 1 });
  assert.deepEqual(targetStatus.json(), { count: 1, inboundCount: 1, outboundCount: 0 });
  const [openedSource, openedTarget, openedUnlinked] = await Promise.all([
    fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/open`, headers: auth }),
    fixture.app.inject({ method: "POST", url: `/boards/${fixture.target.id}/open`, headers: auth }),
    fixture.app.inject({ method: "POST", url: `/boards/${fixture.third.id}/open`, headers: auth }),
  ]);
  assert.equal(openedSource.json<{ hasMirrors: boolean }>().hasMirrors, true);
  assert.equal(openedTarget.json<{ hasMirrors: boolean }>().hasMirrors, true);
  assert.equal(openedUnlinked.json<{ hasMirrors: boolean }>().hasMirrors, false);

  const inbound = await fixture.app.inject({ method: "GET", url: `/boards/${fixture.target.id}/mirrors`, headers: auth });
  assert.equal(inbound.statusCode, 200);
  assert.deepEqual(inbound.json<Array<{ id: string }>>().map((row) => row.id), [mirror.id]);
  const outbound = await fixture.app.inject({ method: "GET", url: `/boards/${fixture.source.id}/outbound-mirrors`, headers: auth });
  assert.equal(outbound.statusCode, 200);
  const outboundRows = outbound.json<Array<{ id: string; lists: Array<{ sourceListId: string }> }>>();
  assert.deepEqual(outboundRows.map((row) => row.id), [mirror.id]);
  assert.deepEqual(outboundRows[0]?.lists.map((list) => list.sourceListId), [fixture.sourceList.id]);

  const sourceUpdated = await fixture.app.inject({
    method: "PATCH",
    url: `/boards/${fixture.source.id}/mirrors/${mirror.id}`,
    headers: auth,
    payload: { lists: [{ sourceListId: fixture.otherList.id }] },
  });
  assert.equal(sourceUpdated.statusCode, 200, sourceUpdated.body);
  assert.deepEqual(sourceUpdated.json<{ lists: Array<{ sourceListId: string }> }>().lists.map((list) => list.sourceListId), [fixture.otherList.id]);
  const updatedEvents = (await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.eventType, "boardMirror:updated"),
    inArray(eventOutbox.scopeId, [fixture.source.id, fixture.target.id]),
  ))).filter((event) => (event.payload as { mirror?: { id?: string } }).mirror?.id === mirror.id);
  assert.deepEqual(new Set(updatedEvents.map((event) => event.scopeId)), new Set([fixture.source.id, fixture.target.id]));
  const sourcePause = await fixture.app.inject({ method: "PATCH", url: `/boards/${fixture.source.id}/mirrors/${mirror.id}`, headers: auth, payload: { paused: true } });
  assert.equal(sourcePause.statusCode, 400, "source list management must not grant target-owned pause control");

  const paused = await fixture.app.inject({ method: "PATCH", url: `/boards/${fixture.target.id}/mirrors/${mirror.id}`, headers: auth, payload: { paused: true } });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.ok(paused.json<{ pausedAt: string | null }>().pausedAt);
  const reverseWhilePaused = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.target.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.source.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(reverseWhilePaused.statusCode, 409, "pausing must not allow the board direction to reverse");
  const disabled = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors/${mirror.id}/source-disable`, headers: auth });
  assert.equal(disabled.statusCode, 200);
  const reverseWhileDisabled = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.target.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.source.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(reverseWhileDisabled.statusCode, 409, "source disabling must not allow the board direction to reverse");
  const resumed = await fixture.app.inject({ method: "PATCH", url: `/boards/${fixture.target.id}/mirrors/${mirror.id}`, headers: auth, payload: { paused: false } });
  assert.equal(resumed.statusCode, 200);
  assert.ok(resumed.json<{ sourceDisabledAt: string | null }>().sourceDisabledAt, "target resume must not clear source governance");
  const enabled = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors/${mirror.id}/source-enable`, headers: auth });
  assert.equal(enabled.statusCode, 200);
  const [row] = await db.select().from(boardMirrors).where(eq(boardMirrors.id, mirror.id));
  assert.equal(row?.pausedAt, null);
  assert.equal(row?.sourceDisabledAt, null);
  assert.ok(row?.reconcileRequestedAt);
});

void test("reciprocal mirror creation is serialized by board topology locks", async () => {
  const fixture = await setup();
  const auth = { authorization: `Bearer ${fixture.accessToken}` };
  const [forward, reverse] = await Promise.all([
    fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } }),
    fixture.app.inject({ method: "POST", url: `/boards/${fixture.target.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.source.id, lists: [{ sourceListId: fixture.sourceList.id }] } }),
  ]);
  assert.deepEqual([forward.statusCode, reverse.statusCode].sort(), [201, 409]);
  assert.equal((await db.select().from(boardMirrors)).length, 1);
});

void test("card relationship status hides retained links whose counterpart was purged", async () => {
  const fixture = await setup();
  const auth = { authorization: `Bearer ${fixture.accessToken}` };
  const created = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  const mirror = created.json<{ id: string }>();
  const [sourceCard, targetCard] = await db.insert(cards).values([
    { listId: fixture.sourceList.id, boardId: fixture.source.id, title: "Source", position: "1000.0000000000", createdById: fixture.user.id },
    { listId: fixture.sourceList.id, boardId: fixture.target.id, title: "Copy", position: "1000.0000000000", createdById: fixture.user.id },
  ]).returning();
  await db.insert(externalLinks).values({ workspaceId: fixture.workspace.id, provider: `mirror:${mirror.id}`, externalType: "card", externalId: sourceCard!.id, entityType: "card", entityId: targetCard!.id });

  const live = await fixture.app.inject({ method: "GET", url: `/cards/${sourceCard!.id}/mirrors`, headers: auth });
  assert.equal(live.statusCode, 200, live.body);
  assert.deepEqual(live.json<{ asSource: Array<{ cardId: string }> }>().asSource.map((row) => row.cardId), [targetCard!.id]);

  await db.delete(cards).where(eq(cards.id, targetCard!.id));
  assert.equal((await db.select().from(externalLinks).where(eq(externalLinks.externalId, sourceCard!.id))).length, 1, "the recreation tombstone remains durable");
  const purged = await fixture.app.inject({ method: "GET", url: `/cards/${sourceCard!.id}/mirrors`, headers: auth });
  assert.deepEqual(purged.json(), { asSource: [], asTarget: [] });
});

void test("deleting a mirror removes worker links but leaves target copies", async () => {
  const fixture = await setup();
  const auth = { authorization: `Bearer ${fixture.accessToken}` };
  const created = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(created.statusCode, 201);
  const mirror = created.json<{ id: string }>();
  const [sourceCard, targetCard] = await db.insert(cards).values([
    { listId: fixture.sourceList.id, boardId: fixture.source.id, title: "Source", position: "1000.0000000000", createdById: fixture.user.id },
    { listId: fixture.sourceList.id, boardId: fixture.target.id, title: "Copy", position: "1000.0000000000", createdById: fixture.user.id },
  ]).returning();
  await db.insert(externalLinks).values({ workspaceId: fixture.workspace.id, provider: `mirror:${mirror.id}`, externalType: "card", externalId: sourceCard!.id, entityType: "card", entityId: targetCard!.id });
  const deleted = await fixture.app.inject({ method: "DELETE", url: `/boards/${fixture.source.id}/mirrors/${mirror.id}`, headers: auth });
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal((await db.select().from(cards).where(eq(cards.id, targetCard!.id))).length, 1);
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.workspaceId, fixture.workspace.id), eq(externalLinks.provider, `mirror:${mirror.id}`)))).length, 0);
  const deletedEvents = (await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.eventType, "boardMirror:deleted"),
    inArray(eventOutbox.scopeId, [fixture.source.id, fixture.target.id]),
  ))).filter((event) => (event.payload as { mirrorId?: string }).mirrorId === mirror.id);
  assert.deepEqual(new Set(deletedEvents.map((event) => event.scopeId)), new Set([fixture.source.id, fixture.target.id]));
});

void test("disabling workspace board linking deletes its mirrors and blocks new linking", async () => {
  const fixture = await setup();
  const auth = { authorization: `Bearer ${fixture.accessToken}` };
  const created = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(created.statusCode, 201, created.body);
  const mirror = created.json<{ id: string }>();
  const [sourceCard, targetCard] = await db.insert(cards).values([
    { listId: fixture.sourceList.id, boardId: fixture.source.id, title: "Source", position: "1000.0000000000", createdById: fixture.user.id },
    { listId: fixture.sourceList.id, boardId: fixture.target.id, title: "Copy", position: "1000.0000000000", createdById: fixture.user.id },
  ]).returning();
  await db.insert(externalLinks).values({ workspaceId: fixture.workspace.id, provider: `mirror:${mirror.id}`, externalType: "card", externalId: sourceCard!.id, entityType: "card", entityId: targetCard!.id });

  const status = await fixture.app.inject({ method: "GET", url: `/workspaces/${fixture.workspace.id}/mirror-status`, headers: auth });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json(), { count: 1 });

  const disabled = await fixture.app.inject({ method: "PATCH", url: `/workspaces/${fixture.workspace.id}`, headers: auth, payload: { boardLinkingEnabled: false } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json<{ boardLinkingEnabled: boolean }>().boardLinkingEnabled, false);
  assert.equal((await db.select().from(boardMirrors).where(eq(boardMirrors.id, mirror.id))).length, 0);
  assert.equal((await db.select().from(externalLinks).where(eq(externalLinks.provider, `mirror:${mirror.id}`))).length, 0);
  assert.equal((await db.select().from(cards).where(eq(cards.id, targetCard!.id))).length, 1, "disabling leaves target copies in place");
  const deletedEvents = (await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.eventType, "boardMirror:deleted"),
    inArray(eventOutbox.scopeId, [fixture.source.id, fixture.target.id]),
  ))).filter((event) => (event.payload as { mirrorId?: string }).mirrorId === mirror.id);
  assert.deepEqual(new Set(deletedEvents.map((event) => event.scopeId)), new Set([fixture.source.id, fixture.target.id]));

  const targets = await fixture.app.inject({ method: "GET", url: `/mirror-target-boards?sourceBoardId=${fixture.source.id}`, headers: auth });
  assert.equal(targets.statusCode, 200, targets.body);
  assert.deepEqual(targets.json(), { targets: [], sourceBlockedByIncomingMirror: false });
  const recreated = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(recreated.statusCode, 400, recreated.body);

  const opened = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/open`, headers: auth });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json<{ boardLinkingEnabled: boolean }>().boardLinkingEnabled, false);
});

void test("deleting a participating board emits mirror removal to the surviving board", async () => {
  const fixture = await setup();
  const auth = { authorization: `Bearer ${fixture.accessToken}` };
  const created = await fixture.app.inject({ method: "POST", url: `/boards/${fixture.source.id}/mirrors`, headers: auth, payload: { targetBoardId: fixture.target.id, lists: [{ sourceListId: fixture.sourceList.id }] } });
  assert.equal(created.statusCode, 201, created.body);
  const mirror = created.json<{ id: string }>();

  const deleted = await fixture.app.inject({ method: "DELETE", url: `/boards/${fixture.source.id}`, headers: auth });
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal((await db.select().from(boardMirrors).where(eq(boardMirrors.id, mirror.id))).length, 0);
  const survivingEvents = (await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.eventType, "boardMirror:deleted"),
    eq(eventOutbox.scopeId, fixture.target.id),
  ))).filter((event) => (event.payload as { mirrorId?: string }).mirrorId === mirror.id);
  assert.equal(survivingEvents.length, 1);

  const targetStatus = await fixture.app.inject({ method: "GET", url: `/boards/${fixture.target.id}/mirror-status`, headers: auth });
  assert.deepEqual(targetStatus.json(), { count: 0, inboundCount: 0, outboundCount: 0 });
});
