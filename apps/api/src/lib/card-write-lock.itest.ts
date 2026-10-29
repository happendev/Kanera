import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { boards, cardChecklistItems, cardChecklists, cards, comments, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db, pool } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { signupOwner } from "../test/api-fixtures.js";

async function seedCard(name: string) {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: name, email: `${name}@example.com`, displayName: "Owner" });
  const response = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
  assert.equal(response.statusCode, 201);
  const workspaceId = response.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).limit(1);
  const [board] = await db.insert(boards).values({ workspaceId, name: "Board", position: "1000" }).returning();
  const [card] = await db.insert(cards).values({ boardId: board!.id, listId: list!.id, title: "Card", position: "1000", createdById: owner.user.id }).returning();
  return { app, owner, card: card! };
}

async function waitForBlockedQuery(blocker: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [blocker],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No query blocked by backend ${blocker}`);
}

// Pause after a child-row UPDATE has locked its row but before the revision trigger runs. The
// competing route must wait on the first writer's card lock, not take it and deadlock on the child.
// HTTP bursts alone cannot reliably force this interleaving; each file has its own test database.
async function pauseChildUpdate(table: "comment" | "card_checklist_item") {
  const gate: PoolClient = await pool.connect();
  await gate.query("SELECT pg_advisory_lock(88194723)");
  await pool.query(`CREATE FUNCTION test_pause_child_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(88194723); RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER test_pause_child_update BEFORE UPDATE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION test_pause_child_update()`);
  const { rows } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return {
    pid: rows[0]!.pid,
    release: () => gate.query("SELECT pg_advisory_unlock_all()"),
    dispose: async () => {
      await pool.query(`DROP TRIGGER test_pause_child_update ON ${table}`);
      await pool.query("DROP FUNCTION test_pause_child_update()");
      gate.release();
    },
  };
}

void test("single comment edit and bulk deletion use the same card-before-child lock order", async () => {
  const { app, owner, card } = await seedCard("comment-lock-order");
  const [comment] = await db.insert(comments).values({ cardId: card.id, authorId: owner.user.id, body: "Before" }).returning();
  const gate = await pauseChildUpdate("comment");
  const pending: Promise<unknown>[] = [];
  try {
    const editing = app.inject({ method: "PATCH", url: `/comments/${comment!.id}`, headers: owner.auth, payload: { body: "Edited" } }).then((response) => response);
    pending.push(editing);
    const editorPid = await waitForBlockedQuery(gate.pid);
    const deleting = app.inject({ method: "POST", url: `/boards/${card.boardId}/comments/bulk/delete`, headers: owner.auth, payload: { commentIds: [comment!.id] } }).then((response) => response);
    pending.push(deleting);
    await waitForBlockedQuery(editorPid);
    await gate.release();
    const [edited, deleted] = await Promise.all([editing, deleting]);
    // The delete can commit before the edit's response lookup; a missing comment is valid then.
    assert.ok([200, 404].includes(edited.statusCode), edited.body);
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(await db.$count(comments, eq(comments.id, comment!.id)), 0);
  } finally {
    await gate.release();
    await Promise.allSettled(pending);
    await gate.dispose();
    await app.close();
  }
});

void test("single checklist edit and bulk description update use the same card-before-child lock order", async () => {
  const { app, owner, card } = await seedCard("checklist-lock-order");
  const [checklist] = await db.insert(cardChecklists).values({ cardId: card.id, title: "Steps", position: "1000" }).returning();
  const [item] = await db.insert(cardChecklistItems).values({ checklistId: checklist!.id, text: "Before", position: "1000" }).returning();
  const gate = await pauseChildUpdate("card_checklist_item");
  const pending: Promise<unknown>[] = [];
  try {
    const editing = app.inject({ method: "PATCH", url: `/cards/${card.id}/checklist-items/${item!.id}`, headers: owner.auth, payload: { text: "Edited" } }).then((response) => response);
    pending.push(editing);
    const editorPid = await waitForBlockedQuery(gate.pid);
    const bulk = app.inject({ method: "PATCH", url: `/boards/${card.boardId}/checklist-items/bulk/descriptions`, headers: owner.auth,
      payload: { updates: [{ cardId: card.id, checklistId: checklist!.id, itemId: item!.id, description: "Bulk description" }] },
    }).then((response) => response);
    pending.push(bulk);
    await waitForBlockedQuery(editorPid);
    await gate.release();
    const results = await Promise.all([editing, bulk]);
    for (const response of results) assert.equal(response.statusCode, 200, response.body);
    const [saved] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.id, item!.id));
    assert.equal(saved!.text, "Edited");
    assert.equal(saved!.description, "Bulk description");
  } finally {
    await gate.release();
    await Promise.allSettled(pending);
    await gate.dispose();
    await app.close();
  }
});
