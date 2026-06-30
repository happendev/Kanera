import type { NoteAttachment, NoteAttachmentSource } from "../schema/note-attachment.js";

export { NOTE_ATTACHMENT_SOURCES } from "../schema/note-attachment.js";
export type { NoteAttachmentSource } from "../schema/note-attachment.js";

export type NoteAttachmentRow = Pick<
  NoteAttachment,
  "id" | "noteId" | "fileName" | "mimeType" | "byteSize" | "url" | "createdAt" | "uploadedById"
> & {
  uploadedByName: string;
  uploadedByAvatarUrl: string | null;
  source: NoteAttachmentSource;
};
