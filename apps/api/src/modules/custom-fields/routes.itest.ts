import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boards, cards, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
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
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Card", position: "1000.0000000000", createdById: user.id })
    .returning();

  const auth = { authorization: `Bearer ${accessToken}` } as const;
  return { app, auth, workspace, board: board!, card: card!, userId: user.id };
}

test("select field: seeds options and validates option ids against the field", async () => {
  const { app, auth, workspace, card } = await setup();

  const field = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/custom-fields`,
    headers: auth,
    payload: { name: "Status", type: "select", options: [{ label: "Todo" }, { label: "Done" }] },
  });
  assert.equal(field.statusCode, 201);
  const fieldBody = field.json<{ id: string; options: { id: string; label: string }[] }>();
  assert.equal(fieldBody.options.length, 2);
  const todo = fieldBody.options.find((o) => o.label === "Todo")!;

  // Valid option id is accepted.
  const ok = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldBody.id}`,
    headers: auth,
    payload: { valueOptionIds: [todo.id] },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json<{ valueOptionIds: string[] }>().valueOptionIds, [todo.id]);

  // Unknown option id is rejected.
  const bad = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldBody.id}`,
    headers: auth,
    payload: { valueOptionIds: ["00000000-0000-0000-0000-000000000000"] },
  });
  assert.equal(bad.statusCode, 400);

  // Single-value field rejects more than one option.
  const tooMany = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldBody.id}`,
    headers: auth,
    payload: { valueOptionIds: fieldBody.options.map((o) => o.id) },
  });
  assert.equal(tooMany.statusCode, 400);
});

test("user field: only workspace members are accepted", async () => {
  const { app, auth, workspace, card, userId } = await setup();

  const field = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/custom-fields`,
    headers: auth,
    payload: { name: "Reviewer", type: "user", allowMultiple: true },
  });
  assert.equal(field.statusCode, 201);
  const fieldId = field.json<{ id: string }>().id;

  const ok = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldId}`,
    headers: auth,
    payload: { valueUserIds: [userId] },
  });
  assert.equal(ok.statusCode, 200);

  const bad = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldId}`,
    headers: auth,
    payload: { valueUserIds: ["00000000-0000-0000-0000-000000000000"] },
  });
  assert.equal(bad.statusCode, 400);
});

test("value column must match the field type", async () => {
  const { app, auth, workspace, card } = await setup();

  const field = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/custom-fields`,
    headers: auth,
    payload: { name: "Start", type: "date" },
  });
  const fieldId = field.json<{ id: string }>().id;

  const wrong = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldId}`,
    headers: auth,
    payload: { valueText: "not a date" },
  });
  assert.equal(wrong.statusCode, 400);

  const ok = await app.inject({
    method: "PUT",
    url: `/cards/${card.id}/custom-fields/${fieldId}`,
    headers: auth,
    payload: { valueDate: "2026-06-01" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json<{ valueDate: string }>().valueDate, "2026-06-01");
});

test("archived options are dropped from the field's option list", async () => {
  const { app, auth, workspace } = await setup();

  const field = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/custom-fields`,
    headers: auth,
    payload: { name: "Lane", type: "select", options: [{ label: "A" }, { label: "B" }] },
  });
  const fieldBody = field.json<{ id: string; options: { id: string; label: string }[] }>();
  const optionA = fieldBody.options.find((o) => o.label === "A")!;

  const del = await app.inject({ method: "DELETE", url: `/options/${optionA.id}`, headers: auth });
  assert.equal(del.statusCode, 204);

  // Re-fetch the workspace; the archived option should no longer be listed.
  const ws = await app.inject({ method: "GET", url: `/workspaces/${workspace.id}`, headers: auth });
  const fields = ws.json<{ customFields: { id: string; options: { id: string }[] }[] }>().customFields;
  const reloaded = fields.find((f) => f.id === fieldBody.id)!;
  assert.equal(reloaded.options.length, 1);
  assert.ok(!reloaded.options.some((o) => o.id === optionA.id));
});
