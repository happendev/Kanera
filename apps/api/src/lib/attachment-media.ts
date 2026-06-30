import { parseMediaReference, signMediaReference } from "./media-keys.js";

type AttachmentMediaRow = {
  url?: unknown;
  thumbnailUrl?: unknown;
  coverImageUrl?: unknown;
  fileName?: string | null;
};

export function signedAttachmentMediaUrl(storedUrl: unknown): string | null {
  if (typeof storedUrl !== "string" || storedUrl.length === 0) return null;

  const parsed = parseMediaReference(storedUrl);
  return parsed ? signMediaReference(storedUrl, parsed.clientId) : storedUrl;
}

export function shapeAttachmentMedia<T extends AttachmentMediaRow>(row: T): T {
  // Attachment quota/DB ownership belongs to the host org, but media may live in the uploader's
  // namespace for cross-org guest uploads, so always sign from the stored media URL.
  const shaped = {
    ...row,
    url: signedAttachmentMediaUrl(row.url),
    thumbnailUrl: signedAttachmentMediaUrl(row.thumbnailUrl),
    coverImageUrl: signedAttachmentMediaUrl(row.coverImageUrl),
  } as T;
  if (typeof shaped.url === "string" && row.fileName) shaped.url = withDownloadFileName(shaped.url, row.fileName);
  return shaped;
}

function withDownloadFileName(url: string, fileName: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("fn", fileName);
    return parsed.toString();
  } catch {
    return url;
  }
}
