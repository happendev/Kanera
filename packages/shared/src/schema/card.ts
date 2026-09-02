import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tsvector } from "./_tsvector.js";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { clients } from "./client.js";
import { lists } from "./list.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";
import { CARD_DUE_DATE_SLOTS, type CardDueDateSlot } from "../lib/due-date-slots.js";

// Re-exported so existing `@kanera/shared/schema` consumers are unaffected; the values live in
// the dependency-free lib module because the web bundle and MCP server need them without drizzle.
export { CARD_DUE_DATE_SLOTS, type CardDueDateSlot };

export const cards = pgTable(
  "card",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientToken: uuid("client_token"),
    // Direct insert tooling may omit these fields; a BEFORE INSERT trigger derives and allocates
    // them atomically. Product paths use the range allocator and provide all three explicitly.
    workspaceId: uuid("workspace_id").notNull().default(sql`null`).references(() => workspaces.id, { onDelete: "cascade" }),
    // Denormalized immutable routing namespace. Keeping it on the card makes every API, realtime,
    // export, and notification shape capable of constructing the canonical URL without extra joins.
    organisationKey: text("organisation_key").notNull().default(sql`null`).references(() => clients.routeKey),
    number: integer("number").notNull().default(sql`null`),
    key: text("key").notNull().default(sql`null`),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    dueDateLocalDate: date("due_date_local_date", { mode: "string" }),
    dueDateSlot: text("due_date_slot", { enum: CARD_DUE_DATE_SLOTS }),
    dueDateTimezone: text("due_date_timezone"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    coverAttachmentId: uuid("cover_attachment_id"),
    // Full-text search vector: title weighted above description for ranking.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cards_due_date_slot_ck", valueIn(t.dueDateSlot, CARD_DUE_DATE_SLOTS)),
    check("cards_number_ck", sql`${t.number} > 0`),
    check("cards_key_ck", sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$'`),
    uniqueIndex("cards_workspace_id_number_key").on(t.workspaceId, t.number),
    uniqueIndex("cards_organisation_key_key_key").on(t.organisationKey, t.key),
    foreignKey({
      columns: [t.workspaceId, t.boardId],
      foreignColumns: [boards.workspaceId, boards.id],
      name: "cards_workspace_board_fk",
    }).onDelete("cascade"),
    uniqueIndex("cards_client_token_key")
      .on(t.clientToken)
      .where(sql`${t.clientToken} is not null`),
    index("cards_search_vector_idx").using("gin", t.searchVector),
    // Search combines full-text matching with a partial-title fallback. The trigram side keeps
    // that OR indexable instead of forcing a scan that bypasses the full-text GIN index too.
    index("cards_title_trgm_idx").using("gin", sql`lower(${t.title}) gin_trgm_ops`),
    index("cards_board_list_position_idx").on(t.boardId, t.listId, t.position),
    index("cards_board_id_idx").on(t.boardId),
    index("cards_list_id_idx").on(t.listId),
    index("cards_active_board_list_position_idx")
      .on(t.boardId, t.listId, t.position)
      .where(sql`${t.archivedAt} is null`),
    index("cards_active_list_position_idx")
      .on(t.listId, t.position)
      .where(sql`${t.archivedAt} is null`),
    index("cards_active_board_position_idx")
      .on(t.boardId, t.position)
      .where(sql`${t.archivedAt} is null`),
    index("cards_active_incomplete_due_date_idx")
      .on(t.dueDateLocalDate, t.id)
      .where(sql`${t.dueDateLocalDate} is not null and ${t.completedAt} is null and ${t.archivedAt} is null`),
    // Inactivity automations page candidates by the canonical card-activity clock.
    index("cards_active_incomplete_updated_at_idx")
      .on(t.updatedAt, t.id)
      .where(sql`${t.completedAt} is null and ${t.archivedAt} is null`),
    // Archived-card retention is global rather than board/list scoped.
    index("cards_archived_at_idx")
      .on(t.archivedAt)
      .where(sql`${t.archivedAt} is not null`),
    index("cards_completed_history_idx")
      .on(t.boardId, sql`${t.completedAt} desc`, t.id)
      .where(sql`${t.completedAt} is not null and ${t.archivedAt} is null`),
    index("cards_completed_history_list_idx")
      .on(t.boardId, t.listId, sql`${t.completedAt} desc`, t.id)
      .where(sql`${t.completedAt} is not null and ${t.archivedAt} is null`),
  ],
);

export type Card = typeof cards.$inferSelect;
