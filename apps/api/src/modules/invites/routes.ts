import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { dto } from "@kanera/shared";
import { boardInvitations, boardMembers, boards, clientGuestSeats, clientMembers, clients, inviteBoardGrants, inviteTokens, inviteWorkspaceGrants, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { formatDate } from "../../lib/i18n/format.js";
import { serverMessages } from "../../lib/i18n/messages/index.js";
import { requestLocale } from "../../lib/i18n/request-locale.js";
import { assertOrgRole } from "../../lib/access.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { enforceUnauthenticatedLookupRateLimit } from "../../lib/lookup-rate-limit.js";
import { emitToBoard, emitToClient, emitToClientDurable, emitToUser } from "../../realtime/emit.js";
import { hashOpaqueToken, newOpaqueToken } from "../../lib/tokens.js";
import { assertOrgMemberLimit, assertSeatPoolAvailable, lockTenant } from "../../lib/tier-limits.js";
import { captureWorkspaceInvitationCreated, captureWorkspaceMemberJoined } from "../../lib/analytics-milestones.js";
import { pinAdminToWorkspaceBoards, pinOrgAdminToClientBoards } from "../../lib/board-membership.js";
import { recordActivity } from "../../lib/activity.js";
import { notifyAdminsOrgInviteAccepted } from "../../lib/invite-accepted-notifications.js";
import { applyInviteBoardGrantsInTx, assertInviteBoardGrantsGrantable, emitInviteBoardGrants } from "../../lib/invite-board-grants.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { issueUserSession } from "../../auth/session.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";

export async function inviteRoutes(app: FastifyInstance) {
  app.get("/invites/lookup", { preHandler: enforceUnauthenticatedLookupRateLimit }, async (req) => {
    const query = dto.invitationLookupQuery.safeParse(req.query);
    if (!query.success) throw notFound();
    const { token } = query.data;
    const [invite] = await db
      .select({
        id: inviteTokens.id,
        orgName: clients.name,
        orgRole: inviteTokens.orgRole,
        expiresAt: inviteTokens.expiresAt,
      })
      .from(inviteTokens)
      .innerJoin(clients, eq(clients.id, inviteTokens.clientId))
      .where(
        and(
          eq(inviteTokens.tokenHash, hashOpaqueToken(token)),
          isNull(inviteTokens.revokedAt),
          sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
        ),
      )
      .limit(1);
    if (!invite) throw notFound();

    const grants = await db
      .select({
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        role: inviteWorkspaceGrants.role,
      })
      .from(inviteWorkspaceGrants)
      .innerJoin(workspaces, eq(workspaces.id, inviteWorkspaceGrants.workspaceId))
      .where(eq(inviteWorkspaceGrants.inviteId, invite.id));

    return {
      orgName: invite.orgName,
      orgRole: invite.orgRole,
      expiresAt: invite.expiresAt,
      workspaces: grants,
    };
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", authed.authenticate);

    authed.post("/invites/accept", async (req, reply) => {
      if (req.auth.authKind !== "user") throw forbidden();
      const body = dto.acceptInviteBody.parse(req.body);
      const tokenHash = hashOpaqueToken(body.token);
      const [candidate] = await db.select({ clientId: inviteTokens.clientId }).from(inviteTokens).where(and(
        eq(inviteTokens.tokenHash, tokenHash),
        isNull(inviteTokens.revokedAt),
        sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
      )).limit(1);
      if (!candidate) throw unauthorized("invalid invite");

      const accepted = await db.transaction(async (tx) => {
        // All member and guest seat changes for an organisation share this lock. Taking it before
        // any count makes conversion one atomic net seat change under concurrent acceptances.
        await lockTenant(candidate.clientId, tx);
        const [invite] = await tx.select({
          id: inviteTokens.id,
          clientId: inviteTokens.clientId,
          orgRole: inviteTokens.orgRole,
          createdById: inviteTokens.createdById,
          orgName: clients.name,
        }).from(inviteTokens)
          .innerJoin(clients, eq(clients.id, inviteTokens.clientId))
          .where(and(
            eq(inviteTokens.tokenHash, tokenHash),
            isNull(inviteTokens.revokedAt),
            sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
            isNull(clients.suspendedAt),
            isNull(clients.deletedAt),
          ))
          .limit(1);
        if (!invite) throw unauthorized("invalid invite");
        const [existing] = await tx.select({
          active: sql<boolean>`${clientMembers.suspendedAt} is null and ${clientMembers.removedAt} is null`,
          suspended: sql<boolean>`${clientMembers.suspendedAt} is not null`,
        })
          .from(clientMembers)
          .where(and(eq(clientMembers.clientId, invite.clientId), eq(clientMembers.userId, req.auth.sub)))
          .limit(1);
        if (existing?.active) throw conflict("you are already a member of this organisation");
        // A suspension is imposed by platform staff or a plan downgrade and org admins have no
        // unsuspend endpoint, so it must be terminal here: a reusable invite link must not silently
        // clear it (and possibly promote the member to the link's role). Only removed members may
        // re-join through an invite.
        if (existing?.suspended) throw forbidden("your membership of this organisation is suspended");

        // A paid guest already occupies one seat. Release that seat under the tenant lock before
        // counting capacity so conversion remains a net-zero seat change; transaction rollback
        // restores it if any later validation or write fails.
        await tx.delete(clientGuestSeats).where(and(
          eq(clientGuestSeats.clientId, invite.clientId),
          eq(clientGuestSeats.userId, req.auth.sub),
        ));
        await assertOrgMemberLimit(invite.clientId, tx);
        await assertSeatPoolAvailable(invite.clientId, tx);
        const grants = await tx.select({ workspaceId: inviteWorkspaceGrants.workspaceId, role: inviteWorkspaceGrants.role })
          .from(inviteWorkspaceGrants)
          .where(eq(inviteWorkspaceGrants.inviteId, invite.id));
        const preexistingBoardIds = await tx
          .select({ boardId: boardMembers.boardId })
          .from(boardMembers)
          .innerJoin(boards, eq(boards.id, boardMembers.boardId))
          .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
          .where(and(eq(boardMembers.userId, req.auth.sub), eq(workspaces.clientId, invite.clientId)));
        await tx.insert(clientMembers).values({
          clientId: invite.clientId,
          userId: req.auth.sub,
          clientRole: invite.orgRole,
          createdById: invite.createdById,
        }).onConflictDoUpdate({
          target: [clientMembers.clientId, clientMembers.userId],
          set: { clientRole: invite.orgRole, suspendedAt: null, removedAt: null, createdById: invite.createdById, addedAt: new Date() },
        });
        if (grants.length) {
          await tx.insert(workspaceMembers).values(grants.map((grant) => ({ ...grant, userId: req.auth.sub })))
            .onConflictDoUpdate({
              target: [workspaceMembers.workspaceId, workspaceMembers.userId],
              set: { role: sql`excluded.role` },
            });
          // Same invariant as the member-promotion route: a workspace admin must hold a pinned editor
          // row on every board in that workspace, because normal-user board access is resolved from
          // board_members alone. Without this the invitee is "admin" yet 403s on each existing board.
          for (const grant of grants) {
            if (grant.role === "admin") await pinAdminToWorkspaceBoards(tx, grant.workspaceId, req.auth.sub);
          }
        }
        // After workspace grants so a workspace-admin pin from this invite is kept over a board grant.
        // Admin invites carry no board grants (create rejects them): org authority pins every board below.
        const boardGrants = await applyInviteBoardGrantsInTx(tx, {
          inviteId: invite.id,
          clientId: invite.clientId,
          userId: req.auth.sub,
        });
        const [identity] = await tx.select({
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          homeClientId: users.clientId,
          lastOnlineAt: users.lastOnlineAt,
        }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
        if (!identity) throw unauthorized();
        await tx.update(boardInvitations).set({ revokedAt: new Date() }).where(and(
          eq(boardInvitations.clientId, invite.clientId),
          isNull(boardInvitations.revokedAt),
          sql`lower(${boardInvitations.email}) = lower(${identity.email})`,
        ));
        if (invite.orgRole === "owner" || invite.orgRole === "admin") {
          await pinOrgAdminToClientBoards(tx, invite.clientId, req.auth.sub);
        }
        const convertedBoardMemberships = preexistingBoardIds.length === 0 ? [] : await tx
          .select({ member: boardMembers })
          .from(boardMembers)
          .where(and(
            eq(boardMembers.userId, req.auth.sub),
            inArray(boardMembers.boardId, preexistingBoardIds.map((row) => row.boardId)),
          ));
        await tx.update(users).set({ activeClientId: invite.clientId, updatedAt: new Date() }).where(eq(users.id, req.auth.sub));
        await recordActivity(tx, {
          boardId: null,
          workspaceId: null,
          clientId: invite.clientId,
          actorId: req.auth.sub,
          entityType: "workspaceMember",
          entityId: req.auth.sub,
          action: "added",
          payload: { userId: req.auth.sub, role: invite.orgRole, inviteId: invite.id, organisationMembership: true },
        });
        return { ...invite, ...identity, grants, boardGrants, convertedBoardMemberships };
      });

      const user = withSignedMedia(accepted.homeClientId, {
        id: req.auth.sub,
        email: accepted.email,
        displayName: accepted.displayName,
        avatarUrl: accepted.avatarUrl,
        role: accepted.orgRole,
        createdAt: new Date(),
      });
      const event = { clientId: accepted.clientId, user };
      await emitToClientDurable(accepted.clientId, "client:user:added", event);
      emitToUser(req.auth.sub, "client:user:added", event);
      // Existing guest board rows keep their role/restriction during conversion. Publish their new
      // organisation-membership classification so open member menus stop showing the user as a guest
      // without waiting for a board reload.
      for (const { member } of accepted.convertedBoardMemberships) {
        const payload = {
          boardId: member.boardId,
          member,
          user: {
            userId: req.auth.sub,
            displayName: accepted.displayName,
            avatarUrl: user.avatarUrl,
            role: member.role,
            source: "board" as const,
            clientId: accepted.homeClientId,
            isOrganisationMember: true,
          },
        };
        await emitToBoard(member.boardId, "board:member:updated", payload);
        emitToUser(req.auth.sub, "board:member:updated", payload);
      }
      await emitInviteBoardGrants(accepted.boardGrants, {
        id: req.auth.sub,
        clientId: accepted.homeClientId,
        email: accepted.email,
        displayName: accepted.displayName,
        avatarUrl: accepted.avatarUrl,
        lastOnlineAt: accepted.lastOnlineAt,
        orgRole: accepted.orgRole,
      });
      await captureWorkspaceMemberJoined({
        organizationId: accepted.clientId,
        workspaceIds: accepted.grants.map((grant) => grant.workspaceId),
        orgWide: accepted.grants.length === 0 && (accepted.orgRole === "owner" || accepted.orgRole === "admin"),
        actorId: req.auth.sub,
        joinSource: "invitation",
      });
      await notifyAdminsOrgInviteAccepted(app, {
        acceptedUserId: req.auth.sub,
        acceptedByName: accepted.displayName,
        acceptedByEmail: accepted.email,
        clientId: accepted.clientId,
        orgName: accepted.orgName,
        orgRole: accepted.orgRole,
      });
      const session = await issueUserSession(app, req.auth.sub, reply, accepted.clientId, undefined, req.auth.amr);
      disconnectUserRealtimeSockets(req.auth.sub);
      return session;
    });

    authed.post("/clients/me/invites", async (req, reply) => {
      const body = dto.createInviteBody.parse(req.body);
      assertOrgRole(req.auth, "admin");
      // Block creating invites once a free-tier org is already at its member cap. Pending invites do
      // not reserve slots, so both gates are re-checked on acceptance (see auth signup). Checking the
      // purchased pool here avoids handing out a link that is already unusable when it is created.
      await assertOrgMemberLimit(req.auth.cid);
      await assertSeatPoolAvailable(req.auth.cid);

      if (body.workspaces.length > 0) {
        const ids = body.workspaces.map((w) => w.workspaceId);
        const owned = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.clientId, req.auth.cid), inArray(workspaces.id, ids), ne(workspaces.kind, "board")));
        if (owned.length !== ids.length) throw badRequest("workspace not in your organisation");
      }
      await assertInviteBoardGrantsGrantable(req.auth.cid, body.orgRole, body.boards);

      const token = newOpaqueToken();
      const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;

      const invite = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(inviteTokens)
          .values({
            clientId: req.auth.cid,
            tokenHash: token.hash,
            orgRole: body.orgRole,
            email: body.email?.toLowerCase() ?? null,
            expiresAt,
            createdById: req.auth.sub,
          })
          .returning();
        if (body.workspaces.length > 0) {
          await tx.insert(inviteWorkspaceGrants).values(
            body.workspaces.map((g) => ({
              inviteId: row!.id,
              workspaceId: g.workspaceId,
              role: g.role,
            })),
          );
        }
        if (body.boards.length > 0) {
          await tx.insert(inviteBoardGrants).values(
            body.boards.map((grant) => ({ inviteId: row!.id, boardId: grant.boardId, role: grant.role })),
          );
        }
        return row!;
      });

      if (body.email) {
        const [context] = await db
          .select({ orgName: clients.name, inviterName: users.displayName })
          .from(clients)
          .innerJoin(users, eq(users.id, req.auth.sub))
          .where(eq(clients.id, req.auth.cid))
          .limit(1);
        // The invitee may have no account, so the email uses the inviter's on-screen language.
        const locale = requestLocale(req);
        await app.mailer.sendOrgInvite(body.email, {
          locale,
          orgName: context?.orgName ?? "",
          invitedByName: context?.inviterName ?? serverMessages(locale).common.fallbackInviterName,
          orgRole: body.orgRole,
          acceptUrl: `${env.WEB_ORIGIN}/signup?invite=${encodeURIComponent(token.raw)}`,
          expiresAtLabel: expiresAt ? formatDate(locale, expiresAt, { dateStyle: "long", timeZone: "UTC" }) : null,
        });
      }

      emitToClient(req.auth.cid, "client:invite:created", {
        id: invite.id,
        clientId: req.auth.cid,
        email: invite.email,
        orgRole: invite.orgRole,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        createdById: invite.createdById,
        workspaces: body.workspaces,
        boards: body.boards,
      });

      const targetedWorkspaceIds = body.workspaces.map((workspace) => workspace.workspaceId);
      await captureWorkspaceInvitationCreated({
        organizationId: req.auth.cid,
        workspaceIds: targetedWorkspaceIds,
        // An org admin invited without a specific workspace list gains access to every workspace; that is
        // one organisation-scoped invite, not one event per existing workspace.
        orgWide: targetedWorkspaceIds.length === 0 && body.orgRole === "admin",
        actorId: req.auth.sub,
        supportSession: req.auth.authKind === "support",
      });

      return reply
        .status(201)
        .send({ id: invite.id, token: token.raw, expiresAt, orgRole: invite.orgRole, workspaces: body.workspaces, boards: body.boards });
    });

    authed.get("/clients/me/invites", async (req) => {
      assertOrgRole(req.auth, "admin");
      const rows = await db
        .select({
          id: inviteTokens.id,
          email: inviteTokens.email,
          orgRole: inviteTokens.orgRole,
          expiresAt: inviteTokens.expiresAt,
          createdById: inviteTokens.createdById,
          createdAt: inviteTokens.createdAt,
        })
        .from(inviteTokens)
        .where(and(eq(inviteTokens.clientId, req.auth.cid), isNull(inviteTokens.revokedAt), sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`))
        .orderBy(asc(inviteTokens.createdAt));

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const grants = await db
        .select({
          inviteId: inviteWorkspaceGrants.inviteId,
          workspaceId: inviteWorkspaceGrants.workspaceId,
          workspaceName: workspaces.name,
          role: inviteWorkspaceGrants.role,
        })
        .from(inviteWorkspaceGrants)
        .innerJoin(workspaces, eq(workspaces.id, inviteWorkspaceGrants.workspaceId))
        .where(inArray(inviteWorkspaceGrants.inviteId, ids));

      const grantsByInvite = new Map<string, Array<{ workspaceId: string; workspaceName: string; role: string }>>();
      for (const g of grants) {
        const list = grantsByInvite.get(g.inviteId) ?? [];
        list.push({ workspaceId: g.workspaceId, workspaceName: g.workspaceName, role: g.role });
        grantsByInvite.set(g.inviteId, list);
      }

      const boardGrants = await db
        .select({
          inviteId: inviteBoardGrants.inviteId,
          boardId: inviteBoardGrants.boardId,
          boardName: boards.name,
          role: inviteBoardGrants.role,
        })
        .from(inviteBoardGrants)
        .innerJoin(boards, eq(boards.id, inviteBoardGrants.boardId))
        .where(inArray(inviteBoardGrants.inviteId, ids))
        .orderBy(asc(boards.name));
      const boardsByInvite = new Map<string, Array<{ boardId: string; boardName: string; role: string }>>();
      for (const g of boardGrants) {
        const list = boardsByInvite.get(g.inviteId) ?? [];
        list.push({ boardId: g.boardId, boardName: g.boardName, role: g.role });
        boardsByInvite.set(g.inviteId, list);
      }

      return rows.map((r) => ({ ...r, workspaces: grantsByInvite.get(r.id) ?? [], boards: boardsByInvite.get(r.id) ?? [] }));
    });

    authed.delete("/invites/:id", async (req, reply) => {
      assertOrgRole(req.auth, "admin");
      const { id } = dto.uuidParams("id").parse(req.params);
      const [invite] = await db.select().from(inviteTokens).where(eq(inviteTokens.id, id)).limit(1);
      if (!invite) throw notFound();
      if (invite.clientId !== req.auth.cid) throw forbidden();
      await db.update(inviteTokens).set({ revokedAt: new Date() }).where(eq(inviteTokens.id, id));
      emitToClient(req.auth.cid, "client:invite:revoked", { id });
      return reply.status(204).send();
    });
  });
}
