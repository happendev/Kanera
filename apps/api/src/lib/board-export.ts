import type { BoardExportArchive, BoardExportAttachment, BoardExportMember } from "@kanera/shared/dto";
import {
  boardMembers,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cardWatchers,
  cards,
  commentReactions,
  comments,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaceMembers,
} from "@kanera/shared/schema";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { notFound } from "./errors.js";
import { unsignedMediaUrl, withSignedMedia } from "./media-keys.js";

function withDownloadFileName(url: string, fileName: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("fn", fileName);
    return parsed.toString();
  } catch {
    return url;
  }
}

type ExportAttachmentRow = Pick<
  typeof cardAttachments.$inferSelect,
  | "id"
  | "cardId"
  | "uploadedById"
  | "fileName"
  | "mimeType"
  | "byteSize"
  | "fileKey"
  | "url"
  | "thumbnailUrl"
  | "thumbnailFileKey"
  | "coverImageUrl"
  | "coverImageFileKey"
  | "source"
  | "commentId"
  | "createdAt"
> & {
  uploadedByName: string;
  uploadedByAvatarUrl: string | null;
};

function signAttachment(clientId: string, row: ExportAttachmentRow): BoardExportAttachment {
  const signed = withSignedMedia(clientId, {
    url: unsignedMediaUrl(clientId, row.fileKey)!,
    thumbnailUrl: row.thumbnailFileKey ? unsignedMediaUrl(clientId, row.thumbnailFileKey) : row.thumbnailUrl,
    coverImageUrl: row.coverImageFileKey ? unsignedMediaUrl(clientId, row.coverImageFileKey) : row.coverImageUrl,
  });
  return {
    id: row.id,
    cardId: row.cardId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    url: withDownloadFileName(signed.url, row.fileName),
    thumbnailUrl: signed.thumbnailUrl ?? null,
    coverImageUrl: signed.coverImageUrl ?? null,
    source: row.source,
    commentId: row.commentId,
    createdAt: row.createdAt,
    uploadedById: row.uploadedById,
    uploadedByName: row.uploadedByName,
    uploadedByAvatarUrl: row.uploadedByAvatarUrl,
  };
}

function exportCard(row: typeof cards.$inferSelect): BoardExportArchive["cards"][number] {
  const { searchVector: _searchVector, ...card } = row;
  return card;
}

export async function buildBoardExportArchive(boardId: string, clientId: string): Promise<BoardExportArchive> {
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
  if (!board) throw notFound();

  const [
    workspaceLists,
    labels,
    fields,
    fieldOptions,
    boardCards,
    boardMemberRows,
    workspaceMemberRows,
  ] = await Promise.all([
    db.select().from(lists).where(eq(lists.workspaceId, board.workspaceId)).orderBy(asc(lists.position)),
    db.select().from(cardLabels).where(eq(cardLabels.workspaceId, board.workspaceId)).orderBy(asc(cardLabels.position)),
    db.select().from(customFields).where(eq(customFields.workspaceId, board.workspaceId)).orderBy(asc(customFields.position)),
    db
      .select()
      .from(customFieldOptions)
      .innerJoin(customFields, eq(customFields.id, customFieldOptions.fieldId))
      .where(eq(customFields.workspaceId, board.workspaceId))
      .orderBy(asc(customFieldOptions.position)),
    db.select().from(cards).where(eq(cards.boardId, boardId)).orderBy(asc(cards.listId), asc(cards.position)),
    db
      .select({
        userId: boardMembers.userId,
        role: boardMembers.role,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(eq(boardMembers.boardId, boardId)),
    db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        addedAt: workspaceMembers.addedAt,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, board.workspaceId)),
  ]);

  const fieldOptionsByField = new Map<string, (typeof customFieldOptions.$inferSelect)[]>();
  for (const row of fieldOptions) {
    const options = fieldOptionsByField.get(row.custom_field_option.fieldId);
    if (options) options.push(row.custom_field_option);
    else fieldOptionsByField.set(row.custom_field_option.fieldId, [row.custom_field_option]);
  }
  const customFieldsWithOptions = fields.map((field) => ({ ...field, options: fieldOptionsByField.get(field.id) ?? [] }));

  const boardRolesByUserId = new Map(boardMemberRows.map((member) => [member.userId, member.role]));
  const memberMap = new Map<string, BoardExportMember>();
  for (const member of workspaceMemberRows) {
    memberMap.set(member.userId, {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      addedAt: member.addedAt,
      displayName: member.displayName,
      email: member.email,
      avatarUrl: member.avatarUrl,
      source: "workspace",
      boardRole: boardRolesByUserId.get(member.userId) ?? null,
    });
  }
  for (const member of boardMemberRows) {
    if (!memberMap.has(member.userId)) {
      memberMap.set(member.userId, {
        workspaceId: board.workspaceId,
        userId: member.userId,
        // Board-only members (guests) have no workspace role; their role is on boardRole.
        role: null,
        addedAt: board.createdAt,
        displayName: member.displayName,
        email: member.email,
        avatarUrl: member.avatarUrl,
        source: "board",
        boardRole: member.role,
      });
    }
  }

  const cardIds = boardCards.map((card) => card.id);
  if (cardIds.length === 0) {
    return {
      format: "kanera.board.export",
      version: 1,
      exportedAt: new Date().toISOString(),
      board,
      lists: workspaceLists,
      labels,
      customFields: customFieldsWithOptions,
      members: Array.from(memberMap.values()),
      cards: [],
      cardAssignees: [],
      cardLabelAssignments: [],
      cardCustomFieldValues: [],
      checklists: [],
      comments: [],
      commentReactions: [],
      cardWatchers: [],
      attachments: [],
    };
  }

  const [
    assignees,
    labelAssignments,
    fieldValues,
    checklistRows,
    checklistItemRows,
    commentRows,
    watcherRows,
    attachmentRows,
  ] = await Promise.all([
    db.select().from(cardAssignees).where(inArray(cardAssignees.cardId, cardIds)),
    db.select().from(cardLabelAssignments).where(inArray(cardLabelAssignments.cardId, cardIds)),
    db.select().from(cardCustomFieldValues).where(inArray(cardCustomFieldValues.cardId, cardIds)),
    db.select().from(cardChecklists).where(inArray(cardChecklists.cardId, cardIds)).orderBy(asc(cardChecklists.position)),
    db
      .select({
        item: cardChecklistItems,
        checklistId: cardChecklistItems.checklistId,
      })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .where(inArray(cardChecklists.cardId, cardIds))
      .orderBy(asc(cardChecklists.position), asc(cardChecklistItems.position)),
    db
      .select({
        id: comments.id,
        cardId: comments.cardId,
        authorId: comments.authorId,
        authorKind: comments.authorKind,
        apiKeyId: comments.apiKeyId,
        apiKeyName: comments.apiKeyName,
        authorName: sql<string>`case when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
        authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} = 'apiKey' then null else ${users.avatarUrl} end`,
        body: comments.body,
        editedAt: comments.editedAt,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(inArray(comments.cardId, cardIds))
      .orderBy(asc(comments.cardId), asc(comments.createdAt)),
    db.select().from(cardWatchers).where(inArray(cardWatchers.cardId, cardIds)),
    db
      .select({
        id: cardAttachments.id,
        cardId: cardAttachments.cardId,
        uploadedById: cardAttachments.uploadedById,
        fileName: cardAttachments.fileName,
        mimeType: cardAttachments.mimeType,
        byteSize: cardAttachments.byteSize,
        fileKey: cardAttachments.fileKey,
        url: cardAttachments.url,
        thumbnailUrl: cardAttachments.thumbnailUrl,
        thumbnailFileKey: cardAttachments.thumbnailFileKey,
        coverImageUrl: cardAttachments.coverImageUrl,
        coverImageFileKey: cardAttachments.coverImageFileKey,
        source: cardAttachments.source,
        commentId: cardAttachments.commentId,
        createdAt: cardAttachments.createdAt,
        uploadedByName: users.displayName,
        uploadedByAvatarUrl: users.avatarUrl,
      })
      .from(cardAttachments)
      .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
      .where(inArray(cardAttachments.cardId, cardIds))
      .orderBy(desc(cardAttachments.createdAt)),
  ]);

  const commentIds = commentRows.map((comment) => comment.id);
  const reactions = commentIds.length
    ? await db.select().from(commentReactions).where(inArray(commentReactions.commentId, commentIds))
    : [];
  const itemsByChecklist = new Map<string, (typeof cardChecklistItems.$inferSelect)[]>();
  for (const row of checklistItemRows) {
    const items = itemsByChecklist.get(row.checklistId);
    if (items) items.push(row.item);
    else itemsByChecklist.set(row.checklistId, [row.item]);
  }

  return {
    format: "kanera.board.export",
    version: 1,
    exportedAt: new Date().toISOString(),
    board,
    lists: workspaceLists,
    labels,
    customFields: customFieldsWithOptions,
    members: Array.from(memberMap.values()),
    cards: boardCards.map(exportCard),
    cardAssignees: assignees,
    cardLabelAssignments: labelAssignments,
    cardCustomFieldValues: fieldValues,
    checklists: checklistRows.map((checklist) => ({ ...checklist, items: itemsByChecklist.get(checklist.id) ?? [] })),
    comments: commentRows,
    commentReactions: reactions,
    cardWatchers: watcherRows,
    attachments: attachmentRows.map((row) => signAttachment(clientId, row)),
  };
}
