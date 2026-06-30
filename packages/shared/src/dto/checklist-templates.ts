import { z } from "zod";

// Template editing is coarse-grained: items are sent as a whole array that fully
// replaces the stored set. These are low-frequency admin config edits, so this
// keeps both the API surface and the settings UI simple.

const templateItemText = z.string().trim().min(1).max(2000);

export const createChecklistTemplateBody = z.object({
  title: z.string().trim().min(1).max(500),
  items: z.array(templateItemText).max(200).default([]),
});
export type CreateChecklistTemplateBody = z.infer<typeof createChecklistTemplateBody>;

export const updateChecklistTemplateBody = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    items: z.array(templateItemText).max(200).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.items !== undefined,
    "provide a field to update",
  );
export type UpdateChecklistTemplateBody = z.infer<typeof updateChecklistTemplateBody>;

export const moveChecklistTemplateBody = z
  .object({
    afterTemplateId: z.uuid().nullable().optional(),
    beforeTemplateId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterTemplateId !== undefined || v.beforeTemplateId !== undefined,
    "provide afterTemplateId or beforeTemplateId",
  );
export type MoveChecklistTemplateBody = z.infer<typeof moveChecklistTemplateBody>;
