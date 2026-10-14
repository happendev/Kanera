import type {
  WorkspaceTemplate,
  WorkspaceTemplateAutomation,
  WorkspaceTemplateAutomationAction,
  WorkspaceTemplateAutomationTrigger,
} from "./workspace-templates.js";

/** What a template string is, so a translation catalog can tell translators where it appears. */
export type WorkspaceTemplateTextKind =
  | "template name"
  | "template description"
  | "workspace name"
  | "board name"
  | "list name"
  | "custom field name"
  | "custom field option"
  | "custom field value"
  | "label name"
  | "checklist title"
  | "checklist item"
  | "example card title"
  | "example card description";

export type WorkspaceTemplateTranslate = (text: string, kind: WorkspaceTemplateTextKind) => string;

/**
 * Returns a copy of `template` with every human-readable string passed through `translate`, so the
 * workspace a person creates is in their language. Automations and starter cards refer to lists,
 * labels, fields, options and checklists by name, so those references go through `translate` too:
 * the same English always maps to the same translation, which keeps every reference resolvable.
 * Ids, icons, colours, types, enum values and formats are left untouched.
 */
export function localizeWorkspaceTemplate(template: WorkspaceTemplate, translate: WorkspaceTemplateTranslate): WorkspaceTemplate {
  const list = (name: string) => translate(name, "list name");
  const label = (name: string) => translate(name, "label name");
  const checklist = (title: string) => translate(title, "checklist title");

  const trigger = (value: WorkspaceTemplateAutomationTrigger): WorkspaceTemplateAutomationTrigger => {
    if (value.type === "card_enters_list") return { ...value, listName: list(value.listName) };
    if (value.type === "card_label_set") return { ...value, labelName: label(value.labelName) };
    return { ...value };
  };

  const action = (value: WorkspaceTemplateAutomationAction): WorkspaceTemplateAutomationAction => {
    switch (value.type) {
      case "add_labels":
      case "remove_labels":
        return { ...value, labelNames: value.labelNames.map(label) };
      case "apply_checklists":
        return { ...value, checklistTemplateTitles: value.checklistTemplateTitles.map(checklist) };
      case "move_to_list":
        return { ...value, listName: list(value.listName) };
      case "populate_custom_field": {
        const fieldValue = value.value;
        return {
          ...value,
          fieldName: translate(value.fieldName, "custom field name"),
          value: fieldValue.kind === "select"
            ? { ...fieldValue, optionLabels: fieldValue.optionLabels.map((option) => translate(option, "custom field option")) }
            : fieldValue.kind === "text"
              ? { ...fieldValue, text: translate(fieldValue.text, "custom field value") }
              : { ...fieldValue },
        };
      }
      default:
        return { ...value };
    }
  };

  const automation = (value: WorkspaceTemplateAutomation): WorkspaceTemplateAutomation => ({
    trigger: trigger(value.trigger),
    actions: value.actions.map(action),
  });

  return {
    ...template,
    name: translate(template.name, "template name"),
    description: translate(template.description, "template description"),
    workspaceName: translate(template.workspaceName, "workspace name"),
    initialBoardName: translate(template.initialBoardName, "board name"),
    lists: template.lists.map((item) => ({ ...item, name: list(item.name) })),
    customFields: template.customFields.map((field) => ({
      ...field,
      name: translate(field.name, "custom field name"),
      ...(field.options
        ? { options: field.options.map((option) => ({ ...option, label: translate(option.label, "custom field option") })) }
        : {}),
    })),
    labels: template.labels.map((item) => ({ ...item, name: label(item.name) })),
    ...(template.checklistTemplates
      ? {
        checklistTemplates: template.checklistTemplates.map((item) => ({
          title: checklist(item.title),
          items: item.items.map((text) => translate(text, "checklist item")),
        })),
      }
      : {}),
    ...(template.cards
      ? {
        cards: template.cards.map((card) => ({
          ...card,
          title: translate(card.title, "example card title"),
          ...(card.description !== undefined ? { description: translate(card.description, "example card description") } : {}),
          listName: list(card.listName),
          ...(card.labelNames ? { labelNames: card.labelNames.map(label) } : {}),
          ...(card.checklistTemplateTitles ? { checklistTemplateTitles: card.checklistTemplateTitles.map(checklist) } : {}),
        })),
      }
      : {}),
    ...(template.automations ? { automations: template.automations.map(automation) } : {}),
  };
}
