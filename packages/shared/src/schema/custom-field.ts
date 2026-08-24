import { sql } from "drizzle-orm";
import { boolean, check, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { workspaces } from "./workspace.js";

export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "checkbox",
  "select",
  "date",
  "url",
  "user",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const customFields = pgTable(
  "custom_field",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon").notNull().default("forms"),
    type: text("type", { enum: CUSTOM_FIELD_TYPES }).notNull(),
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
    check("custom_fields_type_ck", valueIn(t.type, CUSTOM_FIELD_TYPES)),
    index("custom_fields_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("custom_fields_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type CustomField = typeof customFields.$inferSelect;
