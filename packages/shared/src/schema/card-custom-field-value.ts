import { boolean, index, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { customFields } from "./custom-field.js";

export const cardCustomFieldValues = pgTable(
  "card_custom_field_value",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    valueText: text("value_text"),
    valueNumber: numeric("value_number"),
    valueCheckbox: boolean("value_checkbox"),
    // Local date string (YYYY-MM-DD), mirroring cards.dueDateLocalDate. Date-only for v1.
    valueDate: text("value_date"),
    valueUrl: text("value_url"),
    // Selected option ids (select) / user ids (user). Length 1 when the field is
    // single-value; dangling ids are tolerated at render time (options soft-archive,
    // removed members render as Unknown), matching the assignee handling.
    valueOptionIds: uuid("value_option_ids").array(),
    valueUserIds: uuid("value_user_ids").array(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.fieldId] }),
    index("card_custom_field_values_field_id_idx").on(t.fieldId),
  ],
);

export type CardCustomFieldValue = typeof cardCustomFieldValues.$inferSelect;
export type NewCardCustomFieldValue = typeof cardCustomFieldValues.$inferInsert;
