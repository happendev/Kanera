import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { env } from "./env.js";
import { KaneraApiError, KaneraClient } from "./kanera-client.js";

const uuid = z.uuid();
const pageLimit = z.number().int().min(1).max(100).default(25);
type ToolArgs<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;

export interface KaneraMcpContext {
  apiKey: string;
  publicApiUrl?: string;
}

function client(ctx: KaneraMcpContext) {
  return new KaneraClient({ baseUrl: ctx.publicApiUrl ?? env.KANERA_PUBLIC_API_URL, apiKey: ctx.apiKey });
}

function content(data: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  if (error instanceof KaneraApiError) {
    return content({ error: { status: error.status, code: error.code, message: error.message, retryAfter: error.retryAfter ?? undefined } });
  }
  throw error;
}

function validationError(message: string): never {
  throw new KaneraApiError(400, "VALIDATION_ERROR", message);
}

function noteTargetPath(args: { workspaceId?: string; boardId?: string }, suffix: string) {
  if (Boolean(args.workspaceId) === Boolean(args.boardId)) {
    validationError("provide exactly one of workspaceId or boardId");
  }
  return args.boardId
    ? `/api/v1/boards/${args.boardId}/${suffix}`
    : `/api/v1/workspaces/${args.workspaceId}/${suffix}`;
}

function registerKaneraTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: (args: ToolArgs<T>, api: KaneraClient) => Promise<unknown>,
  ctx: KaneraMcpContext,
) {
  const registerTool = server.registerTool.bind(server) as unknown as (
    toolName: string,
    config: { description: string; inputSchema: T },
    callback: (args: unknown) => Promise<CallToolResult>,
  ) => void;
  registerTool(name, { description, inputSchema }, async (args): Promise<CallToolResult> => {
    try {
      return content(await handler(args as ToolArgs<T>, client(ctx)));
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function createKaneraMcpServer(ctx: KaneraMcpContext) {
  const server = new McpServer(
    { name: "kanera", version: "0.1.0" },
    { instructions: "Kanera lists and custom fields are workspace-scoped. Private board access follows existing API key workspace scope. Event payloads are full entities, not diffs." },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, ctx: KaneraMcpContext) {
  registerKaneraTool(server, "kanera_list_workspaces", "List workspaces visible to the API key.", { limit: pageLimit }, (a, api) =>
    api.get("/api/v1/workspaces", { limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_open_workspace", "Open one workspace.", { workspaceId: uuid }, (a, api) =>
    api.get(`/api/v1/workspaces/${a.workspaceId}`), ctx);
  registerKaneraTool(server, "kanera_list_boards", "List boards in a workspace.", { workspaceId: uuid }, (a, api) =>
    api.get(`/api/v1/workspaces/${a.workspaceId}/boards`), ctx);
  registerKaneraTool(server, "kanera_open_board", "Open a board with lists, visible cards, members, labels, and workspace custom fields.", {
    boardId: uuid,
    includeCompleted: z.boolean().default(false),
    archived: z.boolean().default(false),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/open`, undefined, { includeCompleted: a.includeCompleted, archived: a.archived }), ctx);
  registerKaneraTool(server, "kanera_search", "Search cards, notes, comments, and attachment filenames across the API key workspace.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(8),
  }, (a, api) => api.get("/api/v1/search", { q: a.query, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_get_card", "Read a card detail, including labels, assignees, checklists, attachments, and linked notes.", { cardId: uuid }, (a, api) =>
    api.get(`/api/v1/cards/${a.cardId}/detail`), ctx);
  registerKaneraTool(server, "kanera_create_card", "Create a card in a workspace-scoped list on a board. Requires write/admin.", {
    boardId: uuid,
    listId: uuid.describe("Target list id. Lists are workspace-scoped."),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).optional(),
    atTop: z.boolean().optional(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards`, { title: a.title, description: a.description, atTop: a.atTop }), ctx);
  registerKaneraTool(server, "kanera_update_card", "Update card title, description, or due date. Requires write/admin.", {
    cardId: uuid,
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(50000).nullable().optional(),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/cards/${a.cardId}`, { title: a.title, description: a.description, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_move_card", "Move or reorder a card. Rebalance and moved events are emitted by the public API. Requires write/admin.", {
    cardId: uuid,
    listId: uuid,
    afterCardId: uuid.nullable().optional(),
    beforeCardId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/move`, { listId: a.listId, afterCardId: a.afterCardId, beforeCardId: a.beforeCardId }), ctx);
  registerKaneraTool(server, "kanera_archive_card", "Archive or unarchive a card. Requires write/admin.", { cardId: uuid, archived: z.boolean().default(true) }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/archive`, { archived: a.archived }), ctx);
  registerKaneraTool(server, "kanera_set_card_assignees", "Replace card assignees. Requires write/admin.", { cardId: uuid, userIds: z.array(uuid).max(100) }, (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/assignees`, { userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_set_card_labels", "Replace card labels. Requires write/admin.", { cardId: uuid, labelIds: z.array(uuid).max(100) }, (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/labels`, { labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_set_custom_field_value", "Set one workspace-scoped custom field value on a card. Requires write/admin.", customFieldValueSchema(), (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/custom-fields/${a.fieldId}`, a), ctx);
  registerKaneraTool(server, "kanera_add_comment", "Add a comment to a card. Requires write/admin.", { cardId: uuid, body: z.string().min(1).max(20000) }, (a, api) =>
    api.post(`/api/v1/cards/${a.cardId}/comments`, { body: a.body }), ctx);
  registerKaneraTool(server, "kanera_list_activity", "List recent board activity and comments.", { boardId: uuid, limit: pageLimit }, (a, api) =>
    api.get(`/api/v1/boards/${a.boardId}/activity`, { limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_list_assigned_work", "List assigned active cards in a workspace, optionally for one user.", {
    workspaceId: uuid,
    userId: uuid.optional(),
  }, (a, api) => a.userId ? api.get(`/api/v1/workspaces/${a.workspaceId}/assignees/${a.userId}/cards`) : api.get(`/api/v1/workspaces/${a.workspaceId}/assignees/cards`), ctx);
  registerKaneraTool(server, "kanera_list_notes", "List workspace or board notes by scope.", {
    workspaceId: uuid.optional(),
    boardId: uuid.optional(),
    scope: z.enum(["personal", "team"]).default("team"),
  }, (a, api) => api.get(noteTargetPath(a, "notes"), { scope: a.scope }), ctx);
  registerKaneraTool(server, "kanera_get_note", "Read a note.", { noteId: uuid }, (a, api) => api.get(`/api/v1/notes/${a.noteId}`), ctx);
  registerKaneraTool(server, "kanera_create_note", "Create a workspace or board note. Team notes require write/admin.", noteMutationSchema(), (a, api) =>
    api.post(noteTargetPath(a, "notes"), { scope: a.scope, parentNoteId: a.parentNoteId, title: a.title, icon: a.icon }), ctx);
  registerKaneraTool(server, "kanera_update_note", "Update a note. Team note edits respect Kanera note locks. Requires write/admin for team notes.", {
    noteId: uuid,
    title: z.string().max(200).optional(),
    content: z.string().max(50000).optional(),
    icon: z.string().min(1).max(60).nullable().optional(),
    baseUpdatedAt: z.iso.datetime().optional(),
  }, (a, api) => api.patch(`/api/v1/notes/${a.noteId}`, { title: a.title, content: a.content, icon: a.icon, baseUpdatedAt: a.baseUpdatedAt }), ctx);
}

function customFieldValueSchema() {
  return {
    cardId: uuid,
    fieldId: uuid,
    valueText: z.string().max(20000).nullable().optional(),
    valueNumber: z.union([z.number(), z.string()]).nullable().optional(),
    valueCheckbox: z.boolean().nullable().optional(),
    valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    valueUrl: z.url().max(2000).nullable().optional(),
    valueOptionIds: z.array(uuid).nullable().optional(),
    valueUserIds: z.array(uuid).nullable().optional(),
  };
}

function noteMutationSchema() {
  return {
    workspaceId: uuid.optional(),
    boardId: uuid.optional(),
    scope: z.enum(["personal", "team"]).default("team"),
    parentNoteId: uuid.nullable().optional(),
    title: z.string().max(200).optional(),
    icon: z.string().min(1).max(60).nullable().optional(),
  };
}

function registerResources(server: McpServer, ctx: KaneraMcpContext) {
  registerResource(server, "workspace", "kanera://workspace/{workspaceId}", "Kanera workspace", (vars, api) => api.get(`/api/v1/workspaces/${vars.workspaceId}`), ctx);
  registerResource(server, "board", "kanera://board/{boardId}", "Kanera board", (vars, api) => api.post(`/api/v1/boards/${vars.boardId}/open`), ctx);
  registerResource(server, "card", "kanera://card/{cardId}", "Kanera card detail", (vars, api) => api.get(`/api/v1/cards/${vars.cardId}/detail`), ctx);
  registerResource(server, "note", "kanera://note/{noteId}", "Kanera note", (vars, api) => api.get(`/api/v1/notes/${vars.noteId}`), ctx);
}

function registerResource(
  server: McpServer,
  name: string,
  template: string,
  description: string,
  read: (vars: Record<string, string>, api: KaneraClient) => Promise<unknown>,
  ctx: KaneraMcpContext,
) {
  server.registerResource(name, new ResourceTemplate(template, { list: undefined }), { description, mimeType: "application/json" }, async (uri, vars) => {
    const data = await read(vars as Record<string, string>, client(ctx));
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  });
}

function registerPrompts(server: McpServer) {
  server.registerPrompt("summarize_board_status", { description: "Summarize board progress, blockers, stale cards, and next actions.", argsSchema: { boardId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Open kanera://board/${a.boardId}, inspect lists/cards/activity, and summarize board status with blockers and next actions.` } }],
  }));
  server.registerPrompt("prepare_standup_update", { description: "Prepare a standup update from assigned work and recent board activity.", argsSchema: { workspaceId: uuid, userId: uuid.optional() } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Use Kanera assigned work for workspace ${a.workspaceId}${a.userId ? ` and user ${a.userId}` : ""}. Draft a concise yesterday/today/blockers standup update.` } }],
  }));
  server.registerPrompt("triage_assigned_work", { description: "Triage assigned Kanera work by urgency, stale state, and missing metadata.", argsSchema: { workspaceId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `List assigned Kanera work in workspace ${a.workspaceId}, group it by urgency, and flag stale or underspecified cards.` } }],
  }));
  server.registerPrompt("draft_card_from_notes", { description: "Draft a card title and description from one or more notes.", argsSchema: { noteId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Read kanera://note/${a.noteId} and draft a Kanera card title plus Markdown description. Do not create the card until asked.` } }],
  }));
}
