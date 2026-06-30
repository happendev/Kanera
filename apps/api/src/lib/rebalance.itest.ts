import "../test/setup.integration.js";
import {
  automations,
  boardGroups,
  boards,
  cardLabels,
  cards,
  checklistTemplates,
  clients,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaces,
} from "@kanera/shared/schema";
import * as schema from "@kanera/shared/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db, pool } from "../db.js";
import "../test/integration.js";
import { positionAtIndex } from "./position.js";
import {
  type RebalancedPosition,
  rebalanceAutomations,
  rebalanceBoardGroups,
  rebalanceBoards,
  rebalanceCardLabels,
  rebalanceCards,
  rebalanceChecklistTemplates,
  rebalanceCustomFieldOptions,
  rebalanceCustomFields,
  rebalanceLists,
} from "./rebalance.js";

// numeric(20,10) round-trips with ten fractional digits; seed/expect in that exact form so string
// comparisons against stored positions are unambiguous.
const dec = (value: number): string => value.toFixed(10);

interface Ctx {
  clientId: string;
  workspaceId: string;
  userId: string;
  boardId: string;
  listId: string;
  fieldId: string;
}

// Seed only the org scaffolding. Per-helper scaffolding (board/list for cards, field for options) is
// created inside each case's seed so workspace-scoped rebalancers see exactly the rows they insert.
async function seedCtx(): Promise<Ctx> {
  const ctx: Ctx = {
    clientId: randomUUID(),
    workspaceId: randomUUID(),
    userId: randomUUID(),
    boardId: randomUUID(),
    listId: randomUUID(),
    fieldId: randomUUID(),
  };
  await db.insert(clients).values({ id: ctx.clientId, name: "Acme" });
  await db.insert(workspaces).values({ id: ctx.workspaceId, clientId: ctx.clientId, name: "Delivery" });
  await db.insert(users).values({
    id: ctx.userId,
    clientId: ctx.clientId,
    email: `${ctx.userId}@example.com`,
    passwordHash: "hash",
    displayName: "Member",
  });
  return ctx;
}

// Each rebalanced table funnels through the same batched `case id when ... end` UPDATE, but each
// helper has its own select/scope. A case seeds rows at the given positions (ascending = intended
// final order), runs the helper, and reads the rows back ordered by position.
interface RebalanceCase {
  name: string;
  seed: (ctx: Ctx, positions: string[]) => Promise<string[]>;
  rebalance: (ctx: Ctx) => Promise<RebalancedPosition[]>;
  read: (ctx: Ctx) => Promise<{ id: string; position: string }[]>;
}

const cases: RebalanceCase[] = [
  {
    name: "rebalanceBoards",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(boards).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, name: `Board ${i}`, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceBoards(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: boards.id, position: boards.position }).from(boards).where(eq(boards.workspaceId, ctx.workspaceId)).orderBy(asc(boards.position)),
  },
  {
    name: "rebalanceBoardGroups",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(boardGroups).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, title: `Group ${i}`, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceBoardGroups(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: boardGroups.id, position: boardGroups.position }).from(boardGroups).where(eq(boardGroups.workspaceId, ctx.workspaceId)).orderBy(asc(boardGroups.position)),
  },
  {
    name: "rebalanceLists",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(lists).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, name: `List ${i}`, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceLists(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: lists.id, position: lists.position }).from(lists).where(eq(lists.workspaceId, ctx.workspaceId)).orderBy(asc(lists.position)),
  },
  {
    name: "rebalanceCards",
    seed: async (ctx, positions) => {
      await db.insert(boards).values({ id: ctx.boardId, workspaceId: ctx.workspaceId, name: "Board", position: dec(1000) });
      await db.insert(lists).values({ id: ctx.listId, workspaceId: ctx.workspaceId, name: "List", position: dec(1000) });
      const ids = positions.map(() => randomUUID());
      await db.insert(cards).values(
        positions.map((position, i) => ({ id: ids[i]!, boardId: ctx.boardId, listId: ctx.listId, title: `Card ${i}`, position, createdById: ctx.userId })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceCards(ctx.listId),
    read: (ctx) =>
      db.select({ id: cards.id, position: cards.position }).from(cards).where(and(eq(cards.boardId, ctx.boardId), eq(cards.listId, ctx.listId))).orderBy(asc(cards.position)),
  },
  {
    name: "rebalanceCustomFields",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(customFields).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, name: `Field ${i}`, type: "text" as const, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceCustomFields(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: customFields.id, position: customFields.position }).from(customFields).where(eq(customFields.workspaceId, ctx.workspaceId)).orderBy(asc(customFields.position)),
  },
  {
    name: "rebalanceCustomFieldOptions",
    seed: async (ctx, positions) => {
      await db.insert(customFields).values({ id: ctx.fieldId, workspaceId: ctx.workspaceId, name: "Select", type: "select" as const, position: dec(1000) });
      const ids = positions.map(() => randomUUID());
      await db.insert(customFieldOptions).values(
        positions.map((position, i) => ({ id: ids[i]!, fieldId: ctx.fieldId, label: `Option ${i}`, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceCustomFieldOptions(ctx.fieldId),
    read: (ctx) =>
      db.select({ id: customFieldOptions.id, position: customFieldOptions.position }).from(customFieldOptions).where(eq(customFieldOptions.fieldId, ctx.fieldId)).orderBy(asc(customFieldOptions.position)),
  },
  {
    name: "rebalanceCardLabels",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(cardLabels).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, name: `Label ${i}`, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceCardLabels(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: cardLabels.id, position: cardLabels.position }).from(cardLabels).where(eq(cardLabels.workspaceId, ctx.workspaceId)).orderBy(asc(cardLabels.position)),
  },
  {
    name: "rebalanceChecklistTemplates",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(checklistTemplates).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, title: `Template ${i}`, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceChecklistTemplates(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: checklistTemplates.id, position: checklistTemplates.position }).from(checklistTemplates).where(eq(checklistTemplates.workspaceId, ctx.workspaceId)).orderBy(asc(checklistTemplates.position)),
  },
  {
    name: "rebalanceAutomations",
    seed: async (ctx, positions) => {
      const ids = positions.map(() => randomUUID());
      await db.insert(automations).values(
        positions.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, triggerType: "card_enters_list" as const, position })),
      );
      return ids;
    },
    rebalance: (ctx) => rebalanceAutomations(ctx.workspaceId),
    read: (ctx) =>
      db.select({ id: automations.id, position: automations.position }).from(automations).where(eq(automations.workspaceId, ctx.workspaceId)).orderBy(asc(automations.position)),
  },
];

for (const c of cases) {
  void test(`${c.name} renumbers out-of-step siblings to canonical positions, preserving order`, async () => {
    const ctx = await seedCtx();
    const positions = [dec(5), dec(6), dec(7), dec(8)];
    const ids = await c.seed(ctx, positions);

    const result = await c.rebalance(ctx);
    assert.equal(result.length, positions.length, "every out-of-step row should be returned");

    const rows = await c.read(ctx);
    assert.deepEqual(rows.map((row) => row.id), ids, "ascending order must be preserved");
    rows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));
  });

  void test(`${c.name} is a no-op when positions are already canonical`, async () => {
    const ctx = await seedCtx();
    const positions = [positionAtIndex(0), positionAtIndex(1), positionAtIndex(2)];
    const ids = await c.seed(ctx, positions);

    const result = await c.rebalance(ctx);
    assert.equal(result.length, 0, "no rows should be rewritten");

    const rows = await c.read(ctx);
    assert.deepEqual(rows.map((row) => row.id), ids);
    rows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));
  });
}

void test("rebalanceLists rewrites only changed rows and never nulls untouched siblings", async () => {
  // The CASE returns NULL for any id not in its when-list, so the `where id in (...)` set must match
  // the CASE exactly. Mixing already-canonical rows (filtered out of the update) with out-of-step
  // rows proves untouched siblings keep their exact position and are not clobbered to NULL.
  const ctx = await seedCtx();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const seeded = [positionAtIndex(0), dec(2000.5), positionAtIndex(2), dec(4000.5)];
  await db.insert(lists).values(seeded.map((position, i) => ({ id: ids[i]!, workspaceId: ctx.workspaceId, name: `List ${i}`, position })));

  const result = await rebalanceLists(ctx.workspaceId);
  assert.equal(result.length, 2, "only the two out-of-step rows should be rewritten");

  const rows = await db.select({ id: lists.id, position: lists.position }).from(lists).where(eq(lists.workspaceId, ctx.workspaceId)).orderBy(asc(lists.position));
  assert.equal(rows.length, 4, "no row should disappear or go NULL");
  assert.deepEqual(rows.map((row) => row.id), ids);
  rows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));
});

void test("rebalanceLists handles a single row", async () => {
  const ctx = await seedCtx();
  const id = randomUUID();
  await db.insert(lists).values({ id, workspaceId: ctx.workspaceId, name: "Only", position: dec(5) });

  const result = await rebalanceLists(ctx.workspaceId);
  assert.deepEqual(result, [{ id, position: positionAtIndex(0) }]);

  const [row] = await db.select({ position: lists.position }).from(lists).where(eq(lists.id, id));
  assert.equal(row?.position, positionAtIndex(0));
});

void test("rebalanceLists ignores archived rows and renumbers only active siblings", async () => {
  const ctx = await seedCtx();
  const active = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(lists).values(active.map((id, i) => ({ id, workspaceId: ctx.workspaceId, name: `Active ${i}`, position: dec(5 + i) })));
  const archivedId = randomUUID();
  await db.insert(lists).values({ id: archivedId, workspaceId: ctx.workspaceId, name: "Archived", position: dec(9999), archivedAt: new Date() });

  const result = await rebalanceLists(ctx.workspaceId);
  assert.equal(result.length, 3);

  const activeRows = await db.select({ id: lists.id, position: lists.position }).from(lists).where(and(eq(lists.workspaceId, ctx.workspaceId), isNull(lists.archivedAt))).orderBy(asc(lists.position));
  assert.deepEqual(activeRows.map((row) => row.id), active);
  activeRows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));

  const [archived] = await db.select({ position: lists.position }).from(lists).where(eq(lists.id, archivedId));
  assert.equal(archived?.position, dec(9999), "archived rows must be left untouched");
});

void test("rebalanceLists is scoped to a single workspace", async () => {
  const a = await seedCtx();
  const b = await seedCtx();
  const aIds = [randomUUID(), randomUUID()];
  const bIds = [randomUUID(), randomUUID()];
  await db.insert(lists).values([
    ...aIds.map((id, i) => ({ id, workspaceId: a.workspaceId, name: `A${i}`, position: dec(5 + i) })),
    ...bIds.map((id, i) => ({ id, workspaceId: b.workspaceId, name: `B${i}`, position: dec(50 + i) })),
  ]);

  await rebalanceLists(a.workspaceId);

  const aRows = await db.select({ position: lists.position }).from(lists).where(eq(lists.workspaceId, a.workspaceId)).orderBy(asc(lists.position));
  aRows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));
  const bRows = await db.select({ position: lists.position }).from(lists).where(eq(lists.workspaceId, b.workspaceId)).orderBy(asc(lists.position));
  assert.deepEqual(bRows.map((row) => row.position), [dec(50), dec(51)], "other workspace must be untouched");
});

void test("rebalanceCards runs inside a transaction and is scoped to one list", async () => {
  const ctx = await seedCtx();
  await db.insert(boards).values({ id: ctx.boardId, workspaceId: ctx.workspaceId, name: "Board", position: dec(1000) });
  const listOne = randomUUID();
  const listTwo = randomUUID();
  await db.insert(lists).values([
    { id: listOne, workspaceId: ctx.workspaceId, name: "L1", position: dec(1000) },
    { id: listTwo, workspaceId: ctx.workspaceId, name: "L2", position: dec(2000) },
  ]);
  const listOneCards = [randomUUID(), randomUUID(), randomUUID()];
  const listTwoCards = [randomUUID(), randomUUID()];
  await db.insert(cards).values([
    ...listOneCards.map((id, i) => ({ id, boardId: ctx.boardId, listId: listOne, title: `One ${i}`, position: dec(5 + i), createdById: ctx.userId })),
    ...listTwoCards.map((id, i) => ({ id, boardId: ctx.boardId, listId: listTwo, title: `Two ${i}`, position: dec(50 + i), createdById: ctx.userId })),
  ]);

  // Exercises the tx overload (rebalanceCards is the only helper called inside a transaction).
  const result = await db.transaction((tx) => rebalanceCards(listOne, tx));
  assert.equal(result.length, 3);

  const oneRows = await db.select({ id: cards.id, position: cards.position }).from(cards).where(eq(cards.listId, listOne)).orderBy(asc(cards.position));
  assert.deepEqual(oneRows.map((row) => row.id), listOneCards);
  oneRows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));

  const twoRows = await db.select({ position: cards.position }).from(cards).where(eq(cards.listId, listTwo)).orderBy(asc(cards.position));
  assert.deepEqual(twoRows.map((row) => row.position), [dec(50), dec(51)], "cards in the other list must be untouched");
});

void test("rebalanceCards locks canonical siblings even when no positions change", async () => {
  const ctx = await seedCtx();
  await db.insert(boards).values({ id: ctx.boardId, workspaceId: ctx.workspaceId, name: "Board", position: dec(1000) });
  await db.insert(lists).values({ id: ctx.listId, workspaceId: ctx.workspaceId, name: "List", position: dec(1000) });
  const cardIds = [randomUUID(), randomUUID()];
  await db.insert(cards).values(
    cardIds.map((id, i) => ({
      id,
      boardId: ctx.boardId,
      listId: ctx.listId,
      title: `Card ${i}`,
      position: positionAtIndex(i),
      createdById: ctx.userId,
    })),
  );

  const locker = await pool.connect();
  try {
    await locker.query("begin");
    const lockedDb = drizzle(locker, { schema });
    const result = await rebalanceCards(ctx.listId, lockedDb);
    assert.equal(result.length, 0, "fixture should exercise the no-op rebalance path");

    // A canonical/no-op rebalance does not issue UPDATEs, so the only thing
    // serializing concurrent movers is the SELECT ... FOR UPDATE sibling scan.
    const blockedWriter = await pool.connect();
    try {
      await blockedWriter.query("begin");
      await blockedWriter.query("set local lock_timeout = '100ms'");
      await assert.rejects(
        blockedWriter.query(`update "card" set title = 'Blocked writer' where id = $1`, [cardIds[0]]),
        (error: unknown) => Error.isError(error) && /lock timeout|canceling statement due to lock timeout/.test(error.message),
      );
    } finally {
      await blockedWriter.query("rollback").catch(() => undefined);
      blockedWriter.release();
    }
    await locker.query("commit");
  } finally {
    await locker.query("rollback").catch(() => undefined);
    locker.release();
  }
});

void test("card position migration renumbers per list while preserving each board order", async () => {
  const ctx = await seedCtx();
  const boardA = randomUUID();
  const boardB = randomUUID();
  await db.insert(boards).values([
    { id: boardA, workspaceId: ctx.workspaceId, name: "A", position: dec(1000) },
    { id: boardB, workspaceId: ctx.workspaceId, name: "B", position: dec(2000) },
  ]);
  await db.insert(lists).values({ id: ctx.listId, workspaceId: ctx.workspaceId, name: "List", position: dec(1000) });
  await db.insert(cards).values([
    { id: randomUUID(), boardId: boardA, listId: ctx.listId, title: "A first", position: dec(1000), createdById: ctx.userId },
    { id: randomUUID(), boardId: boardA, listId: ctx.listId, title: "A second", position: dec(2000), createdById: ctx.userId },
    { id: randomUUID(), boardId: boardB, listId: ctx.listId, title: "B first", position: dec(1000), createdById: ctx.userId },
    { id: randomUUID(), boardId: boardB, listId: ctx.listId, title: "B second", position: dec(2000), createdById: ctx.userId },
    { id: randomUUID(), boardId: boardB, listId: ctx.listId, title: "B archived", position: dec(1000), archivedAt: new Date(), createdById: ctx.userId },
  ]);

  await db.execute(sql`
    WITH ranked AS (
      SELECT id,
             (row_number() OVER (PARTITION BY "list_id" ORDER BY "board_id", "position", "id") * 1000)::numeric(20,10) AS new_position
      FROM "card"
    )
    UPDATE "card" c SET "position" = ranked.new_position
    FROM ranked
    WHERE c.id = ranked.id AND c."position" <> ranked.new_position
  `);

  const rows = await db
    .select({ boardId: cards.boardId, title: cards.title, position: cards.position })
    .from(cards)
    .where(eq(cards.listId, ctx.listId))
    .orderBy(asc(cards.position));
  assert.equal(new Set(rows.map((row) => row.position)).size, rows.length, "all cards in the list, including archived, should have unique positions");
  assert.deepEqual(rows.filter((row) => row.boardId === boardA).map((row) => row.title), ["A first", "A second"]);
  assert.deepEqual(rows.filter((row) => row.boardId === boardB && row.title !== "B archived").map((row) => row.title), ["B first", "B second"]);
});

void test("rebalanceCustomFieldOptions is scoped to a single field", async () => {
  const ctx = await seedCtx();
  const fieldOne = randomUUID();
  const fieldTwo = randomUUID();
  await db.insert(customFields).values([
    { id: fieldOne, workspaceId: ctx.workspaceId, name: "F1", type: "select" as const, position: dec(1000) },
    { id: fieldTwo, workspaceId: ctx.workspaceId, name: "F2", type: "select" as const, position: dec(2000) },
  ]);
  const fieldOneOptions = [randomUUID(), randomUUID()];
  const fieldTwoOptions = [randomUUID(), randomUUID()];
  await db.insert(customFieldOptions).values([
    ...fieldOneOptions.map((id, i) => ({ id, fieldId: fieldOne, label: `O1-${i}`, position: dec(5 + i) })),
    ...fieldTwoOptions.map((id, i) => ({ id, fieldId: fieldTwo, label: `O2-${i}`, position: dec(50 + i) })),
  ]);

  await rebalanceCustomFieldOptions(fieldOne);

  const oneRows = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(eq(customFieldOptions.fieldId, fieldOne)).orderBy(asc(customFieldOptions.position));
  oneRows.forEach((row, index) => assert.equal(row.position, positionAtIndex(index)));
  const twoRows = await db.select({ position: customFieldOptions.position }).from(customFieldOptions).where(eq(customFieldOptions.fieldId, fieldTwo)).orderBy(asc(customFieldOptions.position));
  assert.deepEqual(twoRows.map((row) => row.position), [dec(50), dec(51)], "options on the other field must be untouched");
});
