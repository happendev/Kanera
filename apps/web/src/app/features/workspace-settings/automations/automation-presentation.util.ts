import type { AutomationActionBody, CustomFieldTypeName, DueDateSlot } from "@kanera/shared/dto";
import type { WireAutomation, WireCardLabel, WireChecklistTemplate, WireCustomField } from "@kanera/shared/events";
import type { List } from "@kanera/shared/schema";
import type { CardLabelPresentation } from "../../board/card-labels.component";

type PopulateCustomFieldAction = Extract<AutomationActionBody, { type: "populate_custom_field" }>;
type PopulateCustomFieldValue = PopulateCustomFieldAction["config"]["value"];
export type PopulateTextDateFormat = Extract<PopulateCustomFieldValue, { kind: "text_current_date" }>["format"];

/** One fragment of an automation's summary sentence. `strong` marks a configured value, not grammar. */
export type AutomationSummarySegment = { text: string; strong: boolean };

export const automationActionTypes = ["add_labels", "remove_labels", "add_assignees", "remove_assignees", "apply_checklists", "set_due_date", "clear_due_date", "set_completion", "move_to_list", "move_to_top", "move_to_bottom", "populate_custom_field"] as const;
export type AutomationActionTypeName = (typeof automationActionTypes)[number];

export const automationSetCustomFieldTypes = ["text", "number", "date", "checkbox", "select", "user"] as const satisfies readonly CustomFieldTypeName[];

/**
 * The workspace collections an automation summary resolves ids against.
 *
 * Every function here is pure: it reads only its action/automation argument and this snapshot, and
 * never touches component state. That is the point — these run once per action per rendered rule,
 * so they must stay cheap and side-effect free, and they are what makes the settings page's
 * automation tab testable without mounting the page.
 */
export interface AutomationLookups {
  lists: readonly Pick<List, "id" | "name">[];
  labels: readonly WireCardLabel[];
  members: readonly { userId: string; displayName: string }[];
  templates: readonly WireChecklistTemplate[];
  fields: readonly WireCustomField[];
}

// ─── Raw config accessors (no lookups needed) ─────────────────────────────────

export function automationTriggerUserIds(automation: WireAutomation): string[] {
  return automation.triggerUserIds ?? [];
}

export function automationTriggerLabelId(automation: WireAutomation): string {
  return automation.triggerLabelId ?? "";
}

export function automationActionTypeValue(action: AutomationActionBody): string {
  return (automationActionTypes as readonly string[]).includes(action.type) ? action.type : "set_completion";
}

export function automationActionTargetValue(action: AutomationActionBody): string {
  if (action.type === "add_labels" || action.type === "remove_labels") return action.config.labelIds[0] ?? "";
  if (action.type === "add_assignees" || action.type === "remove_assignees") return action.config.userIds[0] ?? "";
  if (action.type === "move_to_list") return action.config.listId;
  if (action.type === "populate_custom_field") return action.config.fieldId;
  return "";
}

export function automationActionUserIds(action: AutomationActionBody): string[] {
  return action.type === "add_assignees" || action.type === "remove_assignees" ? action.config.userIds : [];
}

export function automationActionLabelIds(action: AutomationActionBody): string[] {
  return action.type === "add_labels" || action.type === "remove_labels" ? action.config.labelIds : [];
}

export function automationActionTemplateIds(action: AutomationActionBody): string[] {
  return action.type === "apply_checklists" ? action.config.templateIds : [];
}

export function automationMovePlacementValue(action: AutomationActionBody): "top" | "bottom" {
  return action.type === "move_to_list" && action.config.placement === "top" ? "top" : "bottom";
}

export function automationDueOffsetValue(action: AutomationActionBody): number {
  return action.type === "set_due_date" ? action.config.offsetDays : 0;
}

export function automationDueSlotValue(action: AutomationActionBody): DueDateSlot {
  return action.type === "set_due_date" ? action.config.slot : "anyTime";
}

export function automationDueSlotLabel(slot: DueDateSlot): string {
  if (slot === "anyTime") return "Any time";
  if (slot === "endOfWorkDay") return "End of workday";
  return slot.charAt(0).toUpperCase() + slot.slice(1);
}

export function automationCompletionValue(action: AutomationActionBody): string {
  return action.type === "set_completion" && !action.config.completed ? "false" : "true";
}

export function automationPopulateTextSource(action: AutomationActionBody): "current_date" | "text" {
  return action.type === "populate_custom_field" && action.config.value.kind === "text_current_date" ? "current_date" : "text";
}

export function automationPopulateTextValue(action: AutomationActionBody): string {
  return action.type === "populate_custom_field" && action.config.value.kind === "text" ? action.config.value.text : "";
}

export function automationPopulateTextDateFormatLabel(format: PopulateTextDateFormat): string {
  if (format === "date") return "YYYY-MM-DD";
  if (format === "month") return "YYYY-MM";
  if (format === "month_long_short_year") return "MMMM yy";
  if (format === "month_long_year") return "MMMM yyyy";
  if (format === "datetime") return "YYYY-MM-DD HH:mm";
  return "YYYY-MM-DD";
}

export function isAutomationLabelAction(action: AutomationActionBody): boolean {
  return action.type === "add_labels" || action.type === "remove_labels";
}

export function automationActionIcon(action: AutomationActionBody): string {
  if (action.type === "add_labels" || action.type === "remove_labels") return "ti-tag";
  if (action.type === "add_assignees" || action.type === "remove_assignees") return "ti-user";
  if (action.type === "apply_checklists") return "ti-list-check";
  if (action.type === "move_to_list") return "ti-arrow-right";
  if (action.type === "move_to_top") return "ti-arrow-up";
  if (action.type === "move_to_bottom") return "ti-arrow-down";
  if (action.type === "set_due_date" || action.type === "clear_due_date") return "ti-calendar";
  if (action.type === "populate_custom_field") return "ti-forms";
  return action.config.completed ? "ti-circle-check" : "ti-circle-dashed";
}

export function automationActionIconClass(action: AutomationActionBody): string {
  return `ti ${automationActionIcon(action)}`;
}

// ─── Name resolution ──────────────────────────────────────────────────────────

export function automationLabelName(id: string, lookups: AutomationLookups): string {
  return lookups.labels.find((label) => label.id === id)?.name ?? "Label";
}

/** Distinct from `automationLabelName`: a trigger naming a deleted label must say so, not read as configured. */
export function automationTriggerLabelName(id: string, lookups: AutomationLookups): string {
  return lookups.labels.find((label) => label.id === id)?.name ?? "Deleted label";
}

export function automationMemberName(id: string, lookups: AutomationLookups): string {
  return lookups.members.find((member) => member.userId === id)?.displayName ?? "Member";
}

export function automationTemplateName(id: string, lookups: AutomationLookups): string {
  return lookups.templates.find((template) => template.id === id)?.title ?? "Checklist";
}

export function automationCustomFieldName(id: string, lookups: AutomationLookups): string {
  return lookups.fields.find((field) => field.id === id)?.name ?? "Custom field";
}

export function automationTriggerLabelMissing(automation: WireAutomation, lookups: AutomationLookups): boolean {
  return Boolean(automation.triggerLabelId) && !lookups.labels.some((label) => label.id === automation.triggerLabelId);
}

export function automationSetCustomField(action: AutomationActionBody, lookups: AutomationLookups): WireCustomField | null {
  return action.type === "populate_custom_field"
    ? lookups.fields.find((field) => field.id === action.config.fieldId) ?? null
    : null;
}

/**
 * Labels for the collapsed summary, in the shape `k-card-labels` takes so rule summaries render
 * labels exactly as boards, the table and the agenda do — colour token, not a resolved CSS value.
 */
export function automationActionLabelChips(action: AutomationActionBody, lookups: AutomationLookups): CardLabelPresentation[] {
  return automationActionLabelIds(action).map((id) => {
    const label = lookups.labels.find((candidate) => candidate.id === id);
    return { id, name: label?.name ?? "Deleted label", color: label?.color ?? null };
  });
}

// ─── Summaries ────────────────────────────────────────────────────────────────

/** Collapse a name list to at most two, with a "+N" tail — the shared shape for every multi-target action. */
function truncatedNames(names: string[], emptyLabel: string): string {
  if (names.length === 0) return emptyLabel;
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function automationDueDateSummary(offsetDays: number, slot: DueDateSlot): string {
  const dayLabel =
    offsetDays === 0 ? "today"
      : offsetDays === 1 ? "tomorrow"
        : offsetDays === 7 ? "in 1 week"
          : offsetDays > 0 ? `in ${offsetDays} days`
            : `${Math.abs(offsetDays)} ${Math.abs(offsetDays) === 1 ? "day" : "days"} ago`;
  return slot === "anyTime" ? dayLabel : `${dayLabel}, ${automationDueSlotLabel(slot)}`;
}

/**
 * The rule's "when" clause, worded as prose.
 *
 * An unconfigured target reads as a noun phrase ("a list") rather than a control prompt
 * ("Choose list") because this sentence is read, not clicked.
 */
export function automationTriggerTargetLabel(automation: WireAutomation, lookups: AutomationLookups): string | null {
  if (automation.triggerType === "due_date_arrives") return null;
  if (automation.triggerType === "all_checklist_items_complete") return null;
  if (automation.triggerType === "card_marked_complete") return null;
  if (automation.triggerType === "card_label_set") {
    return automation.triggerLabelId ? automationTriggerLabelName(automation.triggerLabelId, lookups) : "a label";
  }
  if (automation.triggerType === "card_assigned_to_user") {
    return truncatedNames(automationTriggerUserIds(automation).map((id) => automationMemberName(id, lookups)), "selected users");
  }
  return lookups.lists.find((item) => item.id === automation.triggerListId)?.name ?? "a list";
}

export function automationPopulateValueLabel(action: AutomationActionBody, lookups: AutomationLookups): string {
  if (action.type !== "populate_custom_field") return "";
  const value = action.config.value;
  if (value.kind === "text") return value.text || "Text";
  if (value.kind === "number") return String(value.number);
  if (value.kind === "text_current_date") return automationPopulateTextDateFormatLabel(value.format);
  if (value.kind === "date") return value.source === "current" ? "Current date" : value.date;
  if (value.kind === "checkbox") return value.checked ? "Checked" : "Unchecked";
  if (value.kind === "select") {
    const field = automationSetCustomField(action, lookups);
    return truncatedNames(
      value.optionIds.map((id) => field?.options.find((option) => option.id === id)?.label ?? "Option"),
      "Choose option",
    );
  }
  if (value.kind === "user") {
    return truncatedNames(value.userIds.map((id) => automationMemberName(id, lookups)), "Choose members");
  }
  if (value.kind === "field") return value.sourceFieldId ? automationCustomFieldName(value.sourceFieldId, lookups) : "Choose field";
  return "";
}

/**
 * The collapsed summary renders one sentence per action — "Set Billing Month to Branch" — with only
 * the configured values emphasised, which is the shape ClickUp, Trello Butler and Notion all settle
 * on. Segments rather than one string is what lets the template carry that emphasis: the earlier
 * verb/value table needed two strong grey levels to read as columns and never got them, so a
 * sentence with one weight step replaces a layout with none.
 *
 * Label actions end on a trailing space and let k-card-labels finish the sentence — a label's
 * colour *is* the value, so no text stands in for it.
 */
export function automationActionSummarySegments(action: AutomationActionBody, lookups: AutomationLookups): AutomationSummarySegment[] {
  const plain = (text: string): AutomationSummarySegment => ({ text, strong: false });
  const value = (text: string): AutomationSummarySegment => ({ text, strong: true });

  if (action.type === "add_labels" || action.type === "remove_labels") {
    const verb = action.type === "add_labels" ? "Add" : "Remove";
    const count = action.config.labelIds.length;
    if (count === 0) return [plain(`${verb} label `), value("(choose labels)")];
    return [plain(`${verb} ${count === 1 ? "label" : "labels"} `)];
  }
  if (action.type === "add_assignees" || action.type === "remove_assignees") {
    const verb = action.type === "add_assignees" ? "Assign" : "Unassign";
    if (action.config.userIds.length === 0) return [plain(`${verb} `), value("(choose members)")];
    return [plain(`${verb} `), value(automationActionTargetLabel(action, lookups) ?? "")];
  }
  if (action.type === "apply_checklists") {
    if (action.config.templateIds.length === 0) return [plain("Apply "), value("(choose checklists)")];
    const count = action.config.templateIds.length;
    return [plain(`Apply ${count === 1 ? "checklist" : "checklists"} `), value(automationActionTargetLabel(action, lookups) ?? "")];
  }
  if (action.type === "move_to_list") {
    if (!action.config.listId) return [plain("Move to "), value("(choose list)")];
    const listName = lookups.lists.find((list) => list.id === action.config.listId)?.name ?? "list";
    return [plain("Move to "), value(listName), plain(", at the "), value(automationMovePlacementValue(action))];
  }
  if (action.type === "move_to_top") return [plain("Move to the top of its list")];
  if (action.type === "move_to_bottom") return [plain("Move to the bottom of its list")];
  if (action.type === "set_due_date") {
    return [plain("Set due date "), value(automationDueDateSummary(action.config.offsetDays, action.config.slot))];
  }
  if (action.type === "clear_due_date") return [plain("Clear the due date")];
  if (action.type === "populate_custom_field") {
    if (!action.config.fieldId) return [plain("Set "), value("(choose custom field)")];
    return [
      plain("Set "),
      value(automationCustomFieldName(action.config.fieldId, lookups)),
      plain(" to "),
      value(automationPopulateValueLabel(action, lookups)),
    ];
  }
  return [plain(action.config.completed ? "Mark complete" : "Mark incomplete")];
}

/** The value shown on an action's own control. Unlike the summary, unset reads as a prompt. */
export function automationActionTargetLabel(action: AutomationActionBody, lookups: AutomationLookups): string | null {
  if (action.type === "add_labels" || action.type === "remove_labels") {
    return action.config.labelIds[0] ? automationLabelName(action.config.labelIds[0], lookups) : "Choose label";
  }
  if (action.type === "add_assignees" || action.type === "remove_assignees") {
    return truncatedNames(action.config.userIds.map((id) => automationMemberName(id, lookups)), "Choose members");
  }
  if (action.type === "apply_checklists") {
    return truncatedNames(action.config.templateIds.map((id) => automationTemplateName(id, lookups)), "Choose checklists");
  }
  if (action.type === "move_to_list") {
    if (!action.config.listId) return "Choose list";
    const listName = lookups.lists.find((list) => list.id === action.config.listId)?.name ?? "list";
    return `${listName} · ${automationMovePlacementValue(action)}`;
  }
  if (action.type === "set_due_date") return automationDueDateSummary(action.config.offsetDays, action.config.slot);
  if (action.type === "populate_custom_field") {
    if (!action.config.fieldId) return "Choose custom field";
    return `${automationCustomFieldName(action.config.fieldId, lookups)} · ${automationPopulateValueLabel(action, lookups)}`;
  }
  return null;
}

export function automationActionLabelColor(action: AutomationActionBody, lookups: AutomationLookups): string | null {
  if (!isAutomationLabelAction(action)) return null;
  const labelId = automationActionTargetValue(action);
  const color = lookups.labels.find((label) => label.id === labelId)?.color;
  return color ? `var(--color-${color})` : "var(--border-strong)";
}

export function automationActionSummary(action: AutomationActionBody, lookups: AutomationLookups): string {
  if (action.type === "add_labels") return action.config.labelIds[0] ? `Add label ${automationLabelName(action.config.labelIds[0], lookups)}` : "Add label (choose label)";
  if (action.type === "remove_labels") return action.config.labelIds[0] ? `Remove label ${automationLabelName(action.config.labelIds[0], lookups)}` : "Remove label (choose label)";
  if (action.type === "add_assignees") return action.config.userIds.length ? `Assign ${automationActionTargetLabel(action, lookups)}` : "Assign (choose members)";
  if (action.type === "remove_assignees") return action.config.userIds.length ? `Unassign ${automationActionTargetLabel(action, lookups)}` : "Unassign (choose members)";
  if (action.type === "apply_checklists") return action.config.templateIds.length ? `Apply checklist ${automationActionTargetLabel(action, lookups)}` : "Apply checklist (choose checklists)";
  if (action.type === "move_to_list") {
    if (!action.config.listId) return "Move to list (choose list)";
    const listName = lookups.lists.find((list) => list.id === action.config.listId)?.name ?? "list";
    return `Move to ${listName} ${automationMovePlacementValue(action)}`;
  }
  if (action.type === "move_to_top") return "Move to top";
  if (action.type === "move_to_bottom") return "Move to bottom";
  if (action.type === "set_due_date") return `Set due date ${automationDueDateSummary(action.config.offsetDays, action.config.slot)}`;
  if (action.type === "clear_due_date") return "Clear due date";
  if (action.type === "populate_custom_field") {
    return action.config.fieldId
      ? `Set ${automationCustomFieldName(action.config.fieldId, lookups)} to ${automationPopulateValueLabel(action, lookups)}`
      : "Set custom field (choose field)";
  }
  return action.config.completed ? "Mark complete" : "Mark incomplete";
}

/**
 * Whether an action carries enough configuration to be saved.
 *
 * `populate_custom_field` is the involved case: the value's shape has to match the target field's
 * type, and a copy-from-field source only counts when it resolves to a *different* field of the
 * *same* type — otherwise the action would either no-op or copy a value onto itself.
 */
export function isAutomationActionComplete(action: AutomationActionBody, lookups: AutomationLookups): boolean {
  if (action.type === "add_labels" || action.type === "remove_labels") return action.config.labelIds.length > 0;
  if (action.type === "add_assignees" || action.type === "remove_assignees") return action.config.userIds.length > 0;
  if (action.type === "apply_checklists") return action.config.templateIds.length > 0;
  if (action.type === "move_to_list") return !!action.config.listId;
  if (action.type === "populate_custom_field") {
    if (!action.config.fieldId) return false;
    const field = automationSetCustomField(action, lookups);
    if (!field || !(automationSetCustomFieldTypes as readonly CustomFieldTypeName[]).includes(field.type)) return false;
    const value = action.config.value;
    if ((value.kind === "text" || value.kind === "text_current_date") && field.type !== "text") return false;
    if (value.kind === "number" && field.type !== "number") return false;
    if (value.kind === "date" && field.type !== "date") return false;
    if (value.kind === "checkbox" && field.type !== "checkbox") return false;
    if (value.kind === "select" && field.type !== "select") return false;
    if (value.kind === "user" && field.type !== "user") return false;
    if (value.kind === "text") return Boolean(value.text.trim());
    if (value.kind === "date" && value.source === "fixed") return /^\d{4}-\d{2}-\d{2}$/u.test(value.date);
    if (value.kind === "select") return value.optionIds.length > 0 && (field.allowMultiple || value.optionIds.length === 1);
    if (value.kind === "user") return value.userIds.length > 0 && (field.allowMultiple || value.userIds.length === 1);
    if (value.kind === "field") {
      const source = lookups.fields.find((candidate) => candidate.id === value.sourceFieldId) ?? null;
      return Boolean(source && source.type === field.type && source.id !== field.id);
    }
    return true;
  }
  return true;
}
