import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { dto } from "@kanera/shared";
import { clients, inviteTokens, inviteWorkspaceGrants, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { assertOrgRole } from "../../lib/access.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { enforceUnauthenticatedLookupRateLimit } from "../../lib/lookup-rate-limit.js";
import { emitToClient } from "../../realtime/emit.js";
import { hashOpaqueToken, newOpaqueToken } from "../../lib/tokens.js";
import { assertOrgMemberLimit } from "../../lib/tier-limits.js";
import { captureWorkspaceInvitationCreated } from "../../lib/analytics-milestones.js";

export async function inviteRoutes(app: FastifyInstance) {
  app.get("/invites/lookup", { preHandler: enforceUnauthenticatedLookupRateLimit }, async (req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw notFound();
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

    authed.post("/clients/me/invites", async (req, reply) => {
      assertOrgRole(req.auth, "admin");
      // Block creating invites once a free-tier org is already at its member cap. Pending invites do
      // not reserve slots, so the hard gate is re-checked on acceptance (see auth signup).
      await assertOrgMemberLimit(req.auth.cid);
      const body = dto.createInviteBody.parse(req.body);

      if (body.workspaces.length > 0) {
        const ids = body.workspaces.map((w) => w.workspaceId);
        const owned = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.clientId, req.auth.cid), inArray(workspaces.id, ids), ne(workspaces.kind, "board")));
        if (owned.length !== ids.length) throw badRequest("workspace not in your organisation");
      }

      const token = newOpaqueToken();
      const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;

      const invite = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(inviteTokens)
          .values({
            clientId: req.auth.cid,
            tokenHash: token.hash,
            orgRole: body.orgRole,
            email: null,
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
        return row!;
      });

      emitToClient(req.auth.cid, "client:invite:created", {
        id: invite.id,
        clientId: req.auth.cid,
        email: invite.email,
        orgRole: invite.orgRole,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        createdById: invite.createdById,
        workspaces: body.workspaces,
      });

      await captureWorkspaceInvitationCreated({
        organizationId: req.auth.cid,
        workspaceIds: body.workspaces.map((workspace) => workspace.workspaceId),
        actorId: req.auth.sub,
        invitationMethod: invite.email ? "email" : "link",
        invitedRole: body.orgRole,
        supportSession: req.auth.authKind === "support",
      });

      return reply
        .status(201)
        .send({ id: invite.id, token: token.raw, expiresAt, orgRole: invite.orgRole, workspaces: body.workspaces });
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

      return rows.map((r) => ({ ...r, workspaces: grantsByInvite.get(r.id) ?? [] }));
    });

    authed.delete("/invites/:id", async (req, reply) => {
      assertOrgRole(req.auth, "admin");
      const { id } = req.params as { id: string };
      const [invite] = await db.select().from(inviteTokens).where(eq(inviteTokens.id, id)).limit(1);
      if (!invite) throw notFound();
      if (invite.clientId !== req.auth.cid) throw forbidden();
      await db.update(inviteTokens).set({ revokedAt: new Date() }).where(eq(inviteTokens.id, id));
      emitToClient(req.auth.cid, "client:invite:revoked", { id });
      return reply.status(204).send();
    });
  });
}
