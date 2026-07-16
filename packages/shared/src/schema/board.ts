import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { boardGroups } from "./board-group.js";
import { standaloneBoardGroups } from "./standalone-board-group.js";
import { workspaces } from "./workspace.js";

export const boards = pgTable(
  "board",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => boardGroups.id, { onDelete: "set null" }),
    // Only hidden one-board workspaces may use this organisation-level grouping field. Routes
    // validate both workspace kind and owning client because PostgreSQL cannot express that join.
    standaloneGroupId: uuid("standalone_group_id").references(() => standaloneBoardGroups.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").default("layout-kanban"),
    iconColor: text("icon_color"),
    backgroundGradient: text("background_gradient"),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("boards_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("boards_group_id_idx").on(t.groupId),
    index("boards_standalone_group_id_idx").on(t.standaloneGroupId),
    index("boards_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
