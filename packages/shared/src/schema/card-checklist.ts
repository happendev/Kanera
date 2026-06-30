import { sql } from "drizzle-orm";
import { date, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cardDueDateSlot, cards } from "./card.js";
import { users } from "./user.js";

export const cardChecklists = pgTable(
  "card_checklist",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("card_checklists_card_position_idx").on(t.cardId, t.position),
  ],
);

export const cardChecklistItems = pgTable(
  "card_checklist_item",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    checklistId: uuid("checklist_id")
      .notNull()
      .references(() => cardChecklists.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    // Due date mirrors cards exactly: same slots/times and the same overdue rule
    // (see apps/api/src/lib/due-date.ts). dueDateTimezone captures the acting
    // user's timezone when the date is set, so overdue is evaluated correctly.
    dueDateLocalDate: date("due_date_local_date", { mode: "string" }),
    dueDateSlot: cardDueDateSlot("due_date_slot"),
    dueDateTimezone: text("due_date_timezone"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedById: uuid("completed_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("card_checklist_items_checklist_position_idx").on(t.checklistId, t.position),
    // Checklist-item assignment lookups (board membership backfill, assignee filters)
    // query by assignee_id; partial index keeps it small since most items are unassigned.
    index("card_checklist_items_assignee_id_idx")
      .on(t.assigneeId)
      .where(sql`${t.assigneeId} is not null`),
  ],
);

export type CardChecklist = typeof cardChecklists.$inferSelect;
export type NewCardChecklist = typeof cardChecklists.$inferInsert;
export type CardChecklistItem = typeof cardChecklistItems.$inferSelect;
export type NewCardChecklistItem = typeof cardChecklistItems.$inferInsert;
