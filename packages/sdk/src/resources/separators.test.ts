import assert from "node:assert/strict";
import test from "node:test";
import { Kanera } from "../index.js";

const BOARD_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const SEPARATOR_ID = "44444444-4444-4444-8444-444444444444";

void test("separator resources and typed card anchors send the mixed-lane API contract", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const kanera = new Kanera({
    apiKey: "kanera_u_test",
    baseUrl: "https://api.example.test",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const url = new URL(input instanceof URL ? input : input instanceof Request ? input.url : input);
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: SEPARATOR_ID }), { status: 200 });
    }) as typeof fetch,
  });

  await kanera.separators.create(BOARD_ID, LIST_ID, {
    title: "This week",
    color: "blue",
    anchor: { side: "before", item: { type: "card", id: CARD_ID } },
  });
  await kanera.separators.update(SEPARATOR_ID, { title: "Next week", color: null });
  await kanera.separators.move(SEPARATOR_ID, {
    listId: LIST_ID,
    anchor: { side: "after", item: { type: "separator", id: SEPARATOR_ID } },
  });
  await kanera.cards.move(CARD_ID, {
    listId: LIST_ID,
    anchor: { side: "after", item: { type: "separator", id: SEPARATOR_ID } },
  });
  await kanera.separators.delete(SEPARATOR_ID);

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: `/api/v1/boards/${BOARD_ID}/lists/${LIST_ID}/separators`,
      body: { title: "This week", color: "blue", beforeItem: { type: "card", id: CARD_ID } },
    },
    {
      method: "PATCH",
      path: `/api/v1/separators/${SEPARATOR_ID}`,
      body: { title: "Next week", color: null },
    },
    {
      method: "POST",
      path: `/api/v1/separators/${SEPARATOR_ID}/move`,
      body: { listId: LIST_ID, afterItem: { type: "separator", id: SEPARATOR_ID } },
    },
    {
      method: "POST",
      path: `/api/v1/cards/${CARD_ID}/move`,
      body: { listId: LIST_ID, afterItem: { type: "separator", id: SEPARATOR_ID } },
    },
    { method: "DELETE", path: `/api/v1/separators/${SEPARATOR_ID}` },
  ]);
});
