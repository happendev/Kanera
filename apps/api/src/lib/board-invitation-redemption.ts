import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { boardInvitationGrants, boardInvitations, boardMembers, boards, clients, workspaces } from "@kanera/shared/schema";
import { db, type Db } from "../db.js";
import { captureWorkspaceMemberJoined } from "./analytics-milestones.js";
import { assertGuestBoardLimitForBoards } from "./board-guest-limits.js";
import { badRequest, forbidden } from "./errors.js";
import { notifyAdminsBoardInviteAccepted } from "./invite-accepted-notifications.js";
import { withSignedMedia } from "./media-keys.js";
import { hashOpaqueToken } from "./tokens.js";
import { emitToBoard, emitToUser } from "../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type RedeemableBoardInvitation = {
  id: string;
  boardId: string;
  boardName: string;
  // Carried so the primary-board fallback can apply the same archived filter as grant rows
  // without a second query. An invitation row stays valid while live bundled grants remain.
  boardArchivedAt: Date | null;
  role: "editor" | "observer";
  assignedItemsOnly: boolean;
  email: string;
  invitedById: string;
  hostClientId: string;
  orgName: string;
  workspaceId: string;
  workspaceName: string;
  expiresAt: Date | null;
};

export type BoardInvitationGrant = {
  boardId: string;
  boardName: string;
  workspaceId: string;
  workspaceName: string;
  role: "editor" | "observer";
  assignedItemsOnly: boolean;
};

export async function loadRedeemableBoardInvitation(
  selector: { token: string } | { id: string },
  tx?: Tx,
): Promise<RedeemableBoardInvitation | null> {
  const executor = tx ?? db;
  const query = executor
    .select({
      id: boardInvitations.id,
      boardId: boardInvitations.boardId,
      boardName: boards.name,
      boardArchivedAt: boards.archivedAt,
      role: boardInvitations.role,
      assignedItemsOnly: boardInvitations.assignedItemsOnly,
      email: boardInvitations.email,
      invitedById: boardInvitations.invitedById,
      hostClientId: workspaces.clientId,
      orgName: clients.name,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      expiresAt: boardInvitations.expiresAt,
    })
    .from(boardInvitations)
    .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(and(
      "token" in selector
        ? eq(boardInvitations.tokenHash, hashOpaqueToken(selector.token))
        : eq(boardInvitations.id, selector.id),
      isNull(boardInvitations.revokedAt),
      isNull(boardInvitations.acceptedAt),
      sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
    ))
    .limit(1);
  // Transactional callers are acceptance paths. Locking the invitation row makes the live-state
  // revalidation authoritative when two tabs try to redeem the same token concurrently.
  const rows = tx ? await query.for("update", { of: boardInvitations }) : await query;
  return rows[0] ?? null;
}

export async function loadBoardInvitationGrants(
  invitation: RedeemableBoardInvitation,
  tx: Tx = db,
): Promise<BoardInvitationGrant[]> {
  const grants = await tx
    .select({
      boardId: boardInvitationGrants.boardId,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
      workspaceName: workspaces.name,
      role: boardInvitationGrants.role,
      assignedItemsOnly: boardInvitationGrants.assignedItemsOnly,
    })
    .from(boardInvitationGrants)
    .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(boardInvitationGrants.invitationId, invitation.id), isNull(boards.archivedAt)))
    .orderBy(asc(boards.position));
  if (grants.length > 0) return grants;
  // The primary-board fallback must apply the same archived filter as grant rows. An invitation
  // whose every board is archived is dead: returning [] lets callers reject it (lookup 404s,
  // pending lists omit it, redemption refuses) instead of granting access to an unreachable board.
  if (invitation.boardArchivedAt) return [];
  return [{
    boardId: invitation.boardId,
    boardName: invitation.boardName,
    workspaceId: invitation.workspaceId,
    workspaceName: invitation.workspaceName,
    role: invitation.role,
    assignedItemsOnly: invitation.assignedItemsOnly,
  }];
}

export async function redeemBoardInvitationInTx(
  tx: Tx,
  params: {
    invitation: RedeemableBoardInvitation;
    grants: BoardInvitationGrant[];
    userId: string;
    // The redeemer's email and home organisation. Both eligibility invariants are asserted here as
    // a last line of defence so a future caller of this shared helper cannot silently reintroduce
    // redeem-for-the-wrong-mailbox or guest-rows-for-org-members; callers keep their earlier,
    // friendlier pre-checks for UX.
    redeemerEmail: string;
    targetClientId: string;
    createdById?: string;
  },
): Promise<void> {
  if (params.invitation.email.toLowerCase() !== params.redeemerEmail.toLowerCase()) {
    throw forbidden("this invitation was sent to a different email address");
  }
  // board_members rows are for cross-organisation guests only (durable product invariant). A
  // redeemer whose home org IS the host org already has member access; granting guest rows would
  // corrupt rosters and seat accounting.
  if (params.invitation.hostClientId === params.targetClientId) {
    throw badRequest("users already in this organisation cannot accept board guest invites");
  }
  if (params.grants.length === 0) {
    throw badRequest("The invited boards are no longer available.");
  }
  // Capacity allocation, every membership grant, and the acceptance stamp are one unit: a bundled
  // invite must never commit partially or leave a newly-created guest account without its board.
  await assertGuestBoardLimitForBoards({
    hostClientId: params.invitation.hostClientId,
    boardIds: params.grants.map((grant) => grant.boardId),
    userId: params.userId,
    targetClientId: params.targetClientId,
    createdById: params.createdById,
    tx,
  });
  await tx
    .insert(boardMembers)
    .values(params.grants.map((grant) => ({
      boardId: grant.boardId,
      userId: params.userId,
      role: grant.role,
      assignedItemsOnly: grant.assignedItemsOnly,
    })))
    .onConflictDoUpdate({
      target: [boardMembers.boardId, boardMembers.userId],
      set: { role: sql`excluded.role`, assignedItemsOnly: sql`excluded.assigned_items_only` },
    });
  await tx
    .update(boardInvitations)
    .set({ acceptedAt: new Date(), acceptedByUserId: params.userId })
    .where(and(eq(boardInvitations.id, params.invitation.id), isNull(boardInvitations.acceptedAt)));
}

export async function emitBoardInvitationAccepted(
  app: FastifyInstance,
  params: {
    invitation: RedeemableBoardInvitation;
    grants: BoardInvitationGrant[];
    user: {
      id: string;
      clientId: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
    };
    supportSession?: boolean;
  },
): Promise<void> {
  await captureWorkspaceMemberJoined({
    organizationId: params.invitation.hostClientId,
    workspaceIds: [...new Set(params.grants.map((grant) => grant.workspaceId))],
    actorId: params.user.id,
    joinSource: "guest_invitation",
    supportSession: params.supportSession,
  });
  const firstGrant = params.grants[0]!;
  await notifyAdminsBoardInviteAccepted(app, {
    acceptedUserId: params.user.id,
    acceptedByName: params.user.displayName,
    acceptedByEmail: params.user.email,
    hostClientId: params.invitation.hostClientId,
    orgName: params.invitation.orgName,
    boardId: firstGrant.boardId,
    boardName: firstGrant.boardName,
    boardRole: firstGrant.role,
  });

  for (const grant of params.grants) {
    const payload = {
      boardId: grant.boardId,
      member: {
        boardId: grant.boardId,
        userId: params.user.id,
        role: grant.role,
        assignedItemsOnly: grant.assignedItemsOnly,
        pinned: false,
        addedAt: new Date(),
      },
      user: {
        userId: params.user.id,
        displayName: params.user.displayName,
        avatarUrl: withSignedMedia(params.user.clientId, { avatarUrl: params.user.avatarUrl }).avatarUrl,
        role: grant.role,
        source: "board" as const,
        clientId: params.user.clientId,
        isOrganisationMember: false,
      },
    };
    // Membership grants are not board activity rows today. These durable realtime events are the
    // established mutation side effect that keeps open rosters, webhooks, and the new guest in sync.
    await emitToBoard(grant.boardId, "board:member:added", payload);
    emitToUser(params.user.id, "board:member:added", payload);
  }
}
