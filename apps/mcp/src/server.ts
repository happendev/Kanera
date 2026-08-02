import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { docsSearchClient } from "./docs-search.js";
import { env } from "./env.js";
import { KaneraApiError, KaneraClient } from "./kanera-client.js";

const uuid = z.uuid();
const pageLimit = z.number().int().min(1).max(100).default(25);
const fileBase64 = z.string()
  .min(1)
  .max(700_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const workScope = z.object({
  allAccessible: z.boolean().default(false).describe("Set true to include every accessible board and ignore the ID filters."),
  organisationIds: z.array(uuid).max(20).default([]),
  workspaceIds: z.array(uuid).max(100).default([]),
  boardIds: z.array(uuid).max(500).default([]),
}).optional().describe("Omit for every accessible board. When supplied, the listed IDs define the scope unless allAccessible is true.");
const workCustomFieldCondition = z.object({
  workspaceId: uuid,
  fieldId: uuid,
  op: z.enum([
    "contains", "equals", "eq", "neq", "gt", "gte", "lt", "lte",
    "on", "before", "after", "between", "checked", "unchecked",
    "isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty",
  ]),
  value: z.string().max(500).optional(),
  value2: z.string().max(500).optional(),
  ids: z.array(uuid).max(100).optional(),
});
const workFilters = z.object({
  q: z.string().trim().max(200).optional(),
  assigneeIds: z.array(uuid).max(100).optional(),
  listIds: z.array(uuid).max(200).optional(),
  labelIds: z.array(uuid).max(200).optional(),
  customFieldConditions: z.array(workCustomFieldCondition).max(50).optional(),
  completion: z.enum(["activeAndRecentlyCompleted", "active", "completed", "all"]).optional(),
  unassignedOnly: z.boolean().optional(),
  dueFrom: z.iso.date().nullable().optional(),
  dueTo: z.iso.date().nullable().optional(),
  overdueOnly: z.boolean().optional(),
  overdueChecklistOnly: z.boolean().optional(),
  archived: z.boolean().optional(),
  completedFrom: z.iso.datetime().nullable().optional(),
  completedTo: z.iso.datetime().nullable().optional(),
  lastActivityBefore: z.iso.datetime().nullable().optional().describe("Return cards with no visible activity at or after this instant."),
  lastMovedBefore: z.iso.datetime().nullable().optional().describe("Return cards with no move at or after this instant."),
}).optional();
const dueDateSlot = z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]);
const cardUpdateFields = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50000).nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
});
const cardUpdateChanges = z.union([
  cardUpdateFields.extend({ title: z.string().min(1).max(500) }),
  cardUpdateFields.extend({ description: z.string().max(50000).nullable() }),
  cardUpdateFields.extend({ dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
  cardUpdateFields.extend({ dueDateSlot: dueDateSlot.nullable() }),
]);
const checklistItemFields = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  description: z.string().max(50000).nullable().optional(),
  completed: z.boolean().optional(),
  assigneeId: uuid.nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
});
const checklistItemChanges = z.union([
  checklistItemFields.extend({ text: z.string().trim().min(1).max(2000) }),
  checklistItemFields.extend({ description: z.string().max(50000).nullable() }),
  checklistItemFields.extend({ completed: z.boolean() }),
  checklistItemFields.extend({ assigneeId: uuid.nullable() }),
  checklistItemFields.extend({ dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
  checklistItemFields.extend({ dueDateSlot: dueDateSlot.nullable() }),
]);
const bulkChecklistItemFields = z.object({
  assigneeId: uuid.nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
});
const bulkChecklistItemChanges = z.union([
  bulkChecklistItemFields.extend({ assigneeId: uuid.nullable() }),
  bulkChecklistItemFields.extend({ dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
]);
const positionAnchor = z.object({
  side: z.enum(["after", "before"]),
  id: uuid.nullable().describe("Anchor entity id; null means the selected edge."),
});
const CARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/iu;
const ORGANISATION_KEY_PATTERN = /^[A-F0-9]{16}$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type ToolArgs<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;
const require = createRequire(import.meta.url);
// Load the runtime tuple from the shared package without making TypeScript compile shared sources
// outside this package's rootDir. The MCP schema and public API now have one color source of truth.
const { COLOR_TOKENS } = require("@kanera/shared/colors") as {
  COLOR_TOKENS: readonly [string, ...string[]];
};
const { COMMENT_REACTION_TYPES } = require("@kanera/shared/schema") as {
  COMMENT_REACTION_TYPES: readonly [string, ...string[]];
};
const reactionType = z.enum(COMMENT_REACTION_TYPES);
const colorToken = z.enum(COLOR_TOKENS);
const noteUpdateFields = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(50000).optional(),
  icon: z.string().trim().min(1).max(100).nullable().optional(),
  color: colorToken.nullable().optional(),
  baseUpdatedAt: z.iso.datetime().optional(),
});
const noteUpdateChanges = z.union([
  noteUpdateFields.extend({ title: z.string().max(200) }),
  noteUpdateFields.extend({ content: z.string().max(50000) }),
  noteUpdateFields.extend({ icon: z.string().trim().min(1).max(100).nullable() }),
  noteUpdateFields.extend({ color: colorToken.nullable() }),
]);
const mcpPackage = require("../package.json") as { version: string };

export interface KaneraMcpContext {
  apiKey: string;
  publicApiUrl?: string;
  docsSearchUrl?: string;
}

function client(ctx: KaneraMcpContext) {
  return new KaneraClient({ baseUrl: ctx.publicApiUrl ?? env.KANERA_PUBLIC_API_URL, apiKey: ctx.apiKey });
}

const serverDescription = "Read Kanera configuration and manage cards, checklists, comments, notes, attachments, activity, and work reporting.";
const serverIcons = [{
  src: "https://www.kanera.app/assets/favicon/android-chrome-512x512.png",
  mimeType: "image/png" as const,
  sizes: ["512x512"],
}];

function content(data: unknown): CallToolResult {
  const summary = Array.isArray(data)
    ? `Kanera returned ${data.length} item${data.length === 1 ? "" : "s"}. See structuredContent.result.`
    : data === null
      ? "Kanera request completed successfully."
      : "Kanera request completed successfully. See structuredContent.result.";
  // Avoid serializing a potentially large result twice. Modern clients receive the full structured
  // value; the short text block keeps older hosts aware of success without doubling model context.
  return {
    content: [{ type: "text" as const, text: summary }],
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
  kanera_get_standalone_board_settings: READ,
  kanera_get_board: READ,
  kanera_get_cards_list: READ,
  kanera_search: READ,
  kanera_search_docs: READ,
  kanera_get_card: READ,
  kanera_get_cards_content: READ,
  kanera_list_card_history: READ,
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
  kanera_list_card_comments: READ,
  kanera_delete_comment: CHANGE,
  kanera_create_checklist: ADD,
  kanera_update_checklist: CHANGE,
  kanera_delete_checklist: CHANGE,
  kanera_move_checklist: CHANGE,
  kanera_add_checklist_item: ADD,
  kanera_update_checklist_item: CHANGE,
  kanera_bulk_update_checklist_items: CHANGE,
  kanera_delete_checklist_item: CHANGE,
  kanera_move_checklist_item: CHANGE,
  kanera_list_activity: READ,
  kanera_list_completed_work: READ,
  kanera_list_work_done: READ,
  kanera_list_my_work_history: READ,
  kanera_list_my_current_work: READ,
  kanera_query_work_cards: READ,
  kanera_get_portfolio_summary: READ,
  kanera_list_notes: READ,
  kanera_get_note: READ,
  kanera_get_note_backlinks: READ,
  kanera_list_note_attachments: READ,
  kanera_create_note: ADD,
  kanera_update_note: CHANGE,
  kanera_add_note_link: ADD,
  kanera_add_note_attachment: ADD,
  kanera_duplicate_note: ADD,
  kanera_move_note: CHANGE,
  kanera_add_card_attachment: ADD,
  kanera_delete_card_attachment: CHANGE,
  kanera_set_card_cover: CHANGE,
  kanera_update_comment: CHANGE,
  kanera_set_comment_reaction: CHANGE,
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
    // Kanera tools stay within fixed Kanera services and do not contact user-selected hosts.
    openWorldHint: false,
  };
}

function validationError(message: string): never {
  throw new KaneraApiError(400, "VALIDATION_ERROR", message);
}

type CanonicalCardReference = { organisationKey: string; cardKey: string };

function canonicalCardReference(value: string): CanonicalCardReference | null {
  if (!value.startsWith("/") && !/^https?:\/\//iu.test(value)) return null;
  try {
    const url = new URL(value, "https://kanera.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length !== 4 || segments[0] !== "o" || segments[2] !== "c") return null;
    if (!ORGANISATION_KEY_PATTERN.test(segments[1]!) || !CARD_KEY_PATTERN.test(segments[3]!)) return null;
    return { organisationKey: segments[1]!.toUpperCase(), cardKey: segments[3]!.toUpperCase() };
  } catch {
    return null;
  }
}

function isCardReference(value: string): boolean {
  return UUID_PATTERN.test(value) || CARD_KEY_PATTERN.test(value) || canonicalCardReference(value) !== null;
}

const cardReference = z.string().trim().refine(isCardReference, {
  message: "use a card UUID, human key such as PROJ-123, or canonical Kanera card URL",
}).describe("Card UUID, human key such as PROJ-123, or canonical Kanera card URL. Use the URL when the same key is visible in more than one organisation.");

type CardSearchReferenceRow = {
  cardId: string;
  cardKey: string;
  organisationKey: string;
};

async function resolveCardInOrganisation(api: KaneraClient, reference: CanonicalCardReference): Promise<string | null> {
  try {
    const card = await api.get<{ id: string }>(
      `/api/v1/organisations/${encodeURIComponent(reference.organisationKey)}/cards/by-key/${encodeURIComponent(reference.cardKey)}`,
    );
    return card.id;
  } catch (error) {
    if (error instanceof KaneraApiError && error.status === 404) return null;
    throw error;
  }
}

async function resolveCardReference(api: KaneraClient, rawReference: string): Promise<string> {
  const reference = rawReference.trim();
  if (UUID_PATTERN.test(reference)) return reference;

  const canonical = canonicalCardReference(reference);
  if (canonical) {
    const id = await resolveCardInOrganisation(api, canonical);
    if (id) return id;
    throw new KaneraApiError(404, "NOT_FOUND", "card reference was not found or is not accessible");
  }

  // Prefixes are unique only inside an organisation. Search discovers every accessible organisation
  // that may own the key, then the organisation-scoped resolver distinguishes an exact current or
  // historical key from an incidental title/content match without weakening tenant isolation.
  const result = await api.get<{ cards: CardSearchReferenceRow[] }>("/api/v1/search", { q: reference, limit: 20 });
  const candidateIds = new Set<string>();
  const currentMatches = result.cards.filter((card) => card.cardKey.toUpperCase() === reference.toUpperCase());
  for (const card of currentMatches) candidateIds.add(card.cardId);

  const currentOrganisations = new Set(currentMatches.map((card) => card.organisationKey.toUpperCase()));
  const otherOrganisations = Array.from(new Set(
    result.cards
      .map((card) => card.organisationKey.toUpperCase())
      .filter((organisationKey) => !currentOrganisations.has(organisationKey)),
  ));
  const historicalMatches = await Promise.all(otherOrganisations.map((organisationKey) =>
    resolveCardInOrganisation(api, { organisationKey, cardKey: reference })));
  for (const id of historicalMatches) if (id) candidateIds.add(id);

  if (candidateIds.size === 1) return candidateIds.values().next().value!;
  if (candidateIds.size > 1) {
    validationError(`card key ${reference.toUpperCase()} is ambiguous across accessible organisations; use a canonical Kanera card URL or UUID`);
  }
  throw new KaneraApiError(404, "NOT_FOUND", "card reference was not found or is not accessible");
}

function cardReferenceResolver(api: KaneraClient) {
  const cache = new Map<string, Promise<string>>();
  return (reference: string): Promise<string> => {
    const normalized = reference.trim();
    const canonical = canonicalCardReference(normalized);
    const cacheKey = canonical
      ? `${canonical.organisationKey}/${canonical.cardKey}`
      : CARD_KEY_PATTERN.test(normalized)
        ? normalized.toUpperCase()
        : normalized.toLowerCase();
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = resolveCardReference(api, normalized);
      cache.set(cacheKey, pending);
    }
    return pending;
  };
}

async function resolveCardReferences(api: KaneraClient, references: string[]): Promise<string[]> {
  const resolve = cardReferenceResolver(api);
  return Promise.all(references.map(resolve));
}

type CardListCursor = { boardId: string; listId: string; offset: number };
type CollectionCursor = { scope: string; offset: number };

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

function encodeCollectionCursor(cursor: CollectionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCollectionCursor(value: string | undefined, scope: string): CollectionCursor {
  if (!value) return { scope, offset: 0 };
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CollectionCursor>;
    if (cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0) {
      validationError("collection cursor does not match this query");
    }
    return cursor as CollectionCursor;
  } catch (error) {
    if (error instanceof KaneraApiError) throw error;
    validationError("invalid collection cursor");
  }
}

async function remoteCollectionPage<T, U = T>(
  api: KaneraClient,
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
  limit: number | undefined,
  cursorValue: string | undefined,
  scope: string,
  transform: (row: T) => U = ((row: T) => row as unknown as U),
) {
  const cursor = decodeCollectionCursor(cursorValue, scope);
  const pageSize = limit ?? 25;
  const rows = await api.get<T[]>(path, { ...params, limit: pageSize + 1, offset: cursor.offset });
  const items = rows.slice(0, pageSize).map(transform);
  const nextOffset = cursor.offset + items.length;
  return {
    items,
    nextCursor: rows.length > pageSize ? encodeCollectionCursor({ scope, offset: nextOffset }) : null,
  };
}

const collectionPageSchema = {
  cursor: z.string().min(1).max(1000).optional().describe("Opaque nextCursor returned by the previous page."),
  limit: pageLimit,
};

function boundedConfiguration<T extends Record<string, unknown>>(value: T, limit = 100): T {
  const result: Record<string, unknown> = { ...value };
  const truncatedCollections: Array<{ field: string; total: number; returned: number }> = [];
  for (const field of ["lists", "customFields", "cardLabels", "checklistTemplates", "members", "automations", "boards", "notes", "attachments", "cards"] as const) {
    const fieldValue = result[field];
    if (!Array.isArray(fieldValue)) continue;
    const rows: unknown[] = fieldValue;
    const boundedRows = field === "customFields"
      ? rows.slice(0, limit).map((entry) => {
          if (!entry || typeof entry !== "object" || !Array.isArray((entry as { options?: unknown }).options)) return entry;
          const options = (entry as { options: unknown[] }).options;
          return { ...entry, options: options.slice(0, limit), ...(options.length > limit ? { optionsTruncated: true, optionCount: options.length } : {}) };
        })
      : rows.slice(0, limit);
    result[field] = boundedRows;
    if (rows.length > limit) truncatedCollections.push({ field, total: rows.length, returned: limit });
  }
  if (truncatedCollections.length > 0) result.truncatedCollections = truncatedCollections;
  return result as T;
}

function noteTargetPath(args: { workspaceId?: string; boardId?: string }, suffix: string) {
  if (Boolean(args.workspaceId) === Boolean(args.boardId)) {
    validationError("provide exactly one of workspaceId or boardId");
  }
  return args.boardId
    ? `/api/v1/boards/${args.boardId}/${suffix}`
    : `/api/v1/workspaces/${args.workspaceId}/${suffix}`;
}

type NoteRow = {
  id: string;
  content: string;
  updatedAt: string;
} & Record<string, unknown>;

function markdownLink(label: string | undefined, url: string): string {
  const text = (label?.trim() || url).replace(/([\\[\]])/g, "\\$1");
  // Angle-bracket destinations keep parentheses in ordinary URLs from terminating Markdown links.
  const destination = url.replace(/</g, "%3C").replace(/>/g, "%3E");
  return `[${text}](<${destination}>)`;
}

function decodeBase64File(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/u, "");
  if (canonical !== value.replace(/=+$/u, "")) validationError("fileBase64 must be canonical base64");
  return bytes;
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
      annotations: ToolAnnotations;
    },
    callback: (args: unknown) => Promise<CallToolResult>,
  ) => void;
  registerTool(name, {
    title: toolTitle(name),
    description,
    inputSchema,
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
    { instructions: "Kanera MCP is work-focused: it can read configuration needed to resolve boards, lists, labels, fields, options, members, and permissions, but workspace/board/list/field/label administration remains in the Kanera UI. Standard-workspace lists, fields, labels, and membership are shared across its boards; standalone boards have dedicated configuration. Card reference fields accept a UUID, human key such as PROJ-123, or canonical card URL. Use kanera_list_accessible_boards for complete discovery including standalone and guest boards, kanera_get_board for metadata/configuration, and kanera_get_cards_list for bounded list pages. Use kanera_get_cards_content when a selected set of cards needs checklist/comment analysis without one request per card. Use kanera_query_work_cards and kanera_get_portfolio_summary for bounded team, stale-work, and portfolio reporting; use the personal history/current-work tools for standups. Use kanera_search_docs for product guidance and kanera_search for live user data. Personal notes are private to their owner. Read-only credentials cannot mutate. Board, workspace, list, field, label, note, and note-attachment deletion or administration not represented by a tool must be completed manually in the Kanera UI." },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, ctx: KaneraMcpContext) {
  registerKaneraTool(server, "kanera_get_session", "Describe the current Kanera credential, effective scope, pinned workspace if any, and canonical Kanera web URL.", {}, (_a, api) =>
    api.get("/api/v1/session"), ctx);
  registerKaneraTool(server, "kanera_list_workspaces", "List a cursor-paginated directory of accessible standard workspaces. Standalone boards and parent workspaces reached only through board-level guest access are excluded; use kanera_list_accessible_boards for complete board discovery.", collectionPageSchema, async (a, api) => {
    // The public API returns a pinned standalone configuration workspace to its own workspace key.
    // The MCP product model keeps this tool consistently standard-workspace-only for every credential.
    const page = await remoteCollectionPage<{ kind?: string } & Record<string, unknown>>(api, "/api/v1/workspaces", {}, a.limit, a.cursor, "workspaces");
    return { ...page, items: page.items.filter((workspace) => workspace.kind !== "board") };
  }, ctx);
  registerKaneraTool(server, "kanera_list_accessible_boards", "Discover a cursor-paginated directory of every accessible workspace board, standalone board, and cross-organisation guest board.", collectionPageSchema, async (a, api) =>
    remoteCollectionPage(api, "/api/v1/boards", {}, a.limit, a.cursor, "accessible-boards"), ctx);
  registerKaneraTool(server, "kanera_get_workspace", "Read a standard workspace and its shared lists, custom fields, labels, templates, and automations. For a standalone board, use kanera_get_standalone_board_settings.", { workspaceId: uuid }, async (a, api) =>
    boundedConfiguration((await standardWorkspaceContext(api, a.workspaceId)).detail), ctx);
  registerKaneraTool(server, "kanera_list_workspace_boards", "List a cursor-paginated directory of boards inside a standard workspace. Use kanera_list_accessible_boards when the workspace is unknown or the board may be standalone.", { workspaceId: uuid, ...collectionPageSchema }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return remoteCollectionPage(api, `/api/v1/workspaces/${a.workspaceId}/boards`, {}, a.limit, a.cursor, `workspace-boards:${a.workspaceId}`);
  }, ctx);
  registerKaneraTool(server, "kanera_list_workspace_members", "List a cursor-paginated directory of a standard workspace's members with userId, displayName, email, and role. Use kanera_get_board to resolve assignees for a standalone board. Requires workspace access.", { workspaceId: uuid, ...collectionPageSchema }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return remoteCollectionPage(api, `/api/v1/workspaces/${a.workspaceId}/members`, {}, a.limit, a.cursor, `workspace-members:${a.workspaceId}`);
  }, ctx);
  registerKaneraTool(server, "kanera_get_standalone_board_settings", "Read a standalone board's identity, retention, lists, custom fields, labels, templates, and automations using its visible board id. Requires access to the board's configuration; board-only cross-organisation guests cannot use this tool.", {
    boardId: uuid,
  }, async (a, api) => {
    const { board, detail } = await standaloneBoardContext(api, a.boardId);
    return boundedConfiguration({ board, ...detail });
  }, ctx);
  registerKaneraTool(server, "kanera_get_board", "Get a workspace board or standalone board with its workflow lists, members, labels, and custom fields, but without cards. Use the returned list ids with kanera_get_cards_list to retrieve cards only from the lists needed.", {
    boardId: uuid,
  }, async (a, api) => {
    const detail = await api.post<Record<string, unknown>>(`/api/v1/boards/${a.boardId}/open`, undefined, { includeCards: false });
    // Board discovery must not leak the potentially enormous all-list card collection into the
    // MCP result. Keep every other board-detail field aligned with the board-open API payload.
    const { cards: _cards, ...boardWithoutCards } = detail;
    return boundedConfiguration(boardWithoutCards);
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
  registerKaneraTool(server, "kanera_search_docs", "Search official Kanera documentation for product behavior, setup, permissions, and workflow guidance. Returns relevant sections with concise excerpts and canonical source URLs; this does not search the user's live Kanera data.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  }, (a, _api) => docsSearchClient(ctx.docsSearchUrl).search(a.query, a.limit), ctx);
  registerKaneraTool(server, "kanera_get_card", "Read a card detail, including labels, assignees, checklist item descriptions, nested sub-checklists, attachments, and linked notes. Checklists are returned flat; a sub-checklist's parentItemId identifies its owning top-level item.", { cardId: cardReference }, async (a, api) =>
    api.get(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/detail`), ctx);
  registerKaneraTool(server, "kanera_get_cards_content", `Read checklist and comment content for up to 200 selected cards in one board, avoiding one detail/comment request per card during summaries, audits, and migrations. Best-effort: ids not visible on the board are returned in missingCardIds, and cards whose bounded comment history is incomplete are listed in truncatedCardIds so kanera_list_card_comments can page them. ${boardBatchScope}`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
  }, async (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/content/query`, { cardIds: await resolveCardReferences(api, a.cardIds) }), ctx);
  registerKaneraTool(server, "kanera_list_card_history", "List a card's retained, user-visible history, including comments and activity, newest first. Cursor-paginated and accepts a human key such as PROJ-123. Hidden/coalesced no-op activity and activity outside the configured retention window are not returned.", {
    cardId: cardReference,
    cursor: z.string().min(1).max(1000).optional().describe("Opaque nextCursor returned by the previous page."),
    limit: z.number().int().min(1).max(100).default(50),
  }, async (a, api) => api.get(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/feed`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_create_card", "Create a card in one of the board's workflow lists. Works with workspace and standalone boards. Requires board editor access and a write-capable credential.", {
    boardId: uuid,
    listId: uuid.describe("Target workflow list id returned by kanera_get_board."),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).optional(),
    atTop: z.boolean().optional(),
    idempotencyKey: uuid.optional().describe("Stable UUID reused when retrying this create after an ambiguous failure."),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards`, { title: a.title, description: a.description, atTop: a.atTop, clientToken: a.idempotencyKey }), ctx);
  registerKaneraTool(server, "kanera_update_card", "Update one or more card content fields. The required changes object cannot be empty. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    changes: cardUpdateChanges,
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}`, a.changes), ctx);
  registerKaneraTool(server, "kanera_move_card", "Move or reorder a card using one explicit before/after anchor; a null anchor id means that edge. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    listId: uuid,
    anchor: positionAnchor,
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/move`, {
    listId: a.listId,
    ...(a.anchor.side === "after" ? { afterCardId: a.anchor.id } : { beforeCardId: a.anchor.id }),
  }), ctx);
  registerKaneraTool(server, "kanera_duplicate_card", "Copy a card, optionally into another editable board and list. Requires board editor access at the source and destination. This is not idempotent; do not retry after an ambiguous success.", {
    cardId: cardReference,
    boardId: uuid.optional().describe("Destination board; defaults to the source board."),
    listId: uuid.optional().describe("Destination list; required when copying across workspaces, otherwise defaults to the source card's list."),
    atTop: z.boolean().optional(),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/duplicate`, { boardId: a.boardId, listId: a.listId, atTop: a.atTop }), ctx);
  registerKaneraTool(server, "kanera_move_card_to_board", "Move a card to another board in the same standard workspace. Standalone boards have no valid destination. Requires editor access to both boards and a write-capable credential.", {
    cardId: cardReference,
    boardId: uuid.describe("Destination board id. Must be in the same workspace."),
    listId: uuid.optional().describe("Destination list; defaults to a matching list on the target board."),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/move-to-board`, { boardId: a.boardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_archive_card", "Archive or unarchive a card. Requires board editor access and a write-capable credential.", { cardId: cardReference, archived: z.boolean().default(true) }, async (a, api) =>
    api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/archive`, { archived: a.archived }), ctx);
  registerKaneraTool(server, "kanera_set_card_completion", "Mark a card complete or incomplete; completion is distinct from archiving. Requires board editor access and a write-capable credential.", { cardId: cardReference, completed: z.boolean() }, async (a, api) =>
    api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_completion", `Mark up to 200 selected cards complete or incomplete in one board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    completed: z.boolean(),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/completion`, { cardIds: await resolveCardReferences(api, a.cardIds), completed: a.completed }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_due_date", `Set or clear one due date on up to 200 selected cards in a board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    dueDateSlot: z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]).nullable().optional(),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/due-date`, { cardIds: await resolveCardReferences(api, a.cardIds), dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "kanera_bulk_patch_card_labels", `Add or remove labels on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    labelIds: z.array(uuid).min(1),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/labels`, { cardIds: await resolveCardReferences(api, a.cardIds), mode: a.mode, labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_bulk_patch_card_assignees", `Add or remove assignees on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    userIds: z.array(uuid).min(1),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/assignees`, { cardIds: await resolveCardReferences(api, a.cardIds), mode: a.mode, userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_bulk_move_cards", `Move up to 200 selected active cards to one workflow list in their board. Returns moved cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    listId: uuid,
  }, async (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/move`, { cardIds: await resolveCardReferences(api, a.cardIds), listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_bulk_archive_cards", `Archive up to 200 selected cards in one board. This is destructive and cannot bulk-unarchive. Returns archived cards. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/archive`, { cardIds: await resolveCardReferences(api, a.cardIds), archived: true }), ctx);
  registerKaneraTool(server, "kanera_bulk_duplicate_cards", `Duplicate up to 200 selected active cards, optionally to another editable board and list. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires board editor access at the source and destination.`, {
    boardId: uuid.describe("Source board id."),
    cardIds: z.array(cardReference).min(1).max(200),
    targetBoardId: uuid.optional(),
    listId: uuid.optional(),
  }, async (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/duplicate`, { cardIds: await resolveCardReferences(api, a.cardIds), boardId: a.targetBoardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "kanera_bulk_set_card_custom_field", `Set, fill, add, remove, or clear one custom field on up to 200 selected cards. Returns changed values/card ids and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    fieldId: uuid,
    mode: z.enum(["setAll", "fillEmpty", "add", "remove", "clear"]),
    valueText: z.string().max(20000).nullable().optional(),
    valueNumber: z.union([z.number(), z.string()]).nullable().optional(),
    valueCheckbox: z.boolean().nullable().optional(),
    valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    valueUrl: z.url().max(2000).nullable().optional(),
    valueOptionIds: z.array(uuid).nullable().optional(),
    valueUserIds: z.array(uuid).nullable().optional(),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/custom-fields`, {
    cardIds: await resolveCardReferences(api, a.cardIds),
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
  registerKaneraTool(server, "kanera_move_list_cards", "Move every active card from one workflow list to another on exactly one board. Requires board editor access.", {
    sourceListId: uuid,
    targetListId: uuid,
    boardId: uuid,
  }, (a, api) => api.post(`/api/v1/lists/${a.sourceListId}/cards/move`, { targetListId: a.targetListId, boardId: a.boardId }), ctx);
  registerKaneraTool(server, "kanera_archive_list_cards", "Archive every active card in one workflow list on exactly one board. This is destructive and requires board editor access.", {
    listId: uuid,
    boardId: uuid,
  }, (a, api) => api.patch(`/api/v1/lists/${a.listId}/cards/archive`, { boardId: a.boardId }), ctx);
  registerKaneraTool(server, "kanera_set_card_assignees", "Replace all assignees on a card. Requires board editor access and a write-capable credential.", { cardId: cardReference, userIds: z.array(uuid).max(100) }, async (a, api) =>
    api.put(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/assignees`, { userIds: a.userIds }), ctx);
  registerKaneraTool(server, "kanera_set_card_labels", "Replace all labels on a card. Requires board editor access and a write-capable credential.", { cardId: cardReference, labelIds: z.array(uuid).max(100) }, async (a, api) =>
    api.put(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/labels`, { labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "kanera_set_custom_field_value", "Set or clear one custom-field value on a card. Requires board editor access and a write-capable credential.", customFieldValueSchema(), async (a, api) =>
    api.put(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/custom-fields/${a.fieldId}`, customFieldValueBody(a.value)), ctx);
  registerKaneraTool(server, "kanera_add_comment", "Add a comment to a card, optionally linking card attachments already uploaded for that comment. Requires board editor access and a write-capable credential. This is not idempotent; do not retry after an ambiguous success.", {
    cardId: cardReference,
    body: z.string().min(1).max(20000),
    attachmentIds: z.array(uuid).max(100).optional(),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/comments`, { body: a.body, attachmentIds: a.attachmentIds }), ctx);
  registerKaneraTool(server, "kanera_list_card_comments", "List a card's comments, newest first. Cursor-paginated; pass the opaque nextCursor unchanged.", {
    cardId: cardReference,
    cursor: z.string().min(1).max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, async (a, api) => api.get(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/comments`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_delete_comment", "Delete one comment authored by the acting user. Comments from other users, integration credentials, or the system are rejected. This is destructive; use only after an explicit request and, for migrations, after verifying the destination. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
  }, (a, api) => api.delete(`/api/v1/comments/${a.commentId}`), ctx);
  registerKaneraTool(server, "kanera_update_comment", "Replace the text of a comment authored by the acting user, optionally linking newly uploaded card attachments. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
    body: z.string().min(1).max(20000),
    attachmentIds: z.array(uuid).max(100).optional(),
  }, (a, api) => api.patch(`/api/v1/comments/${a.commentId}`, { body: a.body, attachmentIds: a.attachmentIds }), ctx);
  registerKaneraTool(server, "kanera_set_comment_reaction", "Idempotently add or remove the connected user's reaction on another person's comment. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
    type: reactionType,
    active: z.boolean(),
  }, (a, api) => a.active
    ? api.post(`/api/v1/comments/${a.commentId}/reactions`, { type: a.type })
    : api.delete(`/api/v1/comments/${a.commentId}/reactions/${encodeURIComponent(a.type)}`), ctx);
  registerKaneraTool(server, "kanera_add_card_attachment", "Upload one small file to a card. MCP request limits cap fileBase64 at roughly 512 KiB decoded; use the public API directly for larger files. For a new comment attachment, set source=comment and then include the returned attachment id in kanera_add_comment; commentId may link it directly to an existing owned comment.", {
    cardId: cardReference,
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
    fileBase64,
    source: z.enum(["description", "attachment", "comment"]).default("attachment"),
    commentId: uuid.optional(),
  }, async (a, api) => {
    if (a.commentId && a.source !== "comment") validationError("commentId can only be used when source is comment");
    return api.upload(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/attachments`, {
      fileName: a.fileName,
      mimeType: a.mimeType,
      bytes: decodeBase64File(a.fileBase64),
    }, { source: a.source, commentId: a.commentId });
  }, ctx);
  registerKaneraTool(server, "kanera_delete_card_attachment", "Delete a card attachment. If it is the cover, Kanera selects the next eligible image cover. This is destructive and requires board editor access with a write-capable credential.", {
    cardId: cardReference,
    attachmentId: uuid,
  }, async (a, api) => api.delete(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/attachments/${a.attachmentId}`), ctx);
  registerKaneraTool(server, "kanera_set_card_cover", "Set one existing image attachment as a card's cover, or pass null to remove the cover. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    attachmentId: uuid.nullable(),
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/cover`, { attachmentId: a.attachmentId }), ctx);
  registerKaneraTool(server, "kanera_create_checklist", "Add a top-level checklist to a card, or create a one-level sub-checklist by passing the owning top-level parentItemId. Requires board editor access and a write-capable credential. This is not idempotent.", {
    cardId: cardReference,
    title: z.string().trim().min(1).max(500),
    parentItemId: uuid.nullable().optional().describe("Top-level checklist item that owns this sub-checklist; omit or null for a card-level checklist."),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists`, { title: a.title, parentItemId: a.parentItemId }), ctx);
  registerKaneraTool(server, "kanera_update_checklist", "Rename a checklist. Requires board editor access and a write-capable credential.", { cardId: cardReference, checklistId: uuid, title: z.string().trim().min(1).max(500) }, async (a, api) =>
    api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}`, { title: a.title }), ctx);
  registerKaneraTool(server, "kanera_delete_checklist", "Delete a checklist and its items. This is destructive and requires board editor access with a write-capable credential.", { cardId: cardReference, checklistId: uuid }, async (a, api) =>
    api.delete(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}`), ctx);
  registerKaneraTool(server, "kanera_move_checklist", "Reorder a checklist using one explicit before/after anchor; a null anchor id means that edge. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid,
    anchor: positionAnchor,
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/move`,
    a.anchor.side === "after" ? { afterChecklistId: a.anchor.id } : { beforeChecklistId: a.anchor.id }), ctx);
  registerKaneraTool(server, "kanera_add_checklist_item", "Add an item to a checklist. Items in sub-checklists are leaf rows with text and completion only. Requires board editor access and a write-capable credential. This is not idempotent.", { cardId: cardReference, checklistId: uuid, text: z.string().trim().min(1).max(2000) }, async (a, api) =>
    api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items`, { text: a.text }), ctx);
  registerKaneraTool(server, "kanera_update_checklist_item", "Update a checklist item's text, completion, description, assignee, or due date. Description, assignee, and due date apply only to top-level items; sub-checklist leaves support text and completion only. Provide at least one field. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid,
    itemId: uuid,
    changes: checklistItemChanges,
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/${a.itemId}`, a.changes), ctx);
  registerKaneraTool(server, "kanera_bulk_update_checklist_items", "Set or clear the assignee or due date on all items in one checklist. Provide assigneeId or a due date. Repeating the same arguments is idempotent. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid,
    changes: bulkChecklistItemChanges,
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/bulk`, a.changes), ctx);
  registerKaneraTool(server, "kanera_delete_checklist_item", "Delete a checklist item. This is destructive and requires board editor access with a write-capable credential.", { cardId: cardReference, checklistId: uuid, itemId: uuid }, async (a, api) =>
    api.delete(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/${a.itemId}`), ctx);
  registerKaneraTool(server, "kanera_move_checklist_item", "Move or reorder a checklist item, optionally into another checklist, using one explicit anchor. A null anchor id means that edge. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid.describe("Source checklist id."),
    itemId: uuid,
    targetChecklistId: uuid.optional().describe("Destination checklist id; omit to reorder within the source checklist."),
    anchor: positionAnchor,
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/${a.itemId}/move`, {
    checklistId: a.targetChecklistId,
    ...(a.anchor.side === "after" ? { afterItemId: a.anchor.id } : { beforeItemId: a.anchor.id }),
  }), ctx);
  registerKaneraTool(server, "kanera_list_activity", "List a cursor-paginated board-wide feed of recent activity and comments.", {
    boardId: uuid,
    cursor: z.string().min(1).max(1000).optional(),
    limit: pageLimit,
  }, (a, api) => api.get(`/api/v1/boards/${a.boardId}/activity`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "kanera_list_completed_work", "List completed cards on one board, newest first. Cursor-paginated with optional date, list, and title filters.", {
    boardId: uuid,
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    listId: uuid.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }, (a, api) => api.get(`/api/v1/boards/${a.boardId}/completed`, {
    from: a.from, to: a.to, listId: a.listId, q: a.q, cursor: a.cursor, limit: a.limit,
  }), ctx);
  registerKaneraTool(server, "kanera_list_work_done", "List created, moved, completed, and checklist activity on one board. from and to are required ISO datetimes.", {
    boardId: uuid,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    q: z.string().trim().min(1).max(200).optional(),
    timeZone: z.string().trim().min(1).max(100).default("UTC"),
  }, (a, api) => api.get(`/api/v1/boards/${a.boardId}/work-done`, {
    from: a.from,
    to: a.to,
    q: a.q,
    timeZone: a.timeZone,
  }), ctx);
  registerKaneraTool(server, "kanera_list_my_work_history", "List work performed by the connected user across all accessible boards, including standalone and guest boards. Returns created, moved, completed, and checklist-item-completed events, complete-range counts, display-name lookups, card URLs, and cursor pagination. Use a calendar preset or an exact from/to range; presets use the profile timezone unless timeZone is supplied.", {
    preset: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month"]).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    timeZone: z.string().trim().min(1).max(100).optional(),
    scope: workScope,
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, (a, api) => {
    if (Boolean(a.from) !== Boolean(a.to)) validationError("from and to must be provided together");
    if (a.preset && (a.from || a.to)) validationError("preset cannot be combined with from and to");
    return api.post("/api/v1/me/work-history", a);
  }, ctx);
  registerKaneraTool(server, "kanera_list_my_current_work", "List the connected user's active cards and assigned checklist items across all accessible boards. Returns current totals, display-name lookups, card URLs, and cursor pagination. Use with kanera_list_my_work_history to prepare a standup.", {
    scope: workScope,
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500_000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, (a, api) => api.post("/api/v1/me/current-work", a), ctx);
  registerKaneraTool(server, "kanera_query_work_cards", "Query a bounded page of my or my visible team's cards across accessible workspace, standalone, and guest boards. Supports assignment, workflow, label, custom-field, due/completion, overdue, unassigned, last-activity, and last-moved filters. Each card includes lastActivityAt and lastMovedAt for stale-work analysis.", {
    lens: z.enum(["my", "team"]),
    scope: workScope,
    filters: workFilters,
    sort: z.enum(["dueAsc", "dueDesc", "titleAsc", "titleDesc", "createdAsc", "createdDesc", "updatedAsc", "updatedDesc"]).default("dueAsc"),
    cursor: z.string().min(1).max(500_000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, (a, api) => api.post("/api/v1/work/cards/query", a), ctx);
  registerKaneraTool(server, "kanera_get_portfolio_summary", "Get bounded organisation, workspace, and board rollups across accessible work, including active, overdue, due-soon, unassigned, completed, and overdue-checklist counts plus recent activity buckets.", {
    scope: workScope,
    filters: workFilters,
    days: z.number().int().min(1).max(60).default(30),
    timeZone: z.string().trim().min(1).max(100).default("UTC"),
  }, (a, api) => api.post("/api/v1/work/portfolio/query", a), ctx);
  registerKaneraTool(server, "kanera_list_notes", "List a cursor-paginated page of flat note metadata. parentNoteId expresses the hierarchy; use kanera_get_note for full content. Provide exactly one of workspaceId for a standard workspace or boardId for a workspace or standalone board. Personal notes are limited to the connected user.", {
    workspaceId: uuid.optional(),
    boardId: uuid.optional(),
    scope: z.enum(["personal", "team"]).default("team"),
    ...collectionPageSchema,
  }, async (a, api) => {
    const target = a.boardId ? `board:${a.boardId}` : `workspace:${a.workspaceId}`;
    // Tree listings are navigation metadata; defer large Markdown bodies to get_note so one page
    // cannot consume the entire model context in a large knowledge base.
    return remoteCollectionPage<Record<string, unknown>, Record<string, unknown>>(
      api,
      noteTargetPath(a, "notes"),
      { scope: a.scope },
      a.limit,
      a.cursor,
      `notes:${target}:${a.scope}`,
      ({ content: _content, ...note }) => note,
    );
  }, ctx);
  registerKaneraTool(server, "kanera_get_note", "Read any visible top-level or nested note. Personal notes are limited to their owner.", { noteId: uuid }, (a, api) => api.get(`/api/v1/notes/${a.noteId}`), ctx);
  registerKaneraTool(server, "kanera_get_note_backlinks", "List bounded visible cards, boards, and notes that link to a note.", { noteId: uuid }, async (a, api) =>
    boundedConfiguration(await api.get<Record<string, unknown>>(`/api/v1/notes/${a.noteId}/backlinks`)), ctx);
  registerKaneraTool(server, "kanera_list_note_attachments", "List a bounded set of files attached to a visible note at any hierarchy level.", { noteId: uuid }, async (a, api) => {
    const rows = await api.get<unknown[]>(`/api/v1/notes/${a.noteId}/attachments`);
    return { items: rows.slice(0, 100), truncated: rows.length > 100, total: rows.length };
  }, ctx);
  registerKaneraTool(server, "kanera_create_note", "Create a personal or team note at any supported hierarchy level. The required target explicitly selects a standard workspace or a board. Personal notes are private to the connected user. Team notes require workspace administration or board editor access; creation is not idempotent.", noteMutationSchema(), (a, api) =>
    api.post(a.target.type === "workspace"
      ? `/api/v1/workspaces/${a.target.workspaceId}/notes`
      : `/api/v1/boards/${a.target.boardId}/notes`, {
      scope: a.scope,
      parentNoteId: a.parentNoteId,
      title: a.title,
      icon: a.icon,
      color: a.color,
    }), ctx);
  registerKaneraTool(server, "kanera_update_note", "Update one or more fields on any visible top-level or nested note. The required changes object cannot be empty. Markdown content can contain external links, Kanera-internal links, and attachment URLs. Team-note edits respect Kanera note locks and require workspace administration or board editor access; personal notes are limited to their owner.", {
    noteId: uuid,
    changes: noteUpdateChanges,
  }, (a, api) => api.patch(`/api/v1/notes/${a.noteId}`, a.changes), ctx);
  registerKaneraTool(server, "kanera_add_note_link", "Append a Markdown link to a note without replacing its existing content. The public API's optimistic timestamp prevents overwriting a concurrent edit.", {
    noteId: uuid,
    url: z.url().max(2048),
    label: z.string().trim().min(1).max(200).optional(),
  }, async (a, api) => {
    const note = await api.get<NoteRow>(`/api/v1/notes/${a.noteId}`);
    const link = markdownLink(a.label, a.url);
    const content = note.content.trimEnd() ? `${note.content.trimEnd()}\n\n${link}` : link;
    return api.patch(`/api/v1/notes/${a.noteId}`, { content, baseUpdatedAt: note.updatedAt });
  }, ctx);
  registerKaneraTool(server, "kanera_add_note_attachment", "Upload one small file to a note at any hierarchy level. MCP request limits cap fileBase64 at roughly 512 KiB decoded; use the public API directly for larger files. The returned URL can be added to note content with kanera_add_note_link.", {
    noteId: uuid,
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
    fileBase64,
    source: z.enum(["description", "attachment"]).default("attachment"),
  }, (a, api) => api.upload(`/api/v1/notes/${a.noteId}/attachments`, {
    fileName: a.fileName,
    mimeType: a.mimeType,
    bytes: decodeBase64File(a.fileBase64),
  }, { source: a.source }), ctx);
  registerKaneraTool(server, "kanera_duplicate_note", "Duplicate one visible note, including its Markdown, icon, color, and link relationships. Descendant notes and binary attachments are not copied. The duplicate remains in the same workspace/board and personal/team collection.", {
    noteId: uuid,
    parentNoteId: uuid.nullable().optional(),
    title: z.string().max(200).optional(),
  }, (a, api) => api.post(`/api/v1/notes/${a.noteId}/duplicate`, {
    parentNoteId: a.parentNoteId,
    title: a.title,
  }), ctx);
  registerKaneraTool(server, "kanera_move_note", "Reparent or reorder a note within its current workspace/board and personal/team collection. Notes cannot be moved across tenancy boundaries.", {
    noteId: uuid,
    parentNoteId: uuid.nullable(),
    afterNoteId: uuid.nullable().optional(),
    beforeNoteId: uuid.nullable().optional(),
  }, (a, api) => api.patch(`/api/v1/notes/${a.noteId}/move`, {
    parentNoteId: a.parentNoteId,
    afterNoteId: a.afterNoteId,
    beforeNoteId: a.beforeNoteId,
  }), ctx);
}

function customFieldValueSchema() {
  return {
    cardId: cardReference,
    fieldId: uuid,
    value: z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), value: z.string().max(20000).nullable() }),
      z.object({ type: z.literal("number"), value: z.union([z.number(), z.string()]).nullable() }),
      z.object({ type: z.literal("checkbox"), value: z.boolean().nullable() }),
      z.object({ type: z.literal("date"), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
      z.object({ type: z.literal("url"), value: z.url().max(2000).nullable() }),
      z.object({ type: z.literal("select"), value: z.array(uuid).nullable() }),
      z.object({ type: z.literal("user"), value: z.array(uuid).nullable() }),
    ]),
  };
}

function customFieldValueBody(value: ToolArgs<ReturnType<typeof customFieldValueSchema>>["value"]) {
  switch (value.type) {
    case "text": return { valueText: value.value };
    case "number": return { valueNumber: value.value };
    case "checkbox": return { valueCheckbox: value.value };
    case "date": return { valueDate: value.value };
    case "url": return { valueUrl: value.value };
    case "select": return { valueOptionIds: value.value };
    case "user": return { valueUserIds: value.value };
  }
}

function noteMutationSchema() {
  return {
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("workspace"), workspaceId: uuid }),
      z.object({ type: z.literal("board"), boardId: uuid }),
    ]),
    scope: z.enum(["personal", "team"]).default("team"),
    parentNoteId: uuid.nullable().optional(),
    title: z.string().max(200).optional(),
    icon: z.string().trim().min(1).max(100).nullable().optional(),
    color: colorToken.nullable().optional(),
  };
}

function registerResources(server: McpServer, ctx: KaneraMcpContext) {
  registerResource(server, "workspace", "kanera://workspace/{workspaceId}", "Bounded standard workspace configuration and shared resources.", (vars, api) => standardWorkspaceContext(api, vars.workspaceId!).then((result) => boundedConfiguration(result.detail)), ctx);
  registerResource(server, "board", "kanera://board/{boardId}", "Bounded workspace or standalone board metadata and configuration without cards.", async (vars, api) => boundedConfiguration(await api.post<Record<string, unknown>>(`/api/v1/boards/${vars.boardId}/open`, undefined, { includeCards: false })), ctx);
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
    messages: [{ role: "user", content: { type: "text", text: `Call kanera_get_board for ${a.boardId}, then page the relevant lists with kanera_get_cards_list. Use kanera_query_work_cards scoped to this board for overdue, unassigned, and stale-card evidence, and inspect kanera_list_card_history only for cards that need chronology. Summarize progress, blockers, risks, and next actions; distinguish observed facts from inferences.` } }],
  }));
  server.registerPrompt("prepare_standup_update", { description: "Prepare the connected user's cross-board standup update.", argsSchema: { period: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month"]).default("yesterday") } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Use kanera_list_my_work_history with preset ${a.period} for work I performed across my accessible Kanera boards, then use kanera_list_my_current_work for work in flight. Draft a concise accomplishments/current work/blockers update. Identify blockers only when supported by card data, and label any inference.` } }],
  }));
  server.registerPrompt("draft_card_from_notes", { description: "Draft a card title and description from one note.", argsSchema: { noteId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Call kanera_get_note for ${a.noteId} and draft a Kanera card title plus Markdown description. Do not create the card until asked.` } }],
  }));
}
