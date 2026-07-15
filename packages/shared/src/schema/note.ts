import { sql } from "drizzle-orm";
import { foreignKey, index, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ColorToken } from "../lib/colors.js";
import { tsvector } from "./_tsvector.js";
import { boards } from "./board.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const noteScope = pgEnum("note_scope", ["personal", "team"]);
export type NoteScope = (typeof noteScope.enumValues)[number];

export const notes = pgTable(
  "note",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // null = workspace-level notes, set = board-scoped notes
    boardId: uuid("board_id").references(() => boards.id, { onDelete: "cascade" }),
    // self-FK; declared below as an explicit foreignKey constraint to avoid forward-reference issues
    parentNoteId: uuid("parent_note_id"),
    scope: noteScope("scope").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull().default(""),
    // markdown text body (signed media URLs stripped on write, re-signed on read)
    content: text("content").notNull().default(""),
    // tabler icon slug, e.g. "notebook" (no `ti-` prefix)
    icon: text("icon").default("file-text"),
    // shared color-palette token (see lib/colors); tints the note icon in the tree and editor
    color: text("color").$type<ColorToken | null>(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    // single-writer edit lock for team notes — see notes route handlers
    editingUserId: uuid("editing_user_id").references(() => users.id, { onDelete: "set null" }),
    editingExpiresAt: timestamp("editing_expires_at", { withTimezone: true }),
    // Full-text search vector: title weighted above content body for ranking.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notes_search_vector_idx").using("gin", t.searchVector),
    foreignKey({
      columns: [t.parentNoteId],
      foreignColumns: [t.id],
      name: "note_parent_note_id_fk",
    }).onDelete("cascade"),
    // Descendant-depth checks and self-FK cascades start from parent_note_id alone.
    index("notes_parent_note_id_idx")
      .on(t.parentNoteId)
      .where(sql`${t.parentNoteId} is not null`),
    index("notes_workspace_scope_parent_position_idx").on(
      t.workspaceId,
      t.boardId,
      t.scope,
      t.ownerId,
      t.parentNoteId,
      t.position,
    ),
    index("notes_owner_idx").on(t.ownerId),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
