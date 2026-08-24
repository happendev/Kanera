import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { COLOR_TOKENS } from "../lib/colors.js";
import { DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS, DEFAULT_INACTIVE_CARDS_DAYS } from "../lib/workspace-defaults.js";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";

export const WORKSPACE_KINDS = ["standard", "board"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const CARD_KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export const workspaces = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The empty defaults are consumed by the database insert trigger for internal/test tooling that
    // inserts workspaces directly. Product creation routes reserve an explicit prefix first.
    cardKeyPrefix: text("card_key_prefix").notNull().default(""),
    // Allocation is intentionally internal: API workspace shapes omit this monotonically increasing
    // counter while the database locks the row to hand out contiguous ranges.
    lastCardNumber: integer("last_card_number").notNull().default(0),
    // kind='board' is a hidden one-board workspace presented as a standalone board. The one-board
    // invariant is enforced in routes because a boards constraint cannot reference workspace.kind;
    // kind stays flippable so a future conversion can expose the workspace without restructuring it.
    kind: text("kind", { enum: WORKSPACE_KINDS }).notNull().default("standard"),
    icon: text("icon").default("rocket"),
    accentColor: text("accent_color", { enum: COLOR_TOKENS }),
    completedCardsActiveDays: integer("completed_cards_active_days").notNull().default(DEFAULT_COMPLETED_CARDS_ACTIVE_DAYS),
    inactiveCardsDays: integer("inactive_cards_days").notNull().default(DEFAULT_INACTIVE_CARDS_DAYS),
    boardHealthEnabled: boolean("board_health_enabled").notNull().default(true),
    boardHealthOverdueEnabled: boolean("board_health_overdue_enabled").notNull().default(true),
    boardHealthUnassignedEnabled: boolean("board_health_unassigned_enabled").notNull().default(true),
    boardHealthInactiveEnabled: boolean("board_health_inactive_enabled").notNull().default(true),
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
    check("workspaces_card_key_prefix_ck", sql`${t.cardKeyPrefix} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check("workspaces_last_card_number_ck", sql`${t.lastCardNumber} >= 0`),
    check("workspaces_accent_color_ck", valueIn(t.accentColor, COLOR_TOKENS)),
    // Human prefixes only compete with workspaces in the same organisation. The organisation's
    // opaque route key supplies the globally unambiguous part of a copied card URL.
    uniqueIndex("workspaces_client_id_card_key_prefix_key").on(t.clientId, t.cardKeyPrefix),
    index("workspaces_client_id_idx").on(t.clientId),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
