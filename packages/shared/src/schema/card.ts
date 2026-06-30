import { sql } from "drizzle-orm";
import { date, index, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tsvector } from "./_tsvector.js";
import { boards } from "./board.js";
import { lists } from "./list.js";
import { users } from "./user.js";

export const cardDueDateSlot = pgEnum("card_due_date_slot", ["anyTime", "morning", "afternoon", "endOfWorkDay"]);
export type CardDueDateSlot = (typeof cardDueDateSlot.enumValues)[number];

export const cards = pgTable(
  "card",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
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
    dueDateSlot: cardDueDateSlot("due_date_slot"),
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
    index("cards_search_vector_idx").using("gin", t.searchVector),
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
    index("cards_completed_history_idx")
      .on(t.boardId, sql`${t.completedAt} desc`, t.id)
      .where(sql`${t.completedAt} is not null and ${t.archivedAt} is null`),
    index("cards_completed_history_list_idx")
      .on(t.boardId, t.listId, sql`${t.completedAt} desc`, t.id)
      .where(sql`${t.completedAt} is not null and ${t.archivedAt} is null`),
  ],
);

export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
