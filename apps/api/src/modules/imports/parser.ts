import type { TrelloImportManifest } from "@kanera/shared/dto";
import { trelloColorToToken, trelloCustomFieldTypeToKanera } from "./colors.js";
import type {
  NormalizedTrelloBoard,
  ParsedTrelloImport,
  TrelloAttachmentSource,
  TrelloCardSource,
  TrelloChecklistSource,
  TrelloCommentSource,
  TrelloCustomFieldItemSource,
  TrelloCustomFieldOptionSource,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function byPos<T extends { pos: number }>(a: T, b: T): number {
  return a.pos - b.pos;
}

function normalizeCustomFieldValue(value: unknown): unknown {
  const record = asRecord(value);
  return record.value ?? value;
}

export function parseTrelloExport(raw: unknown): ParsedTrelloImport {
  const board = asRecord(raw);
  const boardId = asString(board.id, "trello-board");
  const labels = asArray(board.labels).map((item) => {
    const label = asRecord(item);
    return {
      id: asString(label.id),
      name: asString(label.name, "Unnamed label"),
      color: asNullableString(label.color),
    };
  }).filter((label) => label.id);

  const members = asArray(board.members).map((item) => {
    const member = asRecord(item);
    return {
      id: asString(member.id),
      fullName: asString(member.fullName, asString(member.username, "Unknown member")),
      username: asNullableString(member.username),
      email: asNullableString(member.email),
    };
  }).filter((member) => member.id);

  const customFields = asArray(board.customFields).map((item) => {
    const field = asRecord(item);
    const type = asString(field.type, "text");
    const options: TrelloCustomFieldOptionSource[] = asArray(field.options).map((optionItem) => {
      const option = asRecord(optionItem);
      const value = asRecord(option.value);
      return {
        id: asString(option.id),
        label: asString(value.text, "Option"),
        color: trelloColorToToken(asNullableString(option.color)),
      };
    }).filter((option) => option.id);
    return {
      id: asString(field.id),
      name: asString(field.name, "Untitled field"),
      type,
      suggestedType: trelloCustomFieldTypeToKanera(type),
      options,
    };
  }).filter((field) => field.id);

  const checklists: TrelloChecklistSource[] = asArray(board.checklists).map((item) => {
    const checklist = asRecord(item);
    return {
      id: asString(checklist.id),
      name: asString(checklist.name, "Checklist"),
      pos: asNumber(checklist.pos),
      items: asArray(checklist.checkItems).map((checkItem) => {
        const row = asRecord(checkItem);
        return {
          id: asString(row.id),
          name: asString(row.name, "Checklist item"),
          pos: asNumber(row.pos),
          state: asString(row.state, "incomplete"),
          idMember: asNullableString(row.idMember),
          due: asNullableString(row.due),
        };
      }).filter((row) => row.id).sort(byPos),
    };
  }).filter((checklist) => checklist.id).sort(byPos);

  const comments: TrelloCommentSource[] = asArray(board.actions).filter((item) => asRecord(item).type === "commentCard").map((item) => {
    const action = asRecord(item);
    const data = asRecord(action.data);
    const card = asRecord(data.card);
    const memberCreator = asRecord(action.memberCreator);
    return {
      id: asString(action.id),
      cardId: asString(card.id),
      memberId: asNullableString(action.idMemberCreator),
      memberName: asNullableString(memberCreator.fullName),
      text: asString(data.text),
      date: asString(action.date),
    };
  }).filter((comment) => comment.id && comment.cardId && comment.text);

  const cards: TrelloCardSource[] = asArray(board.cards).map((item) => {
    const card = asRecord(item);
    const attachments: TrelloAttachmentSource[] = asArray(card.attachments).map((attachmentItem) => {
      const attachment = asRecord(attachmentItem);
      return {
        id: asString(attachment.id),
        name: asString(attachment.name, "Attachment"),
        url: asString(attachment.url),
        isUpload: asBoolean(attachment.isUpload),
        mimeType: asNullableString(attachment.mimeType),
        byteSize: typeof attachment.bytes === "number" ? attachment.bytes : null,
      };
    }).filter((attachment) => attachment.id && attachment.url);
    const customFieldItems: TrelloCustomFieldItemSource[] = asArray(card.customFieldItems).map((fieldItem) => {
      const row = asRecord(fieldItem);
      return {
        fieldId: asString(row.idCustomField),
        optionId: asNullableString(row.idValue),
        value: normalizeCustomFieldValue(row.value),
      };
    }).filter((row) => row.fieldId);
    return {
      id: asString(card.id),
      name: asString(card.name, "Untitled card"),
      desc: asNullableString(card.desc),
      listId: asString(card.idList),
      pos: asNumber(card.pos),
      closed: asBoolean(card.closed),
      due: asNullableString(card.due),
      dueComplete: asBoolean(card.dueComplete),
      labelIds: asArray(card.idLabels).map((id) => asString(id)).filter(Boolean),
      memberIds: asArray(card.idMembers).map((id) => asString(id)).filter(Boolean),
      checklistIds: asArray(card.idChecklists).map((id) => asString(id)).filter(Boolean),
      customFieldItems,
      attachments,
    };
  }).filter((card) => card.id && card.listId).sort(byPos);

  const lists = asArray(board.lists).map((item) => {
    const list = asRecord(item);
    const id = asString(list.id);
    return {
      id,
      name: asString(list.name, "Untitled list"),
      closed: asBoolean(list.closed),
      pos: asNumber(list.pos),
    };
  }).filter((list) => list.id).sort(byPos);

  const source: NormalizedTrelloBoard = {
    board: {
      id: boardId,
      name: asString(board.name, "Imported Trello board"),
      desc: asNullableString(board.desc),
    },
    lists,
    labels,
    customFields,
    members,
    cards,
    checklists,
    comments,
  };

  // Count cards per list in one pass; a `.filter` per list would be O(lists × cards) on big boards.
  const cardCountByList = new Map<string, number>();
  for (const card of source.cards) cardCountByList.set(card.listId, (cardCountByList.get(card.listId) ?? 0) + 1);

  const manifest: TrelloImportManifest = {
    board: { name: source.board.name, desc: source.board.desc },
    lists: source.lists.map((list) => ({
      id: list.id,
      name: list.name,
      closed: list.closed,
      cardCount: cardCountByList.get(list.id) ?? 0,
    })),
    labels: source.labels.map((label) => ({
      id: label.id,
      name: label.name,
      trelloColor: label.color,
      suggestedToken: trelloColorToToken(label.color),
    })),
    customFields: source.customFields.map((field) => ({
      id: field.id,
      name: field.name,
      trelloType: field.type,
      suggestedType: field.suggestedType,
      ...(field.options.length ? { options: field.options.map((option) => ({ id: option.id, label: option.label, color: option.color })) } : {}),
    })),
    members: source.members,
    counts: {
      cards: source.cards.length,
      checklists: source.checklists.length,
      comments: source.comments.length,
      linkAttachments: source.cards.reduce((sum, card) => sum + card.attachments.filter((a) => !a.isUpload).length, 0),
      uploadedAttachments: source.cards.reduce((sum, card) => sum + card.attachments.filter((a) => a.isUpload).length, 0),
    },
  };

  return { manifest, source };
}
