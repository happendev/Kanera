import { sql } from "drizzle-orm";
import { index, numeric, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { users } from "./user.js";

/**
 * One person's ordered priority queue: "do this, then this, then this".
 *
 * This sits in the `card_assignee` / `card_watcher` / `card_mention` family on purpose, because that
 * is its structural shape — an ordering *over* `card_assignee` rows, not a field on the card. The
 * same card can be #1 for one person and #7 for another, so rank belongs to the (user, card) pair.
 *
 * Deliberately not workspace- or board-keyed. `global_work_separator` is keyed by workspace and that
 * is exactly why it cannot express this: a coordinator sequencing someone's week crosses boards and
 * workspaces. A `client_id` would be no better — `board_members` grants cross-organisation guest
 * access, so a queue can legitimately hold a card from an external org's board, and a tenancy column
 * would either be a lie or force two queues per person. `card_assignee`, the exact relation this
 * ranks, carries no tenancy column for the same reason. Tenancy is enforced the way every other card
 * collection enforces it: `loadAccessibleBoards` + `cardAccessCondition` on read, `assertCardAccess`
 * on write.
 *
 * There is deliberately no composite FK to `card_assignee`: `PUT /cards/:id/assignees` deletes and
 * reinserts every assignee row on each edit, so a referencing FK would silently wipe the whole queue
 * whenever anyone touched a card's assignees. The assignee relationship is re-checked at read time
 * instead, which also makes a corrected mis-assignment restore the original rank.
 */
export const cardPriorities = pgTable(
  "card_priority",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("card_priorities_user_card_uq").on(t.targetUserId, t.cardId),
    // Leads with target_user_id then position so the read is one index range scan producing
    // pre-ordered rows with no sort node; card_id makes it covering for the ordering step. The
    // unique index above cannot serve `order by position`, so both are needed.
    index("card_priorities_user_position_idx").on(t.targetUserId, t.position, t.cardId),
    index("card_priorities_card_id_idx").on(t.cardId),
  ],
);

/** A hand-curated "then, then, then" sequence stops meaning anything past ~20 entries. 50 gives
 * headroom without becoming a second backlog, keeps the read one indexed scan, and keeps the
 * write path — which reads the whole queue per drag — cheap. Enforced inside the insert
 * transaction, on the `select … for update` that anchor resolution needs anyway. */
export const MAX_CARD_PRIORITIES_PER_USER = 50;

export type CardPriority = typeof cardPriorities.$inferSelect;
