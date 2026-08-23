import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { BOARD_ROLES } from "./member-roles.js";
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
    role: text("role", { enum: BOARD_ROLES }).notNull().default("editor"),
    // Orthogonal to role: restricted editors/observers may only access cards where they are a
    // card assignee or own at least one checklist item.
    assignedItemsOnly: boolean("assigned_items_only").notNull().default(false),
    // True for rows auto-materialized from workspace- or organisation-admin authority. Pinned rows
    // are non-removable and non-downgradable while that authority remains, and are cleaned up on
    // demotion. Explicit member grants are pinned = false. See board-membership.ts.
    pinned: boolean("pinned").notNull().default(false),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("board_members_role_ck", valueIn(t.role, BOARD_ROLES)),
    primaryKey({ columns: [t.boardId, t.userId] }),
    index("board_members_user_id_idx").on(t.userId),
    // Every board broadcast asks which of this board's members are restricted to assigned items.
    // The composite primary key leads on board_id, but the planner chose a full sequential scan for
    // this probe because assigned_items_only is false for almost every row. Partial, so the index
    // holds only the rare restricted members and stays tiny.
    index("board_members_assigned_items_only_idx")
      .on(t.boardId)
      .where(sql`${t.assignedItemsOnly}`),
  ],
);

export type BoardMember = typeof boardMembers.$inferSelect;
export type NewBoardMember = typeof boardMembers.$inferInsert;
