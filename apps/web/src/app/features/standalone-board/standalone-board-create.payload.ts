import type { ColorToken } from "@kanera/shared/colors";
import type { WorkspaceTemplate, WorkspaceTemplateAutomationAction } from "@kanera/shared/workspace-templates";

const normalizeSeedName = (name: string) => name.trim().toLocaleLowerCase();

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
    // Workspace onboarding allows users to remove preset lists and labels. Do not let optional
    // starter content make that customization invalid: omit cards whose lane was removed and
    // strip only the removed labels from cards that still have a destination.
    cards: (template.cards ?? [])
      .filter((card) => availableLists.has(normalizeSeedName(card.listName)))
      .map((card) => ({
        ...card,
        ...(card.labelNames
          ? { labelNames: card.labelNames.filter((name) => availableLabels.has(normalizeSeedName(name))) }
          : {}),
      })),
    // Automation recipes use human-readable references in the shared template. As with starter
    // cards, drop only rules or actions made invalid by workspace onboarding customization.
    automations,
  };
}

// Standalone creation is available from both first-run onboarding and the in-app dialog. Keep the
// request in one place so both entry points always seed the exact same onboarding template.
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
