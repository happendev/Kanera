import { TABLER_ICONS } from "@kanera/shared/icons";
import { DEFAULT_WORKSPACE_TEMPLATE, WORKSPACE_TEMPLATES } from "@kanera/shared/workspace-templates";
import assert from "node:assert/strict";
import { test } from "node:test";

// Templates reference lists, labels, checklists, and custom fields by name. The seeding route
// rejects the whole request when a name does not resolve, which would turn a typo in the shared
// template into a failed onboarding, so every reference is checked here against the same template.
const icons = new Set<string>(TABLER_ICONS);
const normalize = (name: string) => name.trim().toLocaleLowerCase();

for (const template of WORKSPACE_TEMPLATES) {
  void test(`workspace template ${template.id} is internally consistent`, () => {
    const lists = new Set(template.lists.map((list) => normalize(list.name)));
    const labels = new Set(template.labels.map((label) => normalize(label.name)));
    const checklists = new Set((template.checklistTemplates ?? []).map((checklist) => normalize(checklist.title)));
    const fieldOptions = new Map(
      template.customFields.map((field) => [normalize(field.name), new Set((field.options ?? []).map((option) => normalize(option.label)))]),
    );

    assert.ok(icons.has(template.icon), `template icon ${template.icon}`);
    for (const list of template.lists) assert.ok(icons.has(list.icon), `list icon ${list.icon}`);
    for (const field of template.customFields) assert.ok(icons.has(field.icon), `field icon ${field.icon}`);

    // Lists, labels, and fields are matched case-insensitively at seed time, so near-duplicates
    // would collapse into one row and leave later references pointing at the wrong entity.
    assert.equal(lists.size, template.lists.length, "duplicate list names");
    assert.equal(labels.size, template.labels.length, "duplicate label names");
    assert.equal(fieldOptions.size, template.customFields.length, "duplicate custom field names");
    assert.equal(checklists.size, template.checklistTemplates?.length ?? 0, "duplicate checklist titles");
    // The API refuses a workspace with exactly one list.
    assert.notEqual(template.lists.length, 1, "a template needs zero or at least two lists");
    for (const field of template.customFields) {
      if (field.type === "select") assert.ok((field.options?.length ?? 0) > 0, `select field ${field.name} needs options`);
    }

    for (const card of template.cards ?? []) {
      assert.ok(lists.has(normalize(card.listName)), `card "${card.title}" list ${card.listName}`);
      for (const name of card.labelNames ?? []) assert.ok(labels.has(normalize(name)), `card "${card.title}" label ${name}`);
      for (const title of card.checklistTemplateTitles ?? []) assert.ok(checklists.has(normalize(title)), `card "${card.title}" checklist ${title}`);
    }

    for (const automation of template.automations ?? []) {
      const trigger = automation.trigger;
      if (trigger.type === "card_enters_list") assert.ok(lists.has(normalize(trigger.listName)), `trigger list ${trigger.listName}`);
      if (trigger.type === "card_label_set") assert.ok(labels.has(normalize(trigger.labelName)), `trigger label ${trigger.labelName}`);
      assert.ok(automation.actions.length > 0, "automation without actions");
      for (const action of automation.actions) {
        switch (action.type) {
          case "add_labels":
          case "remove_labels":
            for (const name of action.labelNames) assert.ok(labels.has(normalize(name)), `action label ${name}`);
            break;
          case "apply_checklists":
            for (const title of action.checklistTemplateTitles) assert.ok(checklists.has(normalize(title)), `action checklist ${title}`);
            break;
          case "move_to_list":
            assert.ok(lists.has(normalize(action.listName)), `action list ${action.listName}`);
            if (trigger.type === "card_enters_list") {
              assert.notEqual(normalize(action.listName), normalize(trigger.listName), "move_to_list back into the trigger list would loop");
            }
            break;
          case "populate_custom_field": {
            const options = fieldOptions.get(normalize(action.fieldName));
            assert.ok(options, `action field ${action.fieldName}`);
            const field = template.customFields.find((candidate) => normalize(candidate.name) === normalize(action.fieldName))!;
            const expectedType = action.value.kind === "text_current_date" ? "text" : action.value.kind;
            assert.equal(field.type, expectedType, `action value kind for ${action.fieldName}`);
            if (action.value.kind === "select") {
              for (const label of action.value.optionLabels) assert.ok(options.has(normalize(label)), `action option ${label}`);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  });
}

void test("templates that seed starter cards also seed a board to hold them", () => {
  for (const template of WORKSPACE_TEMPLATES) {
    if (template.cards?.length) assert.ok(template.initialBoardName.trim().length > 0, template.id);
  }
});

void test("the default template stays compatible with DEFAULT_WORKSPACE_CUSTOM_FIELDS", () => {
  // default-workspace-custom-fields.ts narrows the default template's field types to the three the
  // fallback path can create without options; a select field here would be seeded without options.
  for (const field of DEFAULT_WORKSPACE_TEMPLATE.customFields) {
    assert.ok(["text", "number", "checkbox"].includes(field.type), `${field.name} is ${field.type}`);
  }
});
