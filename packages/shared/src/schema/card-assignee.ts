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
    index("card_assignees_user_id_idx").on(t.userId),
  ],
);

export type CardAssignee = typeof cardAssignees.$inferSelect;
export type NewCardAssignee = typeof cardAssignees.$inferInsert;
