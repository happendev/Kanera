import type { ColorToken } from "@kanera/shared/colors";
import type { BoardExportArchive, KaneraBoardImportManifest, TrelloImportManifest } from "@kanera/shared/dto";
import type { CustomFieldTypeName } from "@kanera/shared/dto";

export interface TrelloListSource {
  id: string;
  name: string;
  closed: boolean;
  pos: number;
}

export interface TrelloLabelSource {
  id: string;
  name: string;
  color: string | null;
}

export interface TrelloCustomFieldOptionSource {
  id: string;
  label: string;
  color: ColorToken | null;
}

export interface TrelloCustomFieldSource {
  id: string;
  name: string;
  type: string;
  suggestedType: CustomFieldTypeName;
  options: TrelloCustomFieldOptionSource[];
}

export interface TrelloMemberSource {
  id: string;
  fullName: string;
  username: string | null;
  email?: string | null;
}

export interface TrelloAttachmentSource {
  id: string;
  name: string;
  url: string;
  isUpload: boolean;
  mimeType: string | null;
  byteSize: number | null;
}

export interface TrelloCustomFieldItemSource {
  fieldId: string;
  optionId: string | null;
  value: unknown;
}

export interface TrelloChecklistItemSource {
  id: string;
  name: string;
  pos: number;
  state: string;
  idMember?: string | null;
  due?: string | null;
}

export interface TrelloChecklistSource {
  id: string;
  name: string;
  pos: number;
  items: TrelloChecklistItemSource[];
}

export interface TrelloCommentSource {
  id: string;
  cardId: string;
  memberId: string | null;
  memberName: string | null;
  text: string;
  date: string;
}

export interface TrelloCardSource {
  id: string;
  name: string;
  desc: string | null;
  listId: string;
  pos: number;
  closed: boolean;
  due: string | null;
  dueComplete: boolean;
  labelIds: string[];
  memberIds: string[];
  checklistIds: string[];
  customFieldItems: TrelloCustomFieldItemSource[];
  attachments: TrelloAttachmentSource[];
  coverAttachmentId?: string | null;
}

export interface NormalizedTrelloBoard {
  board: { id: string; name: string; desc: string | null };
  lists: TrelloListSource[];
  labels: TrelloLabelSource[];
  customFields: TrelloCustomFieldSource[];
  members: TrelloMemberSource[];
  cards: TrelloCardSource[];
  checklists: TrelloChecklistSource[];
  comments: TrelloCommentSource[];
}

export interface ParsedTrelloImport {
  manifest: TrelloImportManifest;
  source: NormalizedTrelloBoard;
}

export interface ParsedKaneraBoardImport {
  manifest: KaneraBoardImportManifest;
  source: BoardExportArchive;
}
