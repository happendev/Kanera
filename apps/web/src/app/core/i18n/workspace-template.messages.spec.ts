import { localizeWorkspaceTemplate } from "@kanera/shared/workspace-template-localize";
import { WORKSPACE_TEMPLATES } from "@kanera/shared/workspace-templates";
import { describe, expect, it } from "vitest";
import { hasTemplateText, translateTemplateText } from "./workspace-template.messages";

describe("workspace template messages", () => {
  // Fails when template content changes without regenerating the catalog; the new string would
  // otherwise ship silently untranslated. Fix: pnpm --filter @kanera/web templates:messages
  it("has a message for every string a template can create", () => {
    const missing = new Set<string>();
    for (const template of WORKSPACE_TEMPLATES) {
      localizeWorkspaceTemplate(template, (text) => {
        if (!hasTemplateText(text)) missing.add(text);
        return text;
      });
    }
    expect([...missing]).toEqual([]);
  });

  it("falls back to the English text for unknown strings", () => {
    expect(translateTemplateText("Not a template string")).toBe("Not a template string");
  });

  it("keeps cross-references consistent with what they point at", () => {
    const tag = (text: string) => `«${text}»`;
    for (const template of WORKSPACE_TEMPLATES) {
      const localized = localizeWorkspaceTemplate(template, tag);
      const lists = new Set(localized.lists.map((list) => list.name));
      const labels = new Set(localized.labels.map((label) => label.name));
      const checklists = new Set((localized.checklistTemplates ?? []).map((checklist) => checklist.title));
      const fields = new Map(localized.customFields.map((field) => [field.name, new Set(field.options?.map((option) => option.label))]));
      for (const card of localized.cards ?? []) {
        expect(lists).toContain(card.listName);
        for (const name of card.labelNames ?? []) expect(labels).toContain(name);
        for (const title of card.checklistTemplateTitles ?? []) expect(checklists).toContain(title);
      }
      for (const automation of localized.automations ?? []) {
        if (automation.trigger.type === "card_enters_list") expect(lists).toContain(automation.trigger.listName);
        if (automation.trigger.type === "card_label_set") expect(labels).toContain(automation.trigger.labelName);
        for (const action of automation.actions) {
          if (action.type === "move_to_list") expect(lists).toContain(action.listName);
          if (action.type === "add_labels" || action.type === "remove_labels") for (const name of action.labelNames) expect(labels).toContain(name);
          if (action.type === "apply_checklists") for (const title of action.checklistTemplateTitles) expect(checklists).toContain(title);
          if (action.type === "populate_custom_field") {
            expect(fields.has(action.fieldName)).toBe(true);
            if (action.value.kind === "select") for (const option of action.value.optionLabels) expect(fields.get(action.fieldName)).toContain(option);
          }
        }
      }
      expect(localized.id).toBe(template.id);
      expect(localized.icon).toBe(template.icon);
    }
  });
});
