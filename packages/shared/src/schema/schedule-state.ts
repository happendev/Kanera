import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { cards } from "./card.js";

/**
 * The schedule engine's last verdict per open card, kept so that `schedule.*` events and the
 * scheduling automation triggers fire on boundaries rather than on every edit: a card gains its
 * first conflict once, loses its last conflict once, and a chain of date edits inside one minute
 * yields one event per card. Rows exist only for cards that were open when their board was last
 * rechecked; a card leaving the open set drops its row, so reopening it starts from a clean slate.
 *
 * Dates are YYYY-MM-DD keys, the shape the engine works in (`@kanera/shared/schedule`).
 */
export const cardScheduleState = pgTable("card_schedule_state", {
  cardId: uuid("card_id").primaryKey().references(() => cards.id, { onDelete: "cascade" }),
  /** Open blockers planned to finish on or after this card's planned start; empty when none. */
  conflictBlockerIds: uuid("conflict_blocker_ids").array().notNull().default(sql`'{}'::uuid[]`),
  critical: boolean("critical").notNull().default(false),
  plannedEnd: text("planned_end"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The board-level half of the latch: `schedule.critical_path_slipped` fires only when the board's
 * projected finish moved later, not when a critical card merely swapped places. A board without a
 * row has never been rechecked; the first recheck seeds both tables silently, so a deploy onto a
 * populated database does not announce every existing conflict at once.
 */
export const boardScheduleState = pgTable("board_schedule_state", {
  boardId: uuid("board_id").primaryKey().references(() => boards.id, { onDelete: "cascade" }),
  projectedFinish: text("projected_finish"),
  latestDue: text("latest_due"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Boards whose schedule may have changed and must be re-evaluated against the latch. Every write
 * that can move a bar (dates, completion, archive, relations, moves, deletes) upserts the board in
 * the same transaction; the worker drains the queue. One row per board coalesces a burst of edits
 * into one evaluation, and `requestedAt` lets the drain delete only the request it answered.
 */
export const scheduleRecheckQueue = pgTable("schedule_recheck_queue", {
  boardId: uuid("board_id").primaryKey().references(() => boards.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CardScheduleState = typeof cardScheduleState.$inferSelect;
export type BoardScheduleState = typeof boardScheduleState.$inferSelect;
