import "../test/setup.integration.js";
import { asyncLocalStorage, requestContext } from "@fastify/request-context";
import { activityEvents, boards, clients, supportSessions, users, workspaceApiKeys, workspaces } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../db.js";
import { recordActivity, recordCoalescedActivity, toActivityFeedEvent, type CoalescedActivityInput } from "./activity.js";
import "../test/integration.js";

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const [client] = await db.insert(clients).values({ name: "Acme" }).returning();
  const [actor] = await db
    .insert(users)
    .values({ clientId: client!.id, email: "owner@example.com", passwordHash: "x", displayName: "Owner" })
    .returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Delivery" }).returning();
  const [boardA, boardB, boardC] = await db
    .insert(boards)
    .values([
      { workspaceId: workspace!.id, name: "A", position: "1000.0000000000" },
      { workspaceId: workspace!.id, name: "B", position: "2000.0000000000" },
      { workspaceId: workspace!.id, name: "C", position: "3000.0000000000" },
    ])
    .returning();
  assert.ok(actor);
  assert.ok(workspace);
  assert.ok(boardA);
  assert.ok(boardB);
  assert.ok(boardC);
  return { actor, workspace, boardA, boardB, boardC };
}

function baseInput(f: Fixture, overrides: Partial<CoalescedActivityInput>): CoalescedActivityInput {
  return {
    boardId: f.boardA.id,
    workspaceId: f.workspace.id,
    actorId: f.actor.id,
    entityType: "card",
    entityId: randomUUID(),
    action: "updated",
    coalesceKey: "card:title",
    windowMs: 60_000,
    ...overrides,
  };
}

async function runWithApiKeyContext(apiKeyId: string, apiKeyName: string, callback: () => Promise<void>) {
  await asyncLocalStorage.run({} as Parameters<typeof asyncLocalStorage.run>[0], async () => {
    requestContext.set("authKind", "apiKey");
    requestContext.set("apiKeyId", apiKeyId);
    requestContext.set("apiKeyName", apiKeyName);
    await callback();
  });
}

async function runWithSupportContext(sessionId: string, operatorEmail: string, callback: () => Promise<void>) {
  await asyncLocalStorage.run({} as Parameters<typeof asyncLocalStorage.run>[0], async () => {
    requestContext.set("authKind", "support");
    requestContext.set("supportSessionId", sessionId);
    requestContext.set("supportActorEmail", operatorEmail);
    await callback();
  });
}

void test("card description activity coalesces repeated edits", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  await recordCoalescedActivity(db, baseInput(f, {
    entityId,
    action: "updated",
    coalesceKey: "card:description",
    windowMs: 120_000,
    fromValue: "Draft",
    toValue: "Draft 2",
    payload: { description: "Draft 2" },
  }));
  await recordCoalescedActivity(db, baseInput(f, {
    entityId,
    action: "updated",
    coalesceKey: "card:description",
    windowMs: 120_000,
    fromValue: "Draft 2",
    toValue: "Final",
    payload: { description: "Final" },
  }));

  const [activity] = await db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
  assert.ok(activity);
  assert.equal(activity.boardId, f.boardA.id);
  assert.equal(activity.feedVisible, true);
  assert.equal(activity.coalescedCount, 2);
  assert.deepEqual(activity.payload, { description: "Final", fromValue: "Draft", toValue: "Final" });
});

void test("custom field activity coalesces set and clear events", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  const fieldId = randomUUID();
  await recordCoalescedActivity(db, baseInput(f, {
    entityId,
    action: "customFieldValue:set",
    coalesceKey: `customField:${fieldId}`,
    fromValue: null,
    toValue: "High",
    payload: { fieldId, fieldName: "Priority", fieldType: "text", fromValue: null, toValue: "High" },
  }));
  await recordCoalescedActivity(db, baseInput(f, {
    entityId,
    action: "customFieldValue:set",
    coalesceKey: `customField:${fieldId}`,
    fromValue: "High",
    toValue: null,
    payload: { fieldId, fieldName: "Priority", fieldType: "text", fromValue: "High", toValue: null },
  }));

  const [activity] = await db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
  assert.ok(activity);
  assert.equal(activity.feedVisible, false);
  assert.equal(activity.coalescedCount, 2);
  assert.deepEqual(activity.payload, { fieldId, fieldName: "Priority", fieldType: "text", fromValue: null, toValue: null });
});

void test("list update activity coalesces workspace-level appearance tweaks", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  await recordCoalescedActivity(db, baseInput(f, {
    boardId: null,
    entityType: "list",
    entityId,
    action: "updated",
    coalesceKey: "list:update",
    windowMs: 120_000,
    fromValue: { name: "Todo", icon: null, color: null },
    toValue: { name: "Doing", icon: null, color: "blue" },
    payload: { name: "Doing", color: "blue" },
  }));
  await recordCoalescedActivity(db, baseInput(f, {
    boardId: null,
    entityType: "list",
    entityId,
    action: "updated",
    coalesceKey: "list:update",
    windowMs: 120_000,
    fromValue: { name: "Doing", icon: null, color: "blue" },
    toValue: { name: "Done", icon: "check", color: "green" },
    payload: { name: "Done", icon: "check", color: "green" },
  }));

  const [activity] = await db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
  assert.ok(activity);
  assert.equal(activity.boardId, null);
  assert.equal(activity.feedVisible, true);
  assert.equal(activity.coalescedCount, 2);
  assert.deepEqual(activity.payload, {
    name: "Done",
    color: "green",
    icon: "check",
    fromValue: { name: "Todo", icon: null, color: null },
    toValue: { name: "Done", icon: "check", color: "green" },
  });
});

void test("list position activity preserves the first position and latest final position", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  await recordCoalescedActivity(db, baseInput(f, {
    boardId: null,
    entityType: "list",
    entityId,
    action: "moved",
    coalesceKey: "list:position",
    fromValue: "1000.0000000000",
    toValue: "1500.0000000000",
    payload: { prevPosition: "1000.0000000000", position: "1500.0000000000" },
  }));
  await recordCoalescedActivity(db, baseInput(f, {
    boardId: null,
    entityType: "list",
    entityId,
    action: "moved",
    coalesceKey: "list:position",
    fromValue: "1500.0000000000",
    toValue: "3000.0000000000",
    payload: { prevPosition: "1500.0000000000", position: "3000.0000000000" },
  }));

  const [activity] = await db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
  assert.ok(activity);
  assert.equal(activity.feedVisible, true);
  assert.equal(activity.coalescedCount, 2);
  assert.deepEqual(activity.payload, {
    prevPosition: "1500.0000000000",
    position: "3000.0000000000",
    fromValue: "1000.0000000000",
    toValue: "3000.0000000000",
  });
});

void test("board-transfer activity coalesces rapid card moves without feed spam", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  const listId = randomUUID();

  for (const [fromBoardId, toBoardId] of [
    [f.boardA.id, f.boardB.id],
    [f.boardB.id, f.boardC.id],
    [f.boardC.id, f.boardA.id],
  ] as const) {
    await recordCoalescedActivity(db, baseInput(f, {
      boardId: toBoardId,
      entityId,
      action: "moved",
      coalesceKey: "card:board",
      coalesceAcrossBoards: true,
      preservePayloadKeys: ["fromBoardId", "fromListId", "prevPosition"],
      fromValue: { boardId: fromBoardId, listId },
      toValue: { boardId: toBoardId, listId },
      payload: {
        fromBoardId,
        toBoardId,
        fromListId: listId,
        toListId: listId,
        prevPosition: "1000.0000000000",
        position: "1000.0000000000",
      },
    }));
  }

  const rows = await db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
  assert.equal(rows.length, 1);
  const activity = rows[0]!;
  assert.equal(activity.feedVisible, false);
  assert.equal(activity.coalescedCount, 3);
  assert.equal(activity.boardId, f.boardA.id);
  assert.deepEqual(activity.payload, {
    fromBoardId: f.boardA.id,
    toBoardId: f.boardA.id,
    fromListId: listId,
    toListId: listId,
    prevPosition: "1000.0000000000",
    position: "1000.0000000000",
    fromValue: { boardId: f.boardA.id, listId },
    toValue: { boardId: f.boardA.id, listId },
  });
});

void test("recordActivity snapshots API key attribution from request context", async () => {
  const f = await seedFixture();
  const [apiKey] = await db
    .insert(workspaceApiKeys)
    .values({
      workspaceId: f.workspace.id,
      createdById: f.actor.id,
      name: "Zapier sync",
      keyPrefix: "kanera_live_test",
      keyHash: randomUUID(),
      scope: "write",
    })
    .returning();
  assert.ok(apiKey);

  await runWithApiKeyContext(apiKey.id, apiKey.name, async () => {
    const activity = await recordActivity(db, {
      boardId: f.boardA.id,
      workspaceId: f.workspace.id,
      actorId: f.actor.id,
      entityType: "card",
      entityId: randomUUID(),
      action: "created",
    });

    assert.equal(activity.actorKind, "apiKey");
    assert.equal(activity.apiKeyId, apiKey.id);
    assert.equal(activity.apiKeyName, "Zapier sync");
  });
});

void test("recordActivity attributes a support-session mutation to the operator, not the impersonated owner", async () => {
  const f = await seedFixture();
  const [session] = await db
    .insert(supportSessions)
    .values({
      adminEmail: "operator@kanera.dev",
      targetClientId: f.actor.clientId,
      targetOrgName: "Acme",
      targetUserId: f.actor.id,
      targetUserEmail: "owner@example.com",
      reason: "help set up",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    .returning();
  assert.ok(session);

  await runWithSupportContext(session.id, "operator@kanera.dev", async () => {
    // actorId is the acted-as owner (so entity references stay valid), but the record must identify
    // the operator/session so audit history does not falsely read as the owner's own action.
    const activity = await recordActivity(db, {
      boardId: f.boardA.id,
      workspaceId: f.workspace.id,
      actorId: f.actor.id,
      entityType: "card",
      entityId: randomUUID(),
      action: "created",
    });

    assert.equal(activity.actorKind, "support");
    assert.equal(activity.supportSessionId, session.id);
    assert.equal(activity.supportActorEmail, "operator@kanera.dev");

    // The feed surfaces the operator, never the impersonated owner.
    const feed = toActivityFeedEvent(activity, { displayName: "Owner", avatarUrl: null }, f.actor.clientId);
    assert.match(feed.actorName, /Kanera Support/);
    assert.match(feed.actorName, /operator@kanera\.dev/);
  });
});

void test("coalesced activity separates support-session edits from the owner's own edits", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  const [session] = await db
    .insert(supportSessions)
    .values({
      adminEmail: "operator@kanera.dev",
      targetClientId: f.actor.clientId,
      targetOrgName: "Acme",
      targetUserId: f.actor.id,
      targetUserEmail: "owner@example.com",
      reason: "help set up",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    .returning();
  assert.ok(session);

  // The owner's own edit.
  await recordCoalescedActivity(db, baseInput(f, {
    entityId,
    action: "updated",
    coalesceKey: "card:title",
    fromValue: "Draft",
    toValue: "Owner edit",
    payload: { title: "Owner edit" },
  }));

  // A support-session edit of the same entity in the same window must NOT merge into the owner's row.
  await runWithSupportContext(session.id, "operator@kanera.dev", async () => {
    await recordCoalescedActivity(db, baseInput(f, {
      entityId,
      action: "updated",
      coalesceKey: "card:title",
      fromValue: "Owner edit",
      toValue: "Support edit",
      payload: { title: "Support edit" },
    }));
  });

  const rows = await db
    .select()
    .from(activityEvents)
    .where(inArray(activityEvents.entityId, [entityId]))
    .orderBy(activityEvents.actorKind);

  assert.equal(rows.length, 2);
  assert.equal(rows.some((row) => row.actorKind === "user" && row.supportSessionId === null), true);
  assert.equal(rows.some((row) => row.actorKind === "support" && row.supportSessionId === session.id), true);
});

void test("coalesced activity separates user edits from API key edits by the same actor", async () => {
  const f = await seedFixture();
  const entityId = randomUUID();
  const [apiKey] = await db
    .insert(workspaceApiKeys)
    .values({
      workspaceId: f.workspace.id,
      createdById: f.actor.id,
      name: "Zapier sync",
      keyPrefix: "kanera_live_test",
      keyHash: randomUUID(),
      scope: "write",
    })
    .returning();
  assert.ok(apiKey);

  await recordCoalescedActivity(db, baseInput(f, {
    entityId,
    action: "updated",
    coalesceKey: "card:title",
    fromValue: "Draft",
    toValue: "User edit",
    payload: { title: "User edit" },
  }));

  await runWithApiKeyContext(apiKey.id, apiKey.name, async () => {
    await recordCoalescedActivity(db, baseInput(f, {
      entityId,
      action: "updated",
      coalesceKey: "card:title",
      fromValue: "User edit",
      toValue: "API edit",
      payload: { title: "API edit" },
    }));
  });

  const rows = await db
    .select()
    .from(activityEvents)
    .where(inArray(activityEvents.entityId, [entityId]))
    .orderBy(activityEvents.actorKind);

  assert.equal(rows.length, 2);
  assert.equal(rows.some((row) => row.actorKind === "user" && row.apiKeyId === null), true);
  assert.equal(rows.some((row) => row.actorKind === "apiKey" && row.apiKeyId === apiKey.id), true);
});
