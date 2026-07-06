import { z } from "zod";

export const createBoardInvitationBody = z.object({
  email: z.email(),
  role: z.enum(["editor", "observer"]).default("editor"),
  assignedItemsOnly: z.boolean().default(false),
  expiresInDays: z.number().int().positive().max(365).nullable().optional(),
});
export type CreateBoardInvitationBody = z.infer<typeof createBoardInvitationBody>;

export const boardInvitationLookupResponse = z.object({
  id: z.uuid(),
  boardId: z.string(),
  boardName: z.string(),
  workspaceName: z.string(),
  clientName: z.string(),
  role: z.enum(["editor", "observer"]),
  assignedItemsOnly: z.boolean(),
  expiresAt: z.string().nullable(),
  boards: z.array(z.object({
    boardId: z.string(),
    boardName: z.string(),
    workspaceName: z.string(),
    role: z.enum(["editor", "observer"]),
    assignedItemsOnly: z.boolean(),
  })).optional(),
});
export type BoardInvitationLookupResponse = z.infer<typeof boardInvitationLookupResponse>;

export const acceptBoardInvitationResponse = z.object({
  boardId: z.string(),
  boardIds: z.array(z.string()).optional(),
});
export type AcceptBoardInvitationResponse = z.infer<typeof acceptBoardInvitationResponse>;
