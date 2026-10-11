import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { users } from "./user.js";

/**
 * A personal "remind me about this card at…" alarm. Private to its owner: no other user, activity
 * feed, board room or workspace webhook ever learns that one exists. One per user per card, so
 * setting a new time replaces the old one. The worker sweep stamps `firedAt` when it delivers and
 * keeps the row so the card can show "Reminded at …" until the user clears or reschedules it.
 */
export const cardReminders = pgTable(
  "card_reminder",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("card_reminders_card_user_uniq").on(t.cardId, t.userId),
    index("card_reminders_user_id_idx").on(t.userId, t.remindAt),
    // The sweep only ever scans pending reminders that have come due.
    index("card_reminders_pending_idx").on(t.remindAt).where(sql`${t.firedAt} is null`),
  ],
);

export type CardReminder = typeof cardReminders.$inferSelect;
