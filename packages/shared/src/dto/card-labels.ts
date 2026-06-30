import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { CARD_LABEL_NAME_MAX_LENGTH } from "./name-limits.js";

export const createCardLabelBody = z.object({
  name: z.string().min(1).max(CARD_LABEL_NAME_MAX_LENGTH),
  color: colorTokenSchema.nullable().optional(),
});
export type CreateCardLabelBody = z.infer<typeof createCardLabelBody>;

export const updateCardLabelBody = z.object({
  name: z.string().min(1).max(CARD_LABEL_NAME_MAX_LENGTH).optional(),
  color: colorTokenSchema.nullable().optional(),
});
export type UpdateCardLabelBody = z.infer<typeof updateCardLabelBody>;

export const moveCardLabelBody = z
  .object({
    afterLabelId: z.uuid().nullable().optional(),
    beforeLabelId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterLabelId !== undefined || v.beforeLabelId !== undefined,
    "provide afterLabelId or beforeLabelId",
  );
export type MoveCardLabelBody = z.infer<typeof moveCardLabelBody>;

export const setCardLabelsBody = z.object({
  labelIds: z.array(z.uuid()),
});
export type SetCardLabelsBody = z.infer<typeof setCardLabelsBody>;
