import "../../test/setup.integration.js";
import { boardSeparators, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";

void test("board separators are created and moved at typed card anchors", async () => {
  const app = await buildIntegrationServer();
  const { auth } = await signupOwner(app, {
    orgName: "Separator Agents",
    email: "separator-agent-owner@example.com",
    displayName: "Owner",
  });

  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const boardResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/boards`,
    headers: auth,
    payload: { name: "Launch" },
  });
  assert.equal(boardResponse.statusCode, 201);
  const board = boardResponse.json<{ id: string }>();

  const cardResponse = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/cards`,
    headers: auth,
    payload: { title: "Ship it" },
  });
  assert.equal(cardResponse.statusCode, 201);
  const card = cardResponse.json<{ id: string; position: string }>();

  const createdResponse = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/separators`,
    headers: auth,
    payload: {
      title: "This week",
      color: "blue",
      beforeItem: { type: "card", id: card.id },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const separator = createdResponse.json<{ id: string; title: string; color: string; position: string }>();
  assert.equal(separator.title, "This week");
  assert.equal(separator.color, "blue");
  assert.ok(Number(separator.position) < Number(card.position));

  const movedResponse = await app.inject({
    method: "POST",
    url: `/separators/${separator.id}/move`,
    headers: auth,
    payload: { listId: list.id, beforeItem: null },
  });
  assert.equal(movedResponse.statusCode, 200);
  assert.ok(Number(movedResponse.json<{ position: string }>().position) > Number(card.position));

  const updatedResponse = await app.inject({
    method: "PATCH",
    url: `/separators/${separator.id}`,
    headers: auth,
    payload: { title: "Next week", color: null },
  });
  assert.equal(updatedResponse.statusCode, 200);
  assert.equal(updatedResponse.json<{ title: string }>().title, "Next week");

  const deletedResponse = await app.inject({
    method: "DELETE",
    url: `/separators/${separator.id}`,
    headers: auth,
  });
  assert.equal(deletedResponse.statusCode, 204);
  assert.equal(await db.$count(boardSeparators, eq(boardSeparators.id, separator.id)), 0);

  await app.close();
});
