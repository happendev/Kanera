import { z } from "zod";
export { AUTOMATION_ACTION_LIMIT } from "../automation-limits.js";
import { AUTOMATION_ACTION_LIMIT } from "../automation-limits.js";
import { AUTOMATION_TRIGGER_TYPES } from "../schema/automation.js";
import { dueDateSlot } from "./cards.js";

export const automationTriggerType = z.enum(AUTOMATION_TRIGGER_TYPES).describe(
  "Automation trigger event. card_leaves_list matches the source list of a move. custom_field_value_changed fires only on a transition into the selected typed value. due_date_approaching is scheduled and fires once per due date and lead-time setting before the due day. card_becomes_inactive is scheduled and fires once per inactivity boundary.",
);
export type AutomationTriggerTypeDto = z.infer<typeof automationTriggerType>;

const labelActionConfig = z.object({ labelIds: z.array(z.uuid()).min(1).max(100) });
const assigneeActionConfig = z.object({ userIds: z.array(z.uuid()).min(1).max(100) });
const checklistActionConfig = z.object({ templateIds: z.array(z.uuid()).min(1).max(100) });
const dueDateActionConfig = z.object({
  offsetDays: z.number().int().min(-3650).max(3650),
  slot: dueDateSlot.default("anyTime"),
});
const completionActionConfig = z.object({ completed: z.boolean() });
const moveActionConfig = z.object({
  listId: z.uuid(),
  placement: z.enum(["top", "bottom"]).default("bottom"),
});
const currentDateTextFormat = z.enum(["date", "month", "month_long_short_year", "month_long_year", "datetime"]);
const populateCustomFieldValue = z.union([
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(20000) }),
  z.object({ kind: z.literal("text_current_date"), format: currentDateTextFormat }),
  z.object({ kind: z.literal("number"), number: z.number() }),
  z.object({
    kind: z.literal("date"),
    source: z.literal("fixed"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  }),
  z.object({ kind: z.literal("date"), source: z.literal("current") }),
  z.object({ kind: z.literal("checkbox"), checked: z.boolean() }),
  z.object({ kind: z.literal("select"), optionIds: z.array(z.uuid()).min(1).max(100) }),
  z.object({ kind: z.literal("user"), userIds: z.array(z.uuid()).min(1).max(100) }),
  // Copy from another custom field of the same type (resolved per card at apply time).
  z.object({ kind: z.literal("field"), sourceFieldId: z.uuid() }),
]);
const populateCustomFieldActionConfig = z.object({
  fieldId: z.uuid(),
  onlyIfEmpty: z.boolean().default(true),
  value: populateCustomFieldValue,
});
const emptyConfig = z.object({}).strict();

export const automationTriggerCustomFieldValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text").describe("Text-field value kind."), text: z.string().max(20000).describe("Exact text to match.") }),
  z.object({ kind: z.literal("number").describe("Number-field value kind."), number: z.number().describe("Exact number to match.") }),
  z.object({ kind: z.literal("checkbox").describe("Checkbox-field value kind."), checked: z.boolean().describe("Checked state to match.") }),
  z.object({ kind: z.literal("date").describe("Date-field value kind."), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").describe("Exact local date in YYYY-MM-DD format.") }),
  z.object({ kind: z.literal("url").describe("URL-field value kind."), url: z.url().max(20000).describe("Exact URL to match.") }),
  z.object({ kind: z.literal("select").describe("Select-field value kind."), optionId: z.uuid().describe("Selected option UUID to match; multi-select fields match when this option is present.") }),
  z.object({ kind: z.literal("user").describe("User-field value kind."), userId: z.uuid().describe("Workspace-member UUID to match; multi-user fields match when this member is present.") }),
]);
export type AutomationTriggerCustomFieldValueDto = z.infer<typeof automationTriggerCustomFieldValue>;

export const automationActionBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_labels"), config: labelActionConfig }),
  z.object({ type: z.literal("remove_labels"), config: labelActionConfig }),
  z.object({ type: z.literal("add_assignees"), config: assigneeActionConfig }),
  z.object({ type: z.literal("remove_assignees"), config: assigneeActionConfig }),
  z.object({ type: z.literal("apply_checklists"), config: checklistActionConfig }),
  z.object({ type: z.literal("set_due_date"), config: dueDateActionConfig }),
  z.object({ type: z.literal("clear_due_date"), config: emptyConfig.default({}) }),
  z.object({ type: z.literal("set_completion"), config: completionActionConfig }),
  z.object({ type: z.literal("move_to_list"), config: moveActionConfig }),
  z.object({ type: z.literal("move_to_top"), config: emptyConfig.default({}) }),
  z.object({ type: z.literal("move_to_bottom"), config: emptyConfig.default({}) }),
  z.object({ type: z.literal("populate_custom_field"), config: populateCustomFieldActionConfig }),
]);
export type AutomationActionBody = z.infer<typeof automationActionBody>;

const triggerFields = {
  triggerType: automationTriggerType,
  triggerListId: z.uuid().nullable().optional(),
  triggerUserIds: z.array(z.uuid()).min(1).max(100).nullable().optional(),
  triggerLabelId: z.uuid().nullable().optional(),
  triggerCustomFieldId: z.uuid().nullable().optional(),
  triggerCustomFieldValue: automationTriggerCustomFieldValue.nullable().optional(),
  triggerDaysBefore: z.number().int().min(1).max(3650).nullable().optional(),
  applyOnCreate: z.boolean().default(true),
  applyOnMove: z.boolean().default(true),
};

function requireTriggerConfig(value: { triggerType?: AutomationTriggerTypeDto; triggerListId?: string | null; triggerUserIds?: string[] | null; triggerLabelId?: string | null; triggerCustomFieldId?: string | null; triggerCustomFieldValue?: AutomationTriggerCustomFieldValueDto | null; triggerDaysBefore?: number | null }, ctx: z.RefinementCtx) {
  if ((value.triggerType === "card_enters_list" || value.triggerType === "card_leaves_list") && !value.triggerListId) {
    ctx.addIssue({ code: "custom", path: ["triggerListId"], message: "triggerListId is required" });
  }
  if (value.triggerType === "card_assigned_to_user" && (!value.triggerUserIds || value.triggerUserIds.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["triggerUserIds"], message: "triggerUserIds is required" });
  }
  if (value.triggerType === "card_label_set" && !value.triggerLabelId) {
    ctx.addIssue({ code: "custom", path: ["triggerLabelId"], message: "triggerLabelId is required" });
  }
  if (value.triggerType === "due_date_approaching" && !value.triggerDaysBefore) {
    ctx.addIssue({ code: "custom", path: ["triggerDaysBefore"], message: "triggerDaysBefore is required" });
  }
  if (value.triggerType === "custom_field_value_changed") {
    if (!value.triggerCustomFieldId) ctx.addIssue({ code: "custom", path: ["triggerCustomFieldId"], message: "triggerCustomFieldId is required" });
    if (!value.triggerCustomFieldValue) ctx.addIssue({ code: "custom", path: ["triggerCustomFieldValue"], message: "triggerCustomFieldValue is required" });
  }
}

export const createAutomationBody = z.object({
  enabled: z.boolean().default(false),
  actions: z.array(automationActionBody).max(AUTOMATION_ACTION_LIMIT).default([]),
  ...triggerFields,
}).superRefine(requireTriggerConfig);
export type CreateAutomationBody = z.infer<typeof createAutomationBody>;

export const updateAutomationBody = z
  .object({
    enabled: z.boolean().optional(),
    actions: z.array(automationActionBody).max(AUTOMATION_ACTION_LIMIT).optional(),
    triggerType: automationTriggerType.optional(),
    triggerListId: z.uuid().nullable().optional(),
    triggerUserIds: z.array(z.uuid()).min(1).max(100).nullable().optional(),
    triggerLabelId: z.uuid().nullable().optional(),
    triggerCustomFieldId: z.uuid().nullable().optional(),
    triggerCustomFieldValue: automationTriggerCustomFieldValue.nullable().optional(),
    triggerDaysBefore: z.number().int().min(1).max(3650).nullable().optional(),
    applyOnCreate: z.boolean().optional(),
    applyOnMove: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.enabled !== undefined ||
      v.actions !== undefined ||
      v.triggerType !== undefined ||
      v.triggerListId !== undefined ||
      v.triggerUserIds !== undefined ||
      v.triggerLabelId !== undefined ||
      v.triggerCustomFieldId !== undefined ||
      v.triggerCustomFieldValue !== undefined ||
      v.triggerDaysBefore !== undefined ||
      v.applyOnCreate !== undefined ||
      v.applyOnMove !== undefined,
    "provide a field to update",
  );
export type UpdateAutomationBody = z.infer<typeof updateAutomationBody>;

export const listAutomationExecutionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(101).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ListAutomationExecutionsQuery = z.infer<typeof listAutomationExecutionsQuery>;

export const setAutomationActionsBody = z.object({
  actions: z.array(automationActionBody).max(AUTOMATION_ACTION_LIMIT),
});
export type SetAutomationActionsBody = z.infer<typeof setAutomationActionsBody>;

export const moveAutomationBody = z
  .object({
    afterAutomationId: z.uuid().nullable().optional(),
    beforeAutomationId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterAutomationId !== undefined || v.beforeAutomationId !== undefined,
    "provide afterAutomationId or beforeAutomationId",
  );
export type MoveAutomationBody = z.infer<typeof moveAutomationBody>;
