import type { AutomationActionBody, CustomFieldTypeName, DueDateSlot } from "@kanera/shared/dto";
import type { WireAutomation, WireCardLabel, WireChecklistTemplate, WireCustomField } from "@kanera/shared/events";
import type { List } from "@kanera/shared/schema";
import { icu } from "../../../core/i18n/icu";
import type { CardLabelPresentation } from "../../board/card-labels.component";

type PopulateCustomFieldAction = Extract<AutomationActionBody, { type: "populate_custom_field" }>;
type PopulateCustomFieldValue = PopulateCustomFieldAction["config"]["value"];
export type PopulateTextDateFormat = Extract<PopulateCustomFieldValue, { kind: "text_current_date" }>["format"];

/** One fragment of an automation's summary sentence. `strong` marks a configured value, not grammar. */
export type AutomationSummarySegment = { text: string; strong: boolean };

export const automationActionTypes = ["add_labels", "remove_labels", "add_assignees", "remove_assignees", "apply_checklists", "set_due_date", "clear_due_date", "set_completion", "move_to_list", "move_to_top", "move_to_bottom", "populate_custom_field", "post_comment", "call_webhook"] as const;
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
  // Generic webhook endpoints a call_webhook action can target. Only admins load these, which is
  // fine: the automations tab is admin-only too.
  webhooks: readonly { id: string; name: string }[];
}

/** Placeholders the post_comment template accepts; shown as hints in the editor. */
export const automationCommentTemplateVariables = [
  { token: "{{card.title}}", label: $localize`:Comment template placeholder:Card title` },
  { token: "{{card.key}}", label: $localize`:Comment template placeholder:Card key` },
  { token: "{{card.url}}", label: $localize`:Comment template placeholder:Card link` },
  { token: "{{card.dueDate}}", label: $localize`:Comment template placeholder:Due date` },
  { token: "{{list.name}}", label: $localize`:Comment template placeholder — the list name:List` },
  { token: "{{board.name}}", label: $localize`:Comment template placeholder — the board name:Board` },
  { token: "{{workspace.name}}", label: $localize`:Comment template placeholder — the workspace name:Workspace` },
] as const;

function automationWebhookName(id: string, lookups: AutomationLookups): string {
  return lookups.webhooks.find((hook) => hook.id === id)?.name ?? $localize`Deleted webhook`;
}

/** First line of the comment template, shortened, for collapsed summaries. */
function automationCommentPreview(template: string, max = 60): string {
  const firstLine = template.trim().split(/\r?\n/u)[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
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
  if (action.type === "call_webhook") return action.config.endpointId;
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
  if (slot === "anyTime") return $localize`:Due date time of day:Any time`;
  if (slot === "endOfWorkDay") return $localize`:Due date time of day:End of workday`;
  if (slot === "morning") return $localize`:Due date time of day:Morning`;
  return $localize`:Due date time of day:Afternoon`;
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
  // Display labels for the formats: a translator may localise the pattern letters (JJJJ-MM in German),
  // but the value written to the card is decided by the server, not by this label.
  if (format === "month") return $localize`:Date format option (year-month), e.g. 2026-10:YYYY-MM`;
  if (format === "month_long_short_year") return $localize`:Date format option (month name and 2-digit year), e.g. October 26:MMMM yy`;
  if (format === "month_long_year") return $localize`:Date format option (month name and year), e.g. October 2026:MMMM yyyy`;
  if (format === "datetime") return $localize`:Date format option (date and time), e.g. 2026-10-14 09.30:YYYY-MM-DD HH:mm`;
  return $localize`:Date format option (year-month-day), e.g. 2026-10-14:YYYY-MM-DD`;
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
  if (action.type === "post_comment") return "ti-message-plus";
  if (action.type === "call_webhook") return "ti-webhook";
  return action.config.completed ? "ti-circle-check" : "ti-circle-dashed";
}

export function automationActionIconClass(action: AutomationActionBody): string {
  return `ti ${automationActionIcon(action)}`;
}

// ─── Name resolution ──────────────────────────────────────────────────────────

export function automationLabelName(id: string, lookups: AutomationLookups): string {
  return lookups.labels.find((label) => label.id === id)?.name ?? $localize`:Stand-in for an unknown card label:Label`;
}

/** Distinct from `automationLabelName`: a trigger naming a deleted label must say so, not read as configured. */
export function automationTriggerLabelName(id: string, lookups: AutomationLookups): string {
  return lookups.labels.find((label) => label.id === id)?.name ?? $localize`Deleted label`;
}

export function automationMemberName(id: string, lookups: AutomationLookups): string {
  return lookups.members.find((member) => member.userId === id)?.displayName ?? $localize`:Stand-in for an unknown member:Member`;
}

export function automationTemplateName(id: string, lookups: AutomationLookups): string {
  return lookups.templates.find((template) => template.id === id)?.title ?? $localize`:Stand-in for an unknown checklist template:Checklist`;
}

export function automationCustomFieldName(id: string, lookups: AutomationLookups): string {
  return lookups.fields.find((field) => field.id === id)?.name ?? $localize`:Stand-in for an unknown custom field:Custom field`;
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
    return { id, name: label?.name ?? $localize`Deleted label`, color: label?.color ?? null };
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
  const days = Math.abs(offsetDays);
  const dayLabel =
    offsetDays === 0 ? $localize`:Automation due date, relative to the run:today`
      : offsetDays === 1 ? $localize`:Automation due date, relative to the run:tomorrow`
        : offsetDays === 7 ? $localize`:Automation due date, relative to the run:in 1 week`
          : offsetDays > 0 ? icu($localize`:Automation due date, relative to the run:{days, plural, one {in # day} other {in # days}}`, { days })
            : icu($localize`:Automation due date, relative to the run:{days, plural, one {# day ago} other {# days ago}}`, { days });
  return slot === "anyTime" ? dayLabel : $localize`:Automation due date then the time of day, e.g. tomorrow, Morning:${dayLabel}:day:, ${automationDueSlotLabel(slot)}:timeOfDay:`;
}

/** "top" / "bottom", as the placement reads inside a sentence. */
function automationMovePlacementLabel(action: AutomationActionBody): string {
  return automationMovePlacementValue(action) === "top"
    ? $localize`:Position in a list, inside a sentence (Move to Done, at the top):top`
    : $localize`:Position in a list, inside a sentence (Move to Done, at the bottom):bottom`;
}

/**
 * The rule's "when" clause, worded as prose.
 *
 * An unconfigured target reads as a noun phrase ("a list") rather than a control prompt
 * ("Choose list") because this sentence is read, not clicked.
 */
export function automationTriggerTargetLabel(automation: WireAutomation, lookups: AutomationLookups): string | null {
  if (automation.triggerType === "due_date_arrives") return null;
  if (automation.triggerType === "start_date_arrives") return null;
  if (automation.triggerType === "due_date_approaching") {
    const days = automation.triggerDaysBefore ?? 1;
    return icu($localize`:Automation trigger target:{days, plural, one {# day before} other {# days before}}`, { days });
  }
  if (automation.triggerType === "card_becomes_inactive") return null;
  if (automation.triggerType === "card_in_progress_too_long") {
    if (automation.triggerThresholdSource === "fixed" && automation.triggerThresholdAmount) {
      const count = automation.triggerThresholdAmount;
      return automation.triggerThresholdUnit === "hours"
        ? icu($localize`:Automation trigger target - a card in progress longer than this:{count, plural, one {over # hour} other {over # hours}}`, { count })
        : icu($localize`:Automation trigger target - a card in progress longer than this:{count, plural, one {over # day} other {over # days}}`, { count });
    }
    if (automation.triggerThresholdSource === "custom_field") {
      const field = lookups.fields.find((item) => item.id === automation.triggerCustomFieldId);
      return field
        ? $localize`:Automation trigger target - tracked time passed the value of the named number field, e.g. over Estimate:over ${field.name}:field:`
        : $localize`:Unconfigured automation trigger target:a number field`;
    }
    // The workspace alert is shown in the trigger's own help text.
    return null;
  }
  if (automation.triggerType === "all_checklist_items_complete") return null;
  if (automation.triggerType === "card_marked_complete") return null;
  if (automation.triggerType === "card_unblocked" || automation.triggerType === "card_blocked") return null;
  // Scheduling triggers are derived from the board's dependency graph; there is nothing to pick.
  if (automation.triggerType === "scheduling_conflict_appears" || automation.triggerType === "critical_path_slips") return null;
  if (automation.triggerType === "card_label_set") {
    return automation.triggerLabelId ? automationTriggerLabelName(automation.triggerLabelId, lookups) : $localize`:Unconfigured automation trigger target:a label`;
  }
  if (automation.triggerType === "card_assigned_to_user") {
    return truncatedNames(automationTriggerUserIds(automation).map((id) => automationMemberName(id, lookups)), $localize`:Unconfigured automation trigger target:selected users`);
  }
  if (automation.triggerType === "custom_field_value_changed") {
    const field = lookups.fields.find((item) => item.id === automation.triggerCustomFieldId);
    const value = automation.triggerCustomFieldValue;
    if (!field || !value) return $localize`:Unconfigured automation trigger target:a selected value`;
    const rendered = value.kind === "text" ? value.text
      : value.kind === "number" ? String(value.number)
      : value.kind === "checkbox" ? (value.checked ? $localize`:Checkbox custom field value:Checked` : $localize`:Checkbox custom field value:Unchecked`)
      : value.kind === "date" ? value.date
      : value.kind === "url" ? value.url
      : value.kind === "select" ? field.options.find((option) => option.id === value.optionId)?.label ?? $localize`Deleted option`
      : automationMemberName(value.userId, lookups);
    return `${field.name} = ${rendered}`;
  }
  return lookups.lists.find((item) => item.id === automation.triggerListId)?.name ?? $localize`:Unconfigured automation trigger target:a list`;
}

export function automationPopulateValueLabel(action: AutomationActionBody, lookups: AutomationLookups): string {
  if (action.type !== "populate_custom_field") return "";
  const value = action.config.value;
  if (value.kind === "text") return value.text || $localize`:Stand-in for empty text to write into a field:Text`;
  if (value.kind === "number") return String(value.number);
  if (value.kind === "text_current_date") return automationPopulateTextDateFormatLabel(value.format);
  if (value.kind === "date") return value.source === "current" ? $localize`:Value written by an automation — the date it runs:Current date` : value.date;
  if (value.kind === "checkbox") return value.checked ? $localize`:Checkbox custom field value:Checked` : $localize`:Checkbox custom field value:Unchecked`;
  if (value.kind === "select") {
    const field = automationSetCustomField(action, lookups);
    return truncatedNames(
      value.optionIds.map((id) => field?.options.find((option) => option.id === id)?.label ?? $localize`:Stand-in for an unknown select option:Option`),
      $localize`Choose option`,
    );
  }
  if (value.kind === "user") {
    return truncatedNames(value.userIds.map((id) => automationMemberName(id, lookups)), $localize`Choose members`);
  }
  if (value.kind === "field") return value.sourceFieldId ? automationCustomFieldName(value.sourceFieldId, lookups) : $localize`:Select placeholder — custom field:Choose field`;
  return "";
}

/**
 * Splits a translated summary message into segments. Each `{name}` in `values` becomes a strong
 * segment carrying that value; every other ICU argument (counts) is evaluated as usual. Values go
 * through markers rather than straight into the text, so a "{" or "#" in a user's list or field name
 * stays literal and the template can still emphasise exactly the configured values.
 */
function summarySegments(message: string, values: Record<string, string>, counts: Record<string, number> = {}): AutomationSummarySegment[] {
  const names = Object.keys(values);
  const markers = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]));
  const segments: AutomationSummarySegment[] = [];
  icu(message, { ...counts, ...markers }).split("\u0000").forEach((part, i) => {
    if (i % 2 === 1) segments.push({ text: values[names[Number(part)]!] ?? "", strong: true });
    else if (part) segments.push({ text: part, strong: false });
  });
  return segments;
}

/**
 * The collapsed summary renders one sentence per action — "Set Billing Month to Branch" — with only
 * the configured values emphasised, which is the shape ClickUp, Trello Butler and Notion all settle
 * on. Segments rather than one string is what lets the template carry that emphasis: the earlier
 * verb/value table needed two strong grey levels to read as columns and never got them, so a
 * sentence with one weight step replaces a layout with none.
 *
 * Each sentence is one translatable message with `{value}` arguments (see `summarySegments`), so a
 * translator can move the emphasised values wherever their grammar needs them.
 *
 * Label actions end on a trailing space and let k-card-labels finish the sentence — a label's
 * colour *is* the value, so no text stands in for it.
 */
export function automationActionSummarySegments(action: AutomationActionBody, lookups: AutomationLookups): AutomationSummarySegment[] {
  if (action.type === "add_labels" || action.type === "remove_labels") {
    const count = action.config.labelIds.length;
    if (count === 0) {
      return action.type === "add_labels"
        ? summarySegments($localize`:Automation action summary, not yet configured:Add label {choose}`, { choose: $localize`:Prompt inside an automation summary:(choose labels)` })
        : summarySegments($localize`:Automation action summary, not yet configured:Remove label {choose}`, { choose: $localize`:Prompt inside an automation summary:(choose labels)` });
    }
    // The label chips follow this text and finish the sentence.
    const verb = action.type === "add_labels"
      ? icu($localize`:Automation action summary; coloured label chips follow:{count, plural, one {Add label} other {Add labels}}`, { count })
      : icu($localize`:Automation action summary; coloured label chips follow:{count, plural, one {Remove label} other {Remove labels}}`, { count });
    return [{ text: `${verb} `, strong: false }];
  }
  if (action.type === "add_assignees" || action.type === "remove_assignees") {
    const configured = action.config.userIds.length > 0;
    const members = configured ? automationActionTargetLabel(action, lookups) ?? "" : $localize`:Prompt inside an automation summary:(choose members)`;
    return action.type === "add_assignees"
      ? summarySegments($localize`:Automation action summary:Assign {members}`, { members })
      : summarySegments($localize`:Automation action summary:Unassign {members}`, { members });
  }
  if (action.type === "apply_checklists") {
    const count = action.config.templateIds.length;
    if (count === 0) return summarySegments($localize`:Automation action summary, not yet configured:Apply {choose}`, { choose: $localize`:Prompt inside an automation summary:(choose checklists)` });
    return summarySegments(
      $localize`:Automation action summary:{count, plural, one {Apply checklist {checklists}} other {Apply checklists {checklists}}}`,
      { checklists: automationActionTargetLabel(action, lookups) ?? "" },
      { count },
    );
  }
  if (action.type === "move_to_list") {
    if (!action.config.listId) return summarySegments($localize`:Automation action summary, not yet configured:Move to {choose}`, { choose: $localize`:Prompt inside an automation summary:(choose list)` });
    const listName = lookups.lists.find((list) => list.id === action.config.listId)?.name ?? $localize`:Stand-in for an unknown list:list`;
    return summarySegments($localize`:Automation action summary, e.g. Move to Done, at the bottom:Move to {list}, at the {placement}`, { list: listName, placement: automationMovePlacementLabel(action) });
  }
  if (action.type === "move_to_top") return [{ text: $localize`:Automation action summary:Move to the top of its list`, strong: false }];
  if (action.type === "move_to_bottom") return [{ text: $localize`:Automation action summary:Move to the bottom of its list`, strong: false }];
  if (action.type === "set_due_date") {
    return summarySegments($localize`:Automation action summary, e.g. Set due date tomorrow:Set due date {when}`, { when: automationDueDateSummary(action.config.offsetDays, action.config.slot) });
  }
  if (action.type === "clear_due_date") return [{ text: $localize`:Automation action summary:Clear the due date`, strong: false }];
  if (action.type === "populate_custom_field") {
    if (!action.config.fieldId) return summarySegments($localize`:Automation action summary, not yet configured:Set {choose}`, { choose: $localize`:Prompt inside an automation summary:(choose custom field)` });
    return summarySegments($localize`:Automation action summary, e.g. Set Billing Month to YYYY-MM:Set {field} to {value}`, {
      field: automationCustomFieldName(action.config.fieldId, lookups),
      value: automationPopulateValueLabel(action, lookups),
    });
  }
  if (action.type === "post_comment") {
    const preview = automationCommentPreview(action.config.template);
    return summarySegments($localize`:Automation action summary; the comment follows:Post comment {comment}`, {
      comment: preview ? `“${preview}”` : $localize`:Prompt inside an automation summary:(write the comment)`,
    });
  }
  if (action.type === "call_webhook") {
    const endpoint = action.config.endpointId ? automationWebhookName(action.config.endpointId, lookups) : $localize`:Prompt inside an automation summary:(choose endpoint)`;
    return summarySegments($localize`:Automation action summary; the webhook name follows:Call webhook {endpoint}`, { endpoint });
  }
  return [{ text: action.config.completed ? $localize`:Automation action summary:Mark complete` : $localize`:Automation action summary:Mark incomplete`, strong: false }];
}

/** The value shown on an action's own control. Unlike the summary, unset reads as a prompt. */
export function automationActionTargetLabel(action: AutomationActionBody, lookups: AutomationLookups): string | null {
  if (action.type === "add_labels" || action.type === "remove_labels") {
    return action.config.labelIds[0] ? automationLabelName(action.config.labelIds[0], lookups) : $localize`Choose label`;
  }
  if (action.type === "add_assignees" || action.type === "remove_assignees") {
    return truncatedNames(action.config.userIds.map((id) => automationMemberName(id, lookups)), $localize`Choose members`);
  }
  if (action.type === "apply_checklists") {
    return truncatedNames(action.config.templateIds.map((id) => automationTemplateName(id, lookups)), $localize`Choose checklists`);
  }
  if (action.type === "move_to_list") {
    if (!action.config.listId) return $localize`:Select placeholder:Choose list`;
    const listName = lookups.lists.find((list) => list.id === action.config.listId)?.name ?? $localize`:Stand-in for an unknown list:list`;
    return `${listName} · ${automationMovePlacementLabel(action)}`;
  }
  if (action.type === "set_due_date") return automationDueDateSummary(action.config.offsetDays, action.config.slot);
  if (action.type === "populate_custom_field") {
    if (!action.config.fieldId) return $localize`Choose custom field`;
    return `${automationCustomFieldName(action.config.fieldId, lookups)} · ${automationPopulateValueLabel(action, lookups)}`;
  }
  if (action.type === "post_comment") return automationCommentPreview(action.config.template) || $localize`Write the comment`;
  if (action.type === "call_webhook") return action.config.endpointId ? automationWebhookName(action.config.endpointId, lookups) : $localize`:Select placeholder — webhook endpoint:Choose endpoint`;
  return null;
}

export function automationActionLabelColor(action: AutomationActionBody, lookups: AutomationLookups): string | null {
  if (!isAutomationLabelAction(action)) return null;
  const labelId = automationActionTargetValue(action);
  const color = lookups.labels.find((label) => label.id === labelId)?.color;
  return color ? `var(--color-${color})` : "var(--border-strong)";
}

export function automationActionSummary(action: AutomationActionBody, lookups: AutomationLookups): string {
  if (action.type === "add_labels") return action.config.labelIds[0] ? $localize`:Automation action summary:Add label ${automationLabelName(action.config.labelIds[0], lookups)}:label:` : $localize`:Automation action summary, not yet configured:Add label (choose label)`;
  if (action.type === "remove_labels") return action.config.labelIds[0] ? $localize`:Automation action summary:Remove label ${automationLabelName(action.config.labelIds[0], lookups)}:label:` : $localize`:Automation action summary, not yet configured:Remove label (choose label)`;
  if (action.type === "add_assignees") return action.config.userIds.length ? $localize`:Automation action summary:Assign ${automationActionTargetLabel(action, lookups)}:members:` : $localize`:Automation action summary, not yet configured:Assign (choose members)`;
  if (action.type === "remove_assignees") return action.config.userIds.length ? $localize`:Automation action summary:Unassign ${automationActionTargetLabel(action, lookups)}:members:` : $localize`:Automation action summary, not yet configured:Unassign (choose members)`;
  if (action.type === "apply_checklists") return action.config.templateIds.length ? $localize`:Automation action summary:Apply checklist ${automationActionTargetLabel(action, lookups)}:checklists:` : $localize`:Automation action summary, not yet configured:Apply checklist (choose checklists)`;
  if (action.type === "move_to_list") {
    if (!action.config.listId) return $localize`:Automation action summary, not yet configured:Move to list (choose list)`;
    const listName = lookups.lists.find((list) => list.id === action.config.listId)?.name ?? $localize`:Stand-in for an unknown list:list`;
    return $localize`:Automation action summary, e.g. Move to Done bottom:Move to ${listName}:list: ${automationMovePlacementLabel(action)}:placement:`;
  }
  if (action.type === "move_to_top") return $localize`:Automation action summary:Move to top`;
  if (action.type === "move_to_bottom") return $localize`:Automation action summary:Move to bottom`;
  if (action.type === "set_due_date") return $localize`:Automation action summary, e.g. Set due date tomorrow:Set due date ${automationDueDateSummary(action.config.offsetDays, action.config.slot)}:when:`;
  if (action.type === "clear_due_date") return $localize`:Automation action summary:Clear due date`;
  if (action.type === "populate_custom_field") {
    return action.config.fieldId
      ? $localize`:Automation action summary:Set ${automationCustomFieldName(action.config.fieldId, lookups)}:field: to ${automationPopulateValueLabel(action, lookups)}:value:`
      : $localize`:Automation action summary, not yet configured:Set custom field (choose field)`;
  }
  if (action.type === "post_comment") {
    const preview = automationCommentPreview(action.config.template);
    return preview ? $localize`:Automation action summary:Post comment “${preview}:comment:”` : $localize`:Automation action summary, not yet configured:Post comment (write the comment)`;
  }
  if (action.type === "call_webhook") {
    return action.config.endpointId ? $localize`:Automation action summary:Call webhook ${automationWebhookName(action.config.endpointId, lookups)}:endpoint:` : $localize`:Automation action summary, not yet configured:Call webhook (choose endpoint)`;
  }
  return action.config.completed ? $localize`:Automation action summary:Mark complete` : $localize`:Automation action summary:Mark incomplete`;
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
  if (action.type === "post_comment") return Boolean(action.config.template.trim());
  // The endpoint must still exist: the API rejects an id it cannot find in the workspace.
  if (action.type === "call_webhook") return Boolean(action.config.endpointId) && lookups.webhooks.some((hook) => hook.id === action.config.endpointId);
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
