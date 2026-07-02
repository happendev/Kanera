import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boards, cardCustomFieldValues, customFieldOptions, cards, lists } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

async function setup() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string } }>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const cardRows = await db
    .insert(cards)
    .values([0, 1, 2].map((i) => ({
      listId: list!.id,
      boardId: board!.id,
      title: `Card ${i}`,
      position: `${1000 + i}.0000000000`,
      createdById: user.id,
    })))
    .returning();

  const auth = { authorization: `Bearer ${accessToken}` } as const;
  return { app, auth, workspace, board: board!, cards: cardRows, cardIds: cardRows.map((c) => c.id), userId: user.id };
}

async function createField(
  app: Awaited<ReturnType<typeof setup>>["app"],
  auth: { authorization: string },
  workspaceId: string,
  payload: Record<string, unknown>,
) {
  const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/custom-fields`, headers: auth, payload });
  assert.equal(res.statusCode, 201);
  return res.json<{ id: string; options: { id: string; label: string }[] }>();
}

function bulk(
  app: Awaited<ReturnType<typeof setup>>["app"],
  auth: { authorization: string },
  boardId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: "PATCH", url: `/boards/${boardId}/cards/bulk/custom-fields`, headers: auth, payload });
}

async function valueRow(cardId: string, fieldId: string) {
  const [row] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, cardId), eq(cardCustomFieldValues.fieldId, fieldId)))
    .limit(1);
  return row ?? null;
}

test("setAll writes a scalar value to every selected card", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, { name: "Notes", type: "text" });

  const res = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "setAll", valueText: "hi" });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ updated: number; values: unknown[]; skippedCardIds: string[] }>();
  assert.equal(body.updated, 3);
  assert.equal(body.values.length, 3);
  for (const cardId of cardIds) assert.equal((await valueRow(cardId, field.id))?.valueText, "hi");
});

test("fillEmpty only writes cards with no existing value", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, { name: "Estimate", type: "number" });

  // Pre-populate the first card via the single-card route.
  const pre = await app.inject({
    method: "PUT",
    url: `/cards/${cardIds[0]}/custom-fields/${field.id}`,
    headers: auth,
    payload: { valueNumber: 5 },
  });
  assert.equal(pre.statusCode, 200);

  const res = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "fillEmpty", valueNumber: 9 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ updated: number }>().updated, 2);
  assert.equal((await valueRow(cardIds[0]!, field.id))?.valueNumber, "5"); // untouched
  assert.equal((await valueRow(cardIds[1]!, field.id))?.valueNumber, "9");
  assert.equal((await valueRow(cardIds[2]!, field.id))?.valueNumber, "9");
});

test("add / remove tri-state on a multi-value select field", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, {
    name: "Tags",
    type: "select",
    allowMultiple: true,
    options: [{ label: "A" }, { label: "B" }],
  });
  const a = field.options.find((o) => o.label === "A")!;
  const b = field.options.find((o) => o.label === "B")!;

  assert.equal((await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "add", valueOptionIds: [a.id] })).statusCode, 200);
  assert.equal((await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "add", valueOptionIds: [b.id] })).statusCode, 200);
  for (const cardId of cardIds) assert.deepEqual((await valueRow(cardId, field.id))?.valueOptionIds, [a.id, b.id]);

  // Re-adding an existing id is a no-op (no cards updated).
  const noop = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "add", valueOptionIds: [a.id] });
  assert.equal(noop.json<{ updated: number }>().updated, 0);

  assert.equal((await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "remove", valueOptionIds: [a.id] })).statusCode, 200);
  for (const cardId of cardIds) assert.deepEqual((await valueRow(cardId, field.id))?.valueOptionIds, [b.id]);

  // Removing the last id clears the row and reports the card as cleared.
  const cleared = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "remove", valueOptionIds: [b.id] });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json<{ clearedCardIds: string[] }>().clearedCardIds.length, 3);
  for (const cardId of cardIds) assert.equal(await valueRow(cardId, field.id), null);
});

test("clear removes the value from every selected card", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, { name: "Notes", type: "text" });
  await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "setAll", valueText: "x" });

  const res = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "clear" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ clearedCardIds: string[] }>().clearedCardIds.length, 3);
  for (const cardId of cardIds) assert.equal(await valueRow(cardId, field.id), null);
});

test("single-value select rejects setAll with more than one option", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, {
    name: "Status",
    type: "select",
    options: [{ label: "Todo" }, { label: "Done" }],
  });
  const res = await bulk(app, auth, board.id, {
    cardIds,
    fieldId: field.id,
    mode: "setAll",
    valueOptionIds: field.options.map((o) => o.id),
  });
  assert.equal(res.statusCode, 400);
});

test("archived option ids are rejected", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, {
    name: "Status",
    type: "select",
    options: [{ label: "Todo" }, { label: "Done" }],
  });
  const todo = field.options.find((o) => o.label === "Todo")!;
  await db.update(customFieldOptions).set({ archivedAt: new Date() }).where(eq(customFieldOptions.id, todo.id));

  const res = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "setAll", valueOptionIds: [todo.id] });
  assert.equal(res.statusCode, 400);
});

test("non-member user ids are rejected", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, { name: "Reviewer", type: "user" });
  const res = await bulk(app, auth, board.id, {
    cardIds,
    fieldId: field.id,
    mode: "setAll",
    valueUserIds: ["00000000-0000-0000-0000-000000000000"],
  });
  assert.equal(res.statusCode, 400);
});

test("archived cards are skipped, not written", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const field = await createField(app, auth, workspace.id, { name: "Notes", type: "text" });
  await db.update(cards).set({ archivedAt: new Date() }).where(eq(cards.id, cardIds[2]!));

  const res = await bulk(app, auth, board.id, { cardIds, fieldId: field.id, mode: "setAll", valueText: "hi" });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ updated: number; skippedCardIds: string[] }>();
  assert.equal(body.updated, 2);
  assert.deepEqual(body.skippedCardIds, [cardIds[2]]);
  assert.equal(await valueRow(cardIds[2]!, field.id), null);
});

test("mode ↔ type mismatch is rejected", async () => {
  const { app, auth, workspace, board, cardIds } = await setup();
  const textField = await createField(app, auth, workspace.id, { name: "Notes", type: "text" });
  // add/remove only apply to multi-value fields.
  assert.equal((await bulk(app, auth, board.id, { cardIds, fieldId: textField.id, mode: "add", valueText: "x" })).statusCode, 400);

  const multiField = await createField(app, auth, workspace.id, {
    name: "Tags",
    type: "select",
    allowMultiple: true,
    options: [{ label: "A" }],
  });
  // setAll/fillEmpty are not allowed for multi-value fields.
  assert.equal(
    (await bulk(app, auth, board.id, { cardIds, fieldId: multiField.id, mode: "setAll", valueOptionIds: [multiField.options[0]!.id] })).statusCode,
    400,
  );
});
