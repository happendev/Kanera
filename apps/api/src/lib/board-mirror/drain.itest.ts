import "../../test/integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { boardMirrorDirtyCards, boardMirrorLists, boardMirrors, boards, cards, clients, eventOutbox, externalLinks, lists, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { processBoardMirrors } from "./drain.js";

// Browser coverage in performance-async.spec.ts drives real worker/realtime pause+resume. These
// DB checks cover retention gaps requiring weeks of history, retry-only dirty work, and suppressed
// idle writes, which a normal browser flow cannot reliably observe. Concrete failures include
// checkpointing before gap recovery, starving dirty retries without new events, writing every
// quiet poll, never persisting a heartbeat, and advancing paused or plan-blocked mirrors.
async function fixture() {
  const [client] = await db.insert(clients).values({ name: "Mirror drain test" }).returning();
  const [owner] = await insertTestUsers(db, { clientId: client!.id, email: `mirror-drain-${randomUUID()}@example.test`, displayName: "Mirror owner", passwordHash: "unused" }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Mirror drain" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: owner!.id, role: "admin" });
  const [source, target] = await db.insert(boards).values([
    { workspaceId: workspace!.id, name: "Source", position: "1000" },
    { workspaceId: workspace!.id, name: "Target", position: "2000" },
  ]).returning();
  const [list] = await db.insert(lists).values({ workspaceId: workspace!.id, name: "Queue", position: "1000" }).returning();
  const now = new Date();
  const [mirror] = await db.insert(boardMirrors).values({
    sourceBoardId: source!.id, targetBoardId: target!.id,
    sourceWorkspaceId: workspace!.id, targetWorkspaceId: workspace!.id, createdById: owner!.id,
    cursorEventCreatedAt: now, cursorEventId: "00000000-0000-0000-0000-000000000000", lastSyncAt: now,
  }).returning();
  await db.insert(boardMirrorLists).values({ mirrorId: mirror!.id, sourceListId: list!.id, targetListId: list!.id });
  const card = async (createdAt = new Date()) => (await db.insert(cards).values({
    boardId: source!.id, listId: list!.id, title: "Recover this card", position: "1000", createdById: owner!.id, createdAt, updatedAt: createdAt,
  }).returning())[0]!;
  const readMirror = async () => (await db.select().from(boardMirrors).where(eq(boardMirrors.id, mirror!.id)))[0]!;
  return { client: client!, target: target!, mirror: mirror!, card, readMirror };
}

void test("quiet mirrors skip writes but periodically persist an idle checkpoint", async () => {
  const f = await fixture();
  await processBoardMirrors();
  let stored = await f.readMirror();
  assert.equal(stored.updatedAt.getTime(), f.mirror.updatedAt.getTime());
  assert.equal(stored.lastSyncAt!.getTime(), f.mirror.lastSyncAt!.getTime());
  const old = new Date(Date.now() - 120_000);
  await db.update(boardMirrors).set({ lastSyncAt: old }).where(eq(boardMirrors.id, f.mirror.id));
  await processBoardMirrors();
  stored = await f.readMirror();
  assert.ok(stored.lastSyncAt! > old, "an idle worker observation remains durable for outage detection");
  const checkpoint = stored.updatedAt.getTime();
  await processBoardMirrors();
  assert.equal((await f.readMirror()).updatedAt.getTime(), checkpoint, "the next empty poll must not rewrite the mirror");
});

void test("an empty tail never checkpoints past a retention gap before recovering missed cards", async () => {
  const f = await fixture();
  const day = 86_400_000;
  const beforeGap = new Date(Date.now() - (env.REALTIME_OUTBOX_RETENTION_DAYS + 2) * day);
  await db.update(boardMirrors).set({ createdAt: beforeGap, cursorEventCreatedAt: beforeGap, lastSyncAt: beforeGap }).where(eq(boardMirrors.id, f.mirror.id));
  const sourceCard = await f.card(new Date(Date.now() - day));
  assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.boardId, f.mirror.sourceBoardId))).length, 0, "the missed source event has already been purged");
  const result = await processBoardMirrors();
  // Reconciliation emits its own link notification to the source before this pass tails again.
  // That newly created event is evidence of successful recovery, not the missing historical event.
  const sourceEvents = await db.select().from(eventOutbox).where(eq(eventOutbox.boardId, f.mirror.sourceBoardId));
  assert.deepEqual(sourceEvents.map((event) => event.eventType), [SERVER_EVENTS.CARD_MIRROR_LINKED]);
  assert.equal(result.tailedEvents, sourceEvents.length);
  const [link] = await db.select().from(externalLinks).where(eq(externalLinks.externalId, sourceCard.id));
  assert.ok(link, "gap reconciliation must happen before the heartbeat can hide the gap");
  const [targetCard] = await db.select().from(cards).where(eq(cards.id, link.entityId));
  assert.equal(targetCard?.boardId, f.target.id);
  assert.equal(targetCard?.title, sourceCard.title);
  assert.ok((await f.readMirror()).lastSyncAt! > beforeGap);
});

void test("dirty-card retries and prior mirror errors recover without new outbox rows", async () => {
  const f = await fixture();
  const sourceCard = await f.card();
  await db.insert(boardMirrorDirtyCards).values({ mirrorId: f.mirror.id, sourceCardId: sourceCard.id, facets: ["link"], attempts: 1, nextRetryAt: new Date(Date.now() - 1_000), lastError: "temporary failure" });
  await db.update(boardMirrors).set({ consecutiveFailures: 1, nextRetryAt: new Date(Date.now() - 1_000), lastError: "temporary tail failure" }).where(eq(boardMirrors.id, f.mirror.id));
  const result = await processBoardMirrors();
  assert.equal(result.tailedEvents, 0);
  assert.equal(result.appliedCards, 1);
  assert.equal((await db.select().from(boardMirrorDirtyCards)).length, 0);
  const stored = await f.readMirror();
  assert.equal(stored.lastError, null);
  assert.equal(stored.consecutiveFailures, 0);
});

void test("idle checkpointing does not advance paused or plan-blocked mirrors", async () => {
  const f = await fixture();
  const old = new Date(Date.now() - 120_000);
  await db.update(boardMirrors).set({ lastSyncAt: old, pausedAt: new Date() }).where(eq(boardMirrors.id, f.mirror.id));
  await processBoardMirrors();
  assert.equal((await f.readMirror()).lastSyncAt!.getTime(), old.getTime());
  await db.update(boardMirrors).set({ pausedAt: null }).where(eq(boardMirrors.id, f.mirror.id));
  const mode = env.KANERA_DEPLOYMENT_MODE;
  try {
    env.KANERA_DEPLOYMENT_MODE = "hosted";
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, f.client.id));
    await processBoardMirrors();
    assert.equal((await f.readMirror()).lastSyncAt!.getTime(), old.getTime());
  } finally {
    env.KANERA_DEPLOYMENT_MODE = mode;
  }
});
