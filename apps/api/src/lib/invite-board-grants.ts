import type { InviteBoardGrantInput } from "@kanera/shared/dto";
import { boardMembers, boards, inviteBoardGrants, workspaceMembers, workspaces, type BoardMember, type WorkspaceMember } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type Tx } from "../db.js";
import { emitToBoard, emitToUser, emitToWorkspace } from "../realtime/emit.js";
import { badRequest } from "./errors.js";
import { withSignedMedia } from "./media-keys.js";

/**
 * Invite creation is organisation-admin only, and an organisation admin may grant any board of their
 * organisation, so the tenancy check is "every board belongs to this organisation". Archived boards
 * (or boards of an archived workspace) are refused because the person could not open them; boards
 * deleted later simply cascade away.
 */
export async function assertInviteBoardGrantsGrantable(
  clientId: string,
  orgRole: "admin" | "member",
  grants: InviteBoardGrantInput[],
): Promise<void> {
  if (grants.length === 0) return;
  // Organisation admins inherit pinned editor access to every board on acceptance, which overrides any
  // explicit role; storing grants for them would advertise access the invite cannot shape.
  if (orgRole === "admin") throw badRequest("organisation admins already have access to every board");
  const ids = grants.map((grant) => grant.boardId);
  if (new Set(ids).size !== ids.length) throw badRequest("duplicate board in invite");
  const owned = await db
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), inArray(boards.id, ids), isNull(boards.archivedAt), isNull(workspaces.archivedAt)));
  if (owned.length !== ids.length) throw badRequest("board not in your organisation");
}

export type AppliedInviteBoardGrants = {
  members: BoardMember[];
  workspaceMembers: WorkspaceMember[];
};

/**
 * Materialize an accepted invite's board grants for a new organisation member, inside the acceptance
 * transaction. Mirrors a direct add from the board members menu: an ordinary (unpinned) board row
 * plus a `member` workspace row, because Home and the sidebar discover a member's boards through
 * workspace membership (hidden for standalone boards, so no workspace concept leaks into the UI).
 * Existing rows win: a workspace-admin pin from this same invite, or a converted guest's grant, is
 * never downgraded by the invite's role.
 */
export async function applyInviteBoardGrantsInTx(
  tx: Tx,
  params: { inviteId: string; clientId: string; userId: string },
): Promise<AppliedInviteBoardGrants> {
  // Re-scoped to the inviting organisation at acceptance time as defence in depth; create already
  // validated it and grants for deleted boards no longer exist.
  const grants = await tx
    .select({ boardId: inviteBoardGrants.boardId, role: inviteBoardGrants.role, workspaceId: boards.workspaceId })
    .from(inviteBoardGrants)
    .innerJoin(boards, eq(boards.id, inviteBoardGrants.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(inviteBoardGrants.inviteId, params.inviteId), eq(workspaces.clientId, params.clientId)));
  if (grants.length === 0) return { members: [], workspaceMembers: [] };

  const workspaceIds = [...new Set(grants.map((grant) => grant.workspaceId))];
  const insertedWorkspaceMembers = await tx
    .insert(workspaceMembers)
    .values(workspaceIds.map((workspaceId) => ({ workspaceId, userId: params.userId, role: "member" as const })))
    .onConflictDoNothing()
    .returning();
  const insertedMembers = await tx
    .insert(boardMembers)
    .values(grants.map((grant) => ({ boardId: grant.boardId, userId: params.userId, role: grant.role })))
    .onConflictDoNothing()
    .returning();
  return { members: insertedMembers, workspaceMembers: insertedWorkspaceMembers };
}

/**
 * Same fanout as `emitBoardMemberAdded`: open board rosters and workspace member lists converge, and
 * the user-scoped copy reaches the new member's other sessions (sidebar, Home).
 */
export async function emitInviteBoardGrants(
  applied: AppliedInviteBoardGrants,
  user: {
    id: string;
    clientId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    lastOnlineAt?: Date | null;
    orgRole: "owner" | "admin" | "member";
  },
): Promise<void> {
  for (const workspaceMember of applied.workspaceMembers) {
    const member = withSignedMedia(user.clientId, {
      ...workspaceMember,
      orgRole: user.orgRole,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      lastOnlineAt: user.lastOnlineAt ?? null,
    });
    const payload = { workspaceId: workspaceMember.workspaceId, member };
    await emitToWorkspace(workspaceMember.workspaceId, "workspace:member:added", payload);
    emitToUser(user.id, "workspace:member:added", payload);
  }
  for (const member of applied.members) {
    const payload = {
      boardId: member.boardId,
      member,
      user: {
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: withSignedMedia(user.clientId, { avatarUrl: user.avatarUrl }).avatarUrl,
        lastOnlineAt: user.lastOnlineAt ?? null,
        role: member.role,
        source: "board" as const,
        clientId: user.clientId,
        isOrganisationMember: true,
      },
    };
    await emitToBoard(member.boardId, "board:member:added", payload);
    emitToUser(user.id, "board:member:added", payload);
  }
}
