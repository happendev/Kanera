import { cardAttachments, users } from "@kanera/shared/schema";

/**
 * The attachment row as every list/feed surface selects it (joined to the uploader). This is also the
 * shape of `card:attachment:*` realtime payloads, so adding a column here widens those events.
 */
export const attachmentRowBaseColumns = {
  id: cardAttachments.id,
  cardId: cardAttachments.cardId,
  fileName: cardAttachments.fileName,
  mimeType: cardAttachments.mimeType,
  byteSize: cardAttachments.byteSize,
  url: cardAttachments.url,
  fileKey: cardAttachments.fileKey,
  thumbnailUrl: cardAttachments.thumbnailUrl,
  thumbnailFileKey: cardAttachments.thumbnailFileKey,
  createdAt: cardAttachments.createdAt,
  uploadedById: cardAttachments.uploadedById,
  uploadedByName: users.displayName,
  uploadedByAvatarUrl: users.avatarUrl,
  uploadedByClientId: users.clientId,
  source: cardAttachments.source,
  commentId: cardAttachments.commentId,
} as const;

/** The base row plus the cover-image metadata only the attachment routes expose. */
export const attachmentRowColumns = {
  id: cardAttachments.id,
  cardId: cardAttachments.cardId,
  fileName: cardAttachments.fileName,
  mimeType: cardAttachments.mimeType,
  byteSize: cardAttachments.byteSize,
  url: cardAttachments.url,
  fileKey: cardAttachments.fileKey,
  thumbnailUrl: cardAttachments.thumbnailUrl,
  thumbnailFileKey: cardAttachments.thumbnailFileKey,
  coverImageUrl: cardAttachments.coverImageUrl,
  coverImageFileKey: cardAttachments.coverImageFileKey,
  coverImageWidth: cardAttachments.coverImageWidth,
  coverImageHeight: cardAttachments.coverImageHeight,
  coverImageColor: cardAttachments.coverImageColor,
  createdAt: cardAttachments.createdAt,
  uploadedById: cardAttachments.uploadedById,
  uploadedByName: users.displayName,
  uploadedByAvatarUrl: users.avatarUrl,
  uploadedByClientId: users.clientId,
  source: cardAttachments.source,
  commentId: cardAttachments.commentId,
} as const;
