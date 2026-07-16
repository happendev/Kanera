import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { lists } from "./list.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const BOARD_MIRROR_FACETS = [
  "link",
  "core",
  "labels",
  "fields",
  "comments",
  "attachments",
  "checklists",
  "activities",
] as const;
export type BoardMirrorFacet = (typeof BOARD_MIRROR_FACETS)[number];

export const boardMirrors = pgTable(
  "board_mirror",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    sourceBoardId: uuid("source_board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    targetBoardId: uuid("target_board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    // Workspace ids are intentionally denormalized: worker scans and external-link writes need
    // their tenancy boundary without repeatedly joining through both boards.
    sourceWorkspaceId: uuid("source_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    targetWorkspaceId: uuid("target_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    // Source governance and target ownership are separate switches. Neither side may implicitly
    // undo the other's decision by toggling its own state.
    sourceDisabledAt: timestamp("source_disabled_at", { withTimezone: true }),
    sourceDisabledById: uuid("source_disabled_by_id")
      .references(() => users.id, { onDelete: "set null" }),
    cursorEventCreatedAt: timestamp("cursor_event_created_at", { withTimezone: true }).notNull(),
    cursorEventId: uuid("cursor_event_id").notNull(),
    reconcileRequestedAt: timestamp("reconcile_requested_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("board_mirrors_source_target_uq").on(t.sourceBoardId, t.targetBoardId),
    index("board_mirrors_active_source_idx")
      .on(t.sourceBoardId, t.nextRetryAt)
      .where(sql`${t.pausedAt} is null and ${t.sourceDisabledAt} is null`),
    check("board_mirrors_distinct_boards_check", sql`${t.sourceBoardId} <> ${t.targetBoardId}`),
  ],
);

export const boardMirrorLists = pgTable(
  "board_mirror_list",
  {
    mirrorId: uuid("mirror_id")
      .notNull()
      .references(() => boardMirrors.id, { onDelete: "cascade" }),
    sourceListId: uuid("source_list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    targetListId: uuid("target_list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.mirrorId, t.sourceListId] }),
    index("board_mirror_lists_target_list_idx").on(t.targetListId),
  ],
);

export const boardMirrorDirtyCards = pgTable(
  "board_mirror_dirty_card",
  {
    mirrorId: uuid("mirror_id")
      .notNull()
      .references(() => boardMirrors.id, { onDelete: "cascade" }),
    // Deliberately not a card FK: the tombstone must outlive a hard-deleted source card.
    sourceCardId: uuid("source_card_id").notNull(),
    facets: text("facets").array().notNull().$type<BoardMirrorFacet[]>(),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.mirrorId, t.sourceCardId] }),
    index("board_mirror_dirty_cards_ready_idx").on(t.nextRetryAt, t.updatedAt),
  ],
);

export type BoardMirror = typeof boardMirrors.$inferSelect;
export type NewBoardMirror = typeof boardMirrors.$inferInsert;
export type BoardMirrorList = typeof boardMirrorLists.$inferSelect;
export type NewBoardMirrorList = typeof boardMirrorLists.$inferInsert;
export type BoardMirrorDirtyCard = typeof boardMirrorDirtyCards.$inferSelect;
export type NewBoardMirrorDirtyCard = typeof boardMirrorDirtyCards.$inferInsert;
