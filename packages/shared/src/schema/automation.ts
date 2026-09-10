import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { cards, type CardDueDateSlot } from "./card.js";
import { lists } from "./list.js";
import { workspaces } from "./workspace.js";

export const AUTOMATION_TRIGGER_TYPES = ["card_enters_list", "card_leaves_list", "due_date_arrives", "due_date_approaching", "card_becomes_inactive", "all_checklist_items_complete", "card_assigned_to_user", "card_marked_complete", "card_label_set", "custom_field_value_changed"] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export type AutomationTriggerCustomFieldValue =
  | { kind: "text"; text: string }
  | { kind: "number"; number: number }
  | { kind: "checkbox"; checked: boolean }
  | { kind: "date"; date: string }
  | { kind: "url"; url: string }
  | { kind: "select"; optionId: string }
  | { kind: "user"; userId: string };

export const AUTOMATION_ACTION_TYPES = [
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
  // Outbound actions: they leave the card alone and instead tell someone (a comment on the card's
  // own feed) or something (a workspace webhook endpoint) that the trigger fired.
  "post_comment",
  "call_webhook",
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

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
        | { kind: "text_current_date"; format: "date" | "month" | "month_long_short_year" | "month_long_year" | "datetime" }
        | { kind: "number"; number: number }
        | { kind: "date"; source: "fixed"; date: string }
        | { kind: "date"; source: "current" }
        | { kind: "checkbox"; checked: boolean }
        | { kind: "select"; optionIds: string[] }
        | { kind: "user"; userIds: string[] }
        // Copy the current value of another custom field on the same card. The source
        // field must be the same type as the target; the value is resolved per card at
        // apply time, not stored here.
        | { kind: "field"; sourceFieldId: string };
    }
  // post_comment: Markdown with `{{card.title}}`-style placeholders resolved per card at run time
  // (see AUTOMATION_COMMENT_TEMPLATE_VARIABLES in the automations lib).
  | { template: string }
  // call_webhook: a `webhook_endpoint` row in the same workspace. Referencing the endpoint rather than
  // a raw URL is deliberate: the endpoint already owns the signing secret, the SSRF-checked URL, the
  // enabled flag, and the delivery log, so an automation never has to duplicate any of that.
  | { endpointId: string }
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
    triggerType: text("trigger_type", { enum: AUTOMATION_TRIGGER_TYPES }).notNull(),
    triggerListId: uuid("trigger_list_id").references(() => lists.id, { onDelete: "cascade" }),
    triggerUserIds: uuid("trigger_user_ids").array(),
    // Intentionally no FK: labels are hard-deleted, so unlike triggerListId (which cascades),
    // a deleted trigger label leaves this automation in place but inert (its label can never be
    // re-added). The settings UI surfaces this as a "Deleted label" so an admin can re-point it.
    triggerLabelId: uuid("trigger_label_id"),
    triggerCustomFieldId: uuid("trigger_custom_field_id"),
    triggerCustomFieldValue: jsonb("trigger_custom_field_value").$type<AutomationTriggerCustomFieldValue>(),
    triggerDaysBefore: integer("trigger_days_before"),
    applyOnCreate: boolean("apply_on_create").notNull().default(true),
    applyOnMove: boolean("apply_on_move").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("automations_trigger_type_ck", valueIn(t.triggerType, AUTOMATION_TRIGGER_TYPES)),
    check("automations_trigger_days_before_ck", sql`${t.triggerDaysBefore} is null or (${t.triggerDaysBefore} between 1 and 3650)`),
    index("automations_workspace_id_position_idx").on(t.workspaceId, t.position),
    index("automations_active_workspace_position_idx")
      .on(t.workspaceId, t.position)
      .where(sql`${t.archivedAt} is null`),
    // Every card create and every card move looks up the automations for one list. The
    // workspace+position indexes above can only narrow to the workspace, leaving trigger_type and
    // trigger_list_id as a heap filter over all of its automations — measured at 400 automations in
    // one workspace, that discarded 382 of 402 rows per card move. Position is the trailing column
    // so the ordered read still comes from the index.
    index("automations_trigger_list_idx")
      .on(t.workspaceId, t.triggerType, t.triggerListId, t.position)
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
    type: text("type", { enum: AUTOMATION_ACTION_TYPES }).notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<AutomationActionConfig>(),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("automation_actions_type_ck", valueIn(t.type, AUTOMATION_ACTION_TYPES)),
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
    triggerDaysBefore: integer("trigger_days_before").notNull().default(0),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.automationId, t.cardId] }),
    check("automation_due_date_runs_trigger_days_before_ck", sql`${t.triggerDaysBefore} between 0 and 3650`),
    // The primary key is automation-first; archived-card deletion cascades from card_id.
    index("automation_due_date_runs_card_id_idx").on(t.cardId),
  ],
);

export const automationInactiveRuns = pgTable(
  "automation_inactive_run",
  {
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    // The event identity is the workspace-specific boundary, not merely cards.updated_at. If an
    // admin changes inactiveCardsDays, the same untouched card can cross a genuinely new boundary.
    inactiveAt: timestamp("inactive_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.automationId, t.cardId] }),
    index("automation_inactive_runs_card_id_idx").on(t.cardId),
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

export const AUTOMATION_RUN_OUTCOMES = ["effectful", "noop", "failed"] as const;
export const automationRuns = pgTable(
  "automation_run",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
    outcome: text("outcome", { enum: AUTOMATION_RUN_OUTCOMES }).notNull(),
    // Which card the run acted on. SET NULL rather than CASCADE so a card's deletion does not
    // silently erase the automation's run history and skew its counters versus this table.
    cardId: uuid("card_id").references(() => cards.id, { onDelete: "set null" }),
    // For failed runs, the action that threw. For effectful/no-op runs, the first action of the
    // rule so a reader can see what kind of rule ran without joining automation_action. Open text
    // rather than a CHECK: retired action types must keep reading in historical rows.
    actionType: text("action_type"),
    // Truncated failure message; null unless outcome is "failed".
    error: text("error"),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("automation_runs_outcome_ck", valueIn(t.outcome, AUTOMATION_RUN_OUTCOMES)),
    index("automation_runs_card_id_idx").on(t.cardId).where(sql`${t.cardId} is not null`),
    index("automation_runs_ran_at_idx").on(t.ranAt),
    index("automation_runs_automation_id_ran_at_idx").on(t.automationId, t.ranAt),
  ],
);

export type Automation = typeof automations.$inferSelect;
export type AutomationAction = typeof automationActions.$inferSelect;
export type AutomationDueDateRun = typeof automationDueDateRuns.$inferSelect;
export type AutomationInactiveRun = typeof automationInactiveRuns.$inferSelect;
export type AutomationRunStats = typeof automationRunStats.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
