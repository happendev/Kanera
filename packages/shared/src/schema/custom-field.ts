import { sql } from "drizzle-orm";
import { boolean, index, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspace.js";

export const customFieldType = pgEnum("custom_field_type", [
  "text",
  "number",
  "checkbox",
  "select",
  "date",
  "url",
  "user",
]);
export type CustomFieldType = (typeof customFieldType.enumValues)[number];

export const customFields = pgTable(
  "custom_field",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon").notNull().default("forms"),
    type: customFieldType("type").notNull(),
    // Only meaningful for `select` and `user` fields: when true a card may hold
    // several option/user ids; when false the value is capped to one.
    allowMultiple: boolean("allow_multiple").notNull().default(false),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    showOnCard: boolean("show_on_card").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("custom_fields_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("custom_fields_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type CustomField = typeof customFields.$inferSelect;
export type NewCustomField = typeof customFields.$inferInsert;
