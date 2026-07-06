import { boolean, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { boardRole } from "./member-roles.js";
import { users } from "./user.js";

export const boardMembers = pgTable(
  "board_member",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: boardRole("role").notNull().default("editor"),
    // Orthogonal to role: restricted editors/observers may only access cards where they are a
    // card assignee or own at least one checklist item.
    assignedItemsOnly: boolean("assigned_items_only").notNull().default(false),
    // True for rows auto-materialized because the user is a workspace admin. Pinned rows are
    // non-removable and non-downgradable while the user remains an admin, and are cleaned up on
    // demotion. Explicit member grants are pinned = false. See board-membership.ts.
    pinned: boolean("pinned").notNull().default(false),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.userId] }),
    index("board_members_user_id_idx").on(t.userId),
  ],
);

export type BoardMember = typeof boardMembers.$inferSelect;
export type NewBoardMember = typeof boardMembers.$inferInsert;
