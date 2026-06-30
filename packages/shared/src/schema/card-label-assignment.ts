import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { cardLabels } from "./card-label.js";
import { cards } from "./card.js";

export const cardLabelAssignments = pgTable(
  "card_label_assignment",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => cardLabels.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.labelId] }),
    index("card_label_assignments_label_id_idx").on(t.labelId),
  ],
);

export type CardLabelAssignment = typeof cardLabelAssignments.$inferSelect;
export type NewCardLabelAssignment = typeof cardLabelAssignments.$inferInsert;
