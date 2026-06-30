import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

export const createListBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
  icon: z.string().min(1).max(60).nullable().optional(),
  color: colorTokenSchema.nullable().optional(),
});
export type CreateListBody = z.infer<typeof createListBody>;

export const updateListBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
  icon: z.string().min(1).max(60).nullable().optional(),
  color: colorTokenSchema.nullable().optional(),
});
export type UpdateListBody = z.infer<typeof updateListBody>;

export const moveListCardsBody = z.object({
  targetListId: z.uuid(),
});
export type MoveListCardsBody = z.infer<typeof moveListCardsBody>;

export const moveListBody = z
  .object({
    afterListId: z.uuid().nullable().optional(),
    beforeListId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterListId !== undefined || v.beforeListId !== undefined,
    "provide afterListId or beforeListId",
  );
export type MoveListBody = z.infer<typeof moveListBody>;
