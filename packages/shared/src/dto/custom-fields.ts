import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

export const customFieldTypeSchema = z.enum([
  "text",
  "number",
  "checkbox",
  "select",
  "date",
  "url",
  "user",
]);
export type CustomFieldTypeName = z.infer<typeof customFieldTypeSchema>;

const optionSeedSchema = z.object({
  label: z.string().min(1).max(CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH),
  color: colorTokenSchema.nullable().optional(),
});

export const createCustomFieldBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
  icon: z.string().min(1).max(60).default("forms"),
  type: customFieldTypeSchema,
  allowMultiple: z.boolean().default(false),
  // Initial options for a `select` field; ignored for other types.
  options: z.array(optionSeedSchema).max(100).optional(),
});
export type CreateCustomFieldBody = z.infer<typeof createCustomFieldBody>;

export const updateCustomFieldBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
  icon: z.string().min(1).max(60).optional(),
  showOnCard: z.boolean().optional(),
  // Toggling multi→single is lossy; the server trims existing values to the first id.
  allowMultiple: z.boolean().optional(),
});
export type UpdateCustomFieldBody = z.infer<typeof updateCustomFieldBody>;

export const moveCustomFieldBody = z
  .object({
    afterFieldId: z.uuid().nullable().optional(),
    beforeFieldId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterFieldId !== undefined || v.beforeFieldId !== undefined,
    "provide afterFieldId or beforeFieldId",
  );
export type MoveCustomFieldBody = z.infer<typeof moveCustomFieldBody>;

export const createCustomFieldOptionBody = z.object({
  label: z.string().min(1).max(CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH),
  color: colorTokenSchema.nullable().optional(),
});
export type CreateCustomFieldOptionBody = z.infer<typeof createCustomFieldOptionBody>;

export const updateCustomFieldOptionBody = z.object({
  label: z.string().min(1).max(CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH).optional(),
  color: colorTokenSchema.nullable().optional(),
});
export type UpdateCustomFieldOptionBody = z.infer<typeof updateCustomFieldOptionBody>;

export const moveCustomFieldOptionBody = z
  .object({
    afterOptionId: z.uuid().nullable().optional(),
    beforeOptionId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterOptionId !== undefined || v.beforeOptionId !== undefined,
    "provide afterOptionId or beforeOptionId",
  );
export type MoveCustomFieldOptionBody = z.infer<typeof moveCustomFieldOptionBody>;

export const setCustomFieldValueBody = z
  .object({
    valueText: z.string().max(20000).nullable().optional(),
    valueNumber: z.union([z.number(), z.string()]).nullable().optional(),
    valueCheckbox: z.boolean().nullable().optional(),
    // Local date string YYYY-MM-DD.
    valueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .nullable()
      .optional(),
    valueUrl: z.url().max(2000).nullable().optional(),
    valueOptionIds: z.array(z.uuid()).nullable().optional(),
    valueUserIds: z.array(z.uuid()).nullable().optional(),
  })
  .refine(
    (v) =>
      v.valueText !== undefined ||
      v.valueNumber !== undefined ||
      v.valueCheckbox !== undefined ||
      v.valueDate !== undefined ||
      v.valueUrl !== undefined ||
      v.valueOptionIds !== undefined ||
      v.valueUserIds !== undefined,
    "provide a value",
  );
export type SetCustomFieldValueBody = z.infer<typeof setCustomFieldValueBody>;
