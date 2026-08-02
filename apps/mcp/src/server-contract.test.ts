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

const allToolCases: ToolCase[] = [
  { name: "kanera_get_session", args: {}, method: "GET", path: "/api/v1/session" },
  { name: "kanera_list_workspaces", args: { limit: 10 }, method: "GET", path: "/api/v1/workspaces?limit=11&offset=0" },
  { name: "kanera_list_accessible_boards", args: {}, method: "GET", path: "/api/v1/boards?limit=26&offset=0" },
  { name: "kanera_get_workspace", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}` },
  { name: "kanera_list_workspace_boards", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}/boards?limit=26&offset=0` },
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
  { name: "kanera_list_card_history", args: { cardId: C, limit: 50 }, method: "GET", path: `/api/v1/cards/${C}/feed?limit=50` },
  { name: "kanera_get_cards_content", args: { boardId: B, cardIds: [C] }, method: "POST", path: `/api/v1/boards/${B}/cards/content/query`, body: { cardIds: [C] } },
  { name: "kanera_create_card", args: { boardId: B, listId: L, title: "Title", description: "Body", atTop: true, idempotencyKey: C }, method: "POST", path: `/api/v1/boards/${B}/lists/${L}/cards`, body: { title: "Title", description: "Body", atTop: true, clientToken: C } },
  { name: "kanera_update_card", args: { cardId: C, changes: { title: "New", dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" } }, method: "PATCH", path: `/api/v1/cards/${C}`, body: { title: "New", dueDateLocalDate: "2026-07-01", dueDateSlot: "morning" } },
  { name: "kanera_move_card", args: { cardId: C, listId: L, anchor: { side: "before", id: C } }, method: "POST", path: `/api/v1/cards/${C}/move`, body: { listId: L, beforeCardId: C } },
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
  { name: "kanera_set_custom_field_value", args: { cardId: C, fieldId: F, value: { type: "text", value: "High" } }, method: "PUT", path: `/api/v1/cards/${C}/custom-fields/${F}`, body: { valueText: "High" } },
  { name: "kanera_add_comment", args: { cardId: C, body: "Hello" }, method: "POST", path: `/api/v1/cards/${C}/comments`, body: { body: "Hello" } },
  { name: "kanera_bulk_add_comments", args: { boardId: B, comments: [{ cardId: C, body: "Hello" }] }, method: "POST", path: `/api/v1/boards/${B}/comments/bulk/create`, body: { comments: [{ cardId: C, body: "Hello" }] } },
  { name: "kanera_list_activity", args: { boardId: B, limit: 25 }, method: "GET", path: `/api/v1/boards/${B}/activity?limit=25` },
  { name: "kanera_list_notes", args: { boardId: B, scope: "team" }, method: "GET", path: `/api/v1/boards/${B}/notes?scope=team&limit=26&offset=0` },
  { name: "kanera_get_note", args: { noteId: N }, method: "GET", path: `/api/v1/notes/${N}` },
  { name: "kanera_get_note_backlinks", args: { noteId: N }, method: "GET", path: `/api/v1/notes/${N}/backlinks` },
  { name: "kanera_list_note_attachments", args: { noteId: N }, method: "GET", path: `/api/v1/notes/${N}/attachments` },
  { name: "kanera_create_note", args: { target: { type: "workspace", workspaceId: W }, scope: "team", parentNoteId: null, title: "Plan" }, method: "POST", path: `/api/v1/workspaces/${W}/notes`, body: { scope: "team", parentNoteId: null, title: "Plan" } },
  { name: "kanera_update_note", args: { noteId: N, changes: { title: "Plan 2", content: "Text", baseUpdatedAt: "2026-06-30T00:00:00.000Z" } }, method: "PATCH", path: `/api/v1/notes/${N}`, body: { title: "Plan 2", content: "Text", baseUpdatedAt: "2026-06-30T00:00:00.000Z" } },
  { name: "kanera_duplicate_note", args: { noteId: N, parentNoteId: null, title: "Plan copy" }, method: "POST", path: `/api/v1/notes/${N}/duplicate`, body: { parentNoteId: null, title: "Plan copy" } },
  { name: "kanera_move_note", args: { noteId: N, parentNoteId: null, afterNoteId: null }, method: "PATCH", path: `/api/v1/notes/${N}/move`, body: { parentNoteId: null, afterNoteId: null } },
  { name: "kanera_set_card_completion", args: { cardId: C, completed: true }, method: "PATCH", path: `/api/v1/cards/${C}/completion`, body: { completed: true } },
  { name: "kanera_list_workspace_members", args: { workspaceId: W }, method: "GET", path: `/api/v1/workspaces/${W}/members?limit=26&offset=0` },
  { name: "kanera_create_checklist", args: { cardId: C, title: "Sub-steps", parentItemId: IT }, method: "POST", path: `/api/v1/cards/${C}/checklists`, body: { title: "Sub-steps", parentItemId: IT } },
  { name: "kanera_update_checklist", args: { cardId: C, checklistId: CK, title: "Renamed" }, method: "PATCH", path: `/api/v1/cards/${C}/checklists/${CK}`, body: { title: "Renamed" } },
  { name: "kanera_delete_checklist", args: { cardId: C, checklistId: CK }, method: "DELETE", path: `/api/v1/cards/${C}/checklists/${CK}` },
  { name: "kanera_move_checklist", args: { cardId: C, checklistId: CK, anchor: { side: "before", id: CK } }, method: "POST", path: `/api/v1/cards/${C}/checklists/${CK}/move`, body: { beforeChecklistId: CK } },
  { name: "kanera_add_checklist_item", args: { cardId: C, checklistId: CK, text: "Ship it" }, method: "POST", path: `/api/v1/cards/${C}/checklists/${CK}/items`, body: { text: "Ship it" } },
  { name: "kanera_bulk_add_checklist_items", args: { boardId: B, items: [{ cardId: C, checklistId: CK, text: "Ship it", description: "Details" }] }, method: "POST", path: `/api/v1/boards/${B}/checklist-items/bulk/create`, body: { items: [{ cardId: C, checklistId: CK, text: "Ship it", description: "Details" }] } },
  { name: "kanera_update_checklist_item", args: { cardId: C, checklistId: CK, itemId: IT, changes: { description: "More context", completed: true } }, method: "PATCH", path: `/api/v1/cards/${C}/checklists/${CK}/items/${IT}`, body: { description: "More context", completed: true } },
  { name: "kanera_bulk_update_checklist_items", args: { cardId: C, checklistId: CK, changes: { assigneeId: U } }, method: "PATCH", path: `/api/v1/cards/${C}/checklists/${CK}/items/bulk`, body: { assigneeId: U } },
  { name: "kanera_bulk_set_checklist_item_descriptions", args: { boardId: B, updates: [{ cardId: C, checklistId: CK, itemId: IT, description: "Migrated comment" }] }, method: "PATCH", path: `/api/v1/boards/${B}/checklist-items/bulk/descriptions`, body: { updates: [{ cardId: C, checklistId: CK, itemId: IT, description: "Migrated comment" }] } },
  { name: "kanera_delete_checklist_item", args: { cardId: C, checklistId: CK, itemId: IT }, method: "DELETE", path: `/api/v1/cards/${C}/checklists/${CK}/items/${IT}` },
  { name: "kanera_move_checklist_item", args: { cardId: C, checklistId: CK, itemId: IT, targetChecklistId: CK, anchor: { side: "before", id: IT } }, method: "POST", path: `/api/v1/cards/${C}/checklists/${CK}/items/${IT}/move`, body: { checklistId: CK, beforeItemId: IT } },
  { name: "kanera_list_completed_work", args: { boardId: B, limit: 30 }, method: "GET", path: `/api/v1/boards/${B}/completed?limit=30` },
  { name: "kanera_list_work_done", args: { boardId: B, from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z" }, method: "GET", path: `/api/v1/boards/${B}/work-done?from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-30T00%3A00%3A00.000Z` },
  { name: "kanera_list_my_work_history", args: { preset: "yesterday", limit: 50 }, method: "POST", path: "/api/v1/me/work-history", body: { preset: "yesterday", limit: 50 } },
  { name: "kanera_list_my_current_work", args: { limit: 50 }, method: "POST", path: "/api/v1/me/current-work", body: { limit: 50 } },
  { name: "kanera_duplicate_card", args: { cardId: C, boardId: B, listId: L, atTop: true }, method: "POST", path: `/api/v1/cards/${C}/duplicate`, body: { boardId: B, listId: L, atTop: true } },
  { name: "kanera_move_card_to_board", args: { cardId: C, boardId: B, listId: L }, method: "POST", path: `/api/v1/cards/${C}/move-to-board`, body: { boardId: B, listId: L } },
  { name: "kanera_list_card_comments", args: { cardId: C, limit: 50 }, method: "GET", path: `/api/v1/cards/${C}/comments?limit=50` },
  { name: "kanera_delete_comment", args: { commentId: N }, method: "DELETE", path: `/api/v1/comments/${N}` },
  { name: "kanera_bulk_delete_comments", args: { boardId: B, commentIds: [N] }, method: "POST", path: `/api/v1/boards/${B}/comments/bulk/delete`, body: { commentIds: [N] } },
  { name: "kanera_query_work_cards", args: { lens: "team", limit: 50 }, method: "POST", path: "/api/v1/work/cards/query", body: { lens: "team", limit: 50 } },
  { name: "kanera_get_portfolio_summary", args: { days: 30, timeZone: "UTC" }, method: "POST", path: "/api/v1/work/portfolio/query", body: { days: 30, timeZone: "UTC" } },
  { name: "kanera_update_comment", args: { commentId: N, body: "Updated" }, method: "PATCH", path: `/api/v1/comments/${N}`, body: { body: "Updated" } },
  { name: "kanera_set_comment_reaction", args: { commentId: N, type: "thumbs_up", active: true }, method: "POST", path: `/api/v1/comments/${N}/reactions`, body: { type: "thumbs_up" } },
  { name: "kanera_delete_card_attachment", args: { cardId: C, attachmentId: N }, method: "DELETE", path: `/api/v1/cards/${C}/attachments/${N}` },
  { name: "kanera_set_card_cover", args: { cardId: C, attachmentId: N }, method: "PATCH", path: `/api/v1/cards/${C}/cover`, body: { attachmentId: N } },
];

const nonDefaultToolNames = new Set([
  "kanera_create_workspace", "kanera_create_standalone_board", "kanera_set_standalone_board_retention",
  "kanera_update_workspace", "kanera_create_workspace_board", "kanera_update_board", "kanera_move_workspace_board",
  "kanera_create_list", "kanera_update_list", "kanera_move_list", "kanera_create_custom_field",
  "kanera_update_custom_field", "kanera_move_custom_field", "kanera_create_custom_field_option",
  "kanera_update_custom_field_option", "kanera_move_custom_field_option", "kanera_create_label", "kanera_update_label",
  "kanera_move_label", "kanera_bulk_add_comments", "kanera_bulk_delete_comments",
  "kanera_bulk_add_checklist_items", "kanera_bulk_set_checklist_item_descriptions",
]);
const toolCases = allToolCases.filter((item) => !nonDefaultToolNames.has(item.name));

type ExpectedRequest = { method: string; path: string; body?: unknown };
type MultiRequestToolCase = { name: string; args: unknown; requests: ExpectedRequest[] };
type MultipartToolCase = {
  name: string;
  args: unknown;
  method: string;
  path: string;
  fileName: string;
  mimeType: string;
  text: string;
};

const standaloneLookupRequests: ExpectedRequest[] = [
  { method: "GET", path: `/api/v1/boards/${B}` },
  { method: "GET", path: `/api/v1/workspaces/${W}` },
];
const multiRequestToolCases: MultiRequestToolCase[] = [
  { name: "kanera_get_standalone_board_settings", args: { boardId: B }, requests: standaloneLookupRequests },
  {
    name: "kanera_add_note_link",
    args: { noteId: N, url: "https://example.com/spec", label: "Spec" },
    requests: [
      { method: "GET", path: `/api/v1/notes/${N}` },
      {
        method: "PATCH",
        path: `/api/v1/notes/${N}`,
        body: {
          content: "Existing\n\n[Spec](<https://example.com/spec>)",
          baseUpdatedAt: "2026-06-30T00:00:00.000Z",
        },
      },
    ],
  },
];
const multipartToolCases: MultipartToolCase[] = [{
  name: "kanera_add_note_attachment",
  args: {
    noteId: N,
    fileName: "brief.txt",
    mimeType: "text/plain",
    fileBase64: Buffer.from("hello").toString("base64"),
    source: "attachment",
  },
  method: "POST",
  path: `/api/v1/notes/${N}/attachments?source=attachment`,
  fileName: "brief.txt",
  mimeType: "text/plain",
  text: "hello",
}, {
  name: "kanera_add_card_attachment",
  args: {
    cardId: C,
    fileName: "brief.txt",
    mimeType: "text/plain",
    fileBase64: Buffer.from("hello").toString("base64"),
    source: "attachment",
  },
  method: "POST",
  path: `/api/v1/cards/${C}/attachments?source=attachment`,
  fileName: "brief.txt",
  mimeType: "text/plain",
  text: "hello",
}];

void test("every MCP tool maps to the expected public API request", async () => {
  const server = internals();
  const expectedNames = [...new Set([...toolCases, ...multiRequestToolCases, ...multipartToolCases].map((item) => item.name))].sort();
  assert.equal(expectedNames.length, 69);
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
        if (url.pathname === "/api/v1/boards") {
          return new Response(JSON.stringify([{ id: B, workspaceId: W }]), { status: 200 });
        }
        if (url.pathname === `/api/v1/workspaces/${W}/boards`) {
          return new Response(JSON.stringify([{ id: B, workspaceId: W }]), { status: 200 });
        }
        if (url.pathname === `/api/v1/workspaces/${W}/members`) {
          return new Response(JSON.stringify([{ userId: U }]), { status: 200 });
        }
        if (url.pathname === `/api/v1/workspaces/${W}/notes` || url.pathname === `/api/v1/boards/${B}/notes`) {
          return new Response(JSON.stringify([{ id: N }]), { status: 200 });
        }
        if (url.pathname === `/api/v1/notes/${N}/attachments`) {
          return new Response(JSON.stringify([{ id: O }]), { status: 200 });
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
        if (url.pathname === `/api/v1/notes/${N}` && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({
            id: N,
            content: "Existing",
            updatedAt: "2026-06-30T00:00:00.000Z",
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
        if (url.pathname === `/api/v1/notes/${N}` && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({
            id: N,
            content: "Existing",
            updatedAt: "2026-06-30T00:00:00.000Z",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      await server._registeredTools[item.name]!.handler(item.args);
      assert.deepEqual(requests, item.requests, item.name);
    }

    for (const item of multipartToolCases) {
      let request: Omit<MultipartToolCase, "name" | "args"> | undefined;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        assert.ok(init?.body instanceof FormData);
        const file = init.body.get("file") as File;
        request = {
          method: init.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          fileName: file.name,
          mimeType: file.type,
          text: await file.text(),
        };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      await server._registeredTools[item.name]!.handler(item.args);
      assert.deepEqual(request, {
        method: item.method,
        path: item.path,
        fileName: item.fileName,
        mimeType: item.mimeType,
        text: item.text,
      }, item.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("every MCP tool exposes structured output without a generic output schema and has explicit safety annotations", async () => {
  const tools = internals()._registeredTools;
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.title?.trim(), `${name} title`);
    assert.ok(tool.description?.trim(), `${name} description`);
    assert.equal(tool.outputSchema, undefined, `${name} does not advertise an untyped generic output schema`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${name} destructiveHint`);
    assert.equal(typeof tool.annotations?.idempotentHint, "boolean", `${name} idempotentHint`);
    assert.equal(tool.annotations?.openWorldHint, false, `${name} stays inside Kanera`);
  }
  assert.equal(tools.kanera_delete_comment?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_bulk_archive_cards?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_bulk_duplicate_cards?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_update_card?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_duplicate_card?.annotations?.destructiveHint, false);
  assert.equal(tools.kanera_duplicate_note?.annotations?.destructiveHint, false);
  assert.equal(tools.kanera_add_note_attachment?.annotations?.destructiveHint, false);
  assert.equal(tools.kanera_add_note_link?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_move_note?.annotations?.destructiveHint, true);
  assert.equal("kanera_delete_note" in tools, false);
  assert.equal(tools.kanera_bulk_update_checklist_items?.annotations?.idempotentHint, true);
  assert.equal(tools.kanera_add_card_attachment?.annotations?.idempotentHint, false);
  assert.equal(tools.kanera_delete_card_attachment?.annotations?.destructiveHint, true);
  assert.equal(tools.kanera_query_work_cards?.annotations?.readOnlyHint, true);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: W }]), { status: 200 });
    const result = await tools.kanera_list_workspaces!.handler({ limit: 25 });
    assert.deepEqual(result.structuredContent, { result: { items: [{ id: W }], nextCursor: null } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("tools/list exposes bounded batch content, constrained work mutations, and omits migration writes", async () => {
  const server = createKaneraMcpServer({ apiKey: "kanera_live_test", publicApiUrl: "https://api.example.test" });
  const client = new Client({ name: "kanera-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const createChecklist = byName.get("kanera_create_checklist");
    const updateItem = tools.find((tool) => tool.name === "kanera_update_checklist_item");
    const updateCard = byName.get("kanera_update_card");
    const moveCard = byName.get("kanera_move_card");
    const createNote = byName.get("kanera_create_note");
    const customFieldValue = byName.get("kanera_set_custom_field_value");
    const getCardsContent = byName.get("kanera_get_cards_content");

    assert.ok(createChecklist, "kanera_create_checklist is advertised");
    assert.ok(updateItem, "kanera_update_checklist_item is advertised");
    assert.ok(createChecklist.inputSchema.properties?.parentItemId, "sub-checklist parentItemId is advertised");
    assert.ok(updateItem.inputSchema.properties?.changes, "non-empty checklist changes are nested and required");
    assert.ok(updateCard?.inputSchema.properties?.changes, "non-empty card changes are nested and required");
    assert.ok(moveCard?.inputSchema.properties?.anchor, "card movement has one required anchor");
    assert.ok(createNote?.inputSchema.properties?.target, "note creation has one explicit target");
    assert.ok(customFieldValue?.inputSchema.properties?.value, "custom-field values use a typed value union");
    assert.ok(byName.get("kanera_list_workspaces")?.inputSchema.properties?.cursor, "workspace discovery is paginated");
    assert.ok(byName.get("kanera_list_accessible_boards")?.inputSchema.properties?.cursor, "board discovery is paginated");
    assert.ok(byName.get("kanera_list_notes")?.inputSchema.properties?.cursor, "note discovery is paginated");
    assert.ok(getCardsContent?.inputSchema.properties?.cardIds, "bounded selected-card content reads are advertised");
    assert.match(getCardsContent?.description ?? "", /up to 200 selected cards/i);
    assert.ok(JSON.stringify(tools).length <= 105_000, "the default tool catalog stays within its 105k-character budget");
    for (const name of [
      "kanera_bulk_add_comments",
      "kanera_bulk_delete_comments",
      "kanera_bulk_add_checklist_items",
      "kanera_bulk_set_checklist_item_descriptions",
    ]) assert.equal(byName.has(name), false, `${name} is not in the default MCP`);
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
    const getCard = tools.find((tool) => tool.name === "kanera_get_card");
    const cardHistory = tools.find((tool) => tool.name === "kanera_list_card_history");
    const myWorkHistory = tools.find((tool) => tool.name === "kanera_list_my_work_history");
    const myCurrentWork = tools.find((tool) => tool.name === "kanera_list_my_current_work");

    assert.equal(tools.some((tool) => tool.name === "kanera_open_board"), false, "kanera_open_board is not advertised");
    assert.ok(getBoard, "kanera_get_board is advertised");
    assert.ok(getCardsList, "kanera_get_cards_list is advertised");
    assert.ok(getCard, "kanera_get_card is advertised");
    assert.ok(cardHistory, "kanera_list_card_history is advertised");
    assert.ok(myWorkHistory, "kanera_list_my_work_history is advertised");
    assert.ok(myCurrentWork, "kanera_list_my_current_work is advertised");
    assert.match(getBoard.description ?? "", /without cards/i);
    assert.ok(getCardsList.inputSchema.properties?.boardId, "boardId is advertised");
    assert.ok(getCardsList.inputSchema.properties?.listId, "one listId is advertised");
    assert.ok(getCardsList.inputSchema.properties?.cursor, "cursor pagination is advertised");
    assert.ok(getCardsList.inputSchema.properties?.limit, "bounded page limit is advertised");
    assert.match(getCardsList.description ?? "", /never returns.*unbounded/i);
    assert.match(JSON.stringify(getCard.inputSchema.properties?.cardId), /human key such as PROJ-123/i);
    assert.match(JSON.stringify(cardHistory.inputSchema.properties?.cardId), /human key such as PROJ-123/i);
    assert.ok(cardHistory.inputSchema.properties?.cursor, "card history is cursor-paginated");
    assert.ok(myWorkHistory.inputSchema.properties?.preset, "personal history exposes calendar presets");
    assert.ok(myCurrentWork.inputSchema.properties?.cursor, "current work is cursor-paginated");
  } finally {
    await client.close();
    await server.close();
  }
});

void test("tools/list keeps administration UI-only and retains no aliases", async () => {
  const server = createKaneraMcpServer({ apiKey: "kanera_live_test", publicApiUrl: "https://api.example.test" });
  const client = new Client({ name: "kanera-admin-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const listAccessibleBoards = byName.get("kanera_list_accessible_boards");
    assert.ok(listAccessibleBoards);
    assert.match(listAccessibleBoards.description ?? "", /cross-organisation guest board/i);
    for (const uiOnlyOrLegacyName of [
      "kanera_create_workspace",
      "kanera_create_standalone_board",
      "kanera_set_standalone_board_retention",
      "kanera_update_workspace",
      "kanera_create_workspace_board",
      "kanera_update_board",
      "kanera_move_workspace_board",
      "kanera_create_list",
      "kanera_update_list",
      "kanera_move_list",
      "kanera_create_custom_field",
      "kanera_update_custom_field",
      "kanera_move_custom_field",
      "kanera_create_custom_field_option",
      "kanera_update_custom_field_option",
      "kanera_move_custom_field_option",
      "kanera_create_label",
      "kanera_update_label",
      "kanera_move_label",
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
      assert.equal(byName.has(uiOnlyOrLegacyName), false, `${uiOnlyOrLegacyName} is not in the work-focused contract`);
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
    ["board", B, `/api/v1/boards/${B}/open?includeCards=false`],
    ["card", C, `/api/v1/cards/${C}/detail`],
    ["note", N, `/api/v1/notes/${N}`],
  ] as const;
  assert.deepEqual(Object.keys(server._registeredResourceTemplates).sort(), cases.map(([name]) => name).sort());
  const originalFetch = globalThis.fetch;
  try {
    for (const [name, id, expectedPath] of cases) {
      let path = "";
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        path = `${url.pathname}${url.search}`;
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
    ["prepare_standup_update", { period: "last_week" }, "last_week"],
    ["draft_card_from_notes", { noteId: N }, N],
  ] as const;
  assert.deepEqual(Object.keys(prompts).sort(), cases.map(([name]) => name).sort());
  for (const [name, args, target] of cases) {
    const result = prompts[name]!.callback(args);
    assert.match(result.messages[0]!.content.text, new RegExp(target));
  }
});
