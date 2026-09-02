import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import mcpPackage from "../package.json" with { type: "json" };
import { docsSearchClient } from "./docs-search.js";
import { env } from "./env.js";
import { KaneraApiError, KaneraClient } from "./kanera-client.js";
import { mcpToolDuration } from "./metrics.js";

const uuid = z.uuid();
const pageLimit = z.number().int().min(1).max(100).default(25);
const fileBase64 = z.string()
  .min(1)
  .max(700_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const workScope = z.object({
  allAccessible: z.boolean().default(false).describe("Set true to include every accessible board and ignore the ID filters."),
  organisationIds: z.array(uuid).max(20).default([]).describe("Organisation UUIDs to include."),
  workspaceIds: z.array(uuid).max(100).default([]).describe("Workspace UUIDs to include."),
  boardIds: z.array(uuid).max(500).default([]).describe("Board UUIDs to include."),
}).optional().describe("Omit for every accessible board. When supplied, the listed IDs define the scope unless allAccessible is true.");
const workCustomFieldCondition = z.object({
  workspaceId: uuid.describe("Workspace UUID that owns the custom field."),
  fieldId: uuid.describe("Custom-field UUID to test."),
  op: z.enum([
    "contains", "equals", "eq", "neq", "gt", "gte", "lt", "lte",
    "on", "before", "after", "between", "checked", "unchecked",
    "isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty",
  ]).describe("Comparison operator appropriate for the field type."),
  value: z.string().max(500).optional().describe("Primary scalar comparison value."),
  value2: z.string().max(500).optional().describe("Upper bound used only by the between operator."),
  ids: z.array(uuid).max(100).optional().describe("Option or user UUIDs used by set-based operators."),
});
const workFilters = z.object({
  q: z.string().trim().max(200).optional().describe("Case-insensitive card text query."),
  assigneeIds: z.array(uuid).max(100).optional().describe("User UUIDs; cards matching any are included."),
  listIds: z.array(uuid).max(200).optional().describe("Workflow-list UUIDs to include."),
  labelIds: z.array(uuid).max(200).optional().describe("Label UUIDs; cards matching any are included."),
  customFieldConditions: z.array(workCustomFieldCondition).max(50).optional().describe("Typed custom-field predicates combined with the other filters."),
  completion: z.enum(["activeAndRecentlyCompleted", "active", "completed", "all"]).optional().describe("Completion-state subset to return."),
  unassignedOnly: z.boolean().optional().describe("Return only cards with no assignees."),
  inactiveOnly: z.boolean().optional().describe("Return active cards whose canonical activity timestamp is at least 14 days old."),
  dueFrom: z.iso.date().nullable().optional().describe("Inclusive due-date lower bound in YYYY-MM-DD format."),
  dueTo: z.iso.date().nullable().optional().describe("Inclusive due-date upper bound in YYYY-MM-DD format."),
  overdueOnly: z.boolean().optional().describe("Return only overdue active cards."),
  overdueChecklistOnly: z.boolean().optional().describe("Return only cards with an overdue checklist item."),
  archived: z.boolean().optional().describe("Whether to include archived cards."),
  completedFrom: z.iso.datetime().nullable().optional().describe("Inclusive completion-time lower bound."),
  completedTo: z.iso.datetime().nullable().optional().describe("Exclusive completion-time upper bound."),
  lastActivityBefore: z.iso.datetime().nullable().optional().describe("Return cards with no visible activity at or after this instant."),
  lastMovedBefore: z.iso.datetime().nullable().optional().describe("Return cards with no move at or after this instant."),
}).optional();
const sourceDirectorySchema = z.object({
  boards: z.array(z.looseObject({
    id: uuid,
    name: z.string(),
    url: z.url(),
    workspaceId: uuid,
    workspaceName: z.string(),
    organisationId: uuid,
    organisationName: z.string(),
  })),
  lists: z.array(z.looseObject({ id: uuid, workspaceId: uuid, name: z.string() })),
  labels: z.array(z.looseObject({ id: uuid, workspaceId: uuid, name: z.string() })),
  people: z.array(z.looseObject({ id: uuid, displayName: z.string() })),
});
const linkedWorkCardSchema = z.looseObject({
  id: uuid,
  key: z.string(),
  title: z.string(),
  boardId: uuid,
  workspaceId: uuid,
  listId: uuid,
  url: z.url(),
});
const workCardsOutputSchema = z.looseObject({
  cards: z.array(linkedWorkCardSchema),
  checklistItems: z.array(z.looseObject({ itemId: uuid, boardId: uuid, listId: uuid, assigneeId: uuid, url: z.url() })),
  totals: z.looseObject({ cards: z.number(), completed: z.number() }),
  sources: sourceDirectorySchema,
  nextCursor: z.string().nullable(),
});
const workHistoryOutputSchema = z.object({
  actor: z.object({ userId: uuid, displayName: z.string() }),
  range: z.object({ from: z.iso.datetime(), to: z.iso.datetime(), timeZone: z.string() }),
  summary: z.object({
    created: z.number(),
    moved: z.number(),
    completed: z.number(),
    checklistItemCompleted: z.number(),
    cardsTouched: z.number(),
    totalEvents: z.number(),
  }),
  events: z.array(z.looseObject({
    id: z.string(),
    type: z.enum(["created", "moved", "completed", "checklistItemCompleted"]),
    at: z.iso.datetime(),
    boardId: uuid,
    listId: uuid,
    card: linkedWorkCardSchema,
  })),
  sources: sourceDirectorySchema,
  nextCursor: z.string().nullable(),
});
const searchResultBase = {
  id: uuid,
  matchContext: z.string(),
  workspaceId: uuid,
  workspaceName: z.string(),
  boardId: uuid.nullable(),
  boardName: z.string().nullable(),
  url: z.url(),
};
const cardSearchResultFields = {
  ...searchResultBase,
  boardId: uuid,
  boardName: z.string(),
  cardId: uuid,
  cardKey: z.string(),
  cardTitle: z.string(),
  listName: z.string(),
};
const searchOutputSchema = z.object({
  query: z.string(),
  results: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("card"), ...cardSearchResultFields }),
    z.object({ type: z.literal("comment"), ...cardSearchResultFields }),
    z.object({ type: z.literal("note"), ...searchResultBase, title: z.string() }),
    z.object({ type: z.literal("attachment"), ...cardSearchResultFields, fileName: z.string() }),
  ])),
});
// Dynamic imports keep the MCP package's no-emit typecheck scoped to its own root while allowing
// the standalone CLI build to bundle these runtime sources instead of depending on private
// workspace packages.
const { CARD_DUE_DATE_SLOTS } = await import("@kanera/shared/due-date-slots");
const dueDateSlot = z.enum(CARD_DUE_DATE_SLOTS);
const cardTitle = z.string().min(1).max(500).describe("Non-empty card title, up to 500 characters.");
const cardDescription = z.string().max(50000).nullable().describe("Markdown card description, or null to clear it.");
const cardDueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe("Local due date in YYYY-MM-DD format, or null to clear it.");
const cardDueDateSlot = dueDateSlot.nullable().describe("Named due-time slot, or null to clear it.");
const cardUpdateFields = z.object({
  title: cardTitle.optional(),
  description: cardDescription.optional(),
  dueDateLocalDate: cardDueDate.optional(),
  dueDateSlot: cardDueDateSlot.optional(),
});
const cardUpdateChanges = z.union([
  cardUpdateFields.extend({ title: cardTitle }),
  cardUpdateFields.extend({ description: cardDescription }),
  cardUpdateFields.extend({ dueDateLocalDate: cardDueDate }),
  cardUpdateFields.extend({ dueDateSlot: cardDueDateSlot }),
]);
const checklistText = z.string().trim().min(1).max(2000).describe("Non-empty checklist-item text, up to 2,000 characters.");
const checklistDescription = z.string().max(50000).nullable().describe("Markdown item description, or null to clear it.");
const checklistCompleted = z.boolean().describe("Whether the checklist item is complete.");
const checklistAssigneeId = uuid.nullable().describe("Assignee user UUID, or null to unassign the item.");
const checklistItemFields = z.object({
  text: checklistText.optional(),
  description: checklistDescription.optional(),
  completed: checklistCompleted.optional(),
  assigneeId: checklistAssigneeId.optional(),
  dueDateLocalDate: cardDueDate.optional(),
  dueDateSlot: cardDueDateSlot.optional(),
});
const checklistItemChanges = z.union([
  checklistItemFields.extend({ text: checklistText }),
  checklistItemFields.extend({ description: checklistDescription }),
  checklistItemFields.extend({ completed: checklistCompleted }),
  checklistItemFields.extend({ assigneeId: checklistAssigneeId }),
  checklistItemFields.extend({ dueDateLocalDate: cardDueDate }),
  checklistItemFields.extend({ dueDateSlot: cardDueDateSlot }),
]);
const bulkChecklistItemFields = z.object({
  assigneeId: checklistAssigneeId.optional(),
  dueDateLocalDate: cardDueDate.optional(),
  dueDateSlot: cardDueDateSlot.optional(),
});
const bulkChecklistItemChanges = z.union([
  bulkChecklistItemFields.extend({ assigneeId: checklistAssigneeId }),
  bulkChecklistItemFields.extend({ dueDateLocalDate: cardDueDate }),
]);
const positionAnchor = z.object({
  side: z.enum(["after", "before"]).describe("Place the entity after or before the anchor id."),
  id: uuid.nullable().describe("Anchor entity id; null means the selected edge."),
});
const priorityAnchor = z.object({
  side: z.enum(["after", "before"]).describe("Place the priority entry after or before the anchor id."),
  id: uuid.nullable().describe("Priority-entry id from priorities.list; null means that edge of the queue."),
});
const CARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/iu;
const ORGANISATION_KEY_PATTERN = /^[A-F0-9]{16}$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type ToolArgs<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;

// Tool schemas are also user-facing API documentation. Keep this fallback map centralized so
// reused validation primitives (for example `uuid` and `pageLimit`) never lose their meaning when
// a new tool is registered, while allowing a tool to override a description with narrower context.
const inputParameterDescriptions: Record<string, string> = {
  active: "Whether the selected state should be active (true) or removed (false).",
  afterNoteId: "Sibling note UUID to place this note after; omit or pass null when unused.",
  anchor: "Explicit before/after position anchor; a null anchor id selects that edge.",
  archived: "Whether the card should be archived (true) or active (false).",
  attachmentId: "Attachment UUID; pass null only where removing the current cover is supported.",
  attachmentIds: "Attachment UUIDs already uploaded to the card and owned by the acting user.",
  atTop: "Whether to place the created or duplicated card at the top of its destination list.",
  automationId: "Automation rule UUID returned by an automation list or create operation.",
  beforeNoteId: "Sibling note UUID to place this note before; omit or pass null when unused.",
  boardId: "Board UUID returned by board discovery or a board read.",
  body: "Non-empty Markdown comment text, up to 20,000 characters.",
  cardIds: "One or more card UUIDs, human keys, or canonical Kanera card URLs.",
  changes: "Non-empty object containing only the fields to update.",
  checklistId: "Checklist UUID returned in card detail.",
  color: "Kanera color token, or null to clear the color.",
  commentId: "Comment UUID returned by a card comment or activity read.",
  completed: "Whether the selected card or checklist item should be complete.",
  cursor: "Opaque nextCursor from the previous page; omit for the first page.",
  days: "Number of calendar days to include in the portfolio activity window, from 1 to 60.",
  description: "Markdown description text; omit when no description should be set.",
  dueDateLocalDate: "Local due date in YYYY-MM-DD format, or null to clear it.",
  dueDateSlot: "Named Kanera due-time slot, or null to clear the time slot.",
  enabled: "Whether the automation rule should be enabled.",
  fieldId: "Custom-field UUID returned by board or workspace configuration.",
  fileBase64: "Base64-encoded file bytes, limited to roughly 512 KiB decoded.",
  fileName: "Original file name including its extension, up to 255 characters.",
  filters: "Optional card filters; omit to include all cards allowed by the selected lens and scope.",
  from: "Inclusive ISO 8601 start instant; provide together with to and not with preset.",
  icon: "Tabler icon slug; omit to use the applicable default icon.",
  iconColor: "Kanera color token, or null to use no explicit icon color.",
  itemId: "Checklist-item UUID returned in card detail.",
  label: "Optional human-readable Markdown link label; defaults to the URL when omitted.",
  labelIds: "Label UUIDs returned by board or workspace configuration.",
  limit: "Maximum number of results to return in this page, within the schema's stated bounds.",
  listId: "Workflow-list UUID returned by boards.get.",
  mimeType: "File media type such as image/png or application/pdf.",
  mode: "Operation mode selected from the advertised enum values.",
  name: "Human-readable name within the length constraints shown in the schema.",
  noteId: "Note UUID returned by a note list, search, or note read.",
  parentNoteId: "Parent-note UUID, or null to place the note at the collection root.",
  period: "Calendar period selected from the advertised enum values.",
  preset: "Calendar range preset; omit when providing both from and to.",
  priorityId: "Priority-entry UUID returned by priorities.list.",
  q: "Optional case-insensitive text query for narrowing matching records.",
  query: "Non-empty search text within the maximum length shown in the schema.",
  scope: "Explicit organisation, workspace, board, or note visibility scope described by the schema.",
  sort: "Result ordering selected from the advertised enum values.",
  source: "Attachment placement or origin selected from the advertised enum values.",
  sourceListId: "Source workflow-list UUID returned by boards.get.",
  target: "Destination kind and matching workspace or board UUID.",
  targetBoardId: "Destination board UUID; omit to keep the source board.",
  targetListId: "Destination workflow-list UUID returned by boards.get.",
  text: "Non-empty checklist-item text, up to 2,000 characters.",
  timeZone: "IANA time-zone name such as America/New_York; defaults to UTC where documented.",
  title: "Human-readable title within the maximum length shown in the schema.",
  to: "Exclusive ISO 8601 end instant; provide together with from and not with preset.",
  type: "Value type selected from the advertised enum values.",
  url: "Absolute HTTP or HTTPS URL.",
  userIds: "User UUIDs returned by board members or workspaces.list_members.",
  value: "Typed custom-field value matching the selected discriminator.",
  valueCheckbox: "Checkbox value, or null to clear it.",
  valueDate: "Date value in YYYY-MM-DD format, or null to clear it.",
  valueNumber: "Finite numeric value as a number or numeric string, or null to clear it.",
  valueOptionIds: "Select-option UUIDs, or null to clear the value.",
  valueText: "Text value up to 20,000 characters, or null to clear it.",
  valueUrl: "Absolute URL value, or null to clear it.",
  valueUserIds: "User UUIDs, or null to clear the value.",
  workspaceId: "Standard-workspace UUID returned by workspaces.list.",
};

function describeInputParameters<T extends z.ZodRawShape>(inputSchema: T): T {
  return Object.fromEntries(Object.entries(inputSchema).map(([name, schema]) => {
    const parameterSchema = schema as z.ZodType;
    return [
      name,
      parameterSchema.description?.trim()
        ? parameterSchema
        : parameterSchema.describe(inputParameterDescriptions[name] ?? `Accepted ${name} value.`),
    ];
  })) as unknown as T;
}
const { COLOR_TOKENS } = await import("@kanera/shared/colors");
const { AUTOMATION_ACTION_LIMIT, automationTriggerCustomFieldValue, automationTriggerType } = await import("@kanera/shared/dto");
const { AUTOMATION_ACTION_TYPES, COMMENT_REACTION_TYPES, MAX_CARD_PRIORITIES_PER_USER } = await import("@kanera/shared/schema");
const reactionType = z.enum(COMMENT_REACTION_TYPES);
const colorToken = z.enum(COLOR_TOKENS);
const { WORKSPACE_TEMPLATES, DEFAULT_WORKSPACE_TEMPLATE } = await import("@kanera/shared/workspace-templates");
const { describeWorkspaceTemplateAutomation, findWorkspaceTemplate, standaloneBoardCreatePayload, workspaceTemplateSeedPayload } = await import("@kanera/shared/workspace-template-payload");
type WorkspaceTemplate = (typeof WORKSPACE_TEMPLATES)[number];
type WorkspaceTemplateId = WorkspaceTemplate["id"];
const workspaceTemplateId = z.enum(WORKSPACE_TEMPLATES.map((template) => template.id) as [WorkspaceTemplateId, ...WorkspaceTemplateId[]]);
const iconSlug = z.string().trim().min(1).max(100).describe("Tabler icon slug such as \"rocket\"; omit for the default.");
const seedName = z.string().trim().min(1).max(100).describe("Non-empty name, up to 100 characters.");
const seedList = z.object({ name: seedName, icon: iconSlug.optional() });
const seedCustomField = z.object({
  name: seedName,
  icon: iconSlug.optional(),
  type: z.enum(["text", "number", "checkbox", "select", "date", "url", "user"]).describe("Custom-field value type."),
  allowMultiple: z.boolean().optional().describe("Whether select or user fields accept multiple values."),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(100).describe("Non-empty select-option label."),
    color: colorToken.nullable().optional().describe("Kanera color token, or null for no color."),
  })).max(100).optional().describe("Select options; valid only for select fields."),
});
const seedLabel = z.object({ name: seedName, color: colorToken.nullable().optional().describe("Kanera color token, or null for no color.") });
// Shared by workspace and standalone-board bootstrap. Explicit arrays replace the template's; the
// template's starter cards and automations are then narrowed to whatever survived (see
// workspaceTemplateSeedPayload) so an agent trimming a template cannot produce an invalid request.
const bootstrapConfigurationFields = {
  lists: z.array(seedList).max(32).optional().describe("Ordered workflow lists. Replaces the template's lists. Must be empty or contain at least 2 entries."),
  customFields: z.array(seedCustomField).max(32).optional().describe("Replaces the template's custom fields."),
  labels: z.array(seedLabel).max(64).optional().describe("Replaces the template's labels."),
  seedStarterCards: z.boolean().default(true).describe("Seed the template's example cards into the initial board."),
  seedAutomations: z.boolean().default(true).describe("Seed the template's automation rules. Hosted Free plans may create them disabled."),
};
type BootstrapConfiguration = z.infer<z.ZodObject<typeof bootstrapConfigurationFields>>;
const ORGANISATION_ADMIN_CREDENTIAL = "Requires an organisation admin or owner using a write-capable personal API key or an interactive OAuth grant; workspace-scoped and read-only credentials receive 403 FORBIDDEN. Check session.get: credentialKind must not be \"workspace\" and scope must not be \"read\".";

function compactBody<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function bootstrapWorkspaceConfiguration(template: WorkspaceTemplate | undefined, args: BootstrapConfiguration) {
  // Mirror the API refinement locally so the model gets the corrective message before a request.
  if (args.lists?.length === 1) validationError("lists must be empty or contain at least 2 items");
  const lists = args.lists ?? template?.lists;
  const customFields = args.customFields ?? template?.customFields;
  const labels = args.labels ?? template?.labels;
  // Without a template the keys stay absent so the API applies its own workspace defaults.
  if (!template) return { lists, customFields, labels };
  const seed = workspaceTemplateSeedPayload(
    template,
    (lists ?? []).map((list) => list.name),
    (labels ?? []).map((label) => label.name),
    (customFields ?? []).map((field) => ({ name: field.name, options: field.options?.map((option) => option.label) ?? [] })),
  );
  return {
    lists,
    customFields,
    labels,
    checklistTemplates: seed.checklistTemplates,
    cards: args.seedStarterCards !== false ? seed.cards : [],
    automations: args.seedAutomations !== false ? seed.automations : [],
  };
}

function describeWorkspaceTemplate(template: WorkspaceTemplate) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    icon: template.icon,
    workspaceName: template.workspaceName,
    initialBoardName: template.initialBoardName,
    lists: template.lists.map((list) => list.name),
    customFields: template.customFields.map((field) => ({ name: field.name, type: field.type })),
    labels: template.labels.map((label) => label.name),
    checklistTemplateCount: template.checklistTemplates?.length ?? 0,
    starterCardCount: template.cards?.length ?? 0,
    automationCount: template.automations?.length ?? 0,
    automations: (template.automations ?? []).map(describeWorkspaceTemplateAutomation),
  };
}

// POST /workspaces is gated by organisation role, which /session does not report, so a pre-flight
// cannot distinguish a member from an admin. Let the API decide and make its 403 actionable instead.
async function withOrganisationAdminHint<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof KaneraApiError && error.status === 403 && error.code === "FORBIDDEN") {
      throw new KaneraApiError(403, "FORBIDDEN", `${error.message}. Creating workspaces and standalone boards requires an organisation admin or owner using a write-capable personal API key or interactive OAuth grant; workspace-scoped and read-only credentials cannot. Check session.get.`, error.retryAfter);
    }
    throw error;
  }
}
const noteTitle = z.string().max(200).describe("Note title, up to 200 characters.");
const noteContent = z.string().max(50000).describe("Complete replacement Markdown content, up to 50,000 characters.");
const noteIcon = z.string().trim().min(1).max(100).nullable().describe("Tabler icon slug, or null to clear it.");
const noteColor = colorToken.nullable().describe("Kanera color token, or null to clear it.");
const noteUpdateFields = z.object({
  title: noteTitle.optional(),
  content: noteContent.optional(),
  icon: noteIcon.optional(),
  color: noteColor.optional(),
  baseUpdatedAt: z.iso.datetime().optional().describe("Last observed note update instant for optimistic concurrency."),
});
const noteUpdateChanges = z.union([
  noteUpdateFields.extend({ title: noteTitle }),
  noteUpdateFields.extend({ content: noteContent }),
  noteUpdateFields.extend({ icon: noteIcon }),
  noteUpdateFields.extend({ color: noteColor }),
]);
const automationActionInput = z.object({
  type: z.enum(AUTOMATION_ACTION_TYPES).describe("Automation action type."),
  config: z.looseObject({}).describe("Config by type: add/remove_labels {labelIds}; add/remove_assignees {userIds}; apply_checklists {templateIds}; set_due_date {offsetDays, slot}; clear_due_date/move_to_top/move_to_bottom {}; set_completion {completed}; move_to_list {listId, placement}; populate_custom_field {fieldId, onlyIfEmpty, value}. IDs are UUID arrays where plural. The public API validates the selected type's exact config."),
});
const automationCreateFields = {
  enabled: z.boolean().default(false).describe("Whether the rule should start running immediately. Enabled rules require at least one action."),
  triggerType: automationTriggerType.describe("The event that starts the rule. List-exit and custom-value rules are transition based; approaching-due and inactivity rules are scheduled and one-shot per event boundary."),
  triggerListId: uuid.optional().describe("Required when triggerType is card_enters_list or card_leaves_list."),
  triggerUserIds: z.array(uuid).min(1).max(100).optional().describe("Required when triggerType is card_assigned_to_user."),
  triggerLabelId: uuid.optional().describe("Required when triggerType is card_label_set."),
  triggerCustomFieldId: uuid.optional().describe("Required when triggerType is custom_field_value_changed."),
  triggerCustomFieldValue: automationTriggerCustomFieldValue.optional().describe("Typed selected value required when triggerType is custom_field_value_changed."),
  triggerDaysBefore: z.number().int().min(1).max(3650).optional().describe("Lead time required when triggerType is due_date_approaching."),
  applyOnCreate: z.boolean().default(true).describe("For card_enters_list, also run when a card is created in the trigger list."),
  applyOnMove: z.boolean().default(true).describe("For card_enters_list, run when a card moves into the trigger list."),
  actions: z.array(automationActionInput).max(AUTOMATION_ACTION_LIMIT).default([]).describe("Ordered action definitions; enabled rules require at least one."),
};
const automationChanges = z.object({
  triggerType: automationTriggerType.optional().describe("Replacement event that starts the rule. List-exit and custom-value rules are transition based; approaching-due and inactivity rules are scheduled and one-shot per event boundary."),
  triggerListId: uuid.nullable().optional().describe("Required when the resulting triggerType is card_enters_list or card_leaves_list."),
  triggerUserIds: z.array(uuid).min(1).max(100).nullable().optional().describe("Required when the resulting triggerType is card_assigned_to_user."),
  triggerLabelId: uuid.nullable().optional().describe("Required when the resulting triggerType is card_label_set."),
  triggerCustomFieldId: uuid.nullable().optional().describe("Required when the resulting triggerType is custom_field_value_changed."),
  triggerCustomFieldValue: automationTriggerCustomFieldValue.nullable().optional().describe("Typed selected value required when the resulting triggerType is custom_field_value_changed."),
  triggerDaysBefore: z.number().int().min(1).max(3650).nullable().optional().describe("Lead time required when the resulting triggerType is due_date_approaching."),
  applyOnCreate: z.boolean().optional().describe("For card_enters_list, whether card creation can trigger the rule."),
  applyOnMove: z.boolean().optional().describe("For card_enters_list, whether moving a card can trigger the rule."),
  actions: z.array(automationActionInput).max(AUTOMATION_ACTION_LIMIT).optional().describe("Replace the full ordered action list atomically with the trigger changes. An empty list disables the rule."),
}).refine((value) => Object.values(value).some((item) => item !== undefined), "provide at least one automation change");
export interface KaneraMcpContext {
  apiKey: string;
  publicApiUrl?: string;
  docsSearchUrl?: string;
  /**
   * Emit the per-call JSON telemetry line to stdout. Defaults to on, which is correct for the HTTP
   * and stdio servers where stdout is a log stream. In-process hosts such as the CLI set this false
   * because their stdout is the command's result and callers parse it.
   */
  logToolCalls?: boolean;
}

function client(ctx: KaneraMcpContext, options: { signal?: AbortSignal; idempotencyKey?: string } = {}) {
  return new KaneraClient({
    baseUrl: ctx.publicApiUrl ?? env.KANERA_PUBLIC_API_URL,
    apiKey: ctx.apiKey,
    timeoutMs: env.MCP_UPSTREAM_TIMEOUT_MS,
    ...options,
  });
}

const serverDescription = "Bootstrap Kanera workspaces and boards from templates, read configuration, and manage automations, cards, checklists, comments, notes, attachments, activity, work reporting, and \"Up next\" priority queues.";
const serverIcons = [{
  src: "https://www.kanera.app/assets/favicon/android-chrome-512x512.png",
  mimeType: "image/png" as const,
  sizes: ["512x512"],
}];

function structuredData(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return { items: data };
  if (data !== null && typeof data === "object") return data as Record<string, unknown>;
  if (data === null || data === undefined) return { ok: true };
  return { value: data };
}

function content(data: unknown): CallToolResult {
  const structuredContent = structuredData(data);
  const serialized = JSON.stringify(structuredContent);
  if (Buffer.byteLength(serialized, "utf8") > env.MCP_TOOL_OUTPUT_MAX_BYTES) {
    throw new KaneraApiError(413, "RESPONSE_TOO_LARGE", "Kanera returned too much data for one MCP response; narrow the query or request a smaller page");
  }
  // MCP clients predating structuredContent only inspect text blocks. Keep the canonical JSON in
  // both representations so Claude, ChatGPT, and older generic hosts observe identical results.
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent,
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
  "session.get": READ,
  "workspaces.list": READ,
  "workspaces.list_templates": READ,
  "workspaces.create": ADD,
  "boards.create_standalone": ADD,
  "boards.create": ADD,
  "boards.list_accessible": READ,
  "workspaces.get": READ,
  "workspaces.list_boards": READ,
  "workspaces.list_members": READ,
  "boards.get_standalone_settings": READ,
  "boards.get": READ,
  "cards.list": READ,
  "automations.list": READ,
  "automations.list_executions": READ,
  "automations.create": ADD,
  "automations.update": CHANGE,
  "automations.set_enabled": CHANGE,
  "automations.delete": CHANGE,
  "search.content": READ,
  "search.docs": READ,
  "cards.get": READ,
  "cards.get_content": READ,
  "cards.list_history": READ,
  "cards.create": ADD,
  "cards.update": CHANGE,
  "cards.move": CHANGE,
  "cards.duplicate": ADD,
  "cards.move_to_board": CHANGE,
  "cards.archive": CHANGE,
  "cards.set_completion": CHANGE,
  "cards.bulk_set_completion": CHANGE,
  "cards.bulk_set_due_date": CHANGE,
  "cards.bulk_patch_labels": CHANGE,
  "cards.bulk_patch_assignees": CHANGE,
  "cards.bulk_move": CHANGE,
  "cards.bulk_archive": CHANGE,
  "cards.bulk_duplicate": ADD,
  "cards.bulk_set_custom_field": CHANGE,
  "lists.set_card_completion": CHANGE,
  "lists.move_cards": CHANGE,
  "lists.archive_cards": CHANGE,
  "cards.set_assignees": CHANGE,
  "cards.set_labels": CHANGE,
  "cards.set_custom_field_value": CHANGE,
  "comments.add": ADD,
  "comments.list": READ,
  "comments.delete": CHANGE,
  "checklists.create": ADD,
  "checklists.update": CHANGE,
  "checklists.delete": CHANGE,
  "checklists.move": CHANGE,
  "checklists.add_item": ADD,
  "checklists.update_item": CHANGE,
  "checklists.bulk_update_items": CHANGE,
  "checklists.delete_item": CHANGE,
  "checklists.move_item": CHANGE,
  "activity.list": READ,
  "work.query_cards": READ,
  "work.query_history": READ,
  "work.portfolio_summary": READ,
  "priorities.list_targets": READ,
  "priorities.list": READ,
  "priorities.add": ADD,
  "priorities.move": CHANGE,
  "priorities.remove": CHANGE,
  "notes.list": READ,
  "notes.get": READ,
  "notes.get_backlinks": READ,
  "notes.list_attachments": READ,
  "notes.create": ADD,
  "notes.update": CHANGE,
  "notes.add_link": ADD,
  "notes.add_attachment": ADD,
  "notes.duplicate": ADD,
  "notes.move": CHANGE,
  "cards.add_attachment": ADD,
  "cards.delete_attachment": CHANGE,
  "cards.set_cover": CHANGE,
  "comments.update": CHANGE,
  "comments.set_reaction": CHANGE,
};

function toolTitle(name: string) {
  return name
    .split(/[._]/u)
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

function priorityAnchorBody(anchor: z.infer<typeof priorityAnchor>): { afterId: string | null } | { beforeId: string | null } {
  return anchor.side === "after" ? { afterId: anchor.id } : { beforeId: anchor.id };
}

// The priority routes are addressed by target user so admins can curate a teammate's queue, but the
// overwhelmingly common case is "my own queue"; resolving the session here spares the model a
// separate session.get round trip before every priority call.
async function priorityTargetUserId(api: KaneraClient, targetUserId: string | undefined): Promise<string> {
  if (targetUserId) return targetUserId;
  const session = await api.get<{ userId: string }>("/api/v1/session");
  return session.userId;
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
  outputSchema: z.ZodType<Record<string, unknown>> = z.looseObject({}),
) {
  const supportsReplayProtection = toolBehaviors[name]?.idempotentHint === false
    && name !== "cards.add_attachment"
    && name !== "notes.add_attachment";
  const registeredInputSchema = supportsReplayProtection && !("idempotencyKey" in inputSchema)
    ? {
        ...inputSchema,
        idempotencyKey: z.uuid().optional().describe("Stable UUID reused only when retrying the same mutation after an ambiguous failure. Retained for 24 hours."),
      }
    : inputSchema;
  const registerTool = server.registerTool.bind(server) as unknown as (
    toolName: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodRawShape;
      outputSchema: z.ZodType<Record<string, unknown>>;
      annotations: ToolAnnotations;
    },
    callback: (args: unknown, extra?: { signal: AbortSignal; requestId: string | number }) => Promise<CallToolResult>,
  ) => void;
  registerTool(name, {
    title: toolTitle(name),
    description,
    inputSchema: describeInputParameters(registeredInputSchema),
    outputSchema,
    annotations: toolAnnotations(name),
  }, async (args, extra): Promise<CallToolResult> => {
    const startedAt = performance.now();
    const logToolCalls = ctx.logToolCalls !== false && env.NODE_ENV !== "test" && process.env.NODE_TEST_CONTEXT === undefined;
    try {
      const record = args as Record<string, unknown>;
      const idempotencyKey = typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined;
      const handlerArgs = idempotencyKey
        ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "idempotencyKey"))
        : record;
      const result = content(await handler(handlerArgs as ToolArgs<T>, client(ctx, { signal: extra?.signal, idempotencyKey })));
      if (logToolCalls) {
        console.info(JSON.stringify({
          event: "mcp_tool_call",
          tool: name,
          version: mcpPackage.version,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          outcome: "success",
        }));
      }
      mcpToolDuration.observe({ tool: name, outcome: "success", error_code: "none" }, (performance.now() - startedAt) / 1_000);
      return result;
    } catch (error) {
      const errorCode = error instanceof KaneraApiError ? error.code : "INTERNAL";
      if (logToolCalls) {
        console.info(JSON.stringify({
          event: "mcp_tool_call",
          tool: name,
          version: mcpPackage.version,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          outcome: "error",
          errorCode,
        }));
      }
      mcpToolDuration.observe({ tool: name, outcome: "error", error_code: errorCode }, (performance.now() - startedAt) / 1_000);
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
    { instructions: "Use Kanera MCP tools instead of browser automation for every supported read or write; reserve the web interface for explicitly visual tasks and UI-only administration. For an exact human card key or canonical card URL, call cards.get directly before a mutation and reserve search.content for names, phrases, and other ambiguous text. For cross-board reporting, first resolve people with workspaces.list_members, then use work.query_cards for active or completed assignments and work.query_history for one person's actions in a date range. Use cards.get_content for selected evidence and cards.get or cards.list_history only when deeper detail is needed. search.content returns one bounded, typed result stream with canonical links. Kanera MCP is work-focused: it reads configuration needed to resolve boards, lists, labels, fields, options, members, and permissions. Organisation admins can bootstrap a standard workspace (workspaces.create), a standalone board (boards.create_standalone), or an extra board inside a standard workspace (boards.create), choosing a templateId from workspaces.list_templates or supplying explicit lists, custom fields, and labels; workspace and standalone-board creation needs a write-capable personal key or interactive OAuth grant with organisation admin role, and workspace-scoped keys cannot do it. Workspace admins can manage automations with the dedicated automation tools, while editing or deleting lists, fields, labels, members, and boards after creation remains in the Kanera UI. Standard-workspace lists, fields, labels, membership, and automations are shared across its boards; standalone boards have dedicated configuration. Card reference fields accept a UUID, human key such as PROJ-123, or canonical card URL. Use boards.list_accessible for complete discovery including standalone and guest boards, boards.get for metadata/configuration, and cards.list for bounded list pages. Use work.portfolio_summary for portfolio rollups. Use the priority tools (priorities.list, priorities.add, priorities.move, priorities.remove) to read and curate a user's ranked cross-board \"Up next\" queue; priorities.list_targets shows whose queues a manager can reach. Use search.docs for product guidance and search.content for live user data. Personal notes are private to their owner. Read-only credentials cannot mutate. Board, workspace, list, field, label, note, and note-attachment deletion or administration not represented by a tool must be completed manually in the Kanera UI." },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, ctx: KaneraMcpContext) {
  registerKaneraTool(server, "session.get", "Describe the current Kanera credential and canonical web URL. Personal OAuth/API credentials are identity-wide across the user's live organisation memberships; service/workspace credentials report their pinned workspace.", {}, (_a, api) =>
    api.get("/api/v1/session"), ctx);
  registerKaneraTool(server, "workspaces.list", "List a cursor-paginated directory of accessible standard workspaces. Standalone boards and parent workspaces reached only through board-level guest access are excluded; use boards.list_accessible for complete board discovery.", collectionPageSchema, async (a, api) => {
    // The public API returns a pinned standalone configuration workspace to its own workspace key.
    // The MCP product model keeps this tool consistently standard-workspace-only for every credential.
    const page = await remoteCollectionPage<{ kind?: string } & Record<string, unknown>>(api, "/api/v1/workspaces", {}, a.limit, a.cursor, "workspaces");
    return { ...page, items: page.items.filter((workspace) => workspace.kind !== "board") };
  }, ctx);
  registerKaneraTool(server, "boards.list_accessible", "Discover a cursor-paginated directory of every accessible workspace board, standalone board, and cross-organisation guest board.", collectionPageSchema, async (a, api) =>
    remoteCollectionPage(api, "/api/v1/boards", {}, a.limit, a.cursor, "accessible-boards"), ctx);
  registerKaneraTool(server, "workspaces.list_templates", "List the built-in workspace templates with the lists, custom fields, labels, and seed-content counts each one provides. Call before workspaces.create or boards.create_standalone to choose a templateId; \"blank\" seeds nothing.", {}, async () => ({
    defaultTemplateId: DEFAULT_WORKSPACE_TEMPLATE.id,
    items: WORKSPACE_TEMPLATES.map(describeWorkspaceTemplate),
  }), ctx);
  registerKaneraTool(server, "workspaces.create", `Create a standard workspace whose lists, custom fields, and labels are shared by every board inside it, optionally with an initial board. Choose a templateId from workspaces.list_templates, or supply explicit lists/customFields/labels (they replace the template's; template starter cards and automations that depend on removed items are skipped). Omitting both applies Kanera's default lists, fields, and labels. ${ORGANISATION_ADMIN_CREDENTIAL} This is not idempotent; do not retry after an ambiguous success.`, {
    name: seedName.describe("Workspace name."),
    templateId: workspaceTemplateId.optional().describe("Template to seed from. Omit for Kanera defaults; use \"blank\" for nothing."),
    icon: iconSlug.optional(),
    cardKeyPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/u).optional().describe("Human card-key prefix such as PROJ. Omit to derive one from the name."),
    initialBoard: z.object({
      name: seedName,
      icon: iconSlug.optional(),
      iconColor: colorToken.nullable().optional().describe("Kanera color token, or null for no icon color."),
    }).optional().describe("First board to create. Defaults to the template's board when starter cards are seeded."),
    ...bootstrapConfigurationFields,
  }, async (a, api) => {
    const template = a.templateId ? findWorkspaceTemplate(a.templateId) : undefined;
    const configuration = bootstrapWorkspaceConfiguration(template, a);
    // Starter cards need a board to land in; mirror the web onboarding default rather than failing.
    const initialBoard = a.initialBoard
      ?? (template && (configuration.cards?.length ?? 0) > 0 ? { name: template.initialBoardName, icon: template.icon } : undefined);
    const body = compactBody({
      kind: "standard" as const,
      name: a.name,
      cardKeyPrefix: a.cardKeyPrefix,
      icon: a.icon ?? template?.icon,
      initialBoard,
      ...configuration,
    });
    const created = await withOrganisationAdminHint(() => api.post<Record<string, unknown>>("/api/v1/workspaces", body));
    return { ...created, templateId: a.templateId ?? null };
  }, ctx);
  registerKaneraTool(server, "boards.create_standalone", `Create a standalone board with its own private lists, custom fields, and labels (no visible workspace). Defaults to the "${DEFAULT_WORKSPACE_TEMPLATE.id}" template; pass templateId "blank" or explicit lists for a minimal board. The board is hidden from workspaces.list and visible in boards.list_accessible; read its configuration with boards.get_standalone_settings. ${ORGANISATION_ADMIN_CREDENTIAL} This is not idempotent; do not retry after an ambiguous success.`, {
    name: seedName.describe("Board name."),
    templateId: workspaceTemplateId.default(DEFAULT_WORKSPACE_TEMPLATE.id).describe("Template to seed from; see workspaces.list_templates."),
    icon: iconSlug.optional(),
    iconColor: colorToken.nullable().optional(),
    ...bootstrapConfigurationFields,
  }, async (a, api) => {
    const template = findWorkspaceTemplate(a.templateId)!;
    const configuration = bootstrapWorkspaceConfiguration(template, a);
    const body = compactBody({
      ...standaloneBoardCreatePayload(a.name, template, { icon: a.icon, iconColor: a.iconColor }),
      ...configuration,
    });
    const created = await withOrganisationAdminHint(() =>
      api.post<{ id?: string; cardKeyPrefix?: string; initialBoard?: Record<string, unknown> }>("/api/v1/workspaces", body));
    return {
      board: created.initialBoard ?? null,
      workspaceId: created.id ?? null,
      cardKeyPrefix: created.cardKeyPrefix ?? null,
      templateId: a.templateId,
    };
  }, ctx);
  registerKaneraTool(server, "boards.create", "Add a board to an existing standard workspace. The new board shares the workspace's lists, custom fields, labels, and automations. Requires workspace-admin authority and a write-capable credential (workspace-scoped admin keys work here, unlike workspaces.create). Standalone boards cannot receive a second board; use boards.create_standalone instead. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    name: seedName.describe("Board name."),
    description: z.string().max(2000).optional(),
    icon: iconSlug.optional(),
    iconColor: colorToken.nullable().optional(),
  }, async ({ workspaceId, ...body }, api) => {
    const detail = await api.get<WorkspaceDetail>(`/api/v1/workspaces/${workspaceId}`);
    if (detail.workspace.kind !== "standard") {
      validationError("standalone boards own exactly one board; create another standalone board with boards.create_standalone instead");
    }
    return api.post(`/api/v1/workspaces/${workspaceId}/boards`, compactBody(body));
  }, ctx);
  registerKaneraTool(server, "workspaces.get", "Read a standard workspace and its shared lists, custom fields, labels, templates, and automations. For a standalone board, use boards.get_standalone_settings.", { workspaceId: uuid }, async (a, api) =>
    boundedConfiguration((await standardWorkspaceContext(api, a.workspaceId)).detail), ctx);
  registerKaneraTool(server, "automations.list", "List the ordered automation rules and lifetime run statistics for a standard workspace. Requires workspace-admin authority; use workspaces.get when only general readable workspace configuration is needed.", {
    workspaceId: uuid,
  }, (a, api) => api.get(`/api/v1/workspaces/${a.workspaceId}/automations`), ctx);
  registerKaneraTool(server, "automations.list_executions", "List a cursor-paginated history of one automation's retained execution outcomes (effectful, no-op, or failed), newest first. Requires workspace-admin authority.", {
    automationId: uuid,
    ...collectionPageSchema,
  }, (a, api) => remoteCollectionPage(api, `/api/v1/automations/${a.automationId}/executions`, {}, a.limit, a.cursor, `automation-executions:${a.automationId}`), ctx);
  registerKaneraTool(server, "automations.create", "Create a workspace automation with an ordered action list. Requires workspace-admin authority and a write-capable credential. For a rule that runs only when a card moves into a list, use card_enters_list with applyOnCreate=false and applyOnMove=true; add_assignees plus set_due_date implements a review handoff with a relative deadline. This is not idempotent; do not retry after an ambiguous success.", {
    workspaceId: uuid,
    ...automationCreateFields,
  }, ({ workspaceId, ...body }, api) => api.post(`/api/v1/workspaces/${workspaceId}/automations`, body), ctx);
  registerKaneraTool(server, "automations.update", "Atomically update an automation's trigger settings and/or replace its full ordered action list. Requires workspace-admin authority and a write-capable credential. Use automations.set_enabled for enable/disable changes.", {
    automationId: uuid,
    changes: automationChanges,
  }, (a, api) => api.patch(`/api/v1/automations/${a.automationId}`, a.changes), ctx);
  registerKaneraTool(server, "automations.set_enabled", "Enable or disable one automation without changing its trigger or actions. Enabling requires at least one action and is subject to plan limits. Requires workspace-admin authority and a write-capable credential.", {
    automationId: uuid,
    enabled: z.boolean(),
  }, (a, api) => api.patch(`/api/v1/automations/${a.automationId}`, { enabled: a.enabled }), ctx);
  registerKaneraTool(server, "automations.delete", "Delete one workspace automation. This archives the rule and stops future executions; it does not undo actions from prior executions. Requires workspace-admin authority and a write-capable credential.", {
    automationId: uuid,
  }, (a, api) => api.delete(`/api/v1/automations/${a.automationId}`), ctx);
  registerKaneraTool(server, "workspaces.list_boards", "List a cursor-paginated directory of boards inside a standard workspace. Use boards.list_accessible when the workspace is unknown or the board may be standalone.", { workspaceId: uuid, ...collectionPageSchema }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return remoteCollectionPage(api, `/api/v1/workspaces/${a.workspaceId}/boards`, {}, a.limit, a.cursor, `workspace-boards:${a.workspaceId}`);
  }, ctx);
  registerKaneraTool(server, "workspaces.list_members", "List a cursor-paginated directory of a standard workspace's members with userId, displayName, email, and role. Use boards.get to resolve assignees for a standalone board. Requires workspace access.", { workspaceId: uuid, ...collectionPageSchema }, async (a, api) => {
    await standardWorkspaceContext(api, a.workspaceId);
    return remoteCollectionPage(api, `/api/v1/workspaces/${a.workspaceId}/members`, {}, a.limit, a.cursor, `workspace-members:${a.workspaceId}`);
  }, ctx);
  registerKaneraTool(server, "boards.get_standalone_settings", "Read a standalone board's identity, retention, lists, custom fields, labels, templates, and automations using its visible board id. Requires access to the board's configuration; board-only cross-organisation guests cannot use this tool.", {
    boardId: uuid,
  }, async (a, api) => {
    const { board, detail } = await standaloneBoardContext(api, a.boardId);
    return boundedConfiguration({ board, ...detail });
  }, ctx);
  registerKaneraTool(server, "boards.get", "Get a workspace board or standalone board with its workflow lists, members, labels, and custom fields, but without cards. Use the returned list ids with cards.list to retrieve cards only from the lists needed.", {
    boardId: uuid,
  }, async (a, api) => {
    const detail = await api.post<Record<string, unknown>>(`/api/v1/boards/${a.boardId}/open`, undefined, { includeCards: false });
    // Board discovery must not leak the potentially enormous all-list card collection into the
    // MCP result. Keep every other board-detail field aligned with the board-open API payload.
    const { cards: _cards, ...boardWithoutCards } = detail;
    return boundedConfiguration(boardWithoutCards);
  }, ctx);
  registerKaneraTool(server, "cards.list", "Get one bounded page of active (unarchived) cards, including completed cards, from exactly one workflow list. Use boards.get first to resolve the list id, then pass nextCursor to continue. Never returns cards from another list or an unbounded card collection.", {
    boardId: uuid.describe("Board containing the requested workflow lists."),
    listId: uuid.describe("Exactly one workflow list id returned by boards.get."),
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
  registerKaneraTool(server, "search.content", "Use this when you need to find live Kanera content by words, phrases, card keys, or filenames. Searches accessible cards, notes, comments, and attachment filenames and returns one relevance-ranked, bounded result stream with source metadata and canonical links.", {
    query: z.string().trim().min(1).max(200).describe("Words, quoted phrase, or card key to find, for example landing-page copy or MKT-42."),
    scope: workScope,
    types: z.array(z.enum(["card", "comment", "note", "attachment"])).min(1).max(4).optional().describe("Optional entity types to search; omit to search all supported content."),
    limit: z.number().int().min(1).max(25).default(10).describe("Maximum results across all entity types combined."),
  }, (a, api) => api.post("/api/v1/search/query", a), ctx, searchOutputSchema);
  registerKaneraTool(server, "search.docs", "Search official Kanera documentation for product behavior, setup, permissions, and workflow guidance. Returns relevant sections with concise excerpts and canonical source URLs; this does not search the user's live Kanera data.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  }, (a, _api) => docsSearchClient(ctx.docsSearchUrl).search(a.query, a.limit), ctx);
  registerKaneraTool(server, "cards.get", "Read a card detail, including labels, assignees, checklist item descriptions, nested sub-checklists, attachments, and linked notes. Checklists are returned flat; a sub-checklist's parentItemId identifies its owning top-level item.", { cardId: cardReference }, async (a, api) =>
    api.get(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/detail`), ctx);
  registerKaneraTool(server, "cards.get_content", `Read checklist and comment content for up to 200 selected cards in one board, avoiding one detail/comment request per card during summaries, audits, and migrations. Best-effort: ids not visible on the board are returned in missingCardIds, and cards whose bounded comment history is incomplete are listed in truncatedCardIds so comments.list can page them. ${boardBatchScope}`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
  }, async (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/content/query`, { cardIds: await resolveCardReferences(api, a.cardIds) }), ctx);
  registerKaneraTool(server, "cards.list_history", "List a card's retained, user-visible history, including comments and activity, newest first. Cursor-paginated and accepts a human key such as PROJ-123. Hidden/coalesced no-op activity and activity outside the configured retention window are not returned.", {
    cardId: cardReference,
    cursor: z.string().min(1).max(1000).optional().describe("Opaque nextCursor returned by the previous page."),
    limit: z.number().int().min(1).max(100).default(50),
  }, async (a, api) => api.get(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/feed`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "cards.create", "Create a card in one of the board's workflow lists. Works with workspace and standalone boards. Requires board editor access and a write-capable credential.", {
    boardId: uuid,
    listId: uuid.describe("Target workflow list id returned by boards.get."),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).optional(),
    atTop: z.boolean().optional(),
    idempotencyKey: uuid.optional().describe("Stable UUID reused when retrying this create after an ambiguous failure."),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards`, { title: a.title, description: a.description, atTop: a.atTop }), ctx);
  registerKaneraTool(server, "cards.update", "Update one or more card content fields. The required changes object cannot be empty. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    changes: cardUpdateChanges,
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}`, a.changes), ctx);
  registerKaneraTool(server, "cards.move", "Move or reorder a card using one explicit before/after anchor; a null anchor id means that edge. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    listId: uuid,
    anchor: positionAnchor,
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/move`, {
    listId: a.listId,
    ...(a.anchor.side === "after" ? { afterCardId: a.anchor.id } : { beforeCardId: a.anchor.id }),
  }), ctx);
  registerKaneraTool(server, "cards.duplicate", "Copy a card, optionally into another editable board and list. Requires board editor access at the source and destination. This is not idempotent; do not retry after an ambiguous success.", {
    cardId: cardReference,
    boardId: uuid.optional().describe("Destination board; defaults to the source board."),
    listId: uuid.optional().describe("Destination list; required when copying across workspaces, otherwise defaults to the source card's list."),
    atTop: z.boolean().optional(),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/duplicate`, { boardId: a.boardId, listId: a.listId, atTop: a.atTop }), ctx);
  registerKaneraTool(server, "cards.move_to_board", "Move a card to another board in the same standard workspace. Standalone boards have no valid destination. Requires editor access to both boards and a write-capable credential.", {
    cardId: cardReference,
    boardId: uuid.describe("Destination board id. Must be in the same workspace."),
    listId: uuid.optional().describe("Destination list; defaults to a matching list on the target board."),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/move-to-board`, { boardId: a.boardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "cards.archive", "Archive or unarchive a card. Requires board editor access and a write-capable credential.", { cardId: cardReference, archived: z.boolean().default(true) }, async (a, api) =>
    api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/archive`, { archived: a.archived }), ctx);
  registerKaneraTool(server, "cards.set_completion", "Mark a card complete or incomplete; completion is distinct from archiving. Requires board editor access and a write-capable credential.", { cardId: cardReference, completed: z.boolean() }, async (a, api) =>
    api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "cards.bulk_set_completion", `Mark up to 200 selected cards complete or incomplete in one board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    completed: z.boolean(),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/completion`, { cardIds: await resolveCardReferences(api, a.cardIds), completed: a.completed }), ctx);
  registerKaneraTool(server, "cards.bulk_set_due_date", `Set or clear one due date on up to 200 selected cards in a board. Returns changed cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    dueDateSlot: dueDateSlot.nullable().optional(),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/due-date`, { cardIds: await resolveCardReferences(api, a.cardIds), dueDateLocalDate: a.dueDateLocalDate, dueDateSlot: a.dueDateSlot }), ctx);
  registerKaneraTool(server, "cards.bulk_patch_labels", `Add or remove labels on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    labelIds: z.array(uuid).min(1),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/labels`, { cardIds: await resolveCardReferences(api, a.cardIds), mode: a.mode, labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "cards.bulk_patch_assignees", `Add or remove assignees on up to 200 selected cards in a board. Returns the number changed, changed card ids, and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    mode: z.enum(["add", "remove"]),
    userIds: z.array(uuid).min(1),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/assignees`, { cardIds: await resolveCardReferences(api, a.cardIds), mode: a.mode, userIds: a.userIds }), ctx);
  registerKaneraTool(server, "cards.bulk_move", `Move up to 200 selected active cards to one workflow list in their board. Returns moved cards and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
    listId: uuid,
  }, async (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/move`, { cardIds: await resolveCardReferences(api, a.cardIds), listId: a.listId }), ctx);
  registerKaneraTool(server, "cards.bulk_archive", `Archive up to 200 selected cards in one board. This is destructive and cannot bulk-unarchive. Returns archived cards. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    cardIds: z.array(cardReference).min(1).max(200),
  }, async (a, api) => api.patch(`/api/v1/boards/${a.boardId}/cards/bulk/archive`, { cardIds: await resolveCardReferences(api, a.cardIds), archived: true }), ctx);
  registerKaneraTool(server, "cards.bulk_duplicate", `Duplicate up to 200 selected active cards, optionally to another editable board and list. This is not idempotent: do not retry after an ambiguous success. ${boardBatchScope} Requires board editor access at the source and destination.`, {
    boardId: uuid.describe("Source board id."),
    cardIds: z.array(cardReference).min(1).max(200),
    targetBoardId: uuid.optional(),
    listId: uuid.optional(),
  }, async (a, api) => api.post(`/api/v1/boards/${a.boardId}/cards/bulk/duplicate`, { cardIds: await resolveCardReferences(api, a.cardIds), boardId: a.targetBoardId, listId: a.listId }), ctx);
  registerKaneraTool(server, "cards.bulk_set_custom_field", `Set, fill, add, remove, or clear one custom field on up to 200 selected cards. Returns changed values/card ids and skipped archived card ids. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
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
  registerKaneraTool(server, "lists.set_card_completion", `Mark every active card in one board/list complete or incomplete. Returns the number changed. ${boardBatchScope} Requires board editor access and a write-capable credential.`, {
    boardId: uuid,
    listId: uuid,
    completed: z.boolean(),
  }, (a, api) => api.post(`/api/v1/boards/${a.boardId}/lists/${a.listId}/cards/completion`, { completed: a.completed }), ctx);
  registerKaneraTool(server, "lists.move_cards", "Move every active card from one workflow list to another on exactly one board. Requires board editor access.", {
    sourceListId: uuid,
    targetListId: uuid,
    boardId: uuid,
  }, (a, api) => api.post(`/api/v1/lists/${a.sourceListId}/cards/move`, { targetListId: a.targetListId, boardId: a.boardId }), ctx);
  registerKaneraTool(server, "lists.archive_cards", "Archive every active card in one workflow list on exactly one board. This is destructive and requires board editor access.", {
    listId: uuid,
    boardId: uuid,
  }, (a, api) => api.patch(`/api/v1/lists/${a.listId}/cards/archive`, { boardId: a.boardId }), ctx);
  registerKaneraTool(server, "cards.set_assignees", "Replace all assignees on a card. Requires board editor access and a write-capable credential.", { cardId: cardReference, userIds: z.array(uuid).max(100) }, async (a, api) =>
    api.put(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/assignees`, { userIds: a.userIds }), ctx);
  registerKaneraTool(server, "cards.set_labels", "Replace all labels on a card. Requires board editor access and a write-capable credential.", { cardId: cardReference, labelIds: z.array(uuid).max(100) }, async (a, api) =>
    api.put(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/labels`, { labelIds: a.labelIds }), ctx);
  registerKaneraTool(server, "cards.set_custom_field_value", "Set or clear one custom-field value on a card. Requires board editor access and a write-capable credential.", customFieldValueSchema(), async (a, api) =>
    api.put(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/custom-fields/${a.fieldId}`, customFieldValueBody(a.value)), ctx);
  registerKaneraTool(server, "comments.add", "Add a comment to a card, optionally linking card attachments already uploaded for that comment. Requires board editor access and a write-capable credential. This is not idempotent; do not retry after an ambiguous success.", {
    cardId: cardReference,
    body: z.string().min(1).max(20000),
    attachmentIds: z.array(uuid).max(100).optional(),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/comments`, { body: a.body, attachmentIds: a.attachmentIds }), ctx);
  registerKaneraTool(server, "comments.list", "List a card's comments, newest first. Cursor-paginated; pass the opaque nextCursor unchanged.", {
    cardId: cardReference,
    cursor: z.string().min(1).max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, async (a, api) => api.get(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/comments`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "comments.delete", "Delete one comment authored by the acting user. Comments from other users, integration credentials, or the system are rejected. This is destructive; use only after an explicit request and, for migrations, after verifying the destination. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
  }, (a, api) => api.delete(`/api/v1/comments/${a.commentId}`), ctx);
  registerKaneraTool(server, "comments.update", "Replace the text of a comment authored by the acting user, optionally linking newly uploaded card attachments. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
    body: z.string().min(1).max(20000),
    attachmentIds: z.array(uuid).max(100).optional(),
  }, (a, api) => api.patch(`/api/v1/comments/${a.commentId}`, { body: a.body, attachmentIds: a.attachmentIds }), ctx);
  registerKaneraTool(server, "comments.set_reaction", "Idempotently add or remove the connected user's reaction on another person's comment. Requires board editor access and a write-capable credential.", {
    commentId: uuid,
    type: reactionType,
    active: z.boolean(),
  }, (a, api) => a.active
    ? api.post(`/api/v1/comments/${a.commentId}/reactions`, { type: a.type })
    : api.delete(`/api/v1/comments/${a.commentId}/reactions/${encodeURIComponent(a.type)}`), ctx);
  registerKaneraTool(server, "cards.add_attachment", "Upload one small file to a card. MCP request limits cap fileBase64 at roughly 512 KiB decoded; use the public API directly for larger files. For a new comment attachment, set source=comment and then include the returned attachment id in comments.add; commentId may link it directly to an existing owned comment.", {
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
  registerKaneraTool(server, "cards.delete_attachment", "Delete a card attachment. If it is the cover, Kanera selects the next eligible image cover. This is destructive and requires board editor access with a write-capable credential.", {
    cardId: cardReference,
    attachmentId: uuid,
  }, async (a, api) => api.delete(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/attachments/${a.attachmentId}`), ctx);
  registerKaneraTool(server, "cards.set_cover", "Set one existing image attachment as a card's cover, or pass null to remove the cover. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    attachmentId: uuid.nullable(),
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/cover`, { attachmentId: a.attachmentId }), ctx);
  registerKaneraTool(server, "checklists.create", "Add a top-level checklist to a card, or create a one-level sub-checklist by passing the owning top-level parentItemId. Requires board editor access and a write-capable credential. This is not idempotent.", {
    cardId: cardReference,
    title: z.string().trim().min(1).max(500),
    parentItemId: uuid.nullable().optional().describe("Top-level checklist item that owns this sub-checklist; omit or null for a card-level checklist."),
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists`, { title: a.title, parentItemId: a.parentItemId }), ctx);
  registerKaneraTool(server, "checklists.update", "Rename a checklist. Requires board editor access and a write-capable credential.", { cardId: cardReference, checklistId: uuid, title: z.string().trim().min(1).max(500) }, async (a, api) =>
    api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}`, { title: a.title }), ctx);
  registerKaneraTool(server, "checklists.delete", "Delete a checklist and its items. This is destructive and requires board editor access with a write-capable credential.", { cardId: cardReference, checklistId: uuid }, async (a, api) =>
    api.delete(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}`), ctx);
  registerKaneraTool(server, "checklists.move", "Reorder a checklist using one explicit before/after anchor; a null anchor id means that edge. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid,
    anchor: positionAnchor,
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/move`,
    a.anchor.side === "after" ? { afterChecklistId: a.anchor.id } : { beforeChecklistId: a.anchor.id }), ctx);
  registerKaneraTool(server, "checklists.add_item", "Add an item to a checklist. Items in sub-checklists are leaf rows with text and completion only. Requires board editor access and a write-capable credential. This is not idempotent.", { cardId: cardReference, checklistId: uuid, text: z.string().trim().min(1).max(2000) }, async (a, api) =>
    api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items`, { text: a.text }), ctx);
  registerKaneraTool(server, "checklists.update_item", "Update a checklist item's text, completion, description, assignee, or due date. Description, assignee, and due date apply only to top-level items; sub-checklist leaves support text and completion only. Provide at least one field. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid,
    itemId: uuid,
    changes: checklistItemChanges,
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/${a.itemId}`, a.changes), ctx);
  registerKaneraTool(server, "checklists.bulk_update_items", "Set or clear the assignee or due date on all items in one checklist. Provide assigneeId or a due date. Repeating the same arguments is idempotent. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid,
    changes: bulkChecklistItemChanges,
  }, async (a, api) => api.patch(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/bulk`, a.changes), ctx);
  registerKaneraTool(server, "checklists.delete_item", "Delete a checklist item. This is destructive and requires board editor access with a write-capable credential.", { cardId: cardReference, checklistId: uuid, itemId: uuid }, async (a, api) =>
    api.delete(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/${a.itemId}`), ctx);
  registerKaneraTool(server, "checklists.move_item", "Move or reorder a checklist item, optionally into another checklist, using one explicit anchor. A null anchor id means that edge. Requires board editor access and a write-capable credential.", {
    cardId: cardReference,
    checklistId: uuid.describe("Source checklist id."),
    itemId: uuid,
    targetChecklistId: uuid.optional().describe("Destination checklist id; omit to reorder within the source checklist."),
    anchor: positionAnchor,
  }, async (a, api) => api.post(`/api/v1/cards/${await resolveCardReference(api, a.cardId)}/checklists/${a.checklistId}/items/${a.itemId}/move`, {
    checklistId: a.targetChecklistId,
    ...(a.anchor.side === "after" ? { afterItemId: a.anchor.id } : { beforeItemId: a.anchor.id }),
  }), ctx);
  registerKaneraTool(server, "activity.list", "List a cursor-paginated board-wide feed of recent activity and comments.", {
    boardId: uuid,
    cursor: z.string().min(1).max(1000).optional(),
    limit: pageLimit,
  }, (a, api) => api.get(`/api/v1/boards/${a.boardId}/activity`, { cursor: a.cursor, limit: a.limit }), ctx);
  registerKaneraTool(server, "work.query_history", "Use this when reviewing work performed by one person across projects. Returns only that actor's created, moved, completed, and checklist-item-completed events over an exact or calendar range, with full-range counts, source names, canonical card links, and cursor pagination. Omit userId for the connected user.", {
    userId: uuid.optional().describe("Person whose actions to return; resolve workspace users with workspaces.list_members. Omit for the connected user."),
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
    return api.post("/api/v1/work/history/query", a);
  }, ctx, workHistoryOutputSchema);
  registerKaneraTool(server, "work.query_cards", "Use this when listing current, completed, overdue, unassigned, or stale work across one or many Kanera projects. For another person, use lens=team and one assigneeIds value; do not enumerate boards manually. Results include source-name maps and canonical card links.", {
    lens: z.enum(["my", "team"]).describe("Use my for the connected user's assignments; use team with filters.assigneeIds for another person."),
    scope: workScope,
    filters: workFilters,
    sort: z.enum(["dueAsc", "dueDesc", "titleAsc", "titleDesc", "createdAsc", "createdDesc", "updatedAsc", "updatedDesc"]).default("dueAsc"),
    cursor: z.string().min(1).max(500_000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }, (a, api) => api.post("/api/v1/work/cards/query", a), ctx, workCardsOutputSchema);
  registerKaneraTool(server, "work.portfolio_summary", "Get bounded organisation, workspace, and board rollups across accessible work, including active, overdue, due-soon, unassigned, completed, and overdue-checklist counts plus recent activity buckets.", {
    scope: workScope,
    filters: workFilters,
    days: z.number().int().min(1).max(60).default(30),
    timeZone: z.string().trim().min(1).max(100).default("UTC"),
  }, (a, api) => api.post("/api/v1/work/portfolio/query", a), ctx);
  registerKaneraTool(server, "priorities.list_targets", "List the users whose \"Up next\" priority queues this credential can read: the connected user plus teammates covered by its effective workspace admin authority. Workspace credentials require admin scope and stay pinned to their workspace. Returns each target's userId, display name, email, authority workspace ids, and live queue size. Write capability still depends on credential scope and per-card authorisation.", {},
    (_a, api) => api.get("/api/v1/work/priority-targets"), ctx);
  registerKaneraTool(server, "priorities.list", "List a user's ranked cross-board \"Up next\" priority queue. Omit targetUserId for the connected user's own queue; a teammate's requires admin authority in a shared workspace (priorities.list_targets shows who is readable). Workspace credentials need admin scope and remain pinned to one workspace. Entries whose card this credential cannot see keep their rank but return card: null. Entry ids are the anchors and handles for the add/move/remove priority tools; mutation separately requires a write-capable credential and per-card authority.", {
    targetUserId: uuid.optional().describe("Whose queue to read; omit for the connected user."),
    limit: z.number().int().min(1).max(MAX_CARD_PRIORITIES_PER_USER).optional().describe("Return only the top N entries; ranks and counts still describe the full queue."),
  }, async (a, api) =>
    api.get(`/api/v1/work/priorities/${await priorityTargetUserId(api, a.targetUserId)}`, { limit: a.limit }), ctx);
  registerKaneraTool(server, "priorities.add", `Add a card to a user's "Up next" queue (at most ${MAX_CARD_PRIORITIES_PER_USER} live entries). The card must be assigned to the target user. Your own queue needs only card visibility; a teammate's needs admin authority in the card's workspace. Requires a write-capable credential. Returns the updated queue.`, {
    cardId: cardReference,
    targetUserId: uuid.optional().describe("Whose queue to add to; omit for the connected user."),
    anchor: priorityAnchor.optional().describe("Position among existing entries; omit to append at the bottom."),
  }, async (a, api) => {
    const userId = await priorityTargetUserId(api, a.targetUserId);
    return api.post(`/api/v1/work/priorities/${userId}/cards`, {
      cardId: await resolveCardReference(api, a.cardId),
      ...priorityAnchorBody(a.anchor ?? { side: "before", id: null }),
    });
  }, ctx);
  registerKaneraTool(server, "priorities.move", "Move one \"Up next\" queue entry using one explicit before/after anchor; a null anchor id means that edge. Requires a write-capable credential. Returns the updated queue.", {
    priorityId: uuid.describe("The queue entry id from priorities.list."),
    anchor: priorityAnchor,
  }, (a, api) => api.post(`/api/v1/card-priorities/${a.priorityId}/move`, priorityAnchorBody(a.anchor)), ctx);
  registerKaneraTool(server, "priorities.remove", "Remove one entry from a user's \"Up next\" queue without changing the card itself. Requires a write-capable credential. Returns the updated queue.", {
    priorityId: uuid.describe("The queue entry id from priorities.list."),
  }, (a, api) => api.delete(`/api/v1/card-priorities/${a.priorityId}`), ctx);
  registerKaneraTool(server, "notes.list", "List a cursor-paginated page of flat note metadata. parentNoteId expresses the hierarchy; use notes.get for full content. Provide exactly one of workspaceId for a standard workspace or boardId for a workspace or standalone board. Personal notes are limited to the connected user.", {
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
  registerKaneraTool(server, "notes.get", "Read any visible top-level or nested note. Personal notes are limited to their owner.", { noteId: uuid }, (a, api) => api.get(`/api/v1/notes/${a.noteId}`), ctx);
  registerKaneraTool(server, "notes.get_backlinks", "List bounded visible cards, boards, and notes that link to a note.", { noteId: uuid }, async (a, api) =>
    boundedConfiguration(await api.get<Record<string, unknown>>(`/api/v1/notes/${a.noteId}/backlinks`)), ctx);
  registerKaneraTool(server, "notes.list_attachments", "List a bounded set of files attached to a visible note at any hierarchy level.", { noteId: uuid }, async (a, api) => {
    const rows = await api.get<unknown[]>(`/api/v1/notes/${a.noteId}/attachments`);
    return { items: rows.slice(0, 100), truncated: rows.length > 100, total: rows.length };
  }, ctx);
  registerKaneraTool(server, "notes.create", "Create a personal or team note at any supported hierarchy level. The required target explicitly selects a standard workspace or a board. Personal notes are private to the connected user. Team notes require workspace administration or board editor access; creation is not idempotent.", noteMutationSchema(), (a, api) =>
    api.post(a.target.type === "workspace"
      ? `/api/v1/workspaces/${a.target.workspaceId}/notes`
      : `/api/v1/boards/${a.target.boardId}/notes`, {
      scope: a.scope,
      parentNoteId: a.parentNoteId,
      title: a.title,
      icon: a.icon,
      color: a.color,
    }), ctx);
  registerKaneraTool(server, "notes.update", "Update one or more fields on any visible top-level or nested note. The required changes object cannot be empty. Markdown content can contain external links, Kanera-internal links, and attachment URLs. Team-note edits respect Kanera note locks and require workspace administration or board editor access; personal notes are limited to their owner.", {
    noteId: uuid,
    changes: noteUpdateChanges,
  }, (a, api) => api.patch(`/api/v1/notes/${a.noteId}`, a.changes), ctx);
  registerKaneraTool(server, "notes.add_link", "Append a Markdown link to a note without replacing its existing content. The public API's optimistic timestamp prevents overwriting a concurrent edit.", {
    noteId: uuid,
    url: z.url().max(2048),
    label: z.string().trim().min(1).max(200).optional(),
  }, async (a, api) => {
    const note = await api.get<NoteRow>(`/api/v1/notes/${a.noteId}`);
    const link = markdownLink(a.label, a.url);
    const content = note.content.trimEnd() ? `${note.content.trimEnd()}\n\n${link}` : link;
    return api.patch(`/api/v1/notes/${a.noteId}`, { content, baseUpdatedAt: note.updatedAt });
  }, ctx);
  registerKaneraTool(server, "notes.add_attachment", "Upload one small file to a note at any hierarchy level. MCP request limits cap fileBase64 at roughly 512 KiB decoded; use the public API directly for larger files. The returned URL can be added to note content with notes.add_link.", {
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
  registerKaneraTool(server, "notes.duplicate", "Duplicate one visible note, including its Markdown, icon, color, and link relationships. Descendant notes and binary attachments are not copied. The duplicate remains in the same workspace/board and personal/team collection.", {
    noteId: uuid,
    parentNoteId: uuid.nullable().optional(),
    title: z.string().max(200).optional(),
  }, (a, api) => api.post(`/api/v1/notes/${a.noteId}/duplicate`, {
    parentNoteId: a.parentNoteId,
    title: a.title,
  }), ctx);
  registerKaneraTool(server, "notes.move", "Reparent or reorder a note within its current workspace/board and personal/team collection. Notes cannot be moved across tenancy boundaries.", {
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
      z.object({ type: z.literal("text").describe("Text field discriminator."), value: z.string().max(20000).nullable().describe("Text value, or null to clear it.") }),
      z.object({ type: z.literal("number").describe("Number field discriminator."), value: z.union([z.number(), z.string()]).nullable().describe("Number or numeric string, or null to clear it.") }),
      z.object({ type: z.literal("checkbox").describe("Checkbox field discriminator."), value: z.boolean().nullable().describe("Boolean value, or null to clear it.") }),
      z.object({ type: z.literal("date").describe("Date field discriminator."), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe("YYYY-MM-DD date, or null to clear it.") }),
      z.object({ type: z.literal("url").describe("URL field discriminator."), value: z.url().max(2000).nullable().describe("Absolute URL, or null to clear it.") }),
      z.object({ type: z.literal("select").describe("Select field discriminator."), value: z.array(uuid).nullable().describe("Option UUIDs, or null to clear them.") }),
      z.object({ type: z.literal("user").describe("User field discriminator."), value: z.array(uuid).nullable().describe("User UUIDs, or null to clear them.") }),
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
      z.object({ type: z.literal("workspace").describe("Select a standard workspace target."), workspaceId: uuid.describe("Target standard-workspace UUID.") }),
      z.object({ type: z.literal("board").describe("Select a board target."), boardId: uuid.describe("Target workspace or standalone-board UUID.") }),
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
  server.registerResource(name, new ResourceTemplate(template, { list: undefined }), { description, mimeType: "application/json" }, async (uri, vars, extra) => {
    const data = await read(vars as Record<string, string>, client(ctx, { signal: extra?.signal }));
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  });
}

function registerPrompts(server: McpServer) {
  server.registerPrompt("summarize_board_status", { description: "Summarize board progress, blockers, stale cards, and next actions.", argsSchema: { boardId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Call boards.get for ${a.boardId}, then page the relevant lists with cards.list. Use work.query_cards scoped to this board for overdue, unassigned, and stale-card evidence, and inspect cards.list_history only for cards that need chronology. Summarize progress, blockers, risks, and next actions; distinguish observed facts from inferences.` } }],
  }));
  server.registerPrompt("prepare_standup_update", { description: "Prepare the connected user's cross-board standup update.", argsSchema: { period: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month"]).default("yesterday") } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Use work.query_history with preset ${a.period} and no userId for work I performed, then use work.query_cards with lens=my and completion=active for work in flight. Draft a concise accomplishments/current work/blockers update. Identify blockers only when supported by card data, and label any inference.` } }],
  }));
  server.registerPrompt("prepare_one_on_one", {
    description: "Prepare a read-only cross-project one-on-one review for a workspace member.",
    argsSchema: {
      workspaceId: uuid,
      userId: uuid,
      period: z.enum(["this_week", "last_week", "this_month", "last_month"]).default("last_month"),
    },
  }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Do not make changes in Kanera. For workspace ${a.workspaceId} and user ${a.userId}, use work.query_cards twice with lens=team and that assignee: completion=active for current work, then completion=completed with the ${a.period} date range. Use work.query_history for the same user, workspace, and ${a.period}. Search and inspect only the most relevant supporting cards, comments, and notes. Summarize completed work, important progress, blockers or follow-ups, and 4–5 discussion points with canonical Kanera links. Distinguish observed facts from inferences.` } }],
  }));
  server.registerPrompt("draft_card_from_notes", { description: "Draft a card title and description from one note.", argsSchema: { noteId: uuid } }, (a) => ({
    messages: [{ role: "user", content: { type: "text", text: `Call notes.get for ${a.noteId} and draft a Kanera card title plus Markdown description. Do not create the card until asked.` } }],
  }));
}
