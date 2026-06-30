import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { customFields } from "./custom-field.js";

// Options belong to a `select`-type custom field. Removing an option is a soft
// archive so cards that still reference it keep resolving a label/colour.
export const customFieldOptions = pgTable(
  "custom_field_option",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    color: text("color"),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("custom_field_options_field_id_position_idx").on(t.fieldId, t.position),
    index("custom_field_options_active_field_position_idx")
      .on(t.fieldId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type CustomFieldOption = typeof customFieldOptions.$inferSelect;
export type NewCustomFieldOption = typeof customFieldOptions.$inferInsert;
