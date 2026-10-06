import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";
import { createIconSchema, DEFAULT_LIST_ICON, updateIconSchema } from "./_icons.js";
import { LIST_WIP_LIMIT_MAX } from "../lib/workspace-defaults.js";

/** Advisory work-in-progress limit per board column; null clears it. Matches `lists_wip_limit_ck`. */
export { LIST_WIP_LIMIT_MAX };
export const listWipLimitSchema = z.number().int().min(1).max(LIST_WIP_LIMIT_MAX).nullable();

export const createListBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
  icon: createIconSchema(DEFAULT_LIST_ICON),
  color: colorTokenSchema.nullable().optional(),
  /** Cards in an in-progress list count as actively being worked on and carry a time-in-progress clock. */
  inProgress: z.boolean().optional(),
  wipLimit: listWipLimitSchema.optional(),
});
export type CreateListBody = z.infer<typeof createListBody>;

export const updateListBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
  icon: updateIconSchema(DEFAULT_LIST_ICON),
  color: colorTokenSchema.nullable().optional(),
  inProgress: z.boolean().optional(),
  wipLimit: listWipLimitSchema.optional(),
});
export type UpdateListBody = z.infer<typeof updateListBody>;

export const moveListCardsBody = z.object({
  targetListId: z.uuid(),
  boardId: z.uuid().optional(),
});
export type MoveListCardsBody = z.infer<typeof moveListCardsBody>;

export const archiveListCardsBody = z.object({
  boardId: z.uuid().optional(),
});
export type ArchiveListCardsBody = z.infer<typeof archiveListCardsBody>;

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
