import { attachmentPreviewType, type AttachmentPreviewType } from "../attachment-preview";
import type { ImageLightboxItem } from "../../features/board/image-lightbox.component";
import type { ImageLightboxService } from "../../features/board/image-lightbox.service";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";

export interface LightboxAttachmentRow {
  id: string;
  url: string;
  fileName: string;
  mimeType: string;
  createdAt: string | Date;
}

export type LightboxAttachment = ImageLightboxItem & { id: string };

/**
 * Every attachment the shared lightbox can render, in attachment order, so gallery navigation can
 * cross images, playback media and documents without exposing download-only files in the sequence.
 */
export function toLightboxAttachments(attachments: readonly LightboxAttachmentRow[]): LightboxAttachment[] {
  return attachments.flatMap((attachment) => {
    const mediaType = attachmentPreviewType(attachment.mimeType, attachment.fileName);
    const src = visibleSignedMediaUrl(attachment.url);
    return src && mediaType ? [{
      id: attachment.id,
      src,
      fileName: attachment.fileName,
      createdAt: attachment.createdAt,
      mediaType,
      mimeType: attachment.mimeType,
    }] : [];
  });
}

/**
 * Opens `attachmentId` in the lightbox at its gallery position. Returns false when the attachment is
 * not renderable as `mediaType`, so the caller's template can fall back to a download link.
 */
export function openAttachmentPreview(
  lightbox: ImageLightboxService,
  attachments: readonly LightboxAttachment[],
  attachmentId: string,
  mediaType: AttachmentPreviewType,
  event?: Event,
): boolean {
  const initialIndex = attachments.findIndex((attachment) => attachment.id === attachmentId);
  const selected = attachments[initialIndex];
  if (!selected || selected.mediaType !== mediaType) return false;
  const { id: _id, ...item } = selected;
  lightbox.open({ ...item, images: attachments.map(({ id: _ignored, ...rest }) => rest), initialIndex }, event);
  return true;
}
