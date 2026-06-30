import { sql } from "drizzle-orm";
import { index, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cards } from "./card.js";
import { workspaces } from "./workspace.js";

// Workspace-scoped reusable checklist definitions. Automations can apply these
// templates to seed real card checklists + items.
export const checklistTemplates = pgTable(
  "checklist_template",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checklist_templates_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("checklist_templates_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const checklistTemplateItems = pgTable(
  "checklist_template_item",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    templateId: uuid("template_id")
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checklist_template_items_template_position_idx").on(t.templateId, t.position),
  ],
);

// Persistent ledger of "this template has been applied to this card". Survives
// deletion of the seeded checklist so a template is never re-applied to the same
// card, even if an automation fires again.
export const cardChecklistTemplateApplications = pgTable(
  "card_checklist_template_application",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: "cascade" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.templateId] }),
  ],
);

export type ChecklistTemplate = typeof checklistTemplates.$inferSelect;
export type NewChecklistTemplate = typeof checklistTemplates.$inferInsert;
export type ChecklistTemplateItem = typeof checklistTemplateItems.$inferSelect;
export type NewChecklistTemplateItem = typeof checklistTemplateItems.$inferInsert;
export type CardChecklistTemplateApplication = typeof cardChecklistTemplateApplications.$inferSelect;
