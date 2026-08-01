import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { COLOR_TOKENS, GRADIENT_TOKENS } from "../lib/colors.js";
import { valueIn } from "./_value-check.js";
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
    iconColor: text("icon_color", { enum: COLOR_TOKENS }),
    backgroundGradient: text("background_gradient", { enum: GRADIENT_TOKENS }),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("boards_icon_color_ck", valueIn(t.iconColor, COLOR_TOKENS)),
    check("boards_background_gradient_ck", valueIn(t.backgroundGradient, GRADIENT_TOKENS)),
    index("boards_workspace_id_position_idx").on(t.workspaceId, t.position),
    uniqueIndex("boards_workspace_id_id_key").on(t.workspaceId, t.id),
    index("boards_group_id_idx").on(t.groupId),
    index("boards_standalone_group_id_idx").on(t.standaloneGroupId),
    index("boards_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
