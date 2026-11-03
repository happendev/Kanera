import type { CardAttachmentRow } from "@kanera/shared/dto";
import { cardAttachments, users } from "@kanera/shared/schema";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db.js";
import {
  emitActivityFeedItem,
  emitActivityFeedItemDeleted,
  emitActivityFeedItemUpdated,
  type CoalescedActivityResult,
} from "../../lib/activity.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { attachmentRowColumns } from "../../lib/attachment-rows.js";
import { notFound } from "../../lib/errors.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";

/** Helpers shared by the card attachment use cases and routes. */

type AttachmentRowWithKeys = CardAttachmentRow & {
  fileKey: string;
  thumbnailFileKey: string | null;
  coverImageFileKey: string | null;
  coverImageUrl?: string | null;
  uploadedByClientId: string;
};

export const ATTACHMENT_MISTAKE_WINDOW_MS = 2 * 60 * 1000;

export async function emitCoalescedAttachmentActivity(boardId: string, cardId: string, result: CoalescedActivityResult) {
  // A quick add/remove is an abandoned attachment operation, so remove the original realtime row
  // (and its notification) instead of appending a contradictory removal row to the feed.
  if (result.status === "created") await emitActivityFeedItem(boardId, cardId, result.activity);
  else if (result.status === "updated") await emitActivityFeedItemUpdated(boardId, cardId, result.activity);
  else await emitActivityFeedItemDeleted(boardId, cardId, result.activity.id);
}

export async function selectAttachmentRow(attachmentId: string): Promise<AttachmentRowWithKeys> {
  const [row] = await db
    .select(attachmentRowColumns)
    .from(cardAttachments)
    .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
    .where(eq(cardAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw notFound();
  return row as AttachmentRowWithKeys;
}

/** Attachment rows of one card, newest first, shaped for the API response. */
export async function listCardAttachments(cardId: string) {
  const rows = await db
    .select(attachmentRowColumns)
    .from(cardAttachments)
    .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
    .where(eq(cardAttachments.cardId, cardId))
    .orderBy(desc(cardAttachments.createdAt));

  return rows.map(({ uploadedByClientId, uploadedByAvatarUrl, ...row }) => ({
    ...shapeAttachmentMedia(row),
    uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
  }));
}

export function attachmentResponse<T extends object>(attachment: T, exposeCoverMetadata: boolean): T {
  if (exposeCoverMetadata) return attachment;
  // The app API needs derivative metadata for stable card rendering and cheap drag previews, but
  // it is an internal implementation detail rather than part of the public attachment contract.
  const response = { ...attachment } as T & {
    coverImageWidth?: unknown;
    coverImageHeight?: unknown;
    coverImageColor?: unknown;
  };
  delete response.coverImageWidth;
  delete response.coverImageHeight;
  delete response.coverImageColor;
  return response;
}
