import type { BoardMirrorRow } from "../dto/board-mirrors.js";
import type { CardAttachmentRow } from "../dto/card-attachments.js";
import type { NoteAttachmentRow } from "../dto/note-attachments.js";
import type {
  CommentReactionSummary,
  ReactionType,
  ReactionUserSummary,
} from "../dto/comment-reactions.js";
import type { ActivityFeedEvent, CardFeedItem, CommentRow } from "../dto/comments.js";
import type { NotificationRow } from "../dto/notifications.js";
import type {
  Board,
  BoardGroup,
  BoardMember,
  Automation,
  AutomationAction,
  AssignedWorkSeparator,
  Card,
  CardAssignee,
  CardChecklist,
  CardChecklistItem,
  CardDueDateSlot,
  BoardSeparator,
  ChecklistTemplate,
  ChecklistTemplateItem,
  CardCustomFieldValue,
  CardLabel,
  ClientRole,
  Comment,
  CustomField,
  CustomFieldOption,
  List,
  Note,
  NoteScope,
  Workspace,
  WorkspaceMember,
  StandaloneBoardGroup,
} from "../schema/index.js";
import type { LinkedInternalSummary } from "../dto/internal-links.js";

export type { ActivityFeedEvent, CardAttachmentRow, CardFeedItem, CommentRow, NoteAttachmentRow };

export type WireList = Omit<List, "position"> & { position: string };
export type WireBoardSeparator = Omit<BoardSeparator, "position"> & { position: string };
export type WireAssignedWorkSeparator = Omit<AssignedWorkSeparator, "position"> & { position: string };
export type WireSeparator = WireBoardSeparator | WireAssignedWorkSeparator;
// clientToken is an internal request-deduplication key, not card data for API or realtime clients.
export type WireCard = Omit<Card, "position" | "searchVector" | "clientToken"> & { position: string; url?: string };
export type WireCardChecklistItem = Omit<CardChecklistItem, "position"> & { position: string };
export type WireCardChecklist = Omit<CardChecklist, "position" | "parentItemId"> & {
  position: string;
  parentItemId: string | null;
  items: WireCardChecklistItem[];
};
// Realtime card create/update events use this compact form. Most card events carry repeated
// nullable fields, and the derived `url` is not used by socket consumers, so dropping defaults
// keeps the outbox and websocket frames smaller while clients restore the full object shape.
export type CompactWireCard = Pick<
  WireCard,
  "id" | "listId" | "boardId" | "title" | "position" | "createdById" | "createdAt" | "updatedAt"
> &
  Partial<Omit<WireCard, "id" | "listId" | "boardId" | "title" | "position" | "createdById" | "createdAt" | "updatedAt" | "url">>;

export function compactWireCard(card: WireCard | CompactWireCard): CompactWireCard {
  const out: CompactWireCard = {
    id: card.id,
    listId: card.listId,
    boardId: card.boardId,
    title: card.title,
    position: card.position,
    createdById: card.createdById,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
  if (card.description != null) out.description = card.description;
  if (card.dueDateLocalDate != null) out.dueDateLocalDate = card.dueDateLocalDate;
  if (card.dueDateSlot != null) out.dueDateSlot = card.dueDateSlot;
  if (card.dueDateTimezone != null) out.dueDateTimezone = card.dueDateTimezone;
  if (card.completedAt != null) out.completedAt = card.completedAt;
  if (card.archivedAt != null) out.archivedAt = card.archivedAt;
  if (card.coverAttachmentId != null) out.coverAttachmentId = card.coverAttachmentId;
  return out;
}

export function expandWireCard(card: CompactWireCard): WireCard {
  return {
    id: card.id,
    listId: card.listId,
    boardId: card.boardId,
    title: card.title,
    description: card.description ?? null,
    position: card.position,
    dueDateLocalDate: card.dueDateLocalDate ?? null,
    dueDateSlot: card.dueDateSlot ?? null,
    dueDateTimezone: card.dueDateTimezone ?? null,
    completedAt: card.completedAt ?? null,
    archivedAt: card.archivedAt ?? null,
    createdById: card.createdById,
    coverAttachmentId: card.coverAttachmentId ?? null,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}
export type WireCardSummary = Pick<
  WireCard,
  | "id"
  | "listId"
  | "boardId"
  | "title"
  | "position"
  | "dueDateLocalDate"
  | "dueDateSlot"
  | "dueDateTimezone"
  | "completedAt"
  | "archivedAt"
  | "coverAttachmentId"
  | "createdAt"
  | "updatedAt"
> & {
  hasDescription: boolean;
  commentCount: number;
  attachmentCount: number;
  checklistDoneCount: number;
  checklistTotalCount: number;
  coverUrl: string | null;
  labelIds: string[];
  assigneeIds: string[];
  customFieldValues: CardCustomFieldValue[];
};
// A single custom-field value carries one populated `value*` field and leaves the other six
// null. On a board with custom fields those nested nulls are the largest remaining slice of the
// open payload, so the wire form drops any null value field; the client restores them on decode.
export type CompactCardCustomFieldValue = Pick<CardCustomFieldValue, "cardId" | "fieldId" | "updatedAt"> &
  Partial<CardCustomFieldValue>;

export function compactCardCustomFieldValue(value: CardCustomFieldValue): CompactCardCustomFieldValue {
  const out: CompactCardCustomFieldValue = {
    cardId: value.cardId,
    fieldId: value.fieldId,
    updatedAt: value.updatedAt,
  };
  // Keep `false` (a meaningful checkbox value) and any populated field; drop only nulls.
  if (value.valueText !== null) out.valueText = value.valueText;
  if (value.valueNumber !== null) out.valueNumber = value.valueNumber;
  if (value.valueCheckbox !== null) out.valueCheckbox = value.valueCheckbox;
  if (value.valueDate !== null) out.valueDate = value.valueDate;
  if (value.valueUrl !== null) out.valueUrl = value.valueUrl;
  if (value.valueOptionIds !== null) out.valueOptionIds = value.valueOptionIds;
  if (value.valueUserIds !== null) out.valueUserIds = value.valueUserIds;
  return out;
}

export function expandCardCustomFieldValue(value: CompactCardCustomFieldValue): CardCustomFieldValue {
  return {
    cardId: value.cardId,
    fieldId: value.fieldId,
    updatedAt: value.updatedAt,
    valueText: value.valueText ?? null,
    valueNumber: value.valueNumber ?? null,
    valueCheckbox: value.valueCheckbox ?? null,
    valueDate: value.valueDate ?? null,
    valueUrl: value.valueUrl ?? null,
    valueOptionIds: value.valueOptionIds ?? null,
    valueUserIds: value.valueUserIds ?? null,
  };
}

// Wire-compacted form of a card summary: only fields that differ from their default are
// present. The board-open payload uses this to shrink large boards (3000+ cards) — repeated
// nulls, empty arrays, and zero counts dominate the raw JSON and its parse cost. Always-present
// identity/ordering fields stay required; everything else is optional and restored on decode.
export type CompactCardSummary = Pick<
  WireCardSummary,
  "id" | "listId" | "boardId" | "title" | "position" | "createdAt" | "updatedAt"
> &
  Partial<Omit<WireCardSummary, "customFieldValues">> & { customFieldValues?: CompactCardCustomFieldValue[] };

export function compactCardSummary(card: WireCardSummary): CompactCardSummary {
  const out: CompactCardSummary = {
    id: card.id,
    listId: card.listId,
    boardId: card.boardId,
    title: card.title,
    position: card.position,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
  if (card.dueDateLocalDate !== null) out.dueDateLocalDate = card.dueDateLocalDate;
  if (card.dueDateSlot !== null) out.dueDateSlot = card.dueDateSlot;
  if (card.dueDateTimezone !== null) out.dueDateTimezone = card.dueDateTimezone;
  if (card.completedAt !== null) out.completedAt = card.completedAt;
  if (card.archivedAt !== null) out.archivedAt = card.archivedAt;
  if (card.coverAttachmentId !== null) out.coverAttachmentId = card.coverAttachmentId;
  if (card.coverUrl !== null) out.coverUrl = card.coverUrl;
  if (card.hasDescription) out.hasDescription = true;
  if (card.commentCount) out.commentCount = card.commentCount;
  if (card.attachmentCount) out.attachmentCount = card.attachmentCount;
  if (card.checklistDoneCount) out.checklistDoneCount = card.checklistDoneCount;
  if (card.checklistTotalCount) out.checklistTotalCount = card.checklistTotalCount;
  if (card.labelIds.length) out.labelIds = card.labelIds;
  if (card.assigneeIds.length) out.assigneeIds = card.assigneeIds;
  if (card.customFieldValues.length) out.customFieldValues = card.customFieldValues.map(compactCardCustomFieldValue);
  return out;
}

export function expandCardSummary(card: CompactCardSummary): WireCardSummary {
  return {
    id: card.id,
    listId: card.listId,
    boardId: card.boardId,
    title: card.title,
    position: card.position,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    dueDateLocalDate: card.dueDateLocalDate ?? null,
    dueDateSlot: card.dueDateSlot ?? null,
    dueDateTimezone: card.dueDateTimezone ?? null,
    completedAt: card.completedAt ?? null,
    archivedAt: card.archivedAt ?? null,
    coverAttachmentId: card.coverAttachmentId ?? null,
    coverUrl: card.coverUrl ?? null,
    hasDescription: card.hasDescription ?? false,
    commentCount: card.commentCount ?? 0,
    attachmentCount: card.attachmentCount ?? 0,
    checklistDoneCount: card.checklistDoneCount ?? 0,
    checklistTotalCount: card.checklistTotalCount ?? 0,
    labelIds: card.labelIds ?? [],
    assigneeIds: card.assigneeIds ?? [],
    customFieldValues: (card.customFieldValues ?? []).map(expandCardCustomFieldValue),
  };
}

export interface WireCardDetail {
  card: WireCard;
  customFieldValues: CardCustomFieldValue[];
  labelIds: string[];
  assigneeIds: string[];
  attachments: CardAttachmentRow[];
  checklists: WireCardChecklist[];
  appliedChecklistTemplateIds: string[];
  linkedNotes: LinkedInternalSummary[];
}
export type WireComment = Omit<Comment, "searchVector"> & {
  authorName: string;
  authorAvatarUrl: string | null;
  reactions: CommentReactionSummary[];
  mirrorId?: string | null;
};
export type WireBoard = Omit<Board, "position"> & { position: string };
export type WireBoardGroup = Omit<BoardGroup, "position"> & { position: string };
export type WireStandaloneBoardGroup = StandaloneBoardGroup;
export type WireBoardMember = BoardMember;
export type WireWorkspace = Workspace;
export type WireWorkspaceMember = WorkspaceMember & {
  email?: string;
  displayName?: string;
  avatarUrl?: string | null;
  lastOnlineAt?: string | Date | null;
};
export type WireCustomFieldOption = Omit<CustomFieldOption, "position"> & { position: string };
// Select options travel embedded on the field; other field types carry an empty array.
export type WireCustomField = Omit<CustomField, "position"> & {
  position: string;
  options: WireCustomFieldOption[];
};
export type WireChecklistTemplateItem = Omit<ChecklistTemplateItem, "position"> & { position: string };
export type WireChecklistTemplate = Omit<ChecklistTemplate, "position"> & {
  position: string;
  items: WireChecklistTemplateItem[];
};
export type WireAutomationAction = Omit<AutomationAction, "position"> & { position: string };
export type WireAutomation = Omit<Automation, "position"> & {
  position: string;
  actions: WireAutomationAction[];
};
export type WireCustomFieldValue = CardCustomFieldValue;
export type WireCardLabel = Omit<CardLabel, "position"> & { position: string };
export type WireNote = Omit<Note, "position" | "searchVector"> & { position: string };
export interface WireNoteLock {
  noteId: string;
  editingUserId: string;
  editingUserName: string;
  editingUserAvatarUrl: string | null;
  editingExpiresAt: string;
}
export type WireCardAssignee = CardAssignee;
export interface WireBoardMemberUser {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  // Dual-scope: board:member events carry a board role (editor/observer), while the assigned-work
  // members roster carries a workspace role (admin/member). `source` disambiguates which applies.
  role: "admin" | "member" | "editor" | "observer";
  source: "board" | "workspace";
  // True when this is a workspace admin's pinned board row (non-removable/non-editable in the UI).
  pinned?: boolean;
  // Read-only visibility hint for member rosters. Roles still govern mutation rights.
  assignedItemsOnly?: boolean;
  clientId?: string;
}

export interface WireAssignedBoardSummary {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
}

export interface WireAssignedWorkTargetUser {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: "admin" | "member";
}

export interface WireAssignedWorkMemberStats {
  userId: string;
  overdueCards: number;
  // Overdue assigned checklist items are counted separately from cards so the UI can show
  // a distinct badge rather than conflating two entity types.
  overdueChecklistItems: number;
}

// A checklist item assigned to a user, surfaced as a first-class personal work item.
// Checklist items have no standalone route, so consumers deep-link to the parent card.
export interface WireChecklistAssignment {
  itemId: string;
  text: string;
  cardId: string;
  cardTitle: string;
  checklistId: string;
  // listId lets consumers resolve the card's list (icon/color/name) from their own list set.
  listId: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  assigneeId: string;
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

export interface WireAssignedWorkPayload {
  workspace: WireWorkspace;
  lists: WireList[];
  customFields: WireCustomField[];
  cardLabels: WireCardLabel[];
  members: WireBoardMemberUser[];
  memberStats: WireAssignedWorkMemberStats[];
  boards: WireAssignedBoardSummary[];
  cards: WireCardSummary[];
  separators?: WireSeparator[];
  checklistItems: WireChecklistAssignment[];
  targetUser: WireAssignedWorkTargetUser;
  viewerRole: "admin" | "member";
}

export interface ServerToClientEvents {
  "list:created": (payload: { workspaceId: string; list: WireList }) => void;
  "list:updated": (payload: { workspaceId: string; list: WireList }) => void;
  "list:moved": (payload: {
    workspaceId: string;
    listId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "list:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "list:deleted": (payload: { workspaceId: string; listId: string }) => void;

  "customField:created": (payload: { workspaceId: string; customField: WireCustomField }) => void;
  "customField:updated": (payload: { workspaceId: string; customField: WireCustomField }) => void;
  "customField:moved": (payload: {
    workspaceId: string;
    fieldId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "customField:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "customField:deleted": (payload: { workspaceId: string; fieldId: string }) => void;

  "customFieldOption:created": (payload: {
    workspaceId: string;
    fieldId: string;
    option: WireCustomFieldOption;
  }) => void;
  "customFieldOption:updated": (payload: {
    workspaceId: string;
    fieldId: string;
    option: WireCustomFieldOption;
  }) => void;
  "customFieldOption:moved": (payload: {
    workspaceId: string;
    fieldId: string;
    optionId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "customFieldOption:rebalanced": (payload: {
    workspaceId: string;
    fieldId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "customFieldOption:deleted": (payload: { workspaceId: string; fieldId: string; optionId: string }) => void;

  "checklistTemplate:created": (payload: { workspaceId: string; template: WireChecklistTemplate }) => void;
  "checklistTemplate:updated": (payload: { workspaceId: string; template: WireChecklistTemplate }) => void;
  "checklistTemplate:moved": (payload: {
    workspaceId: string;
    templateId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "checklistTemplate:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "checklistTemplate:deleted": (payload: { workspaceId: string; templateId: string }) => void;

  "automation:created": (payload: { workspaceId: string; automation: WireAutomation }) => void;
  "automation:updated": (payload: { workspaceId: string; automation: WireAutomation }) => void;
  "automation:moved": (payload: {
    workspaceId: string;
    automationId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "automation:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "automation:deleted": (payload: { workspaceId: string; automationId: string }) => void;

  "card:created": (payload: { boardId: string; card: CompactWireCard }) => void;
  "card:updated": (payload: { boardId: string; card: CompactWireCard }) => void;
  "card:moved": (payload: {
    boardId: string;
    cardId: string;
    fromListId: string;
    toListId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "card:rebalanced": (payload: {
    boardId: string;
    listId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "card:deleted": (payload: { boardId: string; cardId: string }) => void;
  "separator:created": (payload: { boardId: string; separator: WireSeparator }) => void;
  "separator:updated": (payload: { boardId: string; separator: WireSeparator }) => void;
  "separator:moved": (payload: {
    boardId: string;
    separatorId: string;
    fromListId: string;
    toListId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "separator:rebalanced": (payload: {
    boardId: string;
    listId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "separator:deleted": (payload: { boardId: string; separatorId: string }) => void;
  "assignedWorkSeparator:created": (payload: { workspaceId: string; targetUserId: string; separator: WireAssignedWorkSeparator }) => void;
  "assignedWorkSeparator:updated": (payload: { workspaceId: string; targetUserId: string; separator: WireAssignedWorkSeparator }) => void;
  "assignedWorkSeparator:moved": (payload: {
    workspaceId: string;
    targetUserId: string;
    separatorId: string;
    fromListId: string;
    toListId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "assignedWorkSeparator:deleted": (payload: { workspaceId: string; targetUserId: string; separatorId: string }) => void;
  "card:customFieldValue:set": (payload: {
    boardId: string;
    cardId: string;
    fieldId: string;
    valueText?: string | null;
    valueNumber?: string | null;
    valueCheckbox?: boolean | null;
    valueDate?: string | null;
    valueUrl?: string | null;
    valueOptionIds?: string[] | null;
    valueUserIds?: string[] | null;
  }) => void;
  "card:customFieldValue:cleared": (payload: { boardId: string; cardId: string; fieldId: string }) => void;
  "card:labels:set": (payload: { boardId: string; cardId: string; labelIds: string[] }) => void;
  "card:assignees:set": (payload: { boardId: string; cardId: string; assigneeIds: string[] }) => void;
  "card:visibility:granted": (payload: { boardId: string; cardId: string }) => void;
  "card:visibility:revoked": (payload: { boardId: string; cardId: string }) => void;
  "card:attachment:created": (payload: { boardId: string; cardId: string; attachment: CardAttachmentRow }) => void;
  "card:attachment:deleted": (payload: { boardId: string; cardId: string; attachmentId: string }) => void;
  "card:checklist:created": (payload: { boardId: string; cardId: string; checklist: WireCardChecklist }) => void;
  "card:checklist:updated": (payload: { boardId: string; cardId: string; checklist: WireCardChecklist }) => void;
  "card:checklist:moved": (payload: {
    boardId: string;
    cardId: string;
    checklistId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "card:checklist:rebalanced": (payload: {
    boardId: string;
    cardId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "card:checklist:deleted": (payload: { boardId: string; cardId: string; checklistId: string }) => void;
  // cardTitle/listId are included so assignee-centric consumers (assigned-work) can build a
  // checklist work item without an extra fetch; board + list display come from the consumer's
  // own board/list sets.
  // checklistParentItemId is the parentItemId of the *containing* checklist: null for a top-level
  // checklist, the owning item's id for a nested item-detail checklist. It lets a client whose card
  // detail isn't cached tell top-level items (which drive the card's checklist badge) from nested
  // sub-items without having to look the checklist up locally.
  "card:checklistItem:created": (payload: { boardId: string; cardId: string; cardTitle: string; listId: string; checklistId: string; checklistParentItemId: string | null; item: WireCardChecklistItem }) => void;
  "card:checklistItem:updated": (payload: { boardId: string; cardId: string; cardTitle: string; listId: string; checklistId: string; checklistParentItemId: string | null; item: WireCardChecklistItem; prevCompletedAt?: Date | string | null }) => void;
  "card:checklistItem:moved": (payload: {
    boardId: string;
    cardId: string;
    itemId: string;
    fromChecklistId: string;
    toChecklistId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "card:checklistItem:rebalanced": (payload: {
    boardId: string;
    cardId: string;
    checklistId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "card:checklistItem:deleted": (payload: { boardId: string; cardId: string; checklistId: string; checklistParentItemId: string | null; itemId: string; completedAt: Date | string | null }) => void;

  "cardLabel:created": (payload: { workspaceId: string; cardLabel: WireCardLabel }) => void;
  "cardLabel:updated": (payload: { workspaceId: string; cardLabel: WireCardLabel }) => void;
  "cardLabel:moved": (payload: {
    workspaceId: string;
    labelId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "cardLabel:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "cardLabel:deleted": (payload: { workspaceId: string; labelId: string }) => void;

  "comment:created": (payload: { boardId: string; cardId: string; comment: WireComment }) => void;
  "comment:updated": (payload: { boardId: string; cardId: string; comment: WireComment }) => void;
  "comment:deleted": (payload: { boardId: string; cardId: string; commentId: string }) => void;
  "comment:reaction:added": (payload: {
    boardId: string;
    cardId: string;
    commentId: string;
    type: ReactionType;
    user: ReactionUserSummary;
  }) => void;
  "comment:reaction:removed": (payload: {
    boardId: string;
    cardId: string;
    commentId: string;
    type: ReactionType;
    userId: string;
  }) => void;
  "card:feedItem:created": (payload: { boardId: string; cardId: string; item: CardFeedItem }) => void;
  "card:feedItem:updated": (payload: { boardId: string; cardId: string; item: CardFeedItem }) => void;
  "card:feedItem:deleted": (payload: { boardId: string; cardId: string; type: CardFeedItem["type"]; itemId: string }) => void;

  "board:created": (payload: { workspaceId: string; board: WireBoard }) => void;
  "board:updated": (payload: { board: WireBoard }) => void;
  "board:moved": (payload: {
    workspaceId: string;
    boardId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "board:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "board:deleted": (payload: { workspaceId: string; boardId: string }) => void;
  "boardGroup:created": (payload: { workspaceId: string; group: WireBoardGroup }) => void;
  "boardGroup:updated": (payload: { workspaceId: string; group: WireBoardGroup }) => void;
  "boardGroup:moved": (payload: {
    workspaceId: string;
    groupId: string;
    position: string;
    prevPosition: string;
  }) => void;
  "boardGroup:rebalanced": (payload: {
    workspaceId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "boardGroup:deleted": (payload: { workspaceId: string; groupId: string }) => void;
  "standaloneBoardGroup:upserted": (payload: { group: WireStandaloneBoardGroup }) => void;
  "standaloneBoardGroup:deleted": (payload: { clientId: string; groupId: string }) => void;
  "board:member:added": (payload: { boardId: string; member: WireBoardMember; user: WireBoardMemberUser }) => void;
  "board:member:updated": (payload: { boardId: string; member: WireBoardMember; user: WireBoardMemberUser }) => void;
  "board:member:removed": (payload: { boardId: string; userId: string }) => void;
  "boardMirror:created": (payload: { mirror: BoardMirrorRow }) => void;
  "boardMirror:updated": (payload: { mirror: BoardMirrorRow }) => void;
  "boardMirror:deleted": (payload: { mirrorId: string; sourceBoardId: string; targetBoardId: string }) => void;
  "cardMirror:linked": (payload: {
    mirrorId: string;
    sourceCardId: string;
    sourceBoardId: string;
    targetCardId: string;
    targetBoardId: string;
  }) => void;
  "cardMirror:unlinked": (payload: {
    mirrorId: string;
    sourceCardId: string;
    sourceBoardId: string;
    targetCardId: string;
    targetBoardId: string;
  }) => void;
  "client:updated": (payload: { clientId: string; name: string; logoUrl: string | null }) => void;
  "client:entitlements:changed": (payload: { clientId: string }) => void;
  "user:profile:updated": (payload: { userId: string; displayName: string; avatarUrl: string | null }) => void;

  "workspace:updated": (payload: { workspace: WireWorkspace }) => void;
  "workspace:deleted": (payload: { workspaceId: string }) => void;
  "workspace:member:added": (payload: { workspaceId: string; member: WireWorkspaceMember }) => void;
  "workspace:member:updated": (payload: { workspaceId: string; member: WireWorkspaceMember }) => void;
  "workspace:member:removed": (payload: { workspaceId: string; userId: string }) => void;

  "client:user:added": (payload: { user: WireOrgUser }) => void;
  "client:user:role-changed": (payload: { userId: string; role: ClientRole }) => void;
  "client:user:removed": (payload: { userId: string }) => void;
  "client:invite:created": (payload: WireInviteSummary) => void;
  "client:invite:revoked": (payload: { id: string }) => void;

  "note:created": (payload: { scope: NoteScope; note: WireNote }) => void;
  "note:updated": (payload: { note: WireNote }) => void;
  "note:moved": (payload: {
    noteId: string;
    parentNoteId: string | null;
    position: string;
    prevPosition: string;
  }) => void;
  "note:rebalanced": (payload: {
    scope: NoteScope;
    workspaceId: string;
    boardId: string | null;
    parentNoteId: string | null;
    ownerId: string;
    positions: { id: string; position: string }[];
  }) => void;
  "note:deleted": (payload: { noteId: string }) => void;
  "note:locked": (payload: WireNoteLock) => void;
  "note:unlocked": (payload: { noteId: string }) => void;
  "note:attachment:created": (payload: { note: WireNote; attachment: NoteAttachmentRow }) => void;
  "note:attachment:deleted": (payload: { note: WireNote; attachmentId: string }) => void;

  "notification:created": (payload: { notification: NotificationRow }) => void;
  "notification:updated": (payload: { notification: NotificationRow }) => void;
  "notification:deleted": (payload: { notificationIds: string[] }) => void;
  "notification:read": (payload: { notificationIds: string[]; readAt: string }) => void;
  "notification:unread": (payload: { notificationIds: string[] }) => void;
  "notification:allRead": (payload: { readAt: string }) => void;

  "presence:snapshot": (payload: { workspaceId: string; onlineUserIds: string[] }) => void;
  "presence:changed": (payload: { workspaceId: string; userId: string; online: boolean; lastOnlineAt?: string | Date | null }) => void;
}

export interface WireOrgUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: ClientRole;
  createdAt: Date | string;
}

export interface WireInviteSummary {
  id: string;
  clientId: string;
  email: string | null;
  orgRole: ClientRole;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  createdById: string;
  workspaces: { workspaceId: string; role: "admin" | "member" }[];
}

export interface ClientToServerEvents {
  "board:join": (boardId: string, ack: (ok: boolean) => void) => void;
  "board:leave": (boardId: string) => void;
  "workspace:join": (workspaceId: string, ack: (ok: boolean) => void) => void;
  "workspace:leave": (workspaceId: string) => void;
}

export type ServerEventName = keyof ServerToClientEvents;
export type ClientEventName = keyof ClientToServerEvents;

export const SERVER_EVENTS = {
  LIST_CREATED: "list:created",
  LIST_UPDATED: "list:updated",
  LIST_MOVED: "list:moved",
  LIST_REBALANCED: "list:rebalanced",
  LIST_DELETED: "list:deleted",
  CUSTOM_FIELD_CREATED: "customField:created",
  CUSTOM_FIELD_UPDATED: "customField:updated",
  CUSTOM_FIELD_MOVED: "customField:moved",
  CUSTOM_FIELD_REBALANCED: "customField:rebalanced",
  CUSTOM_FIELD_DELETED: "customField:deleted",
  CUSTOM_FIELD_OPTION_CREATED: "customFieldOption:created",
  CUSTOM_FIELD_OPTION_UPDATED: "customFieldOption:updated",
  CUSTOM_FIELD_OPTION_MOVED: "customFieldOption:moved",
  CUSTOM_FIELD_OPTION_REBALANCED: "customFieldOption:rebalanced",
  CUSTOM_FIELD_OPTION_DELETED: "customFieldOption:deleted",
  CHECKLIST_TEMPLATE_CREATED: "checklistTemplate:created",
  CHECKLIST_TEMPLATE_UPDATED: "checklistTemplate:updated",
  CHECKLIST_TEMPLATE_MOVED: "checklistTemplate:moved",
  CHECKLIST_TEMPLATE_REBALANCED: "checklistTemplate:rebalanced",
  CHECKLIST_TEMPLATE_DELETED: "checklistTemplate:deleted",
  AUTOMATION_CREATED: "automation:created",
  AUTOMATION_UPDATED: "automation:updated",
  AUTOMATION_MOVED: "automation:moved",
  AUTOMATION_REBALANCED: "automation:rebalanced",
  AUTOMATION_DELETED: "automation:deleted",
  CARD_CREATED: "card:created",
  CARD_UPDATED: "card:updated",
  CARD_MOVED: "card:moved",
  CARD_REBALANCED: "card:rebalanced",
  CARD_DELETED: "card:deleted",
  SEPARATOR_CREATED: "separator:created",
  SEPARATOR_UPDATED: "separator:updated",
  SEPARATOR_MOVED: "separator:moved",
  SEPARATOR_REBALANCED: "separator:rebalanced",
  SEPARATOR_DELETED: "separator:deleted",
  ASSIGNED_WORK_SEPARATOR_CREATED: "assignedWorkSeparator:created",
  ASSIGNED_WORK_SEPARATOR_UPDATED: "assignedWorkSeparator:updated",
  ASSIGNED_WORK_SEPARATOR_MOVED: "assignedWorkSeparator:moved",
  ASSIGNED_WORK_SEPARATOR_DELETED: "assignedWorkSeparator:deleted",
  CARD_CUSTOM_FIELD_VALUE_SET: "card:customFieldValue:set",
  CARD_CUSTOM_FIELD_VALUE_CLEARED: "card:customFieldValue:cleared",
  CARD_LABELS_SET: "card:labels:set",
  CARD_ASSIGNEES_SET: "card:assignees:set",
  CARD_VISIBILITY_GRANTED: "card:visibility:granted",
  CARD_VISIBILITY_REVOKED: "card:visibility:revoked",
  CARD_ATTACHMENT_CREATED: "card:attachment:created",
  CARD_ATTACHMENT_DELETED: "card:attachment:deleted",
  CARD_CHECKLIST_CREATED: "card:checklist:created",
  CARD_CHECKLIST_UPDATED: "card:checklist:updated",
  CARD_CHECKLIST_MOVED: "card:checklist:moved",
  CARD_CHECKLIST_REBALANCED: "card:checklist:rebalanced",
  CARD_CHECKLIST_DELETED: "card:checklist:deleted",
  CARD_CHECKLIST_ITEM_CREATED: "card:checklistItem:created",
  CARD_CHECKLIST_ITEM_UPDATED: "card:checklistItem:updated",
  CARD_CHECKLIST_ITEM_MOVED: "card:checklistItem:moved",
  CARD_CHECKLIST_ITEM_REBALANCED: "card:checklistItem:rebalanced",
  CARD_CHECKLIST_ITEM_DELETED: "card:checklistItem:deleted",
  CARD_LABEL_CREATED: "cardLabel:created",
  CARD_LABEL_UPDATED: "cardLabel:updated",
  CARD_LABEL_MOVED: "cardLabel:moved",
  CARD_LABEL_REBALANCED: "cardLabel:rebalanced",
  CARD_LABEL_DELETED: "cardLabel:deleted",
  COMMENT_CREATED: "comment:created",
  COMMENT_UPDATED: "comment:updated",
  COMMENT_DELETED: "comment:deleted",
  COMMENT_REACTION_ADDED: "comment:reaction:added",
  COMMENT_REACTION_REMOVED: "comment:reaction:removed",
  CARD_FEED_ITEM_CREATED: "card:feedItem:created",
  CARD_FEED_ITEM_UPDATED: "card:feedItem:updated",
  CARD_FEED_ITEM_DELETED: "card:feedItem:deleted",
  BOARD_CREATED: "board:created",
  BOARD_UPDATED: "board:updated",
  BOARD_MOVED: "board:moved",
  BOARD_REBALANCED: "board:rebalanced",
  BOARD_DELETED: "board:deleted",
  BOARD_GROUP_CREATED: "boardGroup:created",
  BOARD_GROUP_UPDATED: "boardGroup:updated",
  BOARD_GROUP_MOVED: "boardGroup:moved",
  BOARD_GROUP_REBALANCED: "boardGroup:rebalanced",
  BOARD_GROUP_DELETED: "boardGroup:deleted",
  STANDALONE_BOARD_GROUP_UPSERTED: "standaloneBoardGroup:upserted",
  STANDALONE_BOARD_GROUP_DELETED: "standaloneBoardGroup:deleted",
  BOARD_MEMBER_ADDED: "board:member:added",
  BOARD_MEMBER_UPDATED: "board:member:updated",
  BOARD_MEMBER_REMOVED: "board:member:removed",
  BOARD_MIRROR_CREATED: "boardMirror:created",
  BOARD_MIRROR_UPDATED: "boardMirror:updated",
  BOARD_MIRROR_DELETED: "boardMirror:deleted",
  CARD_MIRROR_LINKED: "cardMirror:linked",
  CARD_MIRROR_UNLINKED: "cardMirror:unlinked",
  CLIENT_UPDATED: "client:updated",
  CLIENT_ENTITLEMENTS_CHANGED: "client:entitlements:changed",
  USER_PROFILE_UPDATED: "user:profile:updated",
  WORKSPACE_UPDATED: "workspace:updated",
  WORKSPACE_DELETED: "workspace:deleted",
  WORKSPACE_MEMBER_ADDED: "workspace:member:added",
  WORKSPACE_MEMBER_UPDATED: "workspace:member:updated",
  WORKSPACE_MEMBER_REMOVED: "workspace:member:removed",
  CLIENT_USER_ADDED: "client:user:added",
  CLIENT_USER_ROLE_CHANGED: "client:user:role-changed",
  CLIENT_USER_REMOVED: "client:user:removed",
  CLIENT_INVITE_CREATED: "client:invite:created",
  CLIENT_INVITE_REVOKED: "client:invite:revoked",
  NOTE_CREATED: "note:created",
  NOTE_UPDATED: "note:updated",
  NOTE_MOVED: "note:moved",
  NOTE_REBALANCED: "note:rebalanced",
  NOTE_DELETED: "note:deleted",
  NOTE_LOCKED: "note:locked",
  NOTE_UNLOCKED: "note:unlocked",
  NOTE_ATTACHMENT_CREATED: "note:attachment:created",
  NOTE_ATTACHMENT_DELETED: "note:attachment:deleted",
  NOTIFICATION_CREATED: "notification:created",
  NOTIFICATION_UPDATED: "notification:updated",
  NOTIFICATION_DELETED: "notification:deleted",
  NOTIFICATION_READ: "notification:read",
  NOTIFICATION_UNREAD: "notification:unread",
  NOTIFICATION_ALL_READ: "notification:allRead",
  PRESENCE_SNAPSHOT: "presence:snapshot",
  PRESENCE_CHANGED: "presence:changed",
} as const satisfies Record<string, ServerEventName>;

export const CLIENT_EVENTS = {
  BOARD_JOIN: "board:join",
  BOARD_LEAVE: "board:leave",
  WORKSPACE_JOIN: "workspace:join",
  WORKSPACE_LEAVE: "workspace:leave",
} as const satisfies Record<string, ClientEventName>;
