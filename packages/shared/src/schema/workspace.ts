import { sql } from "drizzle-orm";
import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS } from "../lib/workspace-defaults.js";
import { clients } from "./client.js";

export const workspaceKind = pgEnum("workspace_kind", ["standard", "board"]);

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
    kind: workspaceKind("kind").notNull().default("standard"),
    icon: text("icon").default("rocket"),
    accentColor: text("accent_color"),
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
    index("workspaces_client_id_idx").on(t.clientId),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
