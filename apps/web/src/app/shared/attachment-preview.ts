export type AttachmentPreviewType = "image" | "video" | "audio" | "pdf";

// This is the single previewability rule for every attachment surface in card detail. A format
// belongs here only when the shared lightbox can render its contents; everything else downloads.
export function attachmentPreviewType(mimeType: string): AttachmentPreviewType | null {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return null;
}
