import assert from "node:assert/strict";
import test from "node:test";
import { Kanera } from "../index.js";

const BOARD_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

void test("schedule reads send the board or workspace scope and the attention limit unchanged", async () => {
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
      return new Response(JSON.stringify({ conflicts: [], critical: [], lateToStart: [], truncated: false }), { status: 200 });
    }) as typeof fetch,
  });

  await kanera.work.schedule({ boardId: BOARD_ID });
  await kanera.work.schedule({ workspaceId: WORKSPACE_ID });
  // An omitted limit is left to the API's default rather than invented here.
  await kanera.work.scheduleAttention();
  const attention = await kanera.work.scheduleAttention({ limit: 5 });

  assert.deepEqual(calls, [
    { method: "POST", path: "/api/v1/cards/schedule", body: { boardId: BOARD_ID } },
    { method: "POST", path: "/api/v1/cards/schedule", body: { workspaceId: WORKSPACE_ID } },
    { method: "POST", path: "/api/v1/work/schedule-attention/query", body: {} },
    { method: "POST", path: "/api/v1/work/schedule-attention/query", body: { limit: 5 } },
  ]);
  assert.deepEqual(attention, { conflicts: [], critical: [], lateToStart: [], truncated: false });
});
