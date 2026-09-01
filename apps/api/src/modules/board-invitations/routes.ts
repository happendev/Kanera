import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { clientMembers, users } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { emitBoardInvitationAccepted, loadBoardInvitationGrants, loadRedeemableBoardInvitation, redeemBoardInvitationInTx } from "../../lib/board-invitation-redemption.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { enforceUnauthenticatedLookupRateLimit } from "../../lib/lookup-rate-limit.js";

export async function boardInvitationRoutes(app: FastifyInstance) {
  // Host-side invitation management lives under /workspaces/:id/guests. These routes are only
  // recipient actions, which keeps guest access policy in one place.
  app.get("/board-invitations/lookup", { preHandler: enforceUnauthenticatedLookupRateLimit }, async (req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw notFound();

    // Shares the redemption lib's validity predicate and grants fallback so this page can never
    // advertise boards (e.g. archived ones) that acceptance would then silently skip.
    const invitation = await loadRedeemableBoardInvitation({ token });
    if (!invitation) throw notFound();
    const grants = await loadBoardInvitationGrants(invitation);
    if (grants.length === 0) throw notFound();

    return {
      id: invitation.id,
      email: invitation.email,
      boardId: invitation.boardId,
      boardName: invitation.boardName,
      workspaceName: invitation.workspaceName,
      clientName: invitation.orgName,
      role: invitation.role,
      assignedItemsOnly: invitation.assignedItemsOnly,
      expiresAt: invitation.expiresAt,
      boards: grants.map((grant) => ({
        boardId: grant.boardId,
        boardName: grant.boardName,
        workspaceName: grant.workspaceName,
        role: grant.role,
        assignedItemsOnly: grant.assignedItemsOnly,
      })),
    };
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", authed.authenticate);

    authed.post("/board-invitations/:id/accept", async (req, reply) => {
      const { id } = req.params as { id: string };
      const invitation = await loadRedeemableBoardInvitation({ id });
      if (!invitation) throw notFound();

      const [acceptingUser] = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          clientId: users.clientId,
          hostMembershipUserId: clientMembers.userId,
        })
        .from(users)
        // Deliberately unfiltered on suspendedAt/removedAt: retained inactive memberships block the
        // board-member guest fallback in the canonical access resolver (accessible-boards.ts), so
        // letting a removed ex-member accept here would burn the invitation into a grant that never
        // opens. The host must re-admit them properly instead.
        .leftJoin(clientMembers, and(
          eq(clientMembers.clientId, invitation.hostClientId),
          eq(clientMembers.userId, users.id),
        ))
        .where(eq(users.id, req.auth.sub))
        .limit(1);
      if (!acceptingUser) throw notFound();
      if (acceptingUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw forbidden("this invitation was sent to a different email address");
      }
      if (acceptingUser.hostMembershipUserId) {
        throw badRequest("users already associated with this organisation cannot accept board guest invites");
      }
      const redeemed = await db.transaction(async (tx) => {
        // Re-read inside the transaction so concurrent acceptance cannot reuse stale eligibility.
        const currentInvitation = await loadRedeemableBoardInvitation({ id }, tx);
        if (!currentInvitation) throw conflict("invitation already accepted");
        const grants = await loadBoardInvitationGrants(currentInvitation, tx);
        await redeemBoardInvitationInTx(tx, {
          invitation: currentInvitation,
          grants,
          userId: acceptingUser.id,
          redeemerEmail: acceptingUser.email,
          targetClientId: acceptingUser.clientId,
          createdById: currentInvitation.invitedById,
        });
        return { invitation: currentInvitation, grants };
      });

      await emitBoardInvitationAccepted(app, {
        invitation: redeemed.invitation,
        grants: redeemed.grants,
        user: acceptingUser,
        supportSession: req.auth.authKind === "support",
      });
      const firstGrant = redeemed.grants[0]!;
      return reply.status(200).send({ boardId: firstGrant.boardId, boardIds: redeemed.grants.map((grant) => grant.boardId) });
    });
  });
}
