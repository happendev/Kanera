import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { dto } from "@kanera/shared";
import {
  boardInvitationGrants,
  boardInvitations,
  boardMembers,
  boards,
  clients,
  users,
  workspaces,
} from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertBoardAccess } from "../../lib/access.js";
import { assertGuestBoardLimit, assertGuestBoardLimitForBoards } from "../../lib/board-guest-limits.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { assertGuestEmailDoesNotMatchOwnerDomain } from "../../lib/guest-domain-policy.js";
import { notifyAdminsBoardInviteAccepted } from "../../lib/invite-accepted-notifications.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { hashOpaqueToken, newOpaqueToken } from "../../lib/tokens.js";
import { assertGuestsAllowed } from "../../lib/tier-limits.js";
import { emitToBoard, emitToUser } from "../../realtime/emit.js";

export async function boardInvitationRoutes(app: FastifyInstance) {
  // Public: look up a board invitation by opaque token.
  app.get("/board-invitations/lookup", async (req) => {
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
        expiresAt: boardInvitations.expiresAt,
      })
      .from(boardInvitations)
      .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(
        and(
          eq(boardInvitations.tokenHash, hashOpaqueToken(token)),
          isNull(boardInvitations.revokedAt),
          isNull(boardInvitations.acceptedAt),
          sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
        ),
      )
      .limit(1);

      if (!row) throw notFound();
    const grants = await db
      .select({
        boardId: boardInvitationGrants.boardId,
        boardName: boards.name,
        workspaceName: workspaces.name,
        role: boardInvitationGrants.role,
      })
      .from(boardInvitationGrants)
      .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(eq(boardInvitationGrants.invitationId, row.id))
      .orderBy(asc(boards.position));

    return { ...row, boards: grants.length > 0 ? grants : [{ boardId: row.boardId, boardName: row.boardName, workspaceName: row.workspaceName, role: row.role }] };
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", authed.authenticate);

    // Invite a user (by email) to a board.
    authed.post("/boards/:id/invitations", async (req, reply) => {
      const { id } = req.params as { id: string };
      const access = await assertBoardAccess(req.auth, id, "admin");
      if (req.auth.authKind !== "apiKey" && req.auth.cid !== access.clientId) {
        // Cross-org board guests are allowed to collaborate on their invited board, but only
        // host-organisation admins/owners may extend that access to more guests.
        throw forbidden();
      }
      const body = dto.createBoardInvitationBody.parse(req.body);
      if (body.role === "admin") throw badRequest("Guests cannot be invited as admins");

      // Look up the board and workspace so we can validate the invitation target.
      const [boardRow] = await db
        .select({
          boardName: boards.name,
          workspaceId: boards.workspaceId,
          clientId: workspaces.clientId,
          workspaceName: workspaces.name,
          clientName: clients.name,
        })
        .from(boards)
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .where(eq(boards.id, id))
        .limit(1);
      if (!boardRow) throw notFound();

      // If a user with that email already exists, add them directly.
      const [existingUser] = await db
        .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId })
        .from(users)
        .where(eq(users.email, body.email))
        .limit(1);

      if (existingUser) {
        // Adding a cross-org user to a board makes them a guest; free-tier hosted orgs cannot.
        // Same-org users fall through (assertGuestBoardLimit also no-ops for them).
        await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: boardRow.clientId, email: body.email, targetClientId: existingUser.clientId });
        if (existingUser.clientId !== boardRow.clientId) await assertGuestsAllowed(boardRow.clientId);
        // The seat-pool gate and the membership insert run in one transaction so the capacity check
        // cannot race a concurrent assignment into the last seat (assertGuestBoardLimit takes a FOR UPDATE
        // tenant lock). Crossing the free guest-board cap consumes a pooled seat; a full pool throws 402.
        const { member, membershipCreated } = await db.transaction(async (tx) => {
          await assertGuestBoardLimit({
            hostClientId: boardRow.clientId,
            boardId: id,
            userId: existingUser.id,
            targetClientId: existingUser.clientId,
            createdById: req.auth.sub,
            tx,
          });
          // Insert first so only a newly granted membership triggers the access email. Existing
          // members still receive role updates without being told that access was granted again.
          const [inserted] = await tx
            .insert(boardMembers)
            .values({ boardId: id, userId: existingUser.id, role: body.role })
            .onConflictDoNothing()
            .returning();
          if (inserted) return { member: inserted, membershipCreated: true };
          const [updated] = await tx
            .update(boardMembers)
            .set({ role: body.role })
            .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, existingUser.id)))
            .returning();
          return { member: updated!, membershipCreated: false };
        });

        if (membershipCreated) {
          const [inviter] = await db
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, req.auth.sub))
            .limit(1);
          await app.mailer.sendBoardAccessGranted(body.email, {
            displayName: existingUser.displayName,
            boardName: boardRow.boardName,
            orgName: boardRow.clientName,
            invitedByName: inviter?.displayName ?? "A Kanera administrator",
            role: member.role,
            boardUrl: `${env.WEB_ORIGIN}/b/${id}`,
          });
        }

        const payload = {
          boardId: id,
          member,
          user: {
            userId: existingUser.id,
            displayName: existingUser.displayName,
            avatarUrl: withSignedMedia(existingUser.clientId, { avatarUrl: existingUser.avatarUrl }).avatarUrl,
            role: member.role,
            source: "board" as const,
            clientId: existingUser.clientId,
          },
        };
        emitToBoard(id, "board:member:added", payload);
        emitToUser(existingUser.id, "board:member:added", payload);
        return reply.status(201).send({ status: "added" as const, userId: existingUser.id });
      }

      // No existing user — this invitation will onboard an external guest, which free-tier hosted
      // orgs are not entitled to.
      await assertGuestsAllowed(boardRow.clientId);
      await assertGuestEmailDoesNotMatchOwnerDomain({ hostClientId: boardRow.clientId, email: body.email });

      // No existing user — create a board invitation and return a one-time link token.
      const [pendingInvite] = await db
        .select({ id: boardInvitations.id })
        .from(boardInvitations)
        .where(
          and(
            eq(boardInvitations.clientId, boardRow.clientId),
            sql`lower(${boardInvitations.email}) = lower(${body.email})`,
            isNull(boardInvitations.revokedAt),
            isNull(boardInvitations.acceptedAt),
            sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
          ),
        )
        .limit(1);
      if (pendingInvite) {
        const [existingGrant] = await db
          .select({ invitationId: boardInvitationGrants.invitationId })
          .from(boardInvitationGrants)
          .where(and(eq(boardInvitationGrants.invitationId, pendingInvite.id), eq(boardInvitationGrants.boardId, id)))
          .limit(1);
        if (existingGrant) throw conflict("There is already a pending invite for this email and board.");
        await db
          .insert(boardInvitationGrants)
          .values({ invitationId: pendingInvite.id, boardId: id, role: body.role })
          .onConflictDoUpdate({
            target: [boardInvitationGrants.invitationId, boardInvitationGrants.boardId],
            set: { role: body.role },
          });
        return reply.status(201).send({ status: "invited" as const, invitationId: pendingInvite.id });
      }

      const token = newOpaqueToken();
      const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;

      const [invitation] = await db
        .insert(boardInvitations)
        .values({
          clientId: boardRow.clientId,
          boardId: id,
          email: body.email,
          role: body.role,
          tokenHash: token.hash,
          invitedById: req.auth.sub,
          expiresAt,
        })
        .returning();

      await db.insert(boardInvitationGrants).values({ invitationId: invitation!.id, boardId: id, role: body.role });

      return reply.status(201).send({ status: "invited" as const, invitationId: invitation!.id, token: token.raw });
    });

    // Accept a board invitation (authenticated — the user must already have an account).
    authed.post("/board-invitations/:id/accept", async (req, reply) => {
      const { id } = req.params as { id: string };

      const [invitation] = await db
        .select({
          id: boardInvitations.id,
          boardId: boardInvitations.boardId,
          boardName: boards.name,
          role: boardInvitations.role,
          email: boardInvitations.email,
          invitedById: boardInvitations.invitedById,
          hostClientId: workspaces.clientId,
          orgName: clients.name,
        })
        .from(boardInvitations)
        .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .innerJoin(clients, eq(clients.id, workspaces.clientId))
        .where(
          and(
            eq(boardInvitations.id, id),
            isNull(boardInvitations.revokedAt),
            isNull(boardInvitations.acceptedAt),
            sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
          ),
        )
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
        .select({
          boardId: boardInvitationGrants.boardId,
          boardName: boards.name,
          role: boardInvitationGrants.role,
        })
        .from(boardInvitationGrants)
        .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
        .where(and(eq(boardInvitationGrants.invitationId, invitation.id), isNull(boards.archivedAt)))
        .orderBy(asc(boards.position));
      const grants = grantRows.length > 0
        ? grantRows
        : [{ boardId: invitation.boardId, boardName: invitation.boardName, role: invitation.role }];

      await db.transaction(async (tx) => {
        // Acceptance past the free guest-board cap consumes a seat from the host's purchased pool. The
        // host pre-paid for capacity, so this only fails if the pool is now full — a 402 SEAT_LIMIT_REACHED
        // thrown before any board access is granted. Runs in-tx with the membership inserts so the gate
        // is race-safe (assertGuestBoardLimitForBoards takes a FOR UPDATE tenant lock).
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
            .values({ boardId: grant.boardId, userId: req.auth.sub, role: grant.role })
            .onConflictDoUpdate({
              target: [boardMembers.boardId, boardMembers.userId],
              set: { role: grant.role },
            });
        }
        await tx
          .update(boardInvitations)
          .set({ acceptedAt: new Date(), acceptedByUserId: acceptingUser.id })
          .where(eq(boardInvitations.id, invitation.id));
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
          member: { boardId: grant.boardId, userId: req.auth.sub, role: grant.role, addedAt: new Date() },
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

    // Revoke a board invitation.
    authed.delete("/boards/:id/invitations/:invitationId", async (req, reply) => {
      const { id, invitationId } = req.params as { id: string; invitationId: string };
      await assertBoardAccess(req.auth, id, "admin");

      const [invitation] = await db
        .select({ id: boardInvitations.id })
        .from(boardInvitations)
        .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
        .where(and(eq(boardInvitations.id, invitationId), eq(boardInvitationGrants.boardId, id)))
        .limit(1);
      if (!invitation) throw notFound();

      await db
        .update(boardInvitations)
        .set({ revokedAt: new Date() })
        .where(eq(boardInvitations.id, invitationId));

      return reply.status(204).send();
    });

    // List pending invitations for a board.
    authed.get("/boards/:id/invitations", async (req) => {
      const { id } = req.params as { id: string };
      await assertBoardAccess(req.auth, id, "admin");

      return db
        .select({
          id: boardInvitations.id,
          email: boardInvitations.email,
          role: boardInvitationGrants.role,
          expiresAt: boardInvitations.expiresAt,
          createdAt: boardInvitations.createdAt,
        })
        .from(boardInvitations)
        .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
        .where(
          and(
            eq(boardInvitationGrants.boardId, id),
            isNull(boardInvitations.revokedAt),
            isNull(boardInvitations.acceptedAt),
            sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
          ),
        )
        .orderBy(boardInvitations.createdAt);
    });
  });
}
