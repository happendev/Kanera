import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createKaneraMcpServer } from "./server.js";

const W = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const L = "44444444-4444-4444-8444-444444444444";
const U = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const N = "77777777-7777-4777-8777-777777777777";
const CK = "88888888-8888-4888-8888-888888888888";
const IT = "99999999-9999-4999-8999-999999999999";
const O = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Tool = {
  handler: (args: unknown) => Promise<CallToolResult>;
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  outputSchema?: unknown;
};
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
  { name: "kanera_get_session", args: {}, method: "GET", path: "/api/v1/session" },
  { name: "kanera_list_workspaces", args: { limit: 10 }, method: "GET", path: "/api/v1/workspaces?limit=10" },
  { name: "kanera_list_accessible_boards", args: {}, method: "GET", path: "/api/v1/home/boards" },
  { name: "kanera_get_workspace", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}` },
  { name: "kanera_list_workspace_boards", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}/boards` },
  { name: "kanera_create_workspace", args: { name: "Delivery" }, method: "POST", path: "/api/v1/workspaces", body: { name: "Delivery" } },
  { name: "kanera_create_standalone_board", args: { name: "Solo", templateId: "blank" }, method: "POST", path: "/api/v1/workspaces", body: { kind: "board", name: "Solo", icon: "layout-kanban", initialBoard: { name: "Solo", icon: "layout-kanban" }, lists: [], customFields: [], labels: [] } },
  { name: "kanera_update_workspace", args: { workspaceId: W, name: "Delivery Ops", completedCardsActiveDays: 30 }, method: "PATCH", path: `/api/v1/workspaces/${W}`, body: { name: "Delivery Ops", completedCardsActiveDays: 30 } },
  { name: "kanera_create_workspace_board", args: { workspaceId: W, name: "Launch", groupId: null, description: "Launch plan" }, method: "POST", path: `/api/v1/workspaces/${W}/boards`, body: { name: "Launch", groupId: null, description: "Launch plan" } },
  { name: "kanera_update_board", args: { boardId: B, name: "Launch 2", groupId: null, description: null }, method: "PATCH", path: `/api/v1/boards/${B}`, body: { name: "Launch 2", groupId: null, description: null } },
  { name: "kanera_move_workspace_board", args: { boardId: B, afterBoardId: null }, method: "POST", path: `/api/v1/boards/${B}/move`, body: { afterBoardId: null } },
  { name: "kanera_create_list", args: { workspaceId: W, name: "Ready" }, method: "POST", path: `/api/v1/workspaces/${W}/lists`, body: { name: "Ready" } },
  { name: "kanera_update_list", args: { workspaceId: W, listId: L, name: "Ready next" }, method: "PATCH", path: `/api/v1/lists/${L}`, body: { name: "Ready next" } },
  { name: "kanera_move_list", args: { workspaceId: W, listId: L, beforeListId: null }, method: "POST", path: `/api/v1/lists/${L}/move`, body: { beforeListId: null } },
  { name: "kanera_create_custom_field", args: { workspaceId: W, name: "Priority", type: "select", allowMultiple: true, options: [{ label: "High" }] }, method: "POST", path: `/api/v1/workspaces/${W}/custom-fields`, body: { name: "Priority", type: "select", allowMultiple: true, options: [{ label: "High" }] } },
  { name: "kanera_update_custom_field", args: { workspaceId: W, fieldId: F, name: "Urgency", showOnCard: true, allowMultiple: false }, method: "PATCH", path: `/api/v1/custom-fields/${F}`, body: { name: "Urgency", showOnCard: true, allowMultiple: false } },
  { name: "kanera_move_custom_field", args: { workspaceId: W, fieldId: F, afterFieldId: null }, method: "POST", path: `/api/v1/custom-fields/${F}/move`, body: { afterFieldId: null } },
  { name: "kanera_create_custom_field_option", args: { workspaceId: W, fieldId: F, label: "Medium" }, method: "POST", path: `/api/v1/custom-fields/${F}/options`, body: { label: "Medium" } },
  { name: "kanera_update_custom_field_option", args: { workspaceId: W, optionId: O, label: "Normal" }, method: "PATCH", path: `/api/v1/options/${O}`, body: { label: "Normal" } },
  { name: "kanera_move_custom_field_option", args: { workspaceId: W, optionId: O, beforeOptionId: null }, method: "POST", path: `/api/v1/options/${O}/move`, body: { beforeOptionId: null } },
  { name: "kanera_create_label", args: { workspaceId: W, name: "Blocked", color: "red" }, method: "POST", path: `/api/v1/workspaces/${W}/card-labels`, body: { name: "Blocked", color: "red" } },
  { name: "kanera_update_label", args: { workspaceId: W, labelId: O, name: "At risk" }, method: "PATCH", path: `/api/v1/card-labels/${O}`, body: { name: "At risk" } },
  { name: "kanera_move_label", args: { workspaceId: W, labelId: O, afterLabelId: null }, method: "POST", path: `/api/v1/card-labels/${O}/move`, body: { afterLabelId: null } },
  { name: "kanera_get_board", args: { boardId: B }, method: "POST", path: `/api/v1/boards/${B}/open?includeCards=false` },
  { name: "kanera_get_cards_list", args: { boardId: B, listId: L, limit: 25 }, method: "POST", path: `/api/v1/boards/${B}/open?includeCompleted=true&archived=false&listId=${L}&cardLimit=25&cardOffset=0` },
  { name: "kanera_search", args: { query: "road map", limit: 8 }, method: "GET", path: "/api/v1/search?q=road+map&limit=8" },
  { name: "kanera_search_docs", args: { query: "board mirrors", limit: 5 }, method: "GET", path: "/docs-search.json" },
  { name: "kanera_get_card", args: { cardId: C }, method: "GET", path: `/api/v1/cards/${C}/detail` },
  { name: "kanera_get_cards_content", args: { boardId: B, cardIds: [C] }, method: "POST", path: `/api/v1/boards/${B}/cards/content/query`, body: { cardIds: [C] } },
  { name: "kanera_create_card", args: { boardId: B, listId: L, title: "Title", description: "Body", atTop: true, idempotencyKey: C }, method: "POST", path: `/api/v1/boards/${B}/lists/${L}/cards`, body: { title: "Title", description: "Body", atTop: true, clientToken: C } },
  { name: "kanera_update_card", args: { cardId: C, title: "New", dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" }, method: "PATCH", path: `/api/v1/cards/${C}`, body: { title: "New", dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" } },
  { name: "kanera_move_card", args: { cardId: C, listId: L, afterCardId: null, beforeCardId: C }, method: "POST", path: `/api/v1/cards/${C}/move`, body: { listId: L, afterCardId: null, beforeCardId: C } },
  { name: "kanera_archive_card", args: { cardId: C, archived: true }, method: "PATCH", path: `/api/v1/cards/${C}/archive`, body: { archived: true } },
  { name: "kanera_set_card_assignees", args: { cardId: C, userIds: [U] }, method: "PUT", path: `/api/v1/cards/${C}/assignees`, body: { userIds: [U] } },
  { name: "kanera_set_card_labels", args: { cardId: C, labelIds: [L] }, method: "PUT", path: `/api/v1/cards/${C}/labels`, body: { labelIds: [L] } },
  { name: "kanera_bulk_set_card_completion", args: { boardId: B, cardIds: [C], completed: true }, method: "PATCH", path: `/api/v1/boards/${B}/cards/bulk/completion`, body: { cardIds: [C], completed: true } },
  { name: "kanera_bulk_set_card_due_date", args: { boardId: B, cardIds: [C], dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" }, method: "PATCH", path: `/api/v1/boards/${B}/cards/bulk/due-date`, body: { cardIds: [C], dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" } },
  { name: "kanera_bulk_patch_card_labels", args: { boardId: B, cardIds: [C], mode: "add", labelIds: [L] }, method: "PATCH", path: `/api/v1/boards/${B}/cards/bulk/labels`, body: { cardIds: [C], mode: "add", labelIds: [L] } },
  { name: "kanera_bulk_patch_card_assignees", args: { boardId: B, cardIds: [C], mode: "add", userIds: [U] }, method: "PATCH", path: `/api/v1/boards/${B}/cards/bulk/assignees`, body: { cardIds: [C], mode: "add", userIds: [U] } },
  { name: "kanera_bulk_move_cards", args: { boardId: B, cardIds: [C], listId: L }, method: "POST", path: `/api/v1/boards/${B}/cards/bulk/move`, body: { cardIds: [C], listId: L } },
  { name: "kanera_bulk_archive_cards", args: { boardId: B, cardIds: [C] }, method: "PATCH", path: `/api/v1/boards/${B}/cards/bulk/archive`, body: { cardIds: [C], archived: true } },
  { name: "kanera_bulk_duplicate_cards", args: { boardId: B, cardIds: [C], targetBoardId: B, listId: L }, method: "POST", path: `/api/v1/boards/${B}/cards/bulk/duplicate`, body: { cardIds: [C], boardId: B, listId: L } },
  { name: "kanera_bulk_set_card_custom_field", args: { boardId: B, cardIds: [C], fieldId: F, mode: "setAll", valueText: "High" }, method: "PATCH", path: `/api/v1/boards/${B}/cards/bulk/custom-fields`, body: { cardIds: [C], fieldId: F, mode: "setAll", valueText: "High" } },
  { name: "kanera_set_list_card_completion", args: { boardId: B, listId: L, completed: true }, method: "POST", path: `/api/v1/boards/${B}/lists/${L}/cards/completion`, body: { completed: true } },
  { name: "kanera_move_list_cards", args: { sourceListId: L, targetListId: F, boardId: B }, method: "POST", path: `/api/v1/lists/${L}/cards/move`, body: { targetListId: F, boardId: B } },
  { name: "kanera_archive_list_cards", args: { listId: L, boardId: B }, method: "PATCH", path: `/api/v1/lists/${L}/cards/archive`, body: { boardId: B } },
  { name: "kanera_set_custom_field_value", args: { cardId: C, fieldId: F, valueText: "High" }, method: "PUT", path: `/api/v1/cards/${C}/custom-fields/${F}`, body: { cardId: C, fieldId: F, valueText: "High" } },
  { name: "kanera_add_comment", args: { cardId: C, body: "Hello" }, method: "POST", path: `/api/v1/cards/${C}/comments`, body: { body: "Hello" } },
  { name: "kanera_bulk_add_comments", args: { boardId: B, comments: [{ cardId: C, body: "Hello" }] }, method: "POST", path: `/api/v1/boards/${B}/comments/bulk/create`, body: { comments: [{ cardId: C, body: "Hello" }] } },
  { name: "kanera_list_activity", args: { boardId: B, limit: 25 }, method: "GET", path: `/api/v1/boards/${B}/activity?limit=25` },
  { name: "kanera_list_assigned_work", args: { workspaceId: W, userId: U }, method: "GET", path: `/api/v1/workspaces/${W}/assignees/${U}/cards` },
  { name: "kanera_list_notes", args: { boardId: B, scope: "team" }, method: "GET", path: `/api/v1/boards/${B}/notes?scope=team` },
  { name: "kanera_get_note", args: { noteId: N }, method: "GET", path: `/api/v1/notes/${N}` },
  { name: "kanera_create_note", args: { workspaceId: W, scope: "team", parentNoteId: null, title: "Plan" }, method: "POST", path: `/api/v1/workspaces/${W}/notes`, body: { scope: "team", parentNoteId: null, title: "Plan" } },
  { name: "kanera_update_note", args: { noteId: N, title: "Plan 2", content: "Text", baseUpdatedAt: "2026-06-30T00:00:00.000Z" }, method: "PATCH", path: `/api/v1/notes/${N}`, body: { title: "Plan 2", content: "Text", baseUpdatedAt: "2026-06-30T00:00:00.000Z" } },
  { name: "kanera_set_card_completion", args: { cardId: C, completed: true }, method: "PATCH", path: `/api/v1/cards/${C}/completion`, body: { completed: true } },
  { name: "kanera_list_workspace_members", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}/members` },
  { name: "kanera_create_checklist", args: { cardId: C, title: "Sub-steps", parentItemId: IT }, method: "POST", path: `/api/v1/cards/${C}/checklists`, body: { title: "Sub-steps", parentItemId: IT } },
  { name: "kanera_update_checklist", args: { cardId: C, checklistId: CK, title: "Renamed" }, method: "PATCH", path: `/api/v1/cards/${C}/checklists/${CK}`, body: { title: "Renamed" } },
  { name: "kanera_delete_checklist", args: { cardId: C, checklistId: CK }, method: "DELETE", path: `/api/v1/cards/${C}/checklists/${CK}` },
  { name: "kanera_move_checklist", args: { cardId: C, checklistId: CK, afterChecklistId: null, beforeChecklistId: CK }, method: "POST", path: `/api/v1/cards/${C}/checklists/${CK}/move`, body: { afterChecklistId: null, beforeChecklistId: CK } },
  { name: "kanera_add_checklist_item", args: { cardId: C, checklistId: CK, text: "Ship it" }, method: "POST", path: `/api/v1/cards/${C}/checklists/${CK}/items`, body: { text: "Ship it" } },
  { name: "kanera_bulk_add_checklist_items", args: { boardId: B, items: [{ cardId: C, checklistId: CK, text: "Ship it", description: "Details" }] }, method: "POST", path: `/api/v1/boards/${B}/checklist-items/bulk/create`, body: { items: [{ cardId: C, checklistId: CK, text: "Ship it", description: "Details" }] } },
  { name: "kanera_update_checklist_item", args: { cardId: C, checklistId: CK, itemId: IT, description: "More context", completed: true }, method: "PATCH", path: `/api/v1/cards/${C}/checklists/${CK}/items/${IT}`, body: { description: "More context", completed: true } },
  { name: "kanera_bulk_update_checklist_items", args: { cardId: C, checklistId: CK, assigneeId: U }, method: "PATCH", path: `/api/v1/cards/${C}/checklists/${CK}/items/bulk`, body: { assigneeId: U } },
  { name: "kanera_bulk_set_checklist_item_descriptions", args: { boardId: B, updates: [{ cardId: C, checklistId: CK, itemId: IT, description: "Migrated comment" }] }, method: "PATCH", path: `/api/v1/boards/${B}/checklist-items/bulk/descriptions`, body: { updates: [{ cardId: C, checklistId: CK, itemId: IT, description: "Migrated comment" }] } },
  { name: "kanera_delete_checklist_item", args: { cardId: C, checklistId: CK, itemId: IT }, method: "DELETE", path: `/api/v1/cards/${C}/checklists/${CK}/items/${IT}` },
  { name: "kanera_move_checklist_item", args: { cardId: C, checklistId: CK, itemId: IT, targetChecklistId: CK, afterItemId: null, beforeItemId: IT }, method: "POST", path: `/api/v1/cards/${C}/checklists/${CK}/items/${IT}/move`, body: { checklistId: CK, afterItemId: null, beforeItemId: IT } },
  { name: "kanera_list_completed_work", args: { workspaceId: W, userId: U, limit: 30 }, method: "GET", path: `/api/v1/workspaces/${W}/assignees/${U}/completed?limit=30` },
  { name: "kanera_list_work_done", args: { workspaceId: W, userId: U, from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z" }, method: "GET", path: `/api/v1/workspaces/${W}/assignees/${U}/work-done?from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-30T00%3A00%3A00.000Z` },
  { name: "kanera_duplicate_card", args: { cardId: C, boardId: B, listId: L, atTop: true }, method: "POST", path: `/api/v1/cards/${C}/duplicate`, body: { boardId: B, listId: L, atTop: true } },
  { name: "kanera_move_card_to_board", args: { cardId: C, boardId: B, listId: L }, method: "POST", path: `/api/v1/cards/${C}/move-to-board`, body: { boardId: B, listId: L } },
  { name: "kanera_list_card_comments", args: { cardId: C, limit: 50 }, method: "GET", path: `/api/v1/cards/${C}/comments?limit=50` },
  { name: "kanera_delete_comment", args: { commentId: N }, method: "DELETE", path: `/api/v1/comments/${N}` },
  { name: "kanera_bulk_delete_comments", args: { boardId: B, commentIds: [N] }, method: "POST", path: `/api/v1/boards/${B}/comments/bulk/delete`, body: { commentIds: [N] } },
];

type ExpectedRequest = { method: string; path: string; body?: unknown };
type MultiRequestToolCase = { name: string; args: unknown; requests: ExpectedRequest[] };

const standaloneLookupRequests: ExpectedRequest[] = [
  { method: "GET", path: `/api/v1/boards/${B}` },
  { method: "GET", path: `/api/v1/workspaces/${W}` },
];
const multiRequestToolCases: MultiRequestToolCase[] = [
  { name: "kanera_get_standalone_board_settings", args: { boardId: B }, requests: standaloneLookupRequests },
  {
    name: "kanera_set_standalone_board_retention",
    args: { boardId: B, completedCardsActiveDays: 14 },
    requests: [...standaloneLookupRequests, { method: "PATCH", path: `/api/v1/workspaces/${W}`, body: { completedCardsActiveDays: 14 } }],
  },
  { name: "kanera_create_list", args: { standaloneBoardId: B, name: "Ready" }, requests: [...standaloneLookupRequests, { method: "POST", path: `/api/v1/workspaces/${W}/lists`, body: { name: "Ready" } }] },
  { name: "kanera_update_list", args: { standaloneBoardId: B, listId: L, name: "Ready next" }, requests: [...standaloneLookupRequests, { method: "PATCH", path: `/api/v1/lists/${L}`, body: { name: "Ready next" } }] },
  { name: "kanera_move_list", args: { standaloneBoardId: B, listId: L, beforeListId: null }, requests: [...standaloneLookupRequests, { method: "POST", path: `/api/v1/lists/${L}/move`, body: { beforeListId: null } }] },
];

void test("every MCP tool maps to the expected public API request", async () => {
  const server = internals();
  const expectedNames = [...new Set([...toolCases, ...multiRequestToolCases].map((item) => item.name))].sort();
  assert.equal(expectedNames.length, 77);
  assert.deepEqual(Object.keys(server._registeredTools).sort(), expectedNames);

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
        if (url.pathname === "/api/v1/workspaces") {
          return new Response(JSON.stringify([{ id: W, kind: "standard" }]), { status: 200 });
        }
        if (url.pathname === `/api/v1/boards/${B}` && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ id: B, workspaceId: W, name: "Board" }), { status: 200 });
        }
        if (url.pathname === `/api/v1/workspaces/${W}` && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({
            workspace: { id: W, kind: "standard", name: "Workspace" },
            role: "admin",
            lists: [{ id: L }],
            customFields: [{ id: F, options: [{ id: O }] }],
            cardLabels: [{ id: O }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      await server._registeredTools[item.name]!.handler(item.args);
      assert.deepEqual(request, { method: item.method, path: item.path, body: item.body }, item.name);
    }

    for (const item of multiRequestToolCases) {
      const requests: ExpectedRequest[] = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        requests.push({
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          ...(body === undefined ? {} : { body }),
        });
        if (url.pathname === `/api/v1/boards/${B}`) {
          return new Response(JSON.stringify({ id: B, workspaceId: W, name: "Solo" }), { status: 200 });
        }
        if (url.pathname === `/api/v1/workspaces/${W}` && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ workspace: { id: W, kind: "board", name: "Solo" }, role: "admin", lists: [{ id: L }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      await server._registeredTools[item.name]!.handler(item.args);
      assert.deepEqual(requests, item.requests, item.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("every MCP tool exposes structured output and explicit safety annotations", async () => {
  const tools = internals()._registeredTools;
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.title?.trim(), `${name} title`);
    assert.ok(tool.description?.trim(), `${name} description`);
    assert.ok(tool.outputSchema, `${name} output schema`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${name} destructiveHint`);
    assert.equal(typeof tool.annotations?.idempotentHint, "boolean", `${name} idempotentHint`);
    assert.equal(tool.annotations?.openWorldHint, false, `${name} stays inside Kanera`);
  }
  assert.equal(tools.kanera_delete_comment?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_bulk_delete_comments?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_bulk_archive_cards?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_bulk_duplicate_cards?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_bulk_add_comments?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_bulk_add_checklist_items?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_create_workspace?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_create_standalone_board?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_create_workspace_board?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_update_workspace?.annotations?.idempotentHint, true);
  assert.equal(tools.kanera_move_custom_field_option?.annotations?.idempotentHint, true);
  assert.equal(tools.kanera_move_label?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_update_card?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_duplicate_card?.annotations?.destructiveHint, false);
  assert.equal(tools.kanera_bulk_update_checklist_items?.annotations?.idempotentHint, true);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: W }]), { status: 200 });
    const result = await tools.kanera_list_workspaces!.handler({ limit: 25 });
    assert.deepEqual(result.structuredContent, { result: [{ id: W }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("tools/list exposes checklist detail and bounded content migration inputs", async () => {
  const server = createKaneraMcpServer({ apiKey: "kanera_live_test", publicApiUrl: "https://api.example.test" });
  const client = new Client({ name: "kanera-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const createChecklist = tools.find((tool) => tool.name === "kanera_create_checklist");
    const updateItem = tools.find((tool) => tool.name === "kanera_update_checklist_item");
    const getCardsContent = tools.find((tool) => tool.name === "kanera_get_cards_content");
    const bulkDescriptions = tools.find((tool) => tool.name === "kanera_bulk_set_checklist_item_descriptions");

    assert.ok(createChecklist, "kanera_create_checklist is advertised");
    assert.ok(updateItem, "kanera_update_checklist_item is advertised");
    assert.ok(getCardsContent, "kanera_get_cards_content is advertised");
    assert.ok(bulkDescriptions, "kanera_bulk_set_checklist_item_descriptions is advertised");
    assert.ok(createChecklist.inputSchema.properties?.parentItemId, "sub-checklist parentItemId is advertised");
    assert.ok(updateItem.inputSchema.properties?.description, "checklist item description is advertised");
    assert.ok(getCardsContent.inputSchema.properties?.cardIds, "selected card ids are advertised");
    assert.ok(bulkDescriptions.inputSchema.properties?.updates, "per-item description updates are advertised");
    assert.match(getCardsContent.description ?? "", /workspace-wide work.*separately for each board/i);
    assert.match(bulkDescriptions.description ?? "", /workspace-wide work.*separately for each board/i);
  } finally {
    await client.close();
    await server.close();
  }
});

void test("tools/list directs callers to scoped board and card reads", async () => {
  const server = createKaneraMcpServer({ apiKey: "kanera_live_test", publicApiUrl: "https://api.example.test" });
  const client = new Client({ name: "kanera-board-read-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const getBoard = tools.find((tool) => tool.name === "kanera_get_board");
    const getCardsList = tools.find((tool) => tool.name === "kanera_get_cards_list");

    assert.equal(tools.some((tool) => tool.name === "kanera_open_board"), false, "kanera_open_board is not advertised");
    assert.ok(getBoard, "kanera_get_board is advertised");
    assert.ok(getCardsList, "kanera_get_cards_list is advertised");
    assert.match(getBoard.description ?? "", /without cards/i);
    assert.ok(getCardsList.inputSchema.properties?.boardId, "boardId is advertised");
    assert.ok(getCardsList.inputSchema.properties?.listId, "one listId is advertised");
    assert.ok(getCardsList.inputSchema.properties?.cursor, "cursor pagination is advertised");
    assert.ok(getCardsList.inputSchema.properties?.limit, "bounded page limit is advertised");
    assert.match(getCardsList.description ?? "", /never returns.*unbounded/i);
  } finally {
    await client.close();
    await server.close();
  }
});

void test("tools/list exposes one unambiguous workspace and standalone contract", async () => {
  const server = createKaneraMcpServer({ apiKey: "kanera_live_test", publicApiUrl: "https://api.example.test" });
  const client = new Client({ name: "kanera-admin-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const createWorkspace = byName.get("kanera_create_workspace");
    const createStandalone = byName.get("kanera_create_standalone_board");
    const setStandaloneRetention = byName.get("kanera_set_standalone_board_retention");
    const listAccessibleBoards = byName.get("kanera_list_accessible_boards");
    const createBoard = byName.get("kanera_create_workspace_board");
    const updateBoard = byName.get("kanera_update_board");
    const createList = byName.get("kanera_create_list");
    const updateList = byName.get("kanera_update_list");
    const moveList = byName.get("kanera_move_list");
    const createField = byName.get("kanera_create_custom_field");
    const createLabel = byName.get("kanera_create_label");

    assert.ok(createWorkspace);
    assert.ok(createStandalone);
    assert.ok(setStandaloneRetention);
    assert.ok(listAccessibleBoards);
    assert.ok(createBoard);
    assert.ok(updateBoard);
    assert.ok(createList);
    assert.ok(createField);
    assert.ok(createLabel);
    for (const tool of [createWorkspace, createStandalone, setStandaloneRetention, createBoard, updateBoard, createList, createField]) {
      assert.equal(tool.inputSchema.properties?.icon, undefined, `${tool.name} omits icon`);
      assert.equal(tool.inputSchema.properties?.color, undefined, `${tool.name} omits color`);
      assert.equal(tool.inputSchema.properties?.iconColor, undefined, `${tool.name} omits icon color`);
      assert.equal(tool.inputSchema.properties?.backgroundGradient, undefined, `${tool.name} omits background`);
    }
    assert.ok(createLabel.inputSchema.properties?.color, "label creation advertises Kanera color options");
    assert.ok(createStandalone.inputSchema.properties?.templateId, "standalone creation advertises onboarding templates");
    assert.match(createStandalone.description ?? "", /explicitly chooses standalone/i);
    assert.match(createStandalone.description ?? "", /dedicated lists, custom fields, labels/i);
    assert.match(createBoard.description ?? "", /standard workspace/i);
    assert.match(createBoard.description ?? "", /shared with the workspace's other boards/i);
    assert.ok(setStandaloneRetention.inputSchema.properties?.completedCardsActiveDays, "standalone retention has one purpose");
    for (const tool of [createList, updateList, moveList, createField, createLabel]) {
      assert.ok(tool);
      assert.ok(tool.inputSchema.properties?.workspaceId, `${tool.name} accepts a standard workspace target`);
      assert.ok(tool.inputSchema.properties?.standaloneBoardId, `${tool.name} accepts a standalone board target`);
    }
    assert.match(listAccessibleBoards.description ?? "", /guestGroups.*cross-organisation/i);
    for (const legacyName of [
      "kanera_resolve",
      "kanera_list_home_boards",
      "kanera_open_workspace",
      "kanera_list_boards",
      "kanera_create_board",
      "kanera_move_board",
      "kanera_update_standalone_board",
      "kanera_create_standalone_board_list",
      "kanera_update_standalone_board_list",
      "kanera_move_standalone_board_list",
    ]) {
      assert.equal(byName.has(legacyName), false, `${legacyName} is not retained as a duplicate alias`);
    }
    assert.equal(byName.has("kanera_delete_workspace"), false);
    assert.equal(byName.has("kanera_delete_standalone_board"), false);
    assert.equal(byName.has("kanera_delete_board"), false);
    assert.equal(byName.has("kanera_delete_list"), false);
    assert.equal(byName.has("kanera_delete_custom_field"), false);
    assert.equal(byName.has("kanera_delete_label"), false);
    assert.equal(byName.has("kanera_add_workspace_member"), false);
    assert.equal(byName.has("kanera_list_board_member_candidates"), false);
    assert.equal(byName.has("kanera_list_board_members"), false);
    assert.equal(byName.has("kanera_add_board_member"), false);
    assert.equal(byName.has("kanera_update_board_member"), false);
    assert.equal(byName.has("kanera_delete_board_member"), false);
    assert.equal(byName.has("kanera_list_standalone_board_guests"), false);
    assert.equal(byName.has("kanera_invite_standalone_board_guest"), false);
    assert.equal(byName.has("kanera_delete_standalone_board_guest"), false);
    assert.equal(byName.has("kanera_delete_standalone_board_guest_invitation"), false);
  } finally {
    await client.close();
    await server.close();
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
        return new Response(JSON.stringify(name === "workspace" ? { workspace: { id, kind: "standard" }, role: "admin" } : { id }), { status: 200 });
      };
      const result = await server._registeredResourceTemplates[name]!.readCallback(new URL(`kanera://${name}/${id}`), { [`${name}Id`]: id });
      assert.equal(path, expectedPath);
      assert.deepEqual(JSON.parse(result.contents[0]!.text!), name === "workspace" ? { workspace: { id, kind: "standard" }, role: "admin" } : { id });
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
  assert.match(prompts.prepare_standup_update!.callback({ standaloneBoardId: B }).messages[0]!.content.text, new RegExp(B));
  assert.match(prompts.triage_assigned_work!.callback({ standaloneBoardId: B }).messages[0]!.content.text, new RegExp(B));
});
