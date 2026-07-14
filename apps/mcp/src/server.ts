import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { env } from "./env.js";
import { KaneraApiError, KaneraClient } from "./kanera-client.js";

const uuid = z.uuid();
const pageLimit = z.number().int().min(1).max(100).default(25);
type ToolArgs<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;
const require = createRequire(import.meta.url);
// Load the runtime tuple from the shared package without making TypeScript compile shared sources
// outside this package's rootDir. The MCP schema and public API now have one color source of truth.
const { COLOR_TOKENS } = require("@kanera/shared/colors") as { COLOR_TOKENS: readonly [string, ...string[]] };
const colorToken = z.enum(COLOR_TOKENS);
const mcpPackage = require("../package.json") as { version: string };

export interface KaneraMcpContext {
  apiKey: string;
  publicApiUrl?: string;
}

function client(ctx: KaneraMcpContext) {
  return new KaneraClient({ baseUrl: ctx.publicApiUrl ?? env.KANERA_PUBLIC_API_URL, apiKey: ctx.apiKey });
}

const toolOutputSchema = { result: z.unknown() };
const serverDescription = "Read and manage Kanera workspaces, boards, lists, cards, assigned work, notes, comments, labels, custom fields, and activity.";
const serverIcons = [{
  src: "https://www.kanera.app/assets/favicon/android-chrome-512x512.png",
  mimeType: "image/png" as const,
  sizes: ["512x512"],
}];

function content(data: unknown): CallToolResult {
  // Keep the text block for older hosts while giving modern clients a typed value that does not
  // need to be reparsed from JSON. Wrapping the value also keeps array-valued API responses valid
  // MCP structuredContent, whose root must be an object.
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
  };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof KaneraApiError) {
    const data = { error: { status: error.status, code: error.code, message: error.message, retryAfter: error.retryAfter ?? undefined } };
    // Tool-domain failures must be marked as errors so the model can correct its arguments or ask
    // for authorization instead of treating the serialized problem document as a successful read.
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: true,
    };
  }
  throw error;
}

const readToolPrefixes = ["kanera_list_", "kanera_open_", "kanera_get_", "kanera_search", "kanera_resolve"];
const destructiveTools = new Set([
  "kanera_archive_card",
  "kanera_archive_list_cards",
  "kanera_bulk_archive_cards",
  "kanera_bulk_patch_card_assignees",
  "kanera_bulk_patch_card_labels",
  "kanera_bulk_set_card_custom_field",
  "kanera_bulk_delete_comments",
  "kanera_delete_comment",
  "kanera_delete_checklist",
  "kanera_delete_checklist_item",
]);
const idempotentMutationPrefixes = [
  "kanera_update_",
  "kanera_set_",
  "kanera_delete_",
  "kanera_archive_",
  "kanera_bulk_set_",
  "kanera_bulk_patch_",
  "kanera_bulk_move_",
  "kanera_bulk_archive_",
  "kanera_bulk_delete_",
  "kanera_move_",
];
const boardBatchScope = "Board-scoped: for workspace-wide work, list the workspace's boards and call this separately for each board.";

function toolTitle(name: string) {
  return name
    .replace(/^kanera_/, "")
    .split("_")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function toolAnnotations(name: string): ToolAnnotations {
  const readOnly = readToolPrefixes.some((prefix) => name.startsWith(prefix));
  return {
    title: toolTitle(name),
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : destructiveTools.has(name),
    idempotentHint: readOnly || idempotentMutationPrefixes.some((prefix) => name.startsWith(prefix)),
    // Kanera tools stay within the authenticated Kanera tenant and do not contact arbitrary hosts.
    openWorldHint: false,
  };
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
    config: {
      title: string;
      description: string;
      inputSchema: T;
      outputSchema: typeof toolOutputSchema;
      annotations: ToolAnnotations;
    },
    callback: (args: unknown) => Promise<CallToolResult>,
  ) => void;
  registerTool(name, {
    title: toolTitle(name),
    description,
    inputSchema,
    outputSchema: toolOutputSchema,
    annotations: toolAnnotations(name),
  }, async (args): Promise<CallToolResult> => {
    try {
      return content(await handler(args as ToolArgs<T>, client(ctx)));
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function createKaneraMcpServer(ctx: KaneraMcpContext) {
  const server = new McpServer(
    {
      name: "kanera",
      title: "Kanera",
      description: serverDescription,
      websiteUrl: "https://www.kanera.app",
      version: mcpPackage.version,
      // Advertise branding in the live initialize response as well as the registry manifest;
      // custom MCP clients connect directly to /mcp and never discover server.json.
      icons: serverIcons,
    },
    { instructions: "Kanera lists, labels, and custom fields are workspace-scoped. Use kanera_list_home_boards for complete board discovery, including cross-organisation guest boards. Board access follows explicit board membership, and a key reaches boards according to its own access: a workspace key reaches every board in its one workspace, while a personal key or OAuth connection inherits its owner's current organisation, workspace, and board permissions across workspaces. Write-scoped OAuth connections can perform supported workspace administration wherever their owner is currently an administrator; read-only OAuth grants cannot mutate. Event payloads are full entities, not diffs." },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, ctx: KaneraMcpContext) {
  registerKaneraTool(server, "kanera_get_session", "Describe the current Kanera credential, effective scope, pinned workspace if any, and canonical Kanera web URL.", {}, (_a, api) =>
    api.get("/api/v1/session"), ctx);
  registerKaneraTool(server, "kanera_list_workspaces", "List workspaces the credential can access at workspace scope. This excludes parent workspaces reached only through cross-organisation guest boards; use kanera_list_home_boards for complete board discovery.", { limit: pageLimit }, (a, api) =>
    api.get("/api/v1/workspaces", { limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_list_home_boards", "Discover every accessible board grouped by workspace. For personal keys and user OAuth, groups contains workspace-accessible boards and guestGroups contains cross-organisation boards explicitly shared with the user. Use this when asked which boards the user has.", {}, (_a, api) =>
    api.get("/api/v1/home/boards"), ctx);
  registerKaneraTool(server, "kanera_open_workspace", "Open one workspace.", { workspaceId: uuid }, (a, api) =>
    api.get(`/api/v1/workspaces/${a.workspaceId}`), ctx);
  registerKaneraTool(server, "kanera_list_boards", "List boards in a workspace.", { workspaceId: uuid }, (a, api) =>
    api.get(`/api/v1/workspaces/${a.workspaceId}/boards`), ctx);
  registerKaneraTool(server, "kanera_list_workspace_members", "List workspace members with userId, displayName, email, and role. Use to resolve a person's name to the userId that assignee tools require.", { workspaceId: uuid }, (a, api) =>
    api.get(`/api/v1/workspaces/${a.workspaceId}/members`), ctx);
  registerKaneraTool(server, "kanera_create_workspace", "Create a workspace with Kanera's default lists, custom fields, and labels. Requires a write-scoped personal/OAuth credential whose owner is an organisation admin. This is not idempotent; do not retry after an ambiguous success.", {
    name: z.string().min(1).max(120),
  }, (a, api) => api.post("/api/v1/workspaces", { name: a.name }), ctx);
  registerKaneraTool(server, "kanera_update_workspace", "Rename a workspace or change how long completed cards stay active. Requires workspace admin.", {
    workspaceId: uuid,
    name: z.string().min(1).max(120).optional(),
    completedCardsActiveDays: z.number().int().min(0).max(365).optional(),
  }, (a, api) => api.patch(`/api/v1/workspaces/${a.workspaceId}`, {
    name: a.name,
    completedCardsActiveDays: a.completedCardsActiveDays,
  }), ctx);
  registerKaneraTool(server, "kanera_create_board", "Create a board in a workspace. Requires workspace admin. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    name: z.string().min(1).max(35),
    groupId: uuid.nullable().optional(),
    description: z.string().max(2000).optional(),
  }, (a, api) => api.post(`/api/v1/workspaces/${a.workspaceId}/boards`, {
    name: a.name,
    groupId: a.groupId,
    description: a.description,
  }), ctx);
  registerKaneraTool(server, "kanera_update_board", "Rename, describe, or regroup a board. Requires workspace admin.", {
    boardId: uuid,
    name: z.string().min(1).max(35).optional(),
    groupId: uuid.nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}`, {
    name: a.name,
    groupId: a.groupId,
    description: a.description,
  }), ctx);
  registerKaneraTool(server, "kanera_move_board", "Reorder a board. Provide afterBoardId or beforeBoardId; null moves to the corresponding edge. Requires workspace admin.", {
    boardId: uuid,
    afterBoardId: uuid.nullable().optional(),
    beforeBoardId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/move`, {
    afterBoardId: a.afterBoardId,
    beforeBoardId: a.beforeBoardId,
  }), ctx);
  registerKaneraTool(server, "kanera_create_list", "Create a workspace-scoped list. Requires workspace admin. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    name: z.string().min(1).max(35),
  }, (a, api) => api.post(`/api/v1/workspaces/${a.workspaceId}/lists`, { name: a.name }), ctx);
  registerKaneraTool(server, "kanera_update_list", "Rename a workspace-scoped list. Requires workspace admin.", {
    listId: uuid,
    name: z.string().min(1).max(35),
  }, (a, api) => api.patch(`/api/v1/lists/${a.listId}`, { name: a.name }), ctx);
  registerKaneraTool(server, "kanera_move_list", "Reorder a workspace-scoped list. Provide afterListId or beforeListId; null moves to the corresponding edge. Requires workspace admin.", {
    listId: uuid,
    afterListId: uuid.nullable().optional(),
    beforeListId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/lists/${a.listId}/move`, {
    afterListId: a.afterListId,
    beforeListId: a.beforeListId,
  }), ctx);
  registerKaneraTool(server, "kanera_create_custom_field", "Create a workspace-scoped custom field, optionally seeding select options. Requires workspace admin. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    name: z.string().min(1).max(35),
    type: z.enum(["text", "number", "checkbox", "select", "date", "url", "user"]),
    allowMultiple: z.boolean().default(false),
    options: z.array(z.object({ label: z.string().min(1).max(120) })).max(100).optional(),
  }, (a, api) => api.post(`/api/v1/workspaces/${a.workspaceId}/custom-fields`, {
    name: a.name,
    type: a.type,
    allowMultiple: a.allowMultiple,
    options: a.options,
  }), ctx);
  registerKaneraTool(server, "kanera_update_custom_field", "Rename a custom field or change its card visibility/multiple-value behavior. Requires workspace admin.", {
    fieldId: uuid,
    name: z.string().min(1).max(35).optional(),
    showOnCard: z.boolean().optional(),
    allowMultiple: z.boolean().optional(),
  }, (a, api) => api.patch(`/api/v1/custom-fields/${a.fieldId}`, {
    name: a.name,
    showOnCard: a.showOnCard,
    allowMultiple: a.allowMultiple,
  }), ctx);
  registerKaneraTool(server, "kanera_move_custom_field", "Reorder a workspace-scoped custom field. Provide afterFieldId or beforeFieldId; null moves to the corresponding edge. Requires workspace admin.", {
    fieldId: uuid,
    afterFieldId: uuid.nullable().optional(),
    beforeFieldId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/custom-fields/${a.fieldId}/move`, {
    afterFieldId: a.afterFieldId,
    beforeFieldId: a.beforeFieldId,
  }), ctx);
  registerKaneraTool(server, "kanera_create_custom_field_option", "Add an option to a select custom field. Requires workspace admin. This is not idempotent; do not retry after an ambiguous success.", {
    fieldId: uuid,
    label: z.string().min(1).max(120),
  }, (a, api) => api.post(`/api/v1/custom-fields/${a.fieldId}/options`, { label: a.label }), ctx);
  registerKaneraTool(server, "kanera_update_custom_field_option", "Rename a select custom-field option. Requires workspace admin.", {
    optionId: uuid,
    label: z.string().min(1).max(120),
  }, (a, api) => api.patch(`/api/v1/options/${a.optionId}`, { label: a.label }), ctx);
  registerKaneraTool(server, "kanera_move_custom_field_option", "Reorder a select custom-field option. Provide afterOptionId or beforeOptionId; null moves to the corresponding edge. Requires workspace admin.", {
    optionId: uuid,
    afterOptionId: uuid.nullable().optional(),
    beforeOptionId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/options/${a.optionId}/move`, {
    afterOptionId: a.afterOptionId,
    beforeOptionId: a.beforeOptionId,
  }), ctx);
  registerKaneraTool(server, "kanera_create_label", "Create a workspace-scoped card label. Requires workspace admin. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    name: z.string().min(1).max(25),
    color: colorToken.nullable().optional().describe("Kanera palette token; omit or use null for no color."),
  }, (a, api) => api.post(`/api/v1/workspaces/${a.workspaceId}/card-labels`, { name: a.name, color: a.color }), ctx);
  registerKaneraTool(server, "kanera_update_label", "Rename a workspace-scoped card label. Requires workspace admin.", {
    labelId: uuid,
    name: z.string().min(1).max(25),
  }, (a, api) => api.patch(`/api/v1/card-labels/${a.labelId}`, { name: a.name }), ctx);
  registerKaneraTool(server, "kanera_move_label", "Reorder a workspace-scoped card label. Provide afterLabelId or beforeLabelId; null moves to the corresponding edge. Requires workspace admin.", {
    labelId: uuid,
    afterLabelId: uuid.nullable().optional(),
    beforeLabelId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/card-labels/${a.labelId}/move`, {
    afterLabelId: a.afterLabelId,
    beforeLabelId: a.beforeLabelId,
  }), ctx);
  registerKaneraTool(server, "kanera_open_board", "Open a board with lists, visible cards, members, labels, and workspace custom fields.", {
    boardId: uuid,
    includeCompleted: z.boolean().default(false),
    archived: z.boolean().default(false),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/open`, undefined, { includeCompleted: a.includeCompleted, archived: a.archived }), ctx);
  registerKaneraTool(server, "kanera_search", "Search cards, notes, comments, and attachment filenames across every workspace the API key can access.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(8),
  }, (a, api) => api.get("/api/v1/search", { q: a.query, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_resolve", "Resolve a human phrase to Kanera cards, notes, comments, or attachment references before using an id-based tool.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(8),
  }, (a, api) => api.get("/api/v1/search", { q: a.query, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_get_card", "Read a card detail, including labels, assignees, checklist item descriptions, nested sub-checklists, attachments, and linked notes. Checklists are returned flat; a sub-checklist's parentItemId identifies its owning top-level item.", { cardId: uuid }, (a, api) =>
    api.get(`/api/v1/cards/${a.cardId}/detail`), ctx);
  registerKaneraTool(server, "kanera_get_cards_content", `Read checklist and comment content for up to 200 selected cards in one board. Use this for migrations and audits instead of calling get_card and list_card_comments once per card. Best-effort: ids not on the board are returned in missingCardIds instead of failing the batch, and any card whose comment history is capped is listed in truncatedCardIds (page its full history via list_card_comments). ${boardBatchScope}`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/content/query`, { cardIds: a.cardIds }), ctx);
  registerKaneraTool(server, "kanera_create_card", "Create a card in a workspace-scoped list on a board. Requires write/admin.", {
    boardId: uuid,
    listId: uuid.describe("Target list id. Lists are workspace-scoped."),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).optional(),
    atTop: z.boolean().optional(),
    idempotencyKey: uuid.optional().describe("Stable UUID reused when retrying this create after an ambiguous failure."),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards`, { title: a.title, description: a.description, atTop: a.atTop, clientToken: a.idempotencyKey }), ctx);
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
  registerKaneraTool(server, "kanera_duplicate_card", "Copy a card, optionally into another board/list where the caller can edit. Requires write/admin.", {
    cardId: uuid,
    boardId: uuid.optional().describe("Destination board; defaults to the source board."),
    listId: uuid.optional().describe("Destination list; required when copying across workspaces, otherwise defaults to the source card's list."),
    atTop: z.boolean().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/duplicate`, { boardId: a.boardId, listId: a.listId, atTop: a.atTop }), ctx);
  registerKaneraTool(server, "kanera_move_card_to_board", "Move a card to a different board in the same workspace. Requires write/admin.", {
    cardId: uuid,
    boardId: uuid.describe("Destination board id. Must be in the same workspace."),
    listId: uuid.optional().describe("Destination list; defaults to a matching list on the target board."),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/move-to-board`, { boardId: a.boardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_archive_card", "Archive or unarchive a card. Requires write/admin.", { cardId: uuid, archived: z.boolean().default(true) }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/archive`, { archived: a.archived }), ctx);
  registerKaneraTool(server, "kanera_set_card_completion", "Mark a card complete or incomplete. Distinct from archiving. Requires write/admin.", { cardId: uuid, completed: z.boolean() }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_completion", `Mark up to 200 selected cards complete or incomplete in one board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    completed: z.boolean(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/completion`, { cardIds: a.cardIds, completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_due_date", `Set or clear one due date on up to 200 selected cards in a board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/due-date`, { cardIds: a.cardIds, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_bulk_patch_card_labels", `Add or remove labels on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    labelIds: z.array(uuid).min(1),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/labels`, { cardIds: a.cardIds, mode: a.mode, labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_bulk_patch_card_assignees", `Add or remove assignees on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    userIds: z.array(uuid).min(1),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/assignees`, { cardIds: a.cardIds, mode: a.mode, userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_bulk_move_cards", `Move up to 200 selected active cards to one workspace-scoped list in their board. Returns moved cards and skipped archived card ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    listId: uuid,
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/move`, { cardIds: a.cardIds, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_bulk_archive_cards", `Archive up to 200 selected cards in one board. This is destructive and cannot bulk-unarchive. Returns archived cards. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/archive`, { cardIds: a.cardIds, archived: true }), ctx);
  registerKaneraTool(server, "kanera_bulk_duplicate_cards", `Duplicate up to 200 selected active cards, optionally to another accessible board/list. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid.describe("Source board id."),
    cardIds: z.array(uuid).min(1).max(200),
    targetBoardId: uuid.optional(),
    listId: uuid.optional(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/duplicate`, { cardIds: a.cardIds, boardId: a.targetBoardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_custom_field", `Set, fill, add, remove, or clear one workspace-scoped custom field on up to 200 selected cards. Returns changed values/card ids and skipped archived card ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    fieldId: uuid,
    mode: z.enum(["setAll", "fillEmpty", "add", "remove", "clear"]),
    valueText: z.string().max(20000).nullable().optional(),
    valueNumber: z.union([z.number(), z.string()]).nullable().optional(),
    valueCheckbox: z.boolean().nullable().optional(),
    valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    valueUrl: z.url().max(2000).nullable().optional(),
    valueOptionIds: z.array(uuid).nullable().optional(),
    valueUserIds: z.array(uuid).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/custom-fields`, {
    cardIds: a.cardIds,
    fieldId: a.fieldId,
    mode: a.mode,
    valueText: a.valueText,
    valueNumber: a.valueNumber,
    valueCheckbox: a.valueCheckbox,
    valueDate: a.valueDate,
    valueUrl: a.valueUrl,
    valueOptionIds: a.valueOptionIds,
    valueUserIds: a.valueUserIds,
  }), ctx);
  registerKaneraTool(server, "kanera_set_list_card_completion", `Mark every active card in one board/list complete or incomplete. Returns the number changed. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    listId: uuid,
    completed: z.boolean(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_move_list_cards", "Move every active card from one workspace-scoped list to another, optionally limited to one board. Returns the number moved. Requires board editor or workspace admin.", {
    sourceListId: uuid,
    targetListId: uuid,
    boardId: uuid.optional(),
  }, (a, api) => api.post(`/api/v1/lists/${a.sourceListId}/cards/move`, { targetListId: a.targetListId, boardId: a.boardId }), ctx);
  registerKaneraTool(server, "kanera_archive_list_cards", "Archive every active card in one workspace-scoped list, optionally limited to one board. This is destructive. Returns the number archived. Requires board editor or workspace admin.", {
    listId: uuid,
    boardId: uuid.optional(),
  }, (a, api) => api.patch(`/api/v1/lists/${a.listId}/cards/archive`, { boardId: a.boardId }), ctx);
  registerKaneraTool(server, "kanera_set_card_assignees", "Replace card assignees. Requires write/admin.", { cardId: uuid, userIds: z.array(uuid).max(100) }, (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/assignees`, { userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_set_card_labels", "Replace card labels. Requires write/admin.", { cardId: uuid, labelIds: z.array(uuid).max(100) }, (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/labels`, { labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_set_custom_field_value", "Set one workspace-scoped custom field value on a card. Requires write/admin.", customFieldValueSchema(), (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/custom-fields/${a.fieldId}`, a), ctx);
  registerKaneraTool(server, "kanera_add_comment", "Add a comment to a card. Requires write/admin.", { cardId: uuid, body: z.string().min(1).max(20000) }, (a, api) =>
    api.post(`/api/v1/cards/${a.cardId}/comments`, { body: a.body }), ctx);
  registerKaneraTool(server, "kanera_bulk_add_comments", `Atomically add up to 200 text comments across cards in one board. Results preserve input order. Attachments are not supported. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    comments: z.array(z.object({ cardId: uuid, body: z.string().min(1).max(20000) })).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/comments/bulk/create`, { comments: a.comments }), ctx);
  registerKaneraTool(server, "kanera_list_card_comments", "List a card's comments, newest first. Cursor-paginated (cursor is an ISO datetime from a prior nextCursor).", {
    cardId: uuid,
    cursor: z.iso.datetime().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, (a, api) => api.get(`/api/v1/cards/${a.cardId}/comments`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_delete_comment", "Delete one comment. Only comments authored by the acting user can be deleted; comments from other users, API keys, or the system are rejected. This is destructive; use only after an explicit request and, for migrations, after verifying the copied destination. Comments are preserved by default. Requires write/admin.", {
    commentId: uuid,
  }, (a, api) => api.delete(`/api/v1/comments/${a.commentId}`), ctx);
  registerKaneraTool(server, "kanera_bulk_delete_comments", `Atomically delete up to 200 comments in one board. All-or-nothing: every comment must be authored by the acting user, so comments from other users, API keys, or the system make the whole batch fail and the error names the offending ids to drop before retrying. This is destructive; use only after an explicit request and verified migration. Comments are preserved by default. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    commentIds: z.array(uuid).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/comments/bulk/delete`, { commentIds: a.commentIds }), ctx);
  registerKaneraTool(server, "kanera_create_checklist", "Add a top-level checklist to a card, or create a one-level sub-checklist by passing the owning top-level parentItemId. Requires write/admin.", {
    cardId: uuid,
    title: z.string().trim().min(1).max(500),
    parentItemId: uuid.nullable().optional().describe("Top-level checklist item that owns this sub-checklist; omit or null for a card-level checklist."),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/checklists`, { title: a.title, parentItemId: a.parentItemId }), ctx);
  registerKaneraTool(server, "kanera_update_checklist", "Rename a checklist. Requires write/admin.", { cardId: uuid, checklistId: uuid, title: z.string().trim().min(1).max(500) }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}`, { title: a.title }), ctx);
  registerKaneraTool(server, "kanera_delete_checklist", "Delete a checklist and its items. Requires write/admin.", { cardId: uuid, checklistId: uuid }, (a, api) =>
    api.delete(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}`), ctx);
  registerKaneraTool(server, "kanera_move_checklist", "Reorder a checklist on a card. Provide exactly one of afterChecklistId or beforeChecklistId. Requires write/admin.", {
    cardId: uuid,
    checklistId: uuid,
    afterChecklistId: uuid.nullable().optional(),
    beforeChecklistId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/move`, { afterChecklistId: a.afterChecklistId, beforeChecklistId: a.beforeChecklistId }), ctx);
  registerKaneraTool(server, "kanera_add_checklist_item", "Add an item to a checklist. Items in sub-checklists are leaf rows with text and completion only. Requires write/admin.", { cardId: uuid, checklistId: uuid, text: z.string().trim().min(1).max(2000) }, (a, api) =>
    api.post(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items`, { text: a.text }), ctx);
  registerKaneraTool(server, "kanera_bulk_add_checklist_items", `Atomically add up to 200 items across checklists and cards in one board. Results preserve input order. Descriptions are supported for top-level items only. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    items: z.array(z.object({
      cardId: uuid,
      checklistId: uuid,
      text: z.string().trim().min(1).max(2000),
      description: z.string().max(50000).nullable().optional(),
    })).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/checklist-items/bulk/create`, { items: a.items }), ctx);
  registerKaneraTool(server, "kanera_update_checklist_item", "Update a checklist item's text, completion, description, assignee, or due date. Description, assignee, and due date apply only to top-level items; sub-checklist leaf rows support text and completion only. Provide at least one field. Requires write/admin.", {
    cardId: uuid,
    checklistId: uuid,
    itemId: uuid,
    text: z.string().trim().min(1).max(2000).optional(),
    description: z.string().max(50000).nullable().optional(),
    completed: z.boolean().optional(),
    assigneeId: uuid.nullable().optional(),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/${a.itemId}`, { text: a.text, description: a.description, completed: a.completed, assigneeId: a.assigneeId, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_bulk_update_checklist_items", "Set the assignee or due date on all items in a checklist at once. Provide assigneeId or a due date. Requires write/admin.", {
    cardId: uuid,
    checklistId: uuid,
    assigneeId: uuid.nullable().optional(),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/bulk`, { assigneeId: a.assigneeId, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_checklist_item_descriptions", `Atomically set different descriptions on up to 200 top-level checklist items across selected cards in one board. Existing comments are not changed or deleted. Repeating the same batch is safe and reports unchanged item ids. ${boardBatchScope} Requires write/admin.`, {
    boardId: uuid,
    updates: z.array(z.object({
      cardId: uuid,
      checklistId: uuid,
      itemId: uuid,
      description: z.string().max(50000).nullable(),
    })).min(1).max(200),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/checklist-items/bulk/descriptions`, { updates: a.updates }), ctx);
  registerKaneraTool(server, "kanera_delete_checklist_item", "Delete a checklist item. Requires write/admin.", { cardId: uuid, checklistId: uuid, itemId: uuid }, (a, api) =>
    api.delete(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/${a.itemId}`), ctx);
  registerKaneraTool(server, "kanera_move_checklist_item", "Move or reorder a checklist item, optionally into another checklist via checklistId. Provide exactly one of afterItemId or beforeItemId. Requires write/admin.", {
    cardId: uuid,
    checklistId: uuid.describe("Source checklist id."),
    itemId: uuid,
    targetChecklistId: uuid.optional().describe("Destination checklist id; omit to reorder within the source checklist."),
    afterItemId: uuid.nullable().optional(),
    beforeItemId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/${a.itemId}/move`, { checklistId: a.targetChecklistId, afterItemId: a.afterItemId, beforeItemId: a.beforeItemId }), ctx);
  registerKaneraTool(server, "kanera_list_activity", "List recent board activity and comments.", { boardId: uuid, limit: pageLimit }, (a, api) =>
    api.get(`/api/v1/boards/${a.boardId}/activity`, { limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_list_assigned_work", "List assigned active cards in a workspace, optionally for one user.", {
    workspaceId: uuid,
    userId: uuid.optional(),
  }, (a, api) => a.userId ? api.get(`/api/v1/workspaces/${a.workspaceId}/assignees/${a.userId}/cards`) : api.get(`/api/v1/workspaces/${a.workspaceId}/assignees/cards`), ctx);
  registerKaneraTool(server, "kanera_list_completed_work", "List a user's completed cards in a workspace, newest first. Cursor-paginated; optional date range, board/list, and title-search filters.", {
    workspaceId: uuid,
    userId: uuid,
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    listId: uuid.optional(),
    boardId: uuid.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }, (a, api) => api.get(`/api/v1/workspaces/${a.workspaceId}/assignees/${a.userId}/completed`, {
    from: a.from, to: a.to, listId: a.listId, boardId: a.boardId, q: a.q, cursor: a.cursor, limit: a.limit,
  }), ctx);
  registerKaneraTool(server, "kanera_list_work_done", "List a work-done timeline (created/moved/completed/checklist events) for a user, or the rest of the team when userId is omitted. from and to are required ISO datetimes bounding the window.", {
    workspaceId: uuid,
    userId: uuid.optional(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    boardId: uuid.optional(),
    q: z.string().trim().min(1).max(200).optional(),
  }, (a, api) => api.get(
    a.userId
      ? `/api/v1/workspaces/${a.workspaceId}/assignees/${a.userId}/work-done`
      : `/api/v1/workspaces/${a.workspaceId}/assignees/work-done`,
    { from: a.from, to: a.to, boardId: a.boardId, q: a.q },
  ), ctx);
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
    messages: [{ role: "user", content: { type: "text", text: `For workspace ${a.workspaceId}${a.userId ? ` and user ${a.userId}` : ""}: use Kanera work-done and completed-work tools for what was closed, and assigned work for what is in flight. Draft a concise yesterday/today/blockers standup update.` } }],
  }));
  server.registerPrompt("triage_assigned_work", { description: "Triage assigned Kanera work by urgency, stale state, and missing metadata.", argsSchema: { workspaceId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `List assigned Kanera work in workspace ${a.workspaceId}, group it by urgency, and flag stale or underspecified cards.` } }],
  }));
  server.registerPrompt("draft_card_from_notes", { description: "Draft a card title and description from one or more notes.", argsSchema: { noteId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Read kanera://note/${a.noteId} and draft a Kanera card title plus Markdown description. Do not create the card until asked.` } }],
  }));
}
