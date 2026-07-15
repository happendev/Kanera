import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { customFieldTypeSchema } from "./custom-fields.js";
import { CARD_LABEL_NAME_MAX_LENGTH, CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH, GENERAL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

const normalizeWorkspaceCustomFieldName = (name: string) => name.trim().toLocaleLowerCase();

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
