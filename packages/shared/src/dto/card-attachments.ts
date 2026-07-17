import type { AttachmentSource, CardAttachment } from "../schema/card-attachment.js";

export { ALLOWED_ATTACHMENT_MIME } from "../attachments.js";
export type { AllowedAttachmentMime } from "../attachments.js";
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
