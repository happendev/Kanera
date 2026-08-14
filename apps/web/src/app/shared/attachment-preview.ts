export type AttachmentPreviewType = "image" | "video" | "audio" | "pdf" | "markdown";

// This is the single previewability rule for attachment surfaces. A format belongs here only when
// the shared lightbox can render its contents; everything else downloads.
export function attachmentPreviewType(mimeType: string, fileName = ""): AttachmentPreviewType | null {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  // Some browsers and import sources report Markdown as plain text or octet-stream, so retain the
  // filename check as part of the durable preview rule instead of relying on upload MIME metadata.
  if (mime === "text/markdown" || mime === "text/x-markdown" || /\.(?:md|markdown)$/i.test(fileName)) return "markdown";
  return null;
}
