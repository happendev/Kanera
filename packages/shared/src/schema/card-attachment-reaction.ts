import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { cardAttachments } from "./card-attachment.js";
import { COMMENT_REACTION_TYPES } from "./comment-reaction.js";
import { users } from "./user.js";

// Attachments share the comment reaction vocabulary so one picker and one summary shape serve both.
export const cardAttachmentReactions = pgTable(
  "card_attachment_reaction",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => cardAttachments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reactionType: text("reaction_type", { enum: COMMENT_REACTION_TYPES }).notNull().default("thumbs_up"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("card_attachment_reactions_type_ck", valueIn(t.reactionType, COMMENT_REACTION_TYPES)),
    uniqueIndex("card_attachment_reactions_attachment_user_type_uniq").on(t.attachmentId, t.userId, t.reactionType),
    index("card_attachment_reactions_attachment_idx").on(t.attachmentId),
  ],
);

export type CardAttachmentReaction = typeof cardAttachmentReactions.$inferSelect;
