import { randomUUID } from "node:crypto";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function safeExtension(ext: string): string {
  return safeSegment(ext.replace(/^\.+/, "").toLowerCase()) || "bin";
}

function optionalSafeExtension(ext: string | null | undefined): string {
  return ext ? safeExtension(ext) : "";
}

function withSuffixBeforeExtension(key: string, suffix: string, ext: string): string {
  const next = key.replace(/\.[^.]+$/, `_${suffix}.${ext}`);
  return next === key ? `${key}_${suffix}.${ext}` : next;
}

export function avatarStorageKey(userId: string, ext: string): string {
  return `avatars/${safeSegment(userId)}/${randomUUID()}.${safeExtension(ext)}`;
}

export function cardAttachmentStorageKey(cardId: string, ext: string | null | undefined): string {
  const safeExt = optionalSafeExtension(ext);
  return `cards/${safeSegment(cardId)}/${randomUUID()}${safeExt ? `.${safeExt}` : ""}`;
}

export function noteAttachmentStorageKey(noteId: string, ext: string): string {
  return `notes/${safeSegment(noteId)}/${randomUUID()}.${safeExtension(ext)}`;
}

export function attachmentThumbnailStorageKey(fileKey: string, ext = "jpg"): string {
  return withSuffixBeforeExtension(fileKey, "thumb", safeExtension(ext));
}

export function attachmentCoverStorageKey(fileKey: string, ext = "jpg"): string {
  return withSuffixBeforeExtension(fileKey, "cover", safeExtension(ext));
}

export function orgLogoStorageKey(ext: string): string {
  return `org/logo/${randomUUID()}.${safeExtension(ext)}`;
}

export function storageProbeKey(): string {
  return `system/storage-tests/${randomUUID()}.txt`;
}
