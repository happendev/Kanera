import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createKaneraMcpServer } from "./server.js";

const W = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const L = "44444444-4444-4444-8444-444444444444";
const U = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const N = "77777777-7777-4777-8777-777777777777";

type Tool = { handler: (args: unknown) => Promise<CallToolResult> };
type Resource = { readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text?: string }> }> };
type Prompt = { callback: (args: Record<string, string>) => { messages: Array<{ content: { text: string } }> } };
type Internals = {
  _registeredTools: Record<string, Tool>;
  _registeredResourceTemplates: Record<string, Resource>;
  _registeredPrompts: Record<string, Prompt>;
};

function internals() {
  return createKaneraMcpServer({ apiKey: "kanera_live_test", publicApiUrl: "https://api.example.test" }) as unknown as Internals;
}

type ToolCase = { name: string; args: unknown; method: string; path: string; body?: unknown };

const toolCases: ToolCase[] = [
  { name: "kanera_list_workspaces", args: { limit: 10 }, method: "GET", path: "/api/v1/workspaces?limit=10" },
  { name: "kanera_open_workspace", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}` },
  { name: "kanera_list_boards", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}/boards` },
  { name: "kanera_open_board", args: { boardId: B, includeCompleted: true, archived: false }, method: "POST", path: `/api/v1/boards/${B}/open?includeCompleted=true&archived=false` },
  { name: "kanera_search", args: { query: "road map", limit: 8 }, method: "GET", path: "/api/v1/search?q=road+map&limit=8" },
  { name: "kanera_get_card", args: { cardId: C }, method: "GET", path: `/api/v1/cards/${C}/detail` },
  { name: "kanera_create_card", args: { boardId: B, listId: L, title: "Title", description: "Body", atTop: true }, method: "POST", path: `/api/v1/boards/${B}/lists/${L}/cards`, body: { title: "Title", description: "Body", atTop: true } },
  { name: "kanera_update_card", args: { cardId: C, title: "New", dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" }, method: "PATCH", path: `/api/v1/cards/${C}`, body: { title: "New", dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" } },
  { name: "kanera_move_card", args: { cardId: C, listId: L, afterCardId: null, beforeCardId: C }, method: "POST", path: `/api/v1/cards/${C}/move`, body: { listId: L, afterCardId: null, beforeCardId: C } },
  { name: "kanera_archive_card", args: { cardId: C, archived: true }, method: "PATCH", path: `/api/v1/cards/${C}/archive`, body: { archived: true } },
  { name: "kanera_set_card_assignees", args: { cardId: C, userIds: [U] }, method: "PUT", path: `/api/v1/cards/${C}/assignees`, body: { userIds: [U] } },
  { name: "kanera_set_card_labels", args: { cardId: C, labelIds: [L] }, method: "PUT", path: `/api/v1/cards/${C}/labels`, body: { labelIds: [L] } },
  { name: "kanera_set_custom_field_value", args: { cardId: C, fieldId: F, valueText: "High" }, method: "PUT", path: `/api/v1/cards/${C}/custom-fields/${F}`, body: { cardId: C, fieldId: F, valueText: "High" } },
  { name: "kanera_add_comment", args: { cardId: C, body: "Hello" }, method: "POST", path: `/api/v1/cards/${C}/comments`, body: { body: "Hello" } },
  { name: "kanera_list_activity", args: { boardId: B, limit: 25 }, method: "GET", path: `/api/v1/boards/${B}/activity?limit=25` },
  { name: "kanera_list_assigned_work", args: { workspaceId: W, userId: U }, method: "GET", path: `/api/v1/workspaces/${W}/assignees/${U}/cards` },
  { name: "kanera_list_notes", args: { boardId: B, scope: "team" }, method: "GET", path: `/api/v1/boards/${B}/notes?scope=team` },
  { name: "kanera_get_note", args: { noteId: N }, method: "GET", path: `/api/v1/notes/${N}` },
  { name: "kanera_create_note", args: { workspaceId: W, scope: "team", parentNoteId: null, title: "Plan", icon: null }, method: "POST", path: `/api/v1/workspaces/${W}/notes`, body: { scope: "team", parentNoteId: null, title: "Plan", icon: null } },
  { name: "kanera_update_note", args: { noteId: N, title: "Plan 2", content: "Text", baseUpdatedAt: "2026-06-30T00:00:00.000Z" }, method: "PATCH", path: `/api/v1/notes/${N}`, body: { title: "Plan 2", content: "Text", baseUpdatedAt: "2026-06-30T00:00:00.000Z" } },
];

void test("every MCP tool maps to the expected public API request", async () => {
  const server = internals();
  assert.deepEqual(Object.keys(server._registeredTools).sort(), toolCases.map((item) => item.name).sort());

  const originalFetch = globalThis.fetch;
  try {
    for (const item of toolCases) {
      let request: { method: string; path: string; body?: unknown } | undefined;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        request = {
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      await server._registeredTools[item.name]!.handler(item.args);
      assert.deepEqual(request, { method: item.method, path: item.path, body: item.body }, item.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("all resource templates fetch and serialize their public API entities", async () => {
  const server = internals();
  const cases = [
    ["workspace", W, `/api/v1/workspaces/${W}`],
    ["board", B, `/api/v1/boards/${B}/open`],
    ["card", C, `/api/v1/cards/${C}/detail`],
    ["note", N, `/api/v1/notes/${N}`],
  ] as const;
  assert.deepEqual(Object.keys(server._registeredResourceTemplates).sort(), cases.map(([name]) => name).sort());
  const originalFetch = globalThis.fetch;
  try {
    for (const [name, id, expectedPath] of cases) {
      let path = "";
      globalThis.fetch = async (input) => {
        path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        return new Response(JSON.stringify({ id }), { status: 200 });
      };
      const result = await server._registeredResourceTemplates[name]!.readCallback(new URL(`kanera://${name}/${id}`), { [`${name}Id`]: id });
      assert.equal(path, expectedPath);
      assert.deepEqual(JSON.parse(result.contents[0]!.text!), { id });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("all prompts produce actionable text containing their target identifier", () => {
  const prompts = internals()._registeredPrompts;
  const cases = [
    ["summarize_board_status", { boardId: B }, B],
    ["prepare_standup_update", { workspaceId: W, userId: U }, W],
    ["triage_assigned_work", { workspaceId: W }, W],
    ["draft_card_from_notes", { noteId: N }, N],
  ] as const;
  assert.deepEqual(Object.keys(prompts).sort(), cases.map(([name]) => name).sort());
  for (const [name, args, target] of cases) {
    const result = prompts[name]!.callback(args);
    assert.match(result.messages[0]!.content.text, new RegExp(target));
  }
});
