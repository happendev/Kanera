import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { COLOR_TOKENS } from "../lib/colors.js";
import { DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS } from "../lib/workspace-defaults.js";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";

export const WORKSPACE_KINDS = ["standard", "board"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const workspaces = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // kind='board' is a hidden one-board workspace presented as a standalone board. The one-board
    // invariant is enforced in routes because a boards constraint cannot reference workspace.kind;
    // kind stays flippable so a future conversion can expose the workspace without restructuring it.
    kind: text("kind", { enum: WORKSPACE_KINDS }).notNull().default("standard"),
    icon: text("icon").default("rocket"),
    accentColor: text("accent_color", { enum: COLOR_TOKENS }),
    completedCardsActiveDays: integer("completed_cards_active_days").notNull().default(DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS),
    // Board linking is configured on the workspace so standard workspaces and the hidden workspace
    // behind a standalone board follow the same governance and cleanup path.
    boardLinkingEnabled: boolean("board_linking_enabled").notNull().default(true),
    // Set when a downgrade-to-free archives a workspace beyond the free cap (mirrors boards.archivedAt).
    // Archived workspaces are hidden from listings and excluded from plan-limit counts.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workspaces_kind_ck", valueIn(t.kind, WORKSPACE_KINDS)),
    check("workspaces_accent_color_ck", valueIn(t.accentColor, COLOR_TOKENS)),
    index("workspaces_client_id_idx").on(t.clientId),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
