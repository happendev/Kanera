import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ColorToken } from "../lib/colors.js";
import { boards } from "./board.js";
import { lists } from "./list.js";
import { users } from "./user.js";

export const boardSeparators = pgTable(
  "board_separator",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    color: text("color").$type<ColorToken | null>(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("board_separators_board_list_position_idx").on(t.boardId, t.listId, t.position),
    index("board_separators_board_id_idx").on(t.boardId),
    index("board_separators_list_id_idx").on(t.listId),
  ],
);

export type BoardSeparator = typeof boardSeparators.$inferSelect;
export type NewBoardSeparator = typeof boardSeparators.$inferInsert;
