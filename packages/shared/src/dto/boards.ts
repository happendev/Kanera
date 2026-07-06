import { z } from "zod";
import { colorTokenSchema, gradientTokenSchema } from "./_colors.js";
import { GENERAL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

export const createBoardBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
  groupId: z.uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().min(1).max(60).nullable().optional(),
  iconColor: colorTokenSchema.nullable().optional(),
  backgroundGradient: gradientTokenSchema.nullable().optional(),
});
export type CreateBoardBody = z.infer<typeof createBoardBody>;

export const updateBoardBody = z.object({
  name: z.string().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
  groupId: z.uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().min(1).max(60).nullable().optional(),
  iconColor: colorTokenSchema.nullable().optional(),
  backgroundGradient: gradientTokenSchema.nullable().optional(),
});
export type UpdateBoardBody = z.infer<typeof updateBoardBody>;

export const updateBoardBackgroundBody = z.object({
  backgroundGradient: gradientTokenSchema.nullable(),
});
export type UpdateBoardBackgroundBody = z.infer<typeof updateBoardBackgroundBody>;

export const moveBoardBody = z.object({
  beforeBoardId: z.uuid().nullable().optional(),
  afterBoardId: z.uuid().nullable().optional(),
});
export type MoveBoardBody = z.infer<typeof moveBoardBody>;

export const createBoardGroupBody = z.object({
  title: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
});
export type CreateBoardGroupBody = z.infer<typeof createBoardGroupBody>;

export const updateBoardGroupBody = z.object({
  title: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
});
export type UpdateBoardGroupBody = z.infer<typeof updateBoardGroupBody>;

export const moveBoardGroupBody = z.object({
  beforeGroupId: z.uuid().nullable().optional(),
  afterGroupId: z.uuid().nullable().optional(),
});
export type MoveBoardGroupBody = z.infer<typeof moveBoardGroupBody>;

export const addBoardMemberBody = z.object({
  userId: z.uuid(),
  role: z.enum(["editor", "observer"]).default("editor"),
  assignedItemsOnly: z.boolean().default(false),
});
export type AddBoardMemberBody = z.infer<typeof addBoardMemberBody>;

export const updateBoardMemberBody = z.object({
  role: z.enum(["editor", "observer"]),
  assignedItemsOnly: z.boolean().optional(),
});
export type UpdateBoardMemberBody = z.infer<typeof updateBoardMemberBody>;
