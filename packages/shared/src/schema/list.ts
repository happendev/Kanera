import { sql } from "drizzle-orm";
import { boolean, check, index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    // Marks the workspace's "work is actively happening" lists. Cards entering one start their
    // time-in-progress clock (`card.in_progress_since`, maintained by database triggers).
    inProgress: boolean("in_progress").notNull().default(false),
    // Work-in-progress limit for one board's column of this list: the most open cards a board should
    // hold in it at once. Advisory (moves are never blocked); null means no limit. Lists are shared by
    // every board in the workspace, and each board is its own team's flow, so the limit applies per
    // board rather than to the workspace-wide total.
    wipLimit: integer("wip_limit"),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("lists_color_ck", valueIn(t.color, COLOR_TOKENS)),
    check("lists_wip_limit_ck", sql`${t.wipLimit} is null or (${t.wipLimit} between 1 and 999)`),
    index("lists_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("lists_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type List = typeof lists.$inferSelect;
