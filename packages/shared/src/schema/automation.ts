import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cards, type CardDueDateSlot } from "./card.js";
import { lists } from "./list.js";
import { workspaces } from "./workspace.js";

export const automationTriggerType = pgEnum("automation_trigger_type", ["card_enters_list", "due_date_arrives", "all_checklist_items_complete", "card_assigned_to_user", "card_marked_complete", "card_label_set"]);
export type AutomationTriggerType = (typeof automationTriggerType.enumValues)[number];

export const automationActionType = pgEnum("automation_action_type", [
  "add_labels",
  "remove_labels",
  "add_assignees",
  "remove_assignees",
  "apply_checklists",
  "set_due_date",
  "clear_due_date",
  "set_completion",
  "move_to_list",
  "move_to_top",
  "move_to_bottom",
  "populate_custom_field",
]);
export type AutomationActionType = (typeof automationActionType.enumValues)[number];

export type AutomationActionConfig =
  | { labelIds: string[] }
  | { userIds: string[] }
  | { templateIds: string[] }
  | { offsetDays: number; slot: CardDueDateSlot }
  | { completed: boolean }
  | { listId: string; placement?: "top" | "bottom" }
  | {
      fieldId: string;
      onlyIfEmpty: boolean;
      value:
        | { kind: "text"; text: string }
        | { kind: "text_current_date"; format: "date" | "month" | "datetime" }
        | { kind: "number"; number: number }
        | { kind: "date"; source: "fixed"; date: string }
        | { kind: "date"; source: "current" }
        | { kind: "checkbox"; checked: boolean }
        | { kind: "select"; optionIds: string[] }
        | { kind: "user"; userIds: string[] };
    }
  | Record<string, never>;

export const automations = pgTable(
  "automation",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    triggerType: automationTriggerType("trigger_type").notNull(),
    triggerListId: uuid("trigger_list_id").references(() => lists.id, { onDelete: "cascade" }),
    triggerUserIds: uuid("trigger_user_ids").array(),
    // Intentionally no FK: labels are hard-deleted, so unlike triggerListId (which cascades),
    // a deleted trigger label leaves this automation in place but inert (its label can never be
    // re-added). The settings UI surfaces this as a "Deleted label" so an admin can re-point it.
    triggerLabelId: uuid("trigger_label_id"),
    applyOnCreate: boolean("apply_on_create").notNull().default(true),
    applyOnMove: boolean("apply_on_move").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automations_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("automations_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const automationActions = pgTable(
  "automation_action",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    type: automationActionType("type").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<AutomationActionConfig>(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automation_actions_automation_position_idx").on(t.automationId, t.position),
  ],
);

export const automationDueDateRuns = pgTable(
  "automation_due_date_run",
  {
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    dueDateLocalDate: text("due_date_local_date").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.automationId, t.cardId] }),
  ],
);

export const automationRunStats = pgTable("automation_run_stats", {
  automationId: uuid("automation_id")
    .primaryKey()
    .references(() => automations.id, { onDelete: "cascade" }),
  runCount: integer("run_count").notNull().default(0),
  effectfulRunCount: integer("effectful_run_count").notNull().default(0),
  noopRunCount: integer("noop_run_count").notNull().default(0),
  failedRunCount: integer("failed_run_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastEffectfulRunAt: timestamp("last_effectful_run_at", { withTimezone: true }),
  lastNoopRunAt: timestamp("last_noop_run_at", { withTimezone: true }),
  lastFailedRunAt: timestamp("last_failed_run_at", { withTimezone: true }),
  lastFailureMessage: text("last_failure_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Automation = typeof automations.$inferSelect;
export type NewAutomation = typeof automations.$inferInsert;
export type AutomationAction = typeof automationActions.$inferSelect;
export type NewAutomationAction = typeof automationActions.$inferInsert;
export type AutomationDueDateRun = typeof automationDueDateRuns.$inferSelect;
export type AutomationRunStats = typeof automationRunStats.$inferSelect;
export type NewAutomationRunStats = typeof automationRunStats.$inferInsert;
