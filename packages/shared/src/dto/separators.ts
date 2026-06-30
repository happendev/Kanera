import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";

export const separatorAnchorItem = z.object({
  type: z.enum(["card", "separator"]),
  id: z.uuid(),
});
export type SeparatorAnchorItem = z.infer<typeof separatorAnchorItem>;

export const createSeparatorBody = z.object({
  title: z.string().max(500).optional(),
  color: colorTokenSchema.nullable().optional(),
  atTop: z.boolean().optional(),
});
export type CreateSeparatorBody = z.infer<typeof createSeparatorBody>;

export const updateSeparatorBody = z.object({
  title: z.string().max(500).optional(),
  color: colorTokenSchema.nullable().optional(),
}).refine((v) => v.title !== undefined || v.color !== undefined, "provide title or color");
export type UpdateSeparatorBody = z.infer<typeof updateSeparatorBody>;

export const moveSeparatorBody = z
  .object({
    listId: z.uuid(),
    afterItem: separatorAnchorItem.nullable().optional(),
    beforeItem: separatorAnchorItem.nullable().optional(),
  })
  .refine(
    (v) => v.afterItem !== undefined || v.beforeItem !== undefined,
    "provide afterItem or beforeItem",
  );
export type MoveSeparatorBody = z.infer<typeof moveSeparatorBody>;
