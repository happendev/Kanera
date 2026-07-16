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
const { COLOR_TOKENS } = require("@kanera/shared/colors") as {
  COLOR_TOKENS: readonly [string, ...string[]];
};
type WorkspaceTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  lists: Array<{ name: string; icon: string }>;
  customFields: Array<{
    name: string;
    icon: string;
    type: "text" | "number" | "checkbox" | "select" | "date" | "url" | "user";
    allowMultiple?: boolean;
    options?: Array<{ label: string; color?: string | null }>;
  }>;
  labels: Array<{ name: string; color: string }>;
};
const { WORKSPACE_TEMPLATES, DEFAULT_WORKSPACE_TEMPLATE } = require("@kanera/shared/workspace-templates") as {
  WORKSPACE_TEMPLATES: WorkspaceTemplate[];
  DEFAULT_WORKSPACE_TEMPLATE: WorkspaceTemplate;
};
const colorToken = z.enum(COLOR_TOKENS);
const workspaceTemplateId = z
  .enum(WORKSPACE_TEMPLATES.map((template) => template.id) as [string, ...string[]])
  .default(DEFAULT_WORKSPACE_TEMPLATE.id)
  .describe(WORKSPACE_TEMPLATES.map((template) => `${template.id}: ${template.description}`).join(" "));
const mcpPackage = require("../package.json") as { version: string };

export interface KaneraMcpContext {
  apiKey: string;
  publicApiUrl?: string;
}

function client(ctx: KaneraMcpContext) {
  return new KaneraClient({ baseUrl: ctx.publicApiUrl ?? env.KANERA_PUBLIC_API_URL, apiKey: ctx.apiKey });
}

const toolOutputSchema = { result: z.unknown() };
const serverDescription = "Read and manage Kanera workspaces, standalone boards, lists, cards, assigned work, notes, comments, labels, custom fields, and activity.";
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

const boardBatchScope = "Board-scoped: for workspace-wide work, list the workspace's boards and call this separately for each board.";

type ToolBehavior = Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint">;
const READ: ToolBehavior = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const ADD: ToolBehavior = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const CHANGE: ToolBehavior = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

// MCP defines destructiveHint=false as additive-only, not merely "reversible". Keep every tool's
// behavior explicit so a new verb cannot silently inherit incorrect safety metadata from its name.
const toolBehaviors: Record<string, ToolBehavior> = {
  kanera_get_session: READ,
  kanera_list_workspaces: READ,
  kanera_list_accessible_boards: READ,
  kanera_get_workspace: READ,
  kanera_list_workspace_boards: READ,
  kanera_list_workspace_members: READ,
  kanera_create_workspace: ADD,
  kanera_create_standalone_board: ADD,
  kanera_get_standalone_board_settings: READ,
  kanera_set_standalone_board_retention: CHANGE,
  kanera_delete_standalone_board: CHANGE,
  kanera_update_workspace: CHANGE,
  kanera_create_workspace_board: ADD,
  kanera_update_board: CHANGE,
  kanera_move_workspace_board: CHANGE,
  kanera_create_list: ADD,
  kanera_update_list: CHANGE,
  kanera_move_list: CHANGE,
  kanera_create_custom_field: ADD,
  kanera_update_custom_field: CHANGE,
  kanera_move_custom_field: CHANGE,
  kanera_create_custom_field_option: ADD,
  kanera_update_custom_field_option: CHANGE,
  kanera_move_custom_field_option: CHANGE,
  kanera_create_label: ADD,
  kanera_update_label: CHANGE,
  kanera_move_label: CHANGE,
  kanera_get_board: READ,
  kanera_get_cards_list: READ,
  kanera_search: READ,
  kanera_get_card: READ,
  kanera_get_cards_content: READ,
  kanera_create_card: ADD,
  kanera_update_card: CHANGE,
  kanera_move_card: CHANGE,
  kanera_duplicate_card: ADD,
  kanera_move_card_to_board: CHANGE,
  kanera_archive_card: CHANGE,
  kanera_set_card_completion: CHANGE,
  kanera_bulk_set_card_completion: CHANGE,
  kanera_bulk_set_card_due_date: CHANGE,
  kanera_bulk_patch_card_labels: CHANGE,
  kanera_bulk_patch_card_assignees: CHANGE,
  kanera_bulk_move_cards: CHANGE,
  kanera_bulk_archive_cards: CHANGE,
  kanera_bulk_duplicate_cards: ADD,
  kanera_bulk_set_card_custom_field: CHANGE,
  kanera_set_list_card_completion: CHANGE,
  kanera_move_list_cards: CHANGE,
  kanera_archive_list_cards: CHANGE,
  kanera_set_card_assignees: CHANGE,
  kanera_set_card_labels: CHANGE,
  kanera_set_custom_field_value: CHANGE,
  kanera_add_comment: ADD,
  kanera_bulk_add_comments: ADD,
  kanera_list_card_comments: READ,
  kanera_delete_comment: CHANGE,
  kanera_bulk_delete_comments: CHANGE,
  kanera_create_checklist: ADD,
  kanera_update_checklist: CHANGE,
  kanera_delete_checklist: CHANGE,
  kanera_move_checklist: CHANGE,
  kanera_add_checklist_item: ADD,
  kanera_bulk_add_checklist_items: ADD,
  kanera_update_checklist_item: CHANGE,
  kanera_bulk_update_checklist_items: CHANGE,
  kanera_bulk_set_checklist_item_descriptions: CHANGE,
  kanera_delete_checklist_item: CHANGE,
  kanera_move_checklist_item: CHANGE,
  kanera_list_activity: READ,
  kanera_list_assigned_work: READ,
  kanera_list_completed_work: READ,
  kanera_list_work_done: READ,
  kanera_list_notes: READ,
  kanera_get_note: READ,
  kanera_create_note: ADD,
  kanera_update_note: CHANGE,
};

function toolTitle(name: string) {
  return name
    .replace(/^kanera_/, "")
    .split("_")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function toolAnnotations(name: string): ToolAnnotations {
  const behavior = toolBehaviors[name];
  if (!behavior) throw new Error(`missing explicit MCP behavior metadata for ${name}`);
  return {
    title: toolTitle(name),
    ...behavior,
    // Kanera tools stay within the authenticated Kanera tenant and do not contact arbitrary hosts.
    openWorldHint: false,
  };
}

function validationError(message: string): never {
  throw new KaneraApiError(400, "VALIDATION_ERROR", message);
}

type CardListCursor = { boardId: string; listId: string; offset: number };

function encodeCardListCursor(cursor: CardListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCardListCursor(value: string, boardId: string, listId: string): CardListCursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CardListCursor>;
    if (
      cursor.boardId !== boardId
      || cursor.listId !== listId
      || !Number.isSafeInteger(cursor.offset)
      || cursor.offset! < 0
    ) {
      validationError("cursor does not match the requested board and list");
    }
    return cursor as CardListCursor;
  } catch (error) {
    if (error instanceof KaneraApiError) throw error;
    validationError("invalid card list cursor");
  }
}

function noteTargetPath(args: { workspaceId?: string; boardId?: string }, suffix: string) {
  if (Boolean(args.workspaceId) === Boolean(args.boardId)) {
    validationError("provide exactly one of workspaceId or boardId");
  }
  return args.boardId
    ? `/api/v1/boards/${args.boardId}/${suffix}`
    : `/api/v1/workspaces/${args.workspaceId}/${suffix}`;
}

type BoardRow = { id: string; workspaceId: string; name: string } & Record<string, unknown>;
type WorkspaceDetail = {
  workspace: { id: string; kind: "standard" | "board"; name: string } & Record<string, unknown>;
  role: "admin" | "member";
  lists?: Array<{ id: string } & Record<string, unknown>>;
  customFields?: Array<{
    id: string;
    options?: Array<{ id: string } & Record<string, unknown>>;
  } & Record<string, unknown>>;
  cardLabels?: Array<{ id: string } & Record<string, unknown>>;
} & Record<string, unknown>;

type ConfigurationTarget = { workspaceId?: string; standaloneBoardId?: string };
const configurationTargetSchema = {
  workspaceId: uuid.optional().describe("Standard workspace id. Provide exactly one of workspaceId or standaloneBoardId."),
  standaloneBoardId: uuid.optional().describe("Visible standalone board id. Provide exactly one of workspaceId or standaloneBoardId."),
};

async function standaloneBoardContext(api: KaneraClient, boardId: string) {
  const board = await api.get<BoardRow>(`/api/v1/boards/${boardId}`);
  const detail = await api.get<WorkspaceDetail>(`/api/v1/workspaces/${board.workspaceId}`);
  if (detail.workspace.kind !== "board") validationError("board is not a standalone board");
  // Dedicated standalone admin tools must never mutate an ordinary board merely because its id was
  // supplied accidentally. Resolving the hidden workspace also gives settings/guest routes the id
  // they need without exposing that implementation detail as an MCP argument.
  return { board, detail, workspaceId: board.workspaceId };
}

async function standardWorkspaceContext(api: KaneraClient, workspaceId: string) {
  const detail = await api.get<WorkspaceDetail>(`/api/v1/workspaces/${workspaceId}`);
  if (detail.workspace.kind !== "standard") validationError("workspaceId must identify a standard workspace; use standaloneBoardId for a standalone board");
  return { detail, workspaceId };
}

async function configurationTargetContext(api: KaneraClient, target: ConfigurationTarget) {
  if (Boolean(target.workspaceId) === Boolean(target.standaloneBoardId)) {
    validationError("provide exactly one of workspaceId or standaloneBoardId");
  }
  return target.standaloneBoardId
    ? standaloneBoardContext(api, target.standaloneBoardId)
    : standardWorkspaceContext(api, target.workspaceId!);
}

function assertTargetEntity(ids: string[], id: string, entity: string) {
  if (!ids.includes(id)) validationError(`${entity} does not belong to the selected configuration target`);
}

function targetListIds(detail: WorkspaceDetail) {
  return detail.lists?.map((list) => list.id) ?? [];
}

function targetFieldIds(detail: WorkspaceDetail) {
  return detail.customFields?.map((field) => field.id) ?? [];
}

function targetOptionIds(detail: WorkspaceDetail) {
  return detail.customFields?.flatMap((field) => field.options?.map((option) => option.id) ?? []) ?? [];
}

function targetLabelIds(detail: WorkspaceDetail) {
  return detail.cardLabels?.map((label) => label.id) ?? [];
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
    { instructions: "Kanera has standard workspaces and standalone boards. A standard workspace may contain multiple boards; its lists, custom fields, labels, and workspace membership are shared by every board. A standalone board has one dedicated set of those resources. For configuration tools, pass workspaceId for a standard workspace or standaloneBoardId for a standalone board; never try to discover or supply the standalone board's backing configuration workspace id. Card, checklist, comment, activity, search, and board-note tools work with both board types unless their description says otherwise. When a user asks to create a board without choosing a type, ask whether it should be standalone or belong to an existing standard workspace; if workspace, also ask which one. Use kanera_create_workspace_board only for the latter and kanera_create_standalone_board only after the user chooses standalone. Use kanera_list_accessible_boards for complete discovery, including standalone and cross-organisation guest boards. Board access follows explicit board membership. A workspace key reaches its pinned workspace; a personal key or OAuth connection inherits its owner's current permissions. Read-only credentials cannot perform protected mutations. Event payloads are full entities, not diffs." },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, ctx: KaneraMcpContext) {
  registerKaneraTool(server, "kanera_get_session", "Describe the current Kanera credential, effective scope, pinned workspace if any, and canonical Kanera web URL.", {}, (_a, api) =>
    api.get("/api/v1/session"), ctx);
  registerKaneraTool(server, "kanera_list_workspaces", "List accessible standard workspaces. Standalone boards and parent workspaces reached only through board-level guest access are excluded; use kanera_list_accessible_boards for complete board discovery.", { limit: pageLimit }, async (a, api) => {
    const rows = await api.get<Array<{ kind?: string } & Record<string, unknown>>>("/api/v1/workspaces", { limit: a.limit });
    // The public API returns a pinned standalone configuration workspace to its own workspace key.
    // The MCP product model keeps this tool consistently standard-workspace-only for every credential.
    return rows.filter((workspace) => workspace.kind !== "board");
  }, ctx);
  registerKaneraTool(server, "kanera_list_accessible_boards", "Discover every accessible workspace board and standalone board. Results are grouped by owning workspace; guestGroups contains cross-organisation boards reached only through explicit board access.", {}, (_a, api) =>
    api.get("/api/v1/home/boards"), ctx);
  registerKaneraTool(server, "kanera_get_workspace", "Read a standard workspace and its shared lists, custom fields, labels, templates, and automations. For a standalone board, use kanera_get_standalone_board_settings.", { workspaceId: uuid }, async (a, api) =>
    (await standardWorkspaceContext(api, a.workspaceId)).detail, ctx);
  registerKaneraTool(server, "kanera_list_workspace_boards", "List the boards inside a standard workspace. Use kanera_list_accessible_boards when the workspace is unknown or the board may be standalone.", { workspaceId: uuid }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return api.get(`/api/v1/workspaces/${a.workspaceId}/boards`);
  }, ctx);
  registerKaneraTool(server, "kanera_list_workspace_members", "List a standard workspace's members with userId, displayName, email, and role. Use kanera_get_board to resolve assignees for a standalone board. Requires workspace access.", { workspaceId: uuid }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return api.get(`/api/v1/workspaces/${a.workspaceId}/members`);
  }, ctx);
  registerKaneraTool(server, "kanera_create_workspace", "Create a standard workspace with Kanera's default lists, custom fields, and labels. Requires an organisation admin using a write-capable personal or OAuth credential. This is not idempotent; do not retry after an ambiguous success.", {
    name: z.string().min(1).max(120),
  }, (a, api) => api.post("/api/v1/workspaces", { name: a.name }), ctx);
  registerKaneraTool(server, "kanera_create_standalone_board", "Create an independent standalone board with dedicated lists, custom fields, labels, and board-level access, using an onboarding template. Use only after the user explicitly chooses standalone. Returns initialBoard; use initialBoard.id for subsequent tools. Requires an organisation admin using a write-capable personal or OAuth credential. This is not idempotent; do not retry after an ambiguous success.", {
    name: z.string().trim().min(1).max(35),
    templateId: workspaceTemplateId,
  }, (a, api) => {
    const template = WORKSPACE_TEMPLATES.find((item) => item.id === a.templateId) ?? DEFAULT_WORKSPACE_TEMPLATE;
    return api.post("/api/v1/workspaces", {
      kind: "board",
      name: a.name,
      icon: template.icon,
      initialBoard: { name: a.name, icon: template.icon },
      lists: template.lists,
      customFields: template.customFields,
      labels: template.labels,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_get_standalone_board_settings", "Read a standalone board's identity, retention, lists, custom fields, labels, templates, and automations using its visible board id. Requires access to the board's configuration; board-only cross-organisation guests cannot use this tool.", {
    boardId: uuid,
  }, async (a, api) => {
    const { board, detail } = await standaloneBoardContext(api, a.boardId);
    return { board, ...detail };
  }, ctx);
  registerKaneraTool(server, "kanera_set_standalone_board_retention", "Set how many days completed cards remain active on a standalone board. Use kanera_update_board for its name or description. Requires standalone-board administration.", {
    boardId: uuid,
    completedCardsActiveDays: z.number().int().min(0).max(365),
  }, async (a, api) => {
    const { workspaceId } = await standaloneBoardContext(api, a.boardId);
    return api.patch(`/api/v1/workspaces/${workspaceId}`, {
      completedCardsActiveDays: a.completedCardsActiveDays,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_delete_standalone_board", "Permanently delete a standalone board and its hidden workspace, including its lists, custom fields, labels, settings, cards, and integrations. Requires standalone-board admin and is destructive.", {
    boardId: uuid,
  }, async (a, api) => {
    await standaloneBoardContext(api, a.boardId);
    return api.delete(`/api/v1/boards/${a.boardId}`);
  }, ctx);
  registerKaneraTool(server, "kanera_update_workspace", "Rename a standard workspace or change how long completed cards remain active. Requires workspace administration. Use kanera_set_standalone_board_retention and kanera_update_board for a standalone board.", {
    workspaceId: uuid,
    name: z.string().min(1).max(120).optional(),
    completedCardsActiveDays: z.number().int().min(0).max(365).optional(),
  }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return api.patch(`/api/v1/workspaces/${a.workspaceId}`, {
      name: a.name,
      completedCardsActiveDays: a.completedCardsActiveDays,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_create_workspace_board", "Create a board inside a standard workspace. Its lists, custom fields, labels, and membership are shared with the workspace's other boards. Use only after the user chooses a workspace board and the target workspace is known. Requires workspace administration. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    name: z.string().min(1).max(35),
    groupId: uuid.nullable().optional(),
    description: z.string().max(2000).optional(),
  }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return api.post(`/api/v1/workspaces/${a.workspaceId}/boards`, {
      name: a.name,
      groupId: a.groupId,
      description: a.description,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_update_board", "Rename or describe a workspace board or standalone board; groupId applies only to workspace boards. Requires administration of the board's owning configuration.", {
    boardId: uuid,
    name: z.string().min(1).max(35).optional(),
    groupId: uuid.nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}`, {
    name: a.name,
    groupId: a.groupId,
    description: a.description,
  }), ctx);
  registerKaneraTool(server, "kanera_move_workspace_board", "Reorder a board inside a standard workspace. Provide exactly one of afterBoardId or beforeBoardId; null moves to that edge. Requires workspace administration.", {
    boardId: uuid,
    afterBoardId: uuid.nullable().optional(),
    beforeBoardId: uuid.nullable().optional(),
  }, async (a, api) => {
    const board = await api.get<BoardRow>(`/api/v1/boards/${a.boardId}`);
    await standardWorkspaceContext(api, board.workspaceId);
    return api.post(`/api/v1/boards/${a.boardId}/move`, {
      afterBoardId: a.afterBoardId,
      beforeBoardId: a.beforeBoardId,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_create_list", "Create a workflow list for a standard workspace or standalone board. Workspace lists are shared by every board; standalone lists belong only to that board. Requires administration of the selected target. This is not idempotent; do not retry after an ambiguous success.", {
    ...configurationTargetSchema,
    name: z.string().min(1).max(35),
  }, async (a, api) => {
    const { workspaceId } = await configurationTargetContext(api, a);
    return api.post(`/api/v1/workspaces/${workspaceId}/lists`, { name: a.name });
  }, ctx);
  registerKaneraTool(server, "kanera_update_list", "Rename a workflow list in a standard workspace or standalone board. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    listId: uuid,
    name: z.string().min(1).max(35),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    assertTargetEntity(targetListIds(detail), a.listId, "list");
    return api.patch(`/api/v1/lists/${a.listId}`, { name: a.name });
  }, ctx);
  registerKaneraTool(server, "kanera_move_list", "Reorder a workflow list in a standard workspace or standalone board. Provide exactly one of afterListId or beforeListId; null moves to that edge. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    listId: uuid,
    afterListId: uuid.nullable().optional(),
    beforeListId: uuid.nullable().optional(),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    const listIds = targetListIds(detail);
    assertTargetEntity(listIds, a.listId, "list");
    const anchorId = a.afterListId ?? a.beforeListId;
    if (anchorId) assertTargetEntity(listIds, anchorId, "anchor list");
    return api.post(`/api/v1/lists/${a.listId}/move`, {
      afterListId: a.afterListId,
      beforeListId: a.beforeListId,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_create_custom_field", "Create a custom field for a standard workspace or standalone board, optionally seeding select options. Workspace fields are shared by every board. Requires administration of the selected target. This is not idempotent; do not retry after an ambiguous success.", {
    ...configurationTargetSchema,
    name: z.string().min(1).max(35),
    type: z.enum(["text", "number", "checkbox", "select", "date", "url", "user"]),
    allowMultiple: z.boolean().default(false),
    options: z.array(z.object({ label: z.string().min(1).max(120) })).max(100).optional(),
  }, async (a, api) => {
    const { workspaceId } = await configurationTargetContext(api, a);
    return api.post(`/api/v1/workspaces/${workspaceId}/custom-fields`, {
      name: a.name,
      type: a.type,
      allowMultiple: a.allowMultiple,
      options: a.options,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_update_custom_field", "Rename a custom field or change its card visibility or multiple-value behavior in a standard workspace or standalone board. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    fieldId: uuid,
    name: z.string().min(1).max(35).optional(),
    showOnCard: z.boolean().optional(),
    allowMultiple: z.boolean().optional(),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    assertTargetEntity(targetFieldIds(detail), a.fieldId, "custom field");
    return api.patch(`/api/v1/custom-fields/${a.fieldId}`, {
      name: a.name,
      showOnCard: a.showOnCard,
      allowMultiple: a.allowMultiple,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_move_custom_field", "Reorder a custom field in a standard workspace or standalone board. Provide exactly one of afterFieldId or beforeFieldId; null moves to that edge. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    fieldId: uuid,
    afterFieldId: uuid.nullable().optional(),
    beforeFieldId: uuid.nullable().optional(),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    const fieldIds = targetFieldIds(detail);
    assertTargetEntity(fieldIds, a.fieldId, "custom field");
    const anchorId = a.afterFieldId ?? a.beforeFieldId;
    if (anchorId) assertTargetEntity(fieldIds, anchorId, "anchor custom field");
    return api.post(`/api/v1/custom-fields/${a.fieldId}/move`, {
      afterFieldId: a.afterFieldId,
      beforeFieldId: a.beforeFieldId,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_create_custom_field_option", "Add an option to a select custom field in a standard workspace or standalone board. Requires administration of the selected target. This is not idempotent; do not retry after an ambiguous success.", {
    ...configurationTargetSchema,
    fieldId: uuid,
    label: z.string().min(1).max(120),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    assertTargetEntity(targetFieldIds(detail), a.fieldId, "custom field");
    return api.post(`/api/v1/custom-fields/${a.fieldId}/options`, { label: a.label });
  }, ctx);
  registerKaneraTool(server, "kanera_update_custom_field_option", "Rename a select custom-field option in a standard workspace or standalone board. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    optionId: uuid,
    label: z.string().min(1).max(120),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    assertTargetEntity(targetOptionIds(detail), a.optionId, "custom-field option");
    return api.patch(`/api/v1/options/${a.optionId}`, { label: a.label });
  }, ctx);
  registerKaneraTool(server, "kanera_move_custom_field_option", "Reorder a select custom-field option in a standard workspace or standalone board. Provide exactly one of afterOptionId or beforeOptionId; null moves to that edge. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    optionId: uuid,
    afterOptionId: uuid.nullable().optional(),
    beforeOptionId: uuid.nullable().optional(),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    const optionIds = targetOptionIds(detail);
    assertTargetEntity(optionIds, a.optionId, "custom-field option");
    const anchorId = a.afterOptionId ?? a.beforeOptionId;
    if (anchorId) assertTargetEntity(optionIds, anchorId, "anchor custom-field option");
    return api.post(`/api/v1/options/${a.optionId}/move`, {
      afterOptionId: a.afterOptionId,
      beforeOptionId: a.beforeOptionId,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_create_label", "Create a card label for a standard workspace or standalone board. Workspace labels are shared by every board. Requires administration of the selected target. This is not idempotent; do not retry after an ambiguous success.", {
    ...configurationTargetSchema,
    name: z.string().min(1).max(25),
    color: colorToken.nullable().optional().describe("Kanera palette token; omit or use null for no color."),
  }, async (a, api) => {
    const { workspaceId } = await configurationTargetContext(api, a);
    return api.post(`/api/v1/workspaces/${workspaceId}/card-labels`, { name: a.name, color: a.color });
  }, ctx);
  registerKaneraTool(server, "kanera_update_label", "Rename a card label in a standard workspace or standalone board. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    labelId: uuid,
    name: z.string().min(1).max(25),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    assertTargetEntity(targetLabelIds(detail), a.labelId, "label");
    return api.patch(`/api/v1/card-labels/${a.labelId}`, { name: a.name });
  }, ctx);
  registerKaneraTool(server, "kanera_move_label", "Reorder a card label in a standard workspace or standalone board. Provide exactly one of afterLabelId or beforeLabelId; null moves to that edge. Requires administration of the selected target.", {
    ...configurationTargetSchema,
    labelId: uuid,
    afterLabelId: uuid.nullable().optional(),
    beforeLabelId: uuid.nullable().optional(),
  }, async (a, api) => {
    const { detail } = await configurationTargetContext(api, a);
    const labelIds = targetLabelIds(detail);
    assertTargetEntity(labelIds, a.labelId, "label");
    const anchorId = a.afterLabelId ?? a.beforeLabelId;
    if (anchorId) assertTargetEntity(labelIds, anchorId, "anchor label");
    return api.post(`/api/v1/card-labels/${a.labelId}/move`, {
      afterLabelId: a.afterLabelId,
      beforeLabelId: a.beforeLabelId,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_get_board", "Get a workspace board or standalone board with its workflow lists, members, labels, and custom fields, but without cards. Use the returned list ids with kanera_get_cards_list to retrieve cards only from the lists needed.", {
    boardId: uuid,
  }, async (a, api) => {
    const detail = await api.post<Record<string, unknown>>(`/api/v1/boards/${a.boardId}/open`, undefined, { includeCards: false });
    // Board discovery must not leak the potentially enormous all-list card collection into the
    // MCP result. Keep every other board-detail field aligned with the board-open API payload.
    const { cards: _cards, ...boardWithoutCards } = detail;
    return boardWithoutCards;
  }, ctx);
  registerKaneraTool(server, "kanera_get_cards_list", "Get one bounded page of active (unarchived) cards, including completed cards, from exactly one workflow list. Use kanera_get_board first to resolve the list id, then pass nextCursor to continue. Never returns cards from another list or an unbounded card collection.", {
    boardId: uuid.describe("Board containing the requested workflow lists."),
    listId: uuid.describe("Exactly one workflow list id returned by kanera_get_board."),
    cursor: z.string().min(1).optional().describe("Opaque nextCursor returned by the previous page."),
    limit: z.number().int().min(1).max(100).default(25).describe("Maximum cards to return in this page."),
  }, async (a, api) => {
    const offset = a.cursor ? decodeCardListCursor(a.cursor, a.boardId, a.listId).offset : 0;
    const detail = await api.post<{ lists?: Array<{ id?: unknown }>; cards?: Array<{ listId?: unknown }>; cardPage?: { hasMore?: unknown } }>(
      `/api/v1/boards/${a.boardId}/open`,
      undefined,
      { includeCompleted: true, archived: false, listId: a.listId, cardLimit: a.limit, cardOffset: offset },
    );
    if (!detail.lists?.some((list) => list.id === a.listId)) validationError("list does not belong to the requested board");
    const cards = (detail.cards ?? []).filter((card) => card.listId === a.listId);
    const page = cards.slice(0, a.limit);
    const nextOffset = offset + page.length;
    // Pagination and list filtering happen before the MCP result is serialized, so the model can
    // never receive an unrelated list or an unbounded list-sized response.
    return {
      cards: page,
      nextCursor: detail.cardPage?.hasMore === true
        ? encodeCardListCursor({ boardId: a.boardId, listId: a.listId, offset: nextOffset })
        : null,
    };
  }, ctx);
  registerKaneraTool(server, "kanera_search", "Search or resolve human references to accessible cards, notes, comments, and attachment filenames across workspace boards, standalone boards, and explicitly shared guest boards.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(8),
  }, (a, api) => api.get("/api/v1/search", { q: a.query, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_get_card", "Read a card detail, including labels, assignees, checklist item descriptions, nested sub-checklists, attachments, and linked notes. Checklists are returned flat; a sub-checklist's parentItemId identifies its owning top-level item.", { cardId: uuid }, (a, api) =>
    api.get(`/api/v1/cards/${a.cardId}/detail`), ctx);
  registerKaneraTool(server, "kanera_get_cards_content", `Read checklist and comment content for up to 200 selected cards in one board. Use this for migrations and audits instead of calling get_card and list_card_comments once per card. Best-effort: ids not on the board are returned in missingCardIds instead of failing the batch, and any card whose comment history is capped is listed in truncatedCardIds (page its full history via list_card_comments). ${boardBatchScope}`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/content/query`, { cardIds: a.cardIds }), ctx);
  registerKaneraTool(server, "kanera_create_card", "Create a card in one of the board's workflow lists. Works with workspace and standalone boards. Requires board editor access and a write-capable credential.", {
    boardId: uuid,
    listId: uuid.describe("Target workflow list id returned by kanera_get_board."),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).optional(),
    atTop: z.boolean().optional(),
    idempotencyKey: uuid.optional().describe("Stable UUID reused when retrying this create after an ambiguous failure."),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards`, { title: a.title, description: a.description, atTop: a.atTop, clientToken: a.idempotencyKey }), ctx);
  registerKaneraTool(server, "kanera_update_card", "Update a card's title, description, or due date. Requires board editor access and a write-capable credential.", {
    cardId: uuid,
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(50000).nullable().optional(),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/cards/${a.cardId}`, { title: a.title, description: a.description, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_move_card", "Move or reorder a card within its board's workflow. Requires board editor access and a write-capable credential.", {
    cardId: uuid,
    listId: uuid,
    afterCardId: uuid.nullable().optional(),
    beforeCardId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/move`, { listId: a.listId, afterCardId: a.afterCardId, beforeCardId: a.beforeCardId }), ctx);
  registerKaneraTool(server, "kanera_duplicate_card", "Copy a card, optionally into another editable board and list. Requires board editor access at the source and destination. This is not idempotent; do not retry after an ambiguous success.", {
    cardId: uuid,
    boardId: uuid.optional().describe("Destination board; defaults to the source board."),
    listId: uuid.optional().describe("Destination list; required when copying across workspaces, otherwise defaults to the source card's list."),
    atTop: z.boolean().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/duplicate`, { boardId: a.boardId, listId: a.listId, atTop: a.atTop }), ctx);
  registerKaneraTool(server, "kanera_move_card_to_board", "Move a card to another board in the same standard workspace. Standalone boards have no valid destination. Requires editor access to both boards and a write-capable credential.", {
    cardId: uuid,
    boardId: uuid.describe("Destination board id. Must be in the same workspace."),
    listId: uuid.optional().describe("Destination list; defaults to a matching list on the target board."),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/move-to-board`, { boardId: a.boardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_archive_card", "Archive or unarchive a card. Requires board editor access and a write-capable credential.", { cardId: uuid, archived: z.boolean().default(true) }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/archive`, { archived: a.archived }), ctx);
  registerKaneraTool(server, "kanera_set_card_completion", "Mark a card complete or incomplete; completion is distinct from archiving. Requires board editor access and a write-capable credential.", { cardId: uuid, completed: z.boolean() }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_completion", `Mark up to 200 selected cards complete or incomplete in one board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    completed: z.boolean(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/completion`, { cardIds: a.cardIds, completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_due_date", `Set or clear one due date on up to 200 selected cards in a board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/due-date`, { cardIds: a.cardIds, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_bulk_patch_card_labels", `Add or remove labels on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    labelIds: z.array(uuid).min(1),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/labels`, { cardIds: a.cardIds, mode: a.mode, labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_bulk_patch_card_assignees", `Add or remove assignees on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    userIds: z.array(uuid).min(1),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/assignees`, { cardIds: a.cardIds, mode: a.mode, userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_bulk_move_cards", `Move up to 200 selected active cards to one workflow list in their board. Returns moved cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
    listId: uuid,
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/move`, { cardIds: a.cardIds, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_bulk_archive_cards", `Archive up to 200 selected cards in one board. This is destructive and cannot bulk-unarchive. Returns archived cards. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(uuid).min(1).max(200),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/archive`, { cardIds: a.cardIds, archived: true }), ctx);
  registerKaneraTool(server, "kanera_bulk_duplicate_cards", `Duplicate up to 200 selected active cards, optionally to another editable board and list. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires board editor access at the source and destination.`, {
    boardId: uuid.describe("Source board id."),
    cardIds: z.array(uuid).min(1).max(200),
    targetBoardId: uuid.optional(),
    listId: uuid.optional(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/duplicate`, { cardIds: a.cardIds, boardId: a.targetBoardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_custom_field", `Set, fill, add, remove, or clear one custom field on up to 200 selected cards. Returns changed values/card ids and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
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
  registerKaneraTool(server, "kanera_set_list_card_completion", `Mark every active card in one board/list complete or incomplete. Returns the number changed. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    listId: uuid,
    completed: z.boolean(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_move_list_cards", "Move every active card from one workflow list to another in the same configuration, optionally limited to one board. Omitting boardId affects every board in a standard workspace. Requires editor access to affected boards or workspace administration.", {
    sourceListId: uuid,
    targetListId: uuid,
    boardId: uuid.optional(),
  }, (a, api) => api.post(`/api/v1/lists/${a.sourceListId}/cards/move`, { targetListId: a.targetListId, boardId: a.boardId }), ctx);
  registerKaneraTool(server, "kanera_archive_list_cards", "Archive every active card in one workflow list, optionally limited to one board. Omitting boardId affects every board in a standard workspace. This is destructive and requires editor access to affected boards or workspace administration.", {
    listId: uuid,
    boardId: uuid.optional(),
  }, (a, api) => api.patch(`/api/v1/lists/${a.listId}/cards/archive`, { boardId: a.boardId }), ctx);
  registerKaneraTool(server, "kanera_set_card_assignees", "Replace all assignees on a card. Requires board editor access and a write-capable credential.", { cardId: uuid, userIds: z.array(uuid).max(100) }, (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/assignees`, { userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_set_card_labels", "Replace all labels on a card. Requires board editor access and a write-capable credential.", { cardId: uuid, labelIds: z.array(uuid).max(100) }, (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/labels`, { labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_set_custom_field_value", "Set or clear one custom-field value on a card. Requires board editor access and a write-capable credential.", customFieldValueSchema(), (a, api) =>
    api.put(`/api/v1/cards/${a.cardId}/custom-fields/${a.fieldId}`, a), ctx);
  registerKaneraTool(server, "kanera_add_comment", "Add a comment to a card. Requires board editor access and a write-capable credential. This is not idempotent; do not retry after an ambiguous success.", { cardId: uuid, body: z.string().min(1).max(20000) }, (a, api) =>
    api.post(`/api/v1/cards/${a.cardId}/comments`, { body: a.body }), ctx);
  registerKaneraTool(server, "kanera_bulk_add_comments", `Atomically add up to 200 text comments across cards in one board. Results preserve input order. Attachments are not supported. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    comments: z.array(z.object({ cardId: uuid, body: z.string().min(1).max(20000) })).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/comments/bulk/create`, { comments: a.comments }), ctx);
  registerKaneraTool(server, "kanera_list_card_comments", "List a card's comments, newest first. Cursor-paginated (cursor is an ISO datetime from a prior nextCursor).", {
    cardId: uuid,
    cursor: z.iso.datetime().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, (a, api) => api.get(`/api/v1/cards/${a.cardId}/comments`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_delete_comment", "Delete one comment authored by the acting user. Comments from other users, integration credentials, or the system are rejected. This is destructive; use only after an explicit request and, for migrations, after verifying the destination. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
  }, (a, api) => api.delete(`/api/v1/comments/${a.commentId}`), ctx);
  registerKaneraTool(server, "kanera_bulk_delete_comments", `Atomically delete up to 200 comments in one board. All-or-nothing: every comment must be authored by the acting user; the error identifies ineligible ids. This is destructive; use only after an explicit request and verified migration. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    commentIds: z.array(uuid).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/comments/bulk/delete`, { commentIds: a.commentIds }), ctx);
  registerKaneraTool(server, "kanera_create_checklist", "Add a top-level checklist to a card, or create a one-level sub-checklist by passing the owning top-level parentItemId. Requires board editor access and a write-capable credential. This is not idempotent.", {
    cardId: uuid,
    title: z.string().trim().min(1).max(500),
    parentItemId: uuid.nullable().optional().describe("Top-level checklist item that owns this sub-checklist; omit or null for a card-level checklist."),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/checklists`, { title: a.title, parentItemId: a.parentItemId }), ctx);
  registerKaneraTool(server, "kanera_update_checklist", "Rename a checklist. Requires board editor access and a write-capable credential.", { cardId: uuid, checklistId: uuid, title: z.string().trim().min(1).max(500) }, (a, api) =>
    api.patch(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}`, { title: a.title }), ctx);
  registerKaneraTool(server, "kanera_delete_checklist", "Delete a checklist and its items. This is destructive and requires board editor access with a write-capable credential.", { cardId: uuid, checklistId: uuid }, (a, api) =>
    api.delete(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}`), ctx);
  registerKaneraTool(server, "kanera_move_checklist", "Reorder a checklist on a card. Provide exactly one of afterChecklistId or beforeChecklistId. Requires board editor access and a write-capable credential.", {
    cardId: uuid,
    checklistId: uuid,
    afterChecklistId: uuid.nullable().optional(),
    beforeChecklistId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/move`, { afterChecklistId: a.afterChecklistId, beforeChecklistId: a.beforeChecklistId }), ctx);
  registerKaneraTool(server, "kanera_add_checklist_item", "Add an item to a checklist. Items in sub-checklists are leaf rows with text and completion only. Requires board editor access and a write-capable credential. This is not idempotent.", { cardId: uuid, checklistId: uuid, text: z.string().trim().min(1).max(2000) }, (a, api) =>
    api.post(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items`, { text: a.text }), ctx);
  registerKaneraTool(server, "kanera_bulk_add_checklist_items", `Atomically add up to 200 items across checklists and cards in one board. Results preserve input order. Descriptions are supported for top-level items only. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    items: z.array(z.object({
      cardId: uuid,
      checklistId: uuid,
      text: z.string().trim().min(1).max(2000),
      description: z.string().max(50000).nullable().optional(),
    })).min(1).max(200),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/checklist-items/bulk/create`, { items: a.items }), ctx);
  registerKaneraTool(server, "kanera_update_checklist_item", "Update a checklist item's text, completion, description, assignee, or due date. Description, assignee, and due date apply only to top-level items; sub-checklist leaves support text and completion only. Provide at least one field. Requires board editor access and a write-capable credential.", {
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
  registerKaneraTool(server, "kanera_bulk_update_checklist_items", "Set or clear the assignee or due date on all items in one checklist. Provide assigneeId or a due date. Repeating the same arguments is idempotent. Requires board editor access and a write-capable credential.", {
    cardId: uuid,
    checklistId: uuid,
    assigneeId: uuid.nullable().optional(),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/bulk`, { assigneeId: a.assigneeId, dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_checklist_item_descriptions", `Atomically set different descriptions on up to 200 top-level checklist items across selected cards in one board. Existing comments are unchanged; repeating the batch reports unchanged item ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    updates: z.array(z.object({
      cardId: uuid,
      checklistId: uuid,
      itemId: uuid,
      description: z.string().max(50000).nullable(),
    })).min(1).max(200),
  }, (a, api) => api.patch(`/api/v1/boards/${a.boardId}/checklist-items/bulk/descriptions`, { updates: a.updates }), ctx);
  registerKaneraTool(server, "kanera_delete_checklist_item", "Delete a checklist item. This is destructive and requires board editor access with a write-capable credential.", { cardId: uuid, checklistId: uuid, itemId: uuid }, (a, api) =>
    api.delete(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/${a.itemId}`), ctx);
  registerKaneraTool(server, "kanera_move_checklist_item", "Move or reorder a checklist item, optionally into another checklist. Provide exactly one of afterItemId or beforeItemId. Requires board editor access and a write-capable credential.", {
    cardId: uuid,
    checklistId: uuid.describe("Source checklist id."),
    itemId: uuid,
    targetChecklistId: uuid.optional().describe("Destination checklist id; omit to reorder within the source checklist."),
    afterItemId: uuid.nullable().optional(),
    beforeItemId: uuid.nullable().optional(),
  }, (a, api) => api.post(`/api/v1/cards/${a.cardId}/checklists/${a.checklistId}/items/${a.itemId}/move`, { checklistId: a.targetChecklistId, afterItemId: a.afterItemId, beforeItemId: a.beforeItemId }), ctx);
  registerKaneraTool(server, "kanera_list_activity", "List recent board activity and comments.", { boardId: uuid, limit: pageLimit }, (a, api) =>
    api.get(`/api/v1/boards/${a.boardId}/activity`, { limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_list_assigned_work", "List assigned active cards across a standard workspace or within a standalone board, optionally for one user. Requires configuration-level access; board-only cross-organisation guests cannot use this view.", {
    ...configurationTargetSchema,
    userId: uuid.optional(),
  }, async (a, api) => {
    const { workspaceId } = await configurationTargetContext(api, a);
    return a.userId ? api.get(`/api/v1/workspaces/${workspaceId}/assignees/${a.userId}/cards`) : api.get(`/api/v1/workspaces/${workspaceId}/assignees/cards`);
  }, ctx);
  registerKaneraTool(server, "kanera_list_completed_work", "List a user's completed cards in a standard workspace or standalone board, newest first. Cursor-paginated with optional date, board/list, and title filters. Requires configuration-level access.", {
    ...configurationTargetSchema,
    userId: uuid,
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    listId: uuid.optional(),
    boardId: uuid.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }, async (a, api) => {
    const { workspaceId } = await configurationTargetContext(api, a);
    return api.get(`/api/v1/workspaces/${workspaceId}/assignees/${a.userId}/completed`, {
      from: a.from, to: a.to, listId: a.listId, boardId: a.boardId, q: a.q, cursor: a.cursor, limit: a.limit,
    });
  }, ctx);
  registerKaneraTool(server, "kanera_list_work_done", "List created, moved, completed, and checklist activity in a standard workspace or standalone board for one user, or for the rest of the team when userId is omitted. from and to are required ISO datetimes. Requires configuration-level access.", {
    ...configurationTargetSchema,
    userId: uuid.optional(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    boardId: uuid.optional(),
    q: z.string().trim().min(1).max(200).optional(),
  }, async (a, api) => {
    const { workspaceId } = await configurationTargetContext(api, a);
    return api.get(
      a.userId
        ? `/api/v1/workspaces/${workspaceId}/assignees/${a.userId}/work-done`
        : `/api/v1/workspaces/${workspaceId}/assignees/work-done`,
      { from: a.from, to: a.to, boardId: a.boardId, q: a.q },
    );
  }, ctx);
  registerKaneraTool(server, "kanera_list_notes", "List personal or team notes. Provide exactly one of workspaceId for a standard workspace or boardId for a workspace or standalone board.", {
    workspaceId: uuid.optional(),
    boardId: uuid.optional(),
    scope: z.enum(["personal", "team"]).default("team"),
  }, (a, api) => api.get(noteTargetPath(a, "notes"), { scope: a.scope }), ctx);
  registerKaneraTool(server, "kanera_get_note", "Read a note.", { noteId: uuid }, (a, api) => api.get(`/api/v1/notes/${a.noteId}`), ctx);
  registerKaneraTool(server, "kanera_create_note", "Create a personal or team note. Provide exactly one of workspaceId for a standard workspace or boardId for either board type. Team notes require workspace administration or board editor access; creation is not idempotent.", noteMutationSchema(), (a, api) =>
    api.post(noteTargetPath(a, "notes"), { scope: a.scope, parentNoteId: a.parentNoteId, title: a.title }), ctx);
  registerKaneraTool(server, "kanera_update_note", "Update a note. Team-note edits respect Kanera note locks and require workspace administration or board editor access; personal notes are limited to their owner.", {
    noteId: uuid,
    title: z.string().max(200).optional(),
    content: z.string().max(50000).optional(),
    baseUpdatedAt: z.iso.datetime().optional(),
  }, (a, api) => api.patch(`/api/v1/notes/${a.noteId}`, { title: a.title, content: a.content, baseUpdatedAt: a.baseUpdatedAt }), ctx);
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
  };
}

function registerResources(server: McpServer, ctx: KaneraMcpContext) {
  registerResource(server, "workspace", "kanera://workspace/{workspaceId}", "Standard workspace configuration and shared resources.", (vars, api) => standardWorkspaceContext(api, vars.workspaceId!).then((result) => result.detail), ctx);
  registerResource(server, "board", "kanera://board/{boardId}", "Workspace or standalone board with its visible cards and configuration.", (vars, api) => api.post(`/api/v1/boards/${vars.boardId}/open`), ctx);
  registerResource(server, "card", "kanera://card/{cardId}", "Card detail from a workspace or standalone board.", (vars, api) => api.get(`/api/v1/cards/${vars.cardId}/detail`), ctx);
  registerResource(server, "note", "kanera://note/{noteId}", "Personal or team note visible to the current credential.", (vars, api) => api.get(`/api/v1/notes/${vars.noteId}`), ctx);
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
  server.registerPrompt("prepare_standup_update", { description: "Prepare a standup update from assigned work in a standard workspace or standalone board.", argsSchema: { ...configurationTargetSchema, userId: uuid.optional() } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `For ${promptConfigurationTarget(a)}${a.userId ? ` and user ${a.userId}` : ""}: use Kanera work-done and completed-work tools for what was closed, and assigned work for what is in flight. Draft a concise yesterday/today/blockers standup update.` } }],
  }));
  server.registerPrompt("triage_assigned_work", { description: "Triage assigned Kanera work in a standard workspace or standalone board.", argsSchema: configurationTargetSchema }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `List assigned Kanera work for ${promptConfigurationTarget(a)}, group it by urgency, and flag stale or underspecified cards.` } }],
  }));
  server.registerPrompt("draft_card_from_notes", { description: "Draft a card title and description from one or more notes.", argsSchema: { noteId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Read kanera://note/${a.noteId} and draft a Kanera card title plus Markdown description. Do not create the card until asked.` } }],
  }));
}

function promptConfigurationTarget(target: ConfigurationTarget) {
  if (Boolean(target.workspaceId) === Boolean(target.standaloneBoardId)) {
    throw new Error("provide exactly one of workspaceId or standaloneBoardId");
  }
  return target.workspaceId
    ? `standard workspace ${target.workspaceId}`
    : `standalone board ${target.standaloneBoardId}`;
}
