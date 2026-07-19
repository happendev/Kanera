import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { boardInvitationGrants, boardInvitations, boardMembers, boards, clients, users, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { assertGuestBoardLimitForBoards } from "../../lib/board-guest-limits.js";
import { captureWorkspaceMemberJoined } from "../../lib/analytics-milestones.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { assertGuestEmailDoesNotMatchOwnerDomain } from "../../lib/guest-domain-policy.js";
import { notifyAdminsBoardInviteAccepted } from "../../lib/invite-accepted-notifications.js";
import { enforceUnauthenticatedLookupRateLimit } from "../../lib/lookup-rate-limit.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { hashOpaqueToken } from "../../lib/tokens.js";
import { emitToBoard, emitToUser } from "../../realtime/emit.js";

export async function boardInvitationRoutes(app: FastifyInstance) {
  // Host-side invitation management lives under /workspaces/:id/guests. These routes are only
  // recipient actions, which keeps guest access policy in one place.
  app.get("/board-invitations/lookup", { preHandler: enforceUnauthenticatedLookupRateLimit }, async (req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw notFound();

    const [row] = await db
      .select({
        id: boardInvitations.id,
        boardId: boardInvitations.boardId,
        boardName: boards.name,
        workspaceName: workspaces.name,
        clientName: clients.name,
        role: boardInvitations.role,
        assignedItemsOnly: boardInvitations.assignedItemsOnly,
        expiresAt: boardInvitations.expiresAt,
      })
      .from(boardInvitations)
      .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(
        eq(boardInvitations.tokenHash, hashOpaqueToken(token)),
        isNull(boardInvitations.revokedAt),
        isNull(boardInvitations.acceptedAt),
        sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
      ))
      .limit(1);
    if (!row) throw notFound();

    const grants = await db
      .select({
        boardId: boardInvitationGrants.boardId,
        boardName: boards.name,
        workspaceName: workspaces.name,
        role: boardInvitationGrants.role,
        assignedItemsOnly: boardInvitationGrants.assignedItemsOnly,
      })
      .from(boardInvitationGrants)
      .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(eq(boardInvitationGrants.invitationId, row.id))
      .orderBy(asc(boards.position));

    return {
      ...row,
      boards: grants.length > 0
        ? grants
        : [{ boardId: row.boardId, boardName: row.boardName, workspaceName: row.workspaceName, role: row.role, assignedItemsOnly: row.assignedItemsOnly }],
    };
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", authed.authenticate);

    authed.post("/board-invitations/:id/accept", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [invitation] = await db
        .select({
          id: boardInvitations.id,
          boardId: boardInvitations.boardId,
          boardName: boards.name,
          role: boardInvitations.role,
          assignedItemsOnly: boardInvitations.assignedItemsOnly,
          email: boardInvitations.email,
          invitedById: boardInvitations.invitedById,
          hostClientId: workspaces.clientId,
          orgName: clients.name,
          workspaceId: workspaces.id,
        })
        .from(boardInvitations)
        .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .where(and(
          eq(boardInvitations.id, id),
          isNull(boardInvitations.revokedAt),
          isNull(boardInvitations.acceptedAt),
          sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
        ))
        .limit(1);
      if (!invitation) throw notFound();

      const [acceptingUser] = await db
        .select({ id: users.id, email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId })
        .from(users)
        .where(eq(users.id, req.auth.sub))
        .limit(1);
      if (!acceptingUser) throw notFound();
      if (acceptingUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw forbidden("this invitation was sent to a different email address");
      }
      if (acceptingUser.clientId === invitation.hostClientId) {
        throw badRequest("users already in this organisation cannot accept board guest invites");
      }
      await assertGuestEmailDoesNotMatchOwnerDomain({
        hostClientId: invitation.hostClientId,
        email: acceptingUser.email,
        targetClientId: acceptingUser.clientId,
      });

      const grantRows = await db
        .select({ boardId: boardInvitationGrants.boardId, boardName: boards.name, workspaceId: boards.workspaceId, role: boardInvitationGrants.role, assignedItemsOnly: boardInvitationGrants.assignedItemsOnly })
        .from(boardInvitationGrants)
        .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
        .where(and(eq(boardInvitationGrants.invitationId, invitation.id), isNull(boards.archivedAt)))
        .orderBy(asc(boards.position));
      const grants = grantRows.length > 0
        ? grantRows
        : [{ boardId: invitation.boardId, boardName: invitation.boardName, workspaceId: invitation.workspaceId, role: invitation.role, assignedItemsOnly: invitation.assignedItemsOnly }];

      await db.transaction(async (tx) => {
        // Acceptance and capacity allocation are atomic so a bundled invite never lands partially.
        await assertGuestBoardLimitForBoards({
          hostClientId: invitation.hostClientId,
          boardIds: grants.map((grant) => grant.boardId),
          userId: req.auth.sub,
          targetClientId: acceptingUser.clientId,
          createdById: invitation.invitedById ?? undefined,
          tx,
        });
        for (const grant of grants) {
          await tx
            .insert(boardMembers)
            .values({ boardId: grant.boardId, userId: req.auth.sub, role: grant.role, assignedItemsOnly: grant.assignedItemsOnly })
            .onConflictDoUpdate({
              target: [boardMembers.boardId, boardMembers.userId],
              set: { role: grant.role, assignedItemsOnly: grant.assignedItemsOnly },
            });
        }
        await tx
          .update(boardInvitations)
          .set({ acceptedAt: new Date(), acceptedByUserId: acceptingUser.id })
          .where(eq(boardInvitations.id, invitation.id));
      });

      await captureWorkspaceMemberJoined({
        organizationId: invitation.hostClientId,
        workspaceIds: [...new Set(grants.map((grant) => grant.workspaceId))],
        actorId: acceptingUser.id,
        joinSource: "guest_invitation",
        supportSession: req.auth.authKind === "support",
      });

      const firstGrant = grants[0]!;
      await notifyAdminsBoardInviteAccepted(app, {
        acceptedUserId: acceptingUser.id,
        acceptedByName: acceptingUser.displayName,
        acceptedByEmail: acceptingUser.email,
        hostClientId: invitation.hostClientId,
        orgName: invitation.orgName,
        boardId: firstGrant.boardId,
        boardName: firstGrant.boardName,
        boardRole: firstGrant.role,
      });

      for (const grant of grants) {
        const payload = {
          boardId: grant.boardId,
          member: { boardId: grant.boardId, userId: req.auth.sub, role: grant.role, assignedItemsOnly: grant.assignedItemsOnly, pinned: false, addedAt: new Date() },
          user: {
            userId: acceptingUser.id,
            displayName: acceptingUser.displayName,
            avatarUrl: withSignedMedia(acceptingUser.clientId, { avatarUrl: acceptingUser.avatarUrl }).avatarUrl,
            role: grant.role,
            source: "board" as const,
            clientId: acceptingUser.clientId,
          },
        };
        emitToBoard(grant.boardId, "board:member:added", payload);
        emitToUser(acceptingUser.id, "board:member:added", payload);
      }

      return reply.status(200).send({ boardId: firstGrant.boardId, boardIds: grants.map((grant) => grant.boardId) });
    });
  });
}
