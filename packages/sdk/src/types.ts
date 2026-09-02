/**
 * Entity shapes returned by the Kanera public API.
 *
 * These describe the fields the API is documented to return. Responses may carry additional
 * fields — TypeScript interfaces are structurally open, so extra data is passed through untouched
 * even when it is not typed here. Where a response is large and variable (board detail,
 * work-query rollups), the collections are typed and the outer envelope stays honest about what
 * it guarantees.
 */

export type Uuid = string;

/** The closed palette Kanera assigns to lists, labels, notes, and custom-field options. */
export type ColorToken =
  | "rose" | "pink" | "red" | "orange" | "amber" | "yellow"
  | "lime" | "green" | "emerald" | "teal" | "cyan" | "sky" | "blue" | "indigo"
  | "violet" | "purple" | "fuchsia" | "gray" | "olive" | "brown";
/** ISO-8601 instant, for example `2026-08-29T00:26:24.421Z`. */
export type Timestamp = string;
/** `YYYY-MM-DD`, with no timezone. Card due dates are local dates by design. */
export type LocalDate = string;

export type CredentialKind = "personal" | "workspace" | "user";
export type CredentialScope = "read" | "write" | "admin";

export interface Session {
  userId: Uuid;
  organisationId: Uuid;
  organisationName: string | null;
  organisationLogoUrl: string | null;
  credentialKind: CredentialKind;
  organisationScope: "identity-wide" | "workspace-pinned";
  /**
   * What this credential may do. `read` means every mutation will be refused — check it once at
   * start-up rather than discovering it on the first write.
   */
  scope: CredentialScope | null;
  /** Set only for workspace credentials, which are pinned to one workspace. */
  workspaceId: Uuid | null;
  /** Origin of the web app, for building links a human can open. */
  webUrl: string;
}

export type WorkspaceKind = "standard" | "board";

export interface Workspace {
  id: Uuid;
  clientId: Uuid;
  name: string;
  kind: WorkspaceKind;
  cardKeyPrefix: string;
  icon: string | null;
  accentColor: ColorToken | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Built-in workspace templates; `blank` seeds nothing. */
export type WorkspaceTemplateId =
  | "development-team"
  | "marketing"
  | "simple-todo"
  | "product-team"
  | "sales-crm"
  | "operations-support"
  | "project-delivery"
  | "event-planning"
  | "client-onboarding"
  | "hiring-pipeline"
  | "blank";

export type WorkspaceSeedAutomationTrigger =
  | { type: "card_enters_list"; listName: string; applyOnCreate?: boolean; applyOnMove?: boolean }
  | { type: "due_date_arrives" }
  | { type: "all_checklist_items_complete" }
  | { type: "card_marked_complete" }
  | { type: "card_label_set"; labelName: string }
  | { type: "card_becomes_inactive" };

export type WorkspaceSeedCustomFieldValue =
  | { kind: "text"; text: string }
  | { kind: "text_current_date"; format: "date" | "month" | "month_long_short_year" | "month_long_year" | "datetime" }
  | { kind: "number"; number: number }
  | { kind: "date"; source: "fixed"; date: string }
  | { kind: "date"; source: "current" }
  | { kind: "checkbox"; checked: boolean }
  | { kind: "select"; optionLabels: string[] };

export type WorkspaceSeedAutomationAction =
  | { type: "add_labels"; labelNames: string[] }
  | { type: "remove_labels"; labelNames: string[] }
  | { type: "apply_checklists"; checklistTemplateTitles: string[] }
  | { type: "set_due_date"; offsetDays: number; slot?: DueDateSlot }
  | { type: "clear_due_date" }
  | { type: "set_completion"; completed: boolean }
  | { type: "move_to_list"; listName: string; placement?: "top" | "bottom" }
  | { type: "move_to_top" }
  | { type: "move_to_bottom" }
  | { type: "populate_custom_field"; fieldName: string; onlyIfEmpty?: boolean; value: WorkspaceSeedCustomFieldValue };

/**
 * One-shot workspace bootstrap. Seed content references lists, labels, fields, and checklist
 * templates by name; the API resolves them inside the same transaction.
 *
 * Requires an organisation admin or owner using a write-capable personal credential; workspace
 * keys cannot create workspaces. Set `kind: "board"` with `initialBoard` for a standalone board.
 */
export interface CreateWorkspaceInput {
  name: string;
  kind?: WorkspaceKind;
  /** Human card-key prefix such as `PROJ`; derived from the name when omitted. */
  cardKeyPrefix?: string;
  icon?: string | null;
  initialBoard?: { name: string; icon?: string | null; iconColor?: ColorToken | null };
  /** Ordered workflow lists. Empty or at least two entries. */
  lists?: { name: string; icon?: string | null }[];
  /** Plain list names; an alternative to `lists`. */
  listNames?: string[];
  customFields?: {
    name: string;
    icon?: string | null;
    type: CustomFieldType;
    allowMultiple?: boolean;
    options?: { label: string; color?: ColorToken | null }[];
  }[];
  labels?: { name: string; color?: ColorToken | null }[];
  checklistTemplates?: { title: string; items: string[] }[];
  /** Starter cards; requires `initialBoard`. */
  cards?: {
    title: string;
    description?: string;
    listName: string;
    labelNames?: string[];
    checklistTemplateTitles?: string[];
  }[];
  automations?: { trigger: WorkspaceSeedAutomationTrigger; actions: WorkspaceSeedAutomationAction[] }[];
}

export interface CreatedWorkspace extends Workspace {
  /** Present when the request included `initialBoard`. */
  initialBoard?: Board;
}

export interface CreateBoardInput {
  name: string;
  groupId?: Uuid | null;
  description?: string;
  icon?: string | null;
  iconColor?: ColorToken | null;
}

export interface List {
  id: Uuid;
  workspaceId: Uuid;
  name: string;
  icon: string | null;
  color: ColorToken | null;
  position: string;
  archivedAt: Timestamp | null;
}

export interface Label {
  id: Uuid;
  workspaceId: Uuid;
  name: string;
  color: ColorToken;
}

export type CustomFieldType = "text" | "number" | "checkbox" | "select" | "date" | "url" | "user";

export interface CustomField {
  id: Uuid;
  workspaceId: Uuid;
  name: string;
  type: CustomFieldType;
  allowMultiple: boolean;
  showOnCard: boolean;
  position: string;
  options?: { id: Uuid; name: string; color: ColorToken | null }[];
}

export interface CustomFieldValue {
  cardId: Uuid;
  fieldId: Uuid;
  textValue?: string | null;
  numberValue?: string | null;
  dateValue?: LocalDate | null;
  booleanValue?: boolean | null;
  optionIds?: Uuid[];
  userIds?: Uuid[];
}

/**
 * Workspace membership is two-tier: `admin` manages everything workspace-scoped, `member` has no
 * workspace-scoped mutation rights and exists to be added to boards. Board membership is separate.
 */
export type WorkspaceRole = "admin" | "member";
export type BoardRole = "editor" | "observer";

export interface Member {
  userId: Uuid;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  avatarUrl?: string | null;
}

export interface Board {
  id: Uuid;
  workspaceId: Uuid;
  name: string;
  description: string | null;
  icon: string | null;
  iconColor: ColorToken | null;
  position: string;
  archivedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A board as returned by discovery, carrying the workspace context needed to act on it. */
export interface AccessibleBoard extends Board {
  workspaceName: string;
  workspaceKind: WorkspaceKind;
  clientId: Uuid;
}

/**
 * Wall-clock cut-off a due date is measured against; this is what defines "overdue". Mirrors
 * `CARD_DUE_DATE_SLOTS` in the Kanera schema.
 */
export type DueDateSlot = "anyTime" | "morning" | "afternoon" | "endOfWorkDay";

export interface Card {
  id: Uuid;
  workspaceId: Uuid;
  boardId: Uuid;
  listId: Uuid;
  /** Stable organisation prefix used to disambiguate a human key across organisations. */
  organisationKey: string;
  /** Human-readable key such as `DELIVERY-1`. Accepted anywhere a card id is. */
  key: string;
  number: number;
  title: string;
  description: string | null;
  position: string;
  dueDateLocalDate: LocalDate | null;
  dueDateSlot: DueDateSlot | null;
  dueDateTimezone: string | null;
  completedAt: Timestamp | null;
  archivedAt: Timestamp | null;
  createdById: Uuid;
  coverAttachmentId: Uuid | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Canonical browser link to the card. */
  url: string;
}

export interface Attachment {
  id: Uuid;
  fileName: string;
  contentType: string;
  byteSize: number;
  createdAt: Timestamp;
  url?: string;
}

export interface ChecklistItem {
  id: Uuid;
  checklistId: Uuid;
  /** The item's label. A checklist has a `title`; its items have `text`. */
  text: string;
  description: string | null;
  completedAt: Timestamp | null;
  assigneeId: Uuid | null;
  dueDateLocalDate: LocalDate | null;
  position: string;
  /** Set when this item owns a nested sub-checklist. */
  parentItemId?: Uuid | null;
}

export interface Checklist {
  id: Uuid;
  cardId: Uuid;
  title: string;
  position: string;
  /** A sub-checklist names the item that owns it; top-level checklists leave this null. */
  parentItemId: Uuid | null;
  items: ChecklistItem[];
}

export interface CardDetail {
  card: Card;
  customFieldValues: CustomFieldValue[];
  labelIds: Uuid[];
  assigneeIds: Uuid[];
  attachments: Attachment[];
  checklists: Checklist[];
  linkedNotes: { id: Uuid; title: string }[];
}

export type CommentAuthorKind = "user" | "apiKey" | "system";

export interface Comment {
  id: Uuid;
  cardId: Uuid;
  authorId: Uuid | null;
  authorKind: CommentAuthorKind;
  apiKeyId: Uuid | null;
  apiKeyName: string | null;
  body: string;
  editedAt: Timestamp | null;
  createdAt: Timestamp;
}

export type NoteScope = "personal" | "team";

export interface Note {
  id: Uuid;
  workspaceId: Uuid | null;
  boardId: Uuid | null;
  parentNoteId: Uuid | null;
  scope: NoteScope;
  ownerId: Uuid | null;
  title: string;
  icon: string | null;
  color: ColorToken | null;
  position: string;
  lastEditedById: Uuid | null;
  lastEditedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface NoteDetail extends Note {
  /** Markdown body. Omitted from list responses, which return navigation metadata only. */
  content: string;
}

export interface ActivityEvent {
  id: Uuid;
  type: string;
  cardId: Uuid | null;
  boardId: Uuid | null;
  actorId: Uuid | null;
  actorKind: string;
  data: unknown;
  createdAt: Timestamp;
}

export interface PriorityContext {
  boardName: string;
  boardIcon: string | null;
  boardIconColor: ColorToken | null;
  listName: string;
  listIcon: string | null;
  listColor: ColorToken | null;
  workspaceName: string;
  labels: { id: Uuid; name: string; color: ColorToken | null }[];
}

export interface PriorityEntry {
  /** The queue-entry id. This is the handle for move and remove, and the anchor for add. */
  id: Uuid;
  position: string;
  /**
   * 1-based over the *target's* live queue, not the viewer's. A manager who can see 3 of 5 entries
   * reads 1, 2, 5 — so that the manager and the assignee say the same number about the same card.
   */
  rank: number;
  /** Null when the entry is in the queue but its card is not visible to this credential. */
  card: Card | null;
  /** Board, list, and workspace names, redacted alongside `card`. */
  context: PriorityContext | null;
}

export interface PriorityQueue {
  targetUserId: Uuid;
  items: PriorityEntry[];
  /** Live queue length before `limit` was applied. */
  totalCount: number;
  /** Entries whose card is hidden from this credential. Only ever non-zero for managers. */
  hiddenCount: number;
  canReorder: boolean;
  reorderableWorkspaceIds: Uuid[];
}

export interface PriorityTarget {
  userId: Uuid;
  displayName: string;
  email: string;
  /** True for the credential's own queue, which needs no admin authority. */
  self: boolean;
  workspaceIds: Uuid[];
  queueSize: number;
}

/** Anchors in a priority queue are bare entry ids: the lane holds exactly one kind of thing. */
export interface PriorityAnchor {
  side: "before" | "after";
  /** A queue-entry id, or null for that edge of the queue. */
  id: Uuid | null;
}

/** The result of a bulk card mutation. `skippedCardIds` names cards the change did not apply to. */
export interface BulkCardResult {
  updated: number;
  cards: Card[];
  skippedCardIds: Uuid[];
}

/** Bulk archive counts under `archived`, not `updated`. */
export interface BulkArchiveResult {
  archived: number;
  cards: Card[];
  skippedCardIds: Uuid[];
}

/** A page whose continuation token is opaque and must be passed back unchanged. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Before/after anchors. A null id means the edge of the list. */
export interface PositionAnchor {
  side: "before" | "after";
  id: Uuid | null;
}

export interface WorkScope {
  allAccessible?: boolean;
  organisationIds?: Uuid[];
  workspaceIds?: Uuid[];
  boardIds?: Uuid[];
}

export interface WorkFilters {
  q?: string;
  assigneeIds?: Uuid[];
  listIds?: Uuid[];
  labelIds?: Uuid[];
  completion?: "activeAndRecentlyCompleted" | "active" | "completed" | "all";
  unassignedOnly?: boolean;
  inactiveOnly?: boolean;
  dueFrom?: LocalDate | null;
  dueTo?: LocalDate | null;
  overdueOnly?: boolean;
  overdueChecklistOnly?: boolean;
  archived?: boolean;
  completedFrom?: Timestamp | null;
  completedTo?: Timestamp | null;
}

export type WorkSort =
  | "dueAsc" | "dueDesc" | "titleAsc" | "titleDesc"
  | "createdAsc" | "createdDesc" | "updatedAsc" | "updatedDesc";

/** Name maps so a caller can render board/list/label/person names without extra lookups. */
export interface WorkSources {
  boards: { id: Uuid; name: string; url: string; workspaceId: Uuid; workspaceName: string; organisationId: Uuid; organisationName: string }[];
  lists: { id: Uuid; workspaceId: Uuid; name: string }[];
  labels: { id: Uuid; workspaceId: Uuid; name: string }[];
  people: { id: Uuid; displayName: string }[];
}

export interface WorkCardsResult {
  cards: Card[];
  checklistItems: { itemId: Uuid; boardId: Uuid; listId: Uuid; assigneeId: Uuid; url: string }[];
  totals: { cards: number; overdue: number; dueSoon: number; completed: number; checklistItems: number; overdueChecklistItems: number };
  sources: WorkSources;
  nextCursor: string | null;
}

export type SearchResultType = "card" | "comment" | "note" | "attachment";

export interface SearchResult {
  id: Uuid;
  type: SearchResultType;
  workspaceId: Uuid;
  workspaceName: string;
  boardId: Uuid | null;
  boardName: string | null;
  url: string;
  matchContext: string;
  cardKey?: string;
  cardTitle?: string;
  listName?: string;
}

/**
 * The body Kanera POSTs to a webhook endpoint. `data` varies by `type`; narrow it on `type`
 * before use.
 */
export interface WebhookPayload {
  id: string;
  type: string;
  workspaceId: Uuid;
  boardId?: Uuid;
  cardId?: Uuid;
  occurredAt: Timestamp;
  data: unknown;
}
