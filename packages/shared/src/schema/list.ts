import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { COLOR_TOKENS } from "../lib/colors.js";
import { valueIn } from "./_value-check.js";
import { workspaces } from "./workspace.js";

export const lists = pgTable(
  "list",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon").default("list"),
    color: text("color", { enum: COLOR_TOKENS }),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("lists_color_ck", valueIn(t.color, COLOR_TOKENS)),
    index("lists_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("lists_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
