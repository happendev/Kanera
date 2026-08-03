import { z } from "zod";
import { CLIENT_ROLES } from "../schema/client-roles.js";
import { WORKSPACE_ROLES } from "../schema/member-roles.js";

export const inviteWorkspaceGrantInput = z.object({
  workspaceId: z.uuid(),
  role: z.enum(WORKSPACE_ROLES).default("member"),
});
export type InviteWorkspaceGrantInput = z.infer<typeof inviteWorkspaceGrantInput>;

export const createInviteBody = z.object({
  orgRole: z.enum(["admin", "member"]).default("member"),
  workspaces: z.array(inviteWorkspaceGrantInput).default([]),
  expiresInDays: z.number().int().positive().max(365).nullable().optional(),
});
export type CreateInviteBody = z.infer<typeof createInviteBody>;

export const acceptInviteBody = z.object({ token: z.string().min(1) });
export type AcceptInviteBody = z.infer<typeof acceptInviteBody>;

export const inviteSummaryResponse = z.object({
  orgName: z.string(),
  orgRole: z.enum(CLIENT_ROLES),
  workspaces: z.array(
    z.object({
      workspaceId: z.uuid(),
      workspaceName: z.string(),
      role: z.enum(WORKSPACE_ROLES),
    }),
  ),
  expiresAt: z.string().nullable(),
});
export type InviteSummaryResponse = z.infer<typeof inviteSummaryResponse>;
