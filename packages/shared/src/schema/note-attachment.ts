import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { notes } from "./note.js";
import { users } from "./user.js";

export const NOTE_ATTACHMENT_SOURCES = ["description", "attachment"] as const;
export type NoteAttachmentSource = (typeof NOTE_ATTACHMENT_SOURCES)[number];

export const noteAttachments = pgTable(
  "note_attachment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    uploadedById: uuid("uploaded_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    fileKey: text("file_key").notNull(),
    url: text("url").notNull(),
    source: text("source").notNull().default("attachment").$type<NoteAttachmentSource>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("note_attachments_client_id_idx").on(t.clientId),
    index("note_attachments_note_id_created_at_idx").on(t.noteId, t.createdAt),
    index("note_attachments_uploaded_by_id_idx").on(t.uploadedById),
  ],
);

export type NoteAttachment = typeof noteAttachments.$inferSelect;
export type NewNoteAttachment = typeof noteAttachments.$inferInsert;
