import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { users } from "./user.js";

export const cardAssignees = pgTable(
  "card_assignee",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.userId] }),
    // Global work starts from a user and walks to cards across many boards. Keeping card_id in the
    // index makes that lookup covering while the inverse direction remains covered by the PK.
    index("card_assignees_user_card_idx").on(t.userId, t.cardId),
  ],
);

export type CardAssignee = typeof cardAssignees.$inferSelect;
export type NewCardAssignee = typeof cardAssignees.$inferInsert;
