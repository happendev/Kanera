import { z } from "zod";
export { AUTOMATION_ACTION_LIMIT } from "../automation-limits.js";
import { AUTOMATION_ACTION_LIMIT } from "../automation-limits.js";
import { dueDateSlot } from "./cards.js";

export const automationTriggerType = z.enum(["card_enters_list", "due_date_arrives", "all_checklist_items_complete", "card_assigned_to_user", "card_marked_complete", "card_label_set"]);
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
const currentDateTextFormat = z.enum(["date", "month", "datetime"]);
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
]);
const populateCustomFieldActionConfig = z.object({
  fieldId: z.uuid(),
  onlyIfEmpty: z.boolean().default(true),
  value: populateCustomFieldValue,
});
const emptyConfig = z.object({}).strict();

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
  applyOnCreate: z.boolean().default(true),
  applyOnMove: z.boolean().default(true),
};

function requireTriggerConfig(value: { triggerType?: AutomationTriggerTypeDto; triggerListId?: string | null; triggerUserIds?: string[] | null; triggerLabelId?: string | null }, ctx: z.RefinementCtx) {
  if (value.triggerType === "card_enters_list" && !value.triggerListId) {
    ctx.addIssue({ code: "custom", path: ["triggerListId"], message: "triggerListId is required" });
  }
  if (value.triggerType === "card_assigned_to_user" && (!value.triggerUserIds || value.triggerUserIds.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["triggerUserIds"], message: "triggerUserIds is required" });
  }
  if (value.triggerType === "card_label_set" && !value.triggerLabelId) {
    ctx.addIssue({ code: "custom", path: ["triggerLabelId"], message: "triggerLabelId is required" });
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
    triggerType: automationTriggerType.optional(),
    triggerListId: z.uuid().nullable().optional(),
    triggerUserIds: z.array(z.uuid()).min(1).max(100).nullable().optional(),
    triggerLabelId: z.uuid().nullable().optional(),
    applyOnCreate: z.boolean().optional(),
    applyOnMove: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.enabled !== undefined ||
      v.triggerType !== undefined ||
      v.triggerListId !== undefined ||
      v.triggerUserIds !== undefined ||
      v.triggerLabelId !== undefined ||
      v.applyOnCreate !== undefined ||
      v.applyOnMove !== undefined,
    "provide a field to update",
  );
export type UpdateAutomationBody = z.infer<typeof updateAutomationBody>;

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
