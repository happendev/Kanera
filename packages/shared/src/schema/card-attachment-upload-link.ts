import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { ATTACHMENT_SOURCES, cardAttachments } from "./card-attachment.js";
import { cards } from "./card.js";
import { comments } from "./comment.js";
import { users } from "./user.js";

/**
 * A single-use, short-lived URL that accepts one raw file upload for a card. Agents run beside the
 * files they want to attach (screenshots, logs) but can only pass small base64 payloads through a
 * tool call, so they mint a link and `curl -T` the file to it instead.
 *
 * The link is a bearer capability, so only its hash is stored. `claims` snapshots the creating
 * credential's authorization context; the upload re-checks that credential is still live and
 * re-runs the card access check with it, so a link never outlives the authority that minted it.
 */
export const cardAttachmentUploadLinks = pgTable(
  "card_attachment_upload_link",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tokenHash: text("token_hash").notNull().unique(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    claims: jsonb("claims").notNull().$type<Record<string, unknown>>(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    source: text("source", { enum: ATTACHMENT_SOURCES }).notNull().default("attachment"),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    maxBytes: integer("max_bytes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attachmentId: uuid("attachment_id").references(() => cardAttachments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("card_attachment_upload_link_expires_idx").on(t.expiresAt),
    check("card_attachment_upload_link_source_ck", valueIn(t.source, ATTACHMENT_SOURCES)),
  ],
);

export type CardAttachmentUploadLink = typeof cardAttachmentUploadLinks.$inferSelect;
