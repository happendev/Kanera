import type { ColorToken } from "./lib/colors.js";
import {
  WORKSPACE_TEMPLATES,
  type WorkspaceTemplate,
  type WorkspaceTemplateAutomation,
  type WorkspaceTemplateAutomationAction,
} from "./workspace-templates.js";

const normalizeSeedName = (name: string) => name.trim().toLocaleLowerCase();

export function findWorkspaceTemplate(id: string): WorkspaceTemplate | undefined {
  return WORKSPACE_TEMPLATES.find((template) => template.id === id);
}

const describeAutomationAction = (action: WorkspaceTemplateAutomationAction): string => {
  switch (action.type) {
    case "add_labels": return `add label${action.labelNames.length === 1 ? "" : "s"} ${action.labelNames.join(", ")}`;
    case "remove_labels": return `remove label${action.labelNames.length === 1 ? "" : "s"} ${action.labelNames.join(", ")}`;
    case "apply_checklists": return `apply checklist ${action.checklistTemplateTitles.join(", ")}`;
    case "set_due_date": return `set due date ${action.offsetDays >= 0 ? "+" : ""}${action.offsetDays} days`;
    case "clear_due_date": return "clear due date";
    case "move_to_top": return "move to top";
    case "move_to_bottom": return "move to bottom";
    case "set_completion": return action.completed ? "mark complete" : "mark incomplete";
    case "move_to_list": return `move to ${action.listName}`;
    case "populate_custom_field": {
      const value = action.value;
      const rendered = value.kind === "text" ? `"${value.text}"`
        : value.kind === "text_current_date" ? `the current ${value.format.replace(/_/g, " ")}`
        : value.kind === "number" ? String(value.number)
        : value.kind === "date" ? (value.source === "current" ? "today" : value.date)
        : value.kind === "checkbox" ? (value.checked ? "checked" : "unchecked")
        : value.optionLabels.join(", ");
      return `set ${action.fieldName} to ${rendered}${action.onlyIfEmpty === false ? "" : " if empty"}`;
    }
  }
};

/**
 * One-line, human-readable rendering of a template automation ("When a card enters Done: mark
 * complete"). Used wherever a template is previewed before creation so people and agents can see
 * what the recipes will do, not just how many there are.
 */
export function describeWorkspaceTemplateAutomation(automation: WorkspaceTemplateAutomation): string {
  const trigger = automation.trigger;
  const when = trigger.type === "card_enters_list" ? `When a card enters ${trigger.listName}`
    : trigger.type === "due_date_arrives" ? "When a card's due date arrives"
    : trigger.type === "card_becomes_inactive" ? "When a card becomes inactive"
    : trigger.type === "all_checklist_items_complete" ? "When every checklist item is complete"
    : trigger.type === "card_marked_complete" ? "When a card is marked complete"
    : `When the ${trigger.labelName} label is set`;
  return `${when}: ${automation.actions.map(describeAutomationAction).join("; ")}`;
}

/**
 * Seed content (checklists, starter cards, automations) for a template, narrowed to whatever lists,
 * labels, and custom fields the caller actually kept. Shared by web onboarding, the standalone
 * board dialog, and the MCP/CLI bootstrap tools so every entry point produces the same request.
 */
export function workspaceTemplateSeedPayload(
  template: WorkspaceTemplate,
  availableListNames = template.lists.map((list) => list.name),
  availableLabelNames = template.labels.map((label) => label.name),
  availableCustomFields = template.customFields.map((field) => ({
    name: field.name,
    options: field.options?.map((option) => option.label) ?? [],
  })),
) {
  const availableLists = new Set(availableListNames.map(normalizeSeedName));
  const availableLabels = new Set(availableLabelNames.map(normalizeSeedName));
  const customFieldsByName = new Map(
    availableCustomFields.map((field) => [normalizeSeedName(field.name), new Set(field.options.map(normalizeSeedName))]),
  );
  const automations = (template.automations ?? []).flatMap((automation) => {
    if (automation.trigger.type === "card_enters_list" && !availableLists.has(normalizeSeedName(automation.trigger.listName))) return [];
    if (automation.trigger.type === "card_label_set" && !availableLabels.has(normalizeSeedName(automation.trigger.labelName))) return [];

    const actions = automation.actions.flatMap<WorkspaceTemplateAutomationAction>((action) => {
      if (action.type === "move_to_list") {
        return availableLists.has(normalizeSeedName(action.listName)) ? [action] : [];
      }
      if (action.type === "add_labels" || action.type === "remove_labels") {
        const labelNames = action.labelNames.filter((name) => availableLabels.has(normalizeSeedName(name)));
        return labelNames.length > 0 ? [{ ...action, labelNames }] : [];
      }
      if (action.type === "populate_custom_field") {
        const optionLabels = customFieldsByName.get(normalizeSeedName(action.fieldName));
        if (!optionLabels) return [];
        if (action.value.kind !== "select") return [action];
        const selectedOptions = action.value.optionLabels.filter((label) => optionLabels.has(normalizeSeedName(label)));
        return selectedOptions.length > 0
          ? [{ ...action, value: { ...action.value, optionLabels: selectedOptions } }]
          : [];
      }
      return [action];
    });
    return actions.length > 0 ? [{ ...automation, actions }] : [];
  });
  return {
    checklistTemplates: template.checklistTemplates ?? [],
    // Callers may remove preset lists and labels. Do not let optional starter content make that
    // customization invalid: omit cards whose lane was removed and strip only the removed labels
    // from cards that still have a destination.
    cards: (template.cards ?? [])
      .filter((card) => availableLists.has(normalizeSeedName(card.listName)))
      .map((card) => ({
        ...card,
        ...(card.labelNames
          ? { labelNames: card.labelNames.filter((name) => availableLabels.has(normalizeSeedName(name))) }
          : {}),
      })),
    // Automation recipes use human-readable references in the shared template. As with starter
    // cards, drop only rules or actions made invalid by customization.
    automations,
  };
}

// Standalone creation is available from first-run onboarding, the in-app dialog, and agents via
// MCP/CLI. Keep the request in one place so every entry point seeds the exact same template.
export function standaloneBoardCreatePayload(
  name: string,
  template: WorkspaceTemplate,
  identity: { icon?: string; iconColor?: ColorToken | null } = {},
) {
  const icon = identity.icon ?? template.icon;
  return {
    kind: "board" as const,
    name,
    icon,
    initialBoard: {
      name,
      icon,
      ...(identity.iconColor !== undefined ? { iconColor: identity.iconColor } : {}),
    },
    lists: template.lists,
    customFields: template.customFields,
    labels: template.labels,
    ...workspaceTemplateSeedPayload(template),
  };
}
