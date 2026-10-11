import { z } from "zod";
import { ATTACHMENT_SOURCES as SOURCES } from "../schema/card-attachment.js";
import type { AttachmentSource, CardAttachment } from "../schema/card-attachment.js";

export { ATTACHMENT_SOURCES } from "../schema/card-attachment.js";
export type { AttachmentSource } from "../schema/card-attachment.js";

export type CardAttachmentRow = Pick<
  CardAttachment,
  "id" | "cardId" | "fileName" | "mimeType" | "byteSize" | "url" | "thumbnailUrl" | "createdAt" | "uploadedById"
> & {
  // Optional keeps older/offline attachment payloads compatible while internal app responses
  // carry derivative metadata for an immediately-selected cover.
  coverImageWidth?: number | null;
  coverImageHeight?: number | null;
  coverImageColor?: string | null;
  uploadedByName: string;
  uploadedByAvatarUrl: string | null;
  source: AttachmentSource;
  commentId: string | null;
};

/**
 * Mint a single-use upload URL for one file. mimeType defaults to the type implied by fileName's
 * extension; the uploaded bytes are stored under this name and type whatever the PUT's headers say.
 */
export const createAttachmentUploadLinkBody = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255).optional(),
  source: z.enum(SOURCES).default("attachment"),
  commentId: z.uuid().nullable().optional(),
});
export type CreateAttachmentUploadLinkBody = z.infer<typeof createAttachmentUploadLinkBody>;
