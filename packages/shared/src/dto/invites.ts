import { z } from "zod";
import { CLIENT_ROLES } from "../schema/client-roles.js";
import { BOARD_ROLES, WORKSPACE_ROLES } from "../schema/member-roles.js";

export const inviteWorkspaceGrantInput = z.object({
  workspaceId: z.uuid(),
  role: z.enum(WORKSPACE_ROLES).default("member"),
});
export type InviteWorkspaceGrantInput = z.infer<typeof inviteWorkspaceGrantInput>;

// Board access granted on acceptance. Workspace membership alone opens no board content, so an
// invite that should land someone on a board names it here. Organisation admins inherit every board,
// so the API rejects board grants on admin invites rather than storing rows that would never apply.
export const inviteBoardGrantInput = z.object({
  boardId: z.uuid(),
  role: z.enum(BOARD_ROLES).default("editor"),
});
export type InviteBoardGrantInput = z.infer<typeof inviteBoardGrantInput>;

export const createInviteBody = z.object({
  orgRole: z.enum(["admin", "member"]).default("member"),
  // Both lists may be empty: an organisation-only invite is valid (a standalone-board account has no
  // workspaces to offer).
  workspaces: z.array(inviteWorkspaceGrantInput).default([]),
  boards: z.array(inviteBoardGrantInput).max(500).default([]),
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
