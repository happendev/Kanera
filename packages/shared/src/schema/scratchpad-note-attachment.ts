import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { scratchpadNotes } from "./scratchpad-note.js";

/**
 * Files embedded in a scratchpad page (pasted screenshots, dropped images).
 *
 * Mirrors `note_attachment` minus two columns that cannot exist here:
 * - no `source`: there is no attachment *list* UI on a scratchpad page, so every row is a body embed.
 * - no `uploaded_by_id`: the uploader is always the page's owner, so the column would be redundant —
 *   and `note_attachment.uploaded_by_id` is `on delete restrict`, which would fight the owner-cascade
 *   this table depends on (deleting a user must take their scratchpad and its files with it).
 */
export const scratchpadNoteAttachments = pgTable(
  "scratchpad_note_attachment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    scratchpadNoteId: uuid("scratchpad_note_id")
      .notNull()
      .references(() => scratchpadNotes.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    fileKey: text("file_key").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Storage-quota sums group by client_id; every attachment table needs this index for that scan.
    index("scratchpad_note_attachments_client_id_idx").on(t.clientId),
    index("scratchpad_note_attachments_note_id_idx").on(t.scratchpadNoteId),
  ],
);

export type ScratchpadNoteAttachment = typeof scratchpadNoteAttachments.$inferSelect;
export type NewScratchpadNoteAttachment = typeof scratchpadNoteAttachments.$inferInsert;
