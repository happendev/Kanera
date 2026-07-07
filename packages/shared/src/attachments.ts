export const ALLOWED_ATTACHMENT_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/json": "json",
  "message/rfc822": "eml",
  "text/plain": "txt",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "7z",
} as const;

export type AllowedAttachmentMime = keyof typeof ALLOWED_ATTACHMENT_MIME;

export const ALLOWED_ATTACHMENT_EXTENSIONS = Array.from(new Set(Object.values(ALLOWED_ATTACHMENT_MIME))).sort();

export function getAllowedAttachmentExtension(mimeType: string, fileName: string): string | null {
  const ext = (ALLOWED_ATTACHMENT_MIME as Record<string, string>)[mimeType];
  if (ext) return ext;

  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  if (!match) return null;

  const fileExt = match[1]!.toLowerCase();
  return (ALLOWED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(fileExt) ? fileExt : null;
}
