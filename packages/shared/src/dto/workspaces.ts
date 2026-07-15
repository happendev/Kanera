import { z } from "zod";
import { AUTOMATION_ACTION_LIMIT, AUTOMATION_LIMIT } from "../automation-limits.js";
import { colorTokenSchema } from "./_colors.js";
import { dueDateSlot } from "./cards.js";
import { customFieldTypeSchema } from "./custom-fields.js";
import { CARD_LABEL_NAME_MAX_LENGTH, CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH, GENERAL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

const normalizeWorkspaceCustomFieldName = (name: string) => name.trim().toLocaleLowerCase();
const normalizeWorkspaceSeedName = (name: string) => name.trim().toLocaleLowerCase();

const initialChecklistTemplate = z.object({
  title: z.string().trim().min(1).max(500),
  items: z.array(z.string().trim().min(1).max(2000)).max(200),
});

const initialCard = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50000).optional(),
  listName: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
  labelNames: z.array(z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH)).max(16).optional(),
  checklistTemplateTitles: z.array(z.string().trim().min(1).max(500)).max(16).optional(),
});

const initialAutomationTrigger = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("card_enters_list"),
    listName: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
    applyOnCreate: z.boolean().default(true),
    applyOnMove: z.boolean().default(true),
  }),
  z.object({ type: z.literal("due_date_arrives") }),
  z.object({ type: z.literal("all_checklist_items_complete") }),
  z.object({ type: z.literal("card_marked_complete") }),
  z.object({
    type: z.literal("card_label_set"),
    labelName: z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH),
  }),
]);

const initialPopulateCustomFieldValue = z.union([
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(20000) }),
  z.object({
    kind: z.literal("text_current_date"),
    format: z.enum(["date", "month", "month_long_short_year", "month_long_year", "datetime"]),
  }),
  z.object({ kind: z.literal("number"), number: z.number() }),
  z.object({
    kind: z.literal("date"),
    source: z.literal("fixed"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  }),
  z.object({ kind: z.literal("date"), source: z.literal("current") }),
  z.object({ kind: z.literal("checkbox"), checked: z.boolean() }),
  z.object({
    kind: z.literal("select"),
    optionLabels: z.array(z.string().trim().min(1).max(CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH)).min(1).max(100),
  }),
]);

const initialAutomationAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_labels"),
    labelNames: z.array(z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH)).min(1).max(100),
  }),
  z.object({
    type: z.literal("remove_labels"),
    labelNames: z.array(z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH)).min(1).max(100),
  }),
  z.object({
    type: z.literal("apply_checklists"),
    checklistTemplateTitles: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  }),
  z.object({
    type: z.literal("set_due_date"),
    offsetDays: z.number().int().min(-3650).max(3650),
    slot: dueDateSlot.default("anyTime"),
  }),
  z.object({ type: z.literal("clear_due_date") }),
  z.object({ type: z.literal("set_completion"), completed: z.boolean() }),
  z.object({
    type: z.literal("move_to_list"),
    listName: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
    placement: z.enum(["top", "bottom"]).default("bottom"),
  }),
  z.object({ type: z.literal("move_to_top") }),
  z.object({ type: z.literal("move_to_bottom") }),
  z.object({
    type: z.literal("populate_custom_field"),
    fieldName: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
    onlyIfEmpty: z.boolean().default(true),
    value: initialPopulateCustomFieldValue,
  }),
]);

const initialAutomation = z.object({
  trigger: initialAutomationTrigger,
  actions: z.array(initialAutomationAction).min(1).max(AUTOMATION_ACTION_LIMIT),
});

export const createWorkspaceBody = z
  .object({
    name: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
    kind: z.enum(["standard", "board"]).default("standard"),
    icon: z.string().min(1).max(60).nullable().optional(),
    initialBoard: z.object({
      name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
      icon: z.string().min(1).max(60).nullable().optional(),
      iconColor: colorTokenSchema.nullable().optional(),
    }).optional(),
    listNames: z.array(z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH)).min(2).max(32).optional(),
    lists: z.array(z.object({
      name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
      icon: z.string().min(1).max(60).nullable().optional(),
    }))
      .max(32)
      .refine((value) => value.length === 0 || value.length >= 2, "lists must be empty or contain at least 2 items")
      .optional(),
    customFields: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
          icon: z.string().min(1).max(60).default("forms"),
          type: customFieldTypeSchema,
          allowMultiple: z.boolean().default(false),
          options: z.array(z.object({
            label: z.string().min(1).max(CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH),
            color: colorTokenSchema.nullable().optional(),
          })).max(100).optional(),
        }),
      )
      .max(32)
      .optional(),
    labels: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH),
          color: colorTokenSchema.nullable().optional(),
        }),
      )
      .max(64)
      .optional(),
    checklistTemplates: z.array(initialChecklistTemplate).max(32).optional(),
    cards: z.array(initialCard).max(64).optional(),
    automations: z.array(initialAutomation).max(AUTOMATION_LIMIT).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "board" && !value.initialBoard) {
      ctx.addIssue({
        code: "custom",
        message: "initialBoard is required for a standalone board",
        path: ["initialBoard"],
        input: value.initialBoard,
      });
    }
    const seen = new Set<string>();
    for (const [index, field] of (value.customFields ?? []).entries()) {
      const normalizedName = normalizeWorkspaceCustomFieldName(field.name);
      if (seen.has(normalizedName)) {
        ctx.addIssue({
          code: "custom",
          message: "custom field names must be unique within a workspace",
          path: ["customFields", index, "name"],
          input: field.name,
        });
      }
      seen.add(normalizedName);
    }

    if ((value.cards?.length ?? 0) > 0 && !value.initialBoard) {
      ctx.addIssue({
        code: "custom",
        message: "initialBoard is required when seeding cards",
        path: ["initialBoard"],
        input: value.initialBoard,
      });
    }

    const checklistTitles = new Set<string>();
    for (const [index, template] of (value.checklistTemplates ?? []).entries()) {
      const normalizedTitle = normalizeWorkspaceSeedName(template.title);
      if (checklistTitles.has(normalizedTitle)) {
        ctx.addIssue({
          code: "custom",
          message: "checklist template titles must be unique within the seed content",
          path: ["checklistTemplates", index, "title"],
          input: template.title,
        });
      }
      checklistTitles.add(normalizedTitle);
    }

    const explicitListNames = value.lists?.map((list) => list.name) ?? value.listNames;
    const availableLists = explicitListNames
      ? new Set(explicitListNames.map(normalizeWorkspaceSeedName))
      : null;
    const availableLabels = value.labels
      ? new Set(value.labels.map((label) => normalizeWorkspaceSeedName(label.name)))
      : null;
    const hasNamedSeedReferences = (value.cards?.length ?? 0) > 0 || (value.automations?.length ?? 0) > 0;
    if (hasNamedSeedReferences && explicitListNames && availableLists!.size !== explicitListNames.length) {
      ctx.addIssue({
        code: "custom",
        message: "seeded list names must be unique when seed content references them",
        path: [value.lists ? "lists" : "listNames"],
        input: explicitListNames,
      });
    }
    if (hasNamedSeedReferences && value.labels && availableLabels!.size !== value.labels.length) {
      ctx.addIssue({
        code: "custom",
        message: "seeded label names must be unique when seed content references them",
        path: ["labels"],
        input: value.labels,
      });
    }
    for (const [cardIndex, card] of (value.cards ?? []).entries()) {
      if (availableLists && !availableLists.has(normalizeWorkspaceSeedName(card.listName))) {
        ctx.addIssue({
          code: "custom",
          message: "starter card listName must reference a seeded list",
          path: ["cards", cardIndex, "listName"],
          input: card.listName,
        });
      }
      for (const [labelIndex, labelName] of (card.labelNames ?? []).entries()) {
        if (availableLabels && !availableLabels.has(normalizeWorkspaceSeedName(labelName))) {
          ctx.addIssue({
            code: "custom",
            message: "starter card labelNames must reference seeded labels",
            path: ["cards", cardIndex, "labelNames", labelIndex],
            input: labelName,
          });
        }
      }
      const cardLabelNames = (card.labelNames ?? []).map(normalizeWorkspaceSeedName);
      if (new Set(cardLabelNames).size !== cardLabelNames.length) {
        ctx.addIssue({
          code: "custom",
          message: "starter card labelNames must not contain duplicates",
          path: ["cards", cardIndex, "labelNames"],
          input: card.labelNames,
        });
      }
      for (const [templateIndex, title] of (card.checklistTemplateTitles ?? []).entries()) {
        if (!checklistTitles.has(normalizeWorkspaceSeedName(title))) {
          ctx.addIssue({
            code: "custom",
            message: "starter card checklistTemplateTitles must reference a seeded checklist template",
            path: ["cards", cardIndex, "checklistTemplateTitles", templateIndex],
            input: title,
          });
        }
      }
    }

    for (const [automationIndex, automation] of (value.automations ?? []).entries()) {
      const { trigger } = automation;
      if (trigger.type === "card_enters_list" && availableLists && !availableLists.has(normalizeWorkspaceSeedName(trigger.listName))) {
        ctx.addIssue({
          code: "custom",
          message: "automation trigger listName must reference a seeded list",
          path: ["automations", automationIndex, "trigger", "listName"],
          input: trigger.listName,
        });
      }
      if (trigger.type === "card_label_set" && availableLabels && !availableLabels.has(normalizeWorkspaceSeedName(trigger.labelName))) {
        ctx.addIssue({
          code: "custom",
          message: "automation trigger labelName must reference a seeded label",
          path: ["automations", automationIndex, "trigger", "labelName"],
          input: trigger.labelName,
        });
      }
      for (const [actionIndex, action] of automation.actions.entries()) {
        if (action.type === "move_to_list" && availableLists && !availableLists.has(normalizeWorkspaceSeedName(action.listName))) {
          ctx.addIssue({
            code: "custom",
            message: "automation action listName must reference a seeded list",
            path: ["automations", automationIndex, "actions", actionIndex, "listName"],
            input: action.listName,
          });
        }
        if (action.type === "add_labels" || action.type === "remove_labels") {
          for (const [labelIndex, labelName] of action.labelNames.entries()) {
            if (availableLabels && !availableLabels.has(normalizeWorkspaceSeedName(labelName))) {
              ctx.addIssue({
                code: "custom",
                message: "automation action labelNames must reference seeded labels",
                path: ["automations", automationIndex, "actions", actionIndex, "labelNames", labelIndex],
                input: labelName,
              });
            }
          }
        }
        if (action.type === "apply_checklists") {
          for (const [templateIndex, title] of action.checklistTemplateTitles.entries()) {
            if (!checklistTitles.has(normalizeWorkspaceSeedName(title))) {
              ctx.addIssue({
                code: "custom",
                message: "automation action checklistTemplateTitles must reference a seeded checklist template",
                path: ["automations", automationIndex, "actions", actionIndex, "checklistTemplateTitles", templateIndex],
                input: title,
              });
            }
          }
        }
        if (action.type === "populate_custom_field" && value.customFields) {
          const field = value.customFields.find(
            (candidate) => normalizeWorkspaceCustomFieldName(candidate.name) === normalizeWorkspaceCustomFieldName(action.fieldName),
          );
          if (!field) {
            ctx.addIssue({
              code: "custom",
              message: "automation action fieldName must reference a seeded custom field",
              path: ["automations", automationIndex, "actions", actionIndex, "fieldName"],
              input: action.fieldName,
            });
            continue;
          }
          const { value: fieldValue } = action;
          const matchingType =
            ((fieldValue.kind === "text" || fieldValue.kind === "text_current_date") && field.type === "text") ||
            (fieldValue.kind === "number" && field.type === "number") ||
            (fieldValue.kind === "date" && field.type === "date") ||
            (fieldValue.kind === "checkbox" && field.type === "checkbox") ||
            (fieldValue.kind === "select" && field.type === "select");
          if (!matchingType) {
            ctx.addIssue({
              code: "custom",
              message: "automation custom field value must match the seeded field type",
              path: ["automations", automationIndex, "actions", actionIndex, "value"],
              input: fieldValue,
            });
          }
          if (fieldValue.kind === "select" && field.type === "select") {
            const optionLabels = new Set((field.options ?? []).map((option) => normalizeWorkspaceSeedName(option.label)));
            for (const [optionIndex, optionLabel] of fieldValue.optionLabels.entries()) {
              if (!optionLabels.has(normalizeWorkspaceSeedName(optionLabel))) {
                ctx.addIssue({
                  code: "custom",
                  message: "automation select optionLabels must reference seeded custom field options",
                  path: ["automations", automationIndex, "actions", actionIndex, "value", "optionLabels", optionIndex],
                  input: optionLabel,
                });
              }
            }
            if (!field.allowMultiple && fieldValue.optionLabels.length > 1) {
              ctx.addIssue({
                code: "custom",
                message: "automation expected a single option for this custom field",
                path: ["automations", automationIndex, "actions", actionIndex, "value", "optionLabels"],
                input: fieldValue.optionLabels,
              });
            }
          }
        }
      }
    }
  });
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBody>;

export const updateWorkspaceBody = z.object({
  name: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  icon: z.string().min(1).max(60).nullable().optional(),
  accentColor: colorTokenSchema.nullable().optional(),
  completedCardsActiveDays: z.number().int().min(0).max(365).optional(),
});
export type UpdateWorkspaceBody = z.infer<typeof updateWorkspaceBody>;

export const updateWorkspaceMemberBody = z.object({
  role: z.enum(["admin", "member"]),
});
export type UpdateWorkspaceMemberBody = z.infer<typeof updateWorkspaceMemberBody>;

export const addWorkspaceMemberBody = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "member"]).default("member"),
});
export type AddWorkspaceMemberBody = z.infer<typeof addWorkspaceMemberBody>;
