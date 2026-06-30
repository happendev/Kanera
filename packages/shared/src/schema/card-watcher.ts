import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { users } from "./user.js";

export const cardWatchers = pgTable(
  "card_watcher",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.userId] }),
    index("card_watchers_user_id_idx").on(t.userId),
  ],
);

export type CardWatcher = typeof cardWatchers.$inferSelect;
export type NewCardWatcher = typeof cardWatchers.$inferInsert;
