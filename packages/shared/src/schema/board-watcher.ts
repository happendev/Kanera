import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { users } from "./user.js";

export const boardWatchers = pgTable(
  "board_watcher",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.userId] }),
    index("board_watchers_user_id_idx").on(t.userId),
  ],
);

export type BoardWatcher = typeof boardWatchers.$inferSelect;
export type NewBoardWatcher = typeof boardWatchers.$inferInsert;
