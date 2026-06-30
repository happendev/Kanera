import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { comments } from "./comment.js";
import { users } from "./user.js";

export const MENTION_SOURCES = ["description", "comment"] as const;
export type MentionSource = (typeof MENTION_SOURCES)[number];

export const cardMentions = pgTable(
  "card_mention",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull().$type<MentionSource>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("card_mentions_card_id_idx").on(t.cardId),
    index("card_mentions_user_id_idx").on(t.userId),
    uniqueIndex("card_mentions_description_uniq")
      .on(t.cardId, t.userId, t.source)
      .where(sql`${t.commentId} is null`),
    uniqueIndex("card_mentions_comment_uniq")
      .on(t.cardId, t.commentId, t.userId, t.source)
      .where(sql`${t.commentId} is not null`),
  ],
);

export type CardMention = typeof cardMentions.$inferSelect;
export type NewCardMention = typeof cardMentions.$inferInsert;
