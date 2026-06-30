import { z } from "zod";

export const inviteWorkspaceGrantInput = z.object({
  workspaceId: z.uuid(),
  role: z.enum(["admin", "editor", "observer"]).default("editor"),
});
export type InviteWorkspaceGrantInput = z.infer<typeof inviteWorkspaceGrantInput>;

export const createInviteBody = z.object({
  orgRole: z.enum(["admin", "member"]).default("member"),
  workspaces: z.array(inviteWorkspaceGrantInput).default([]),
  expiresInDays: z.number().int().positive().max(365).nullable().optional(),
});
export type CreateInviteBody = z.infer<typeof createInviteBody>;

export const inviteSummaryResponse = z.object({
  orgName: z.string(),
  orgRole: z.enum(["owner", "admin", "member"]),
  workspaces: z.array(
    z.object({
      workspaceId: z.uuid(),
      workspaceName: z.string(),
      role: z.enum(["owner", "admin", "editor", "observer"]),
    }),
  ),
  expiresAt: z.string().nullable(),
});
export type InviteSummaryResponse = z.infer<typeof inviteSummaryResponse>;
