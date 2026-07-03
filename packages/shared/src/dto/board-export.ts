import type {
  Board,
  Card,
  CardAssignee,
  CardAttachment,
  CardChecklist,
  CardChecklistItem,
  CardCustomFieldValue,
  CardLabel,
  CardLabelAssignment,
  CardWatcher,
  Comment,
  CommentReaction,
  CustomField,
  CustomFieldOption,
  BoardRole,
  List,
  WorkspaceMember,
} from "../schema/index.js";

export type BoardExportCard = Omit<Card, "searchVector">;
export type BoardExportComment = Omit<Comment, "searchVector"> & {
  authorName: string;
  authorAvatarUrl: string | null;
};
export type BoardExportAttachment = Pick<
  CardAttachment,
  | "id"
  | "cardId"
  | "fileName"
  | "mimeType"
  | "byteSize"
  | "url"
  | "thumbnailUrl"
  | "coverImageUrl"
  | "source"
  | "commentId"
  | "createdAt"
  | "uploadedById"
> & {
  uploadedByName: string;
  uploadedByAvatarUrl: string | null;
};
export type BoardExportChecklist = Omit<CardChecklist, "position"> & {
  position: string;
  items: (Omit<CardChecklistItem, "position"> & { position: string })[];
};
export type BoardExportMember = Pick<WorkspaceMember, "workspaceId" | "userId" | "addedAt"> & {
  // Workspace role for workspace members; null for board-only members (cross-org guests), whose
  // meaningful role is carried on boardRole instead.
  role: WorkspaceMember["role"] | null;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  source: "workspace" | "board";
  boardRole: BoardRole | null;
};
export type BoardExportCustomField = Omit<CustomField, "position"> & {
  position: string;
  options: (Omit<CustomFieldOption, "position"> & { position: string })[];
};

export interface BoardExportArchive {
  format: "kanera.board.export";
  version: 1;
  exportedAt: string;
  board: Board;
  lists: List[];
  labels: CardLabel[];
  customFields: BoardExportCustomField[];
  members: BoardExportMember[];
  cards: BoardExportCard[];
  cardAssignees: CardAssignee[];
  cardLabelAssignments: CardLabelAssignment[];
  cardCustomFieldValues: CardCustomFieldValue[];
  checklists: BoardExportChecklist[];
  comments: BoardExportComment[];
  commentReactions: CommentReaction[];
  cardWatchers: CardWatcher[];
  attachments: BoardExportAttachment[];
}
