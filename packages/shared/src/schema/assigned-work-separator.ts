import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ColorToken } from "../lib/colors.js";
import { lists } from "./list.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const assignedWorkSeparators = pgTable(
  "assigned_work_separator",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    index("assigned_work_separators_target_list_position_idx").on(t.workspaceId, t.targetUserId, t.listId, t.position),
    index("assigned_work_separators_target_user_idx").on(t.targetUserId),
    // list_id is not a leading column of the lane index, so list deletion needs its own
    // reverse-FK lookup for the cascade.
    index("assigned_work_separators_list_id_idx").on(t.listId),
  ],
);

export type AssignedWorkSeparator = typeof assignedWorkSeparators.$inferSelect;
export type NewAssignedWorkSeparator = typeof assignedWorkSeparators.$inferInsert;
