import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tsvector } from "./_tsvector.js";
import { cards } from "./card.js";
import { clients } from "./client.js";
import { users } from "./user.js";

export const ATTACHMENT_SOURCES = ["description", "attachment", "comment"] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export const cardAttachments = pgTable(
  "card_attachment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
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
    thumbnailUrl: text("thumbnail_url"),
    thumbnailFileKey: text("thumbnail_file_key"),
    coverImageUrl: text("cover_image_url"),
    coverImageFileKey: text("cover_image_file_key"),
    source: text("source").notNull().default("attachment").$type<AttachmentSource>(),
    commentId: uuid("comment_id"),
    // Full-text search vector over the attachment file name.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(file_name, ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("card_attachments_search_vector_idx").using("gin", t.searchVector),
    index("card_attachments_client_id_idx").on(t.clientId),
    index("card_attachments_card_id_created_at_idx").on(t.cardId, t.createdAt),
    // Attachment lists join back to the uploader (innerJoin users on uploaded_by_id);
    // without this the join falls back to a scan of the attachment table.
    index("card_attachments_uploaded_by_id_idx").on(t.uploadedById),
    index("card_attachments_comment_id_idx")
      .on(t.commentId)
      .where(sql`${t.commentId} is not null`),
  ],
);

export type CardAttachment = typeof cardAttachments.$inferSelect;
export type NewCardAttachment = typeof cardAttachments.$inferInsert;
