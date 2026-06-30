import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { comments } from "./comment.js";
import { users } from "./user.js";

export const commentReactions = pgTable(
  "comment_reaction",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reactionType: text("reaction_type").notNull().default("thumbs_up"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("comment_reactions_comment_user_type_uniq").on(t.commentId, t.userId, t.reactionType),
    index("comment_reactions_comment_idx").on(t.commentId),
  ],
);

export type CommentReaction = typeof commentReactions.$inferSelect;
export type NewCommentReaction = typeof commentReactions.$inferInsert;
