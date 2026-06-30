import { sql } from "drizzle-orm";
import { index, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { boardGroups } from "./board-group.js";
import { workspaces } from "./workspace.js";

export const boardVisibility = pgEnum("board_visibility", ["private", "workspace"]);

export const boards = pgTable(
  "board",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => boardGroups.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    iconColor: text("icon_color"),
    backgroundGradient: text("background_gradient"),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    visibility: boardVisibility("visibility").notNull().default("workspace"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("boards_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("boards_group_id_idx").on(t.groupId),
    index("boards_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
