import { dto } from "@kanera/shared";
import {
  boardMembers,
  boards,
  clientGuestSeats,
  clientMembers,
  users,
  workspaceApiKeys,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notExists } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertOrgRole } from "../../lib/access.js";
import { emitActivityFeedItem } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { clearNotificationsForRevokedAccess } from "../../lib/notifications.js";
import { pinOrgAdminToClientBoards, unpinOrgAdminFromClientBoards } from "../../lib/board-membership.js";
import { emitCardPriorityInvalidated, emitToBoard, emitToClient, emitToUser, emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";
import { countOwners } from "../../lib/org-owners.js";
import { repointActiveOrganisation } from "../../lib/client-membership.js";

export async function clientUserRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/clients/me/users", async (req) => {
    assertOrgRole(req.auth, "admin");

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        lastOnlineAt: users.lastOnlineAt,
        role: clientMembers.clientRole,
        createdAt: clientMembers.addedAt,
        // Surfaced so the admin UI can flag members disabled by a plan downgrade. Suspended members
        // are retained (and counted here) but cannot authenticate until the org upgrades.
        suspendedAt: clientMembers.suspendedAt,
      })
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      // Exclude platform-admin soft-deleted members alongside org-removed ones.
      .where(and(
        eq(clientMembers.clientId, req.auth.cid),
        isNull(clientMembers.removedAt),
        isNull(users.deletedAt),
      ))
      .orderBy(asc(clientMembers.addedAt));

    if (rows.length === 0) return [];

    const userIds = rows.map((r) => r.id);

    const wsRows = await db
      .select({
        userId: workspaceMembers.userId,
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaces.clientId, req.auth.cid), inArray(workspaceMembers.userId, userIds), ne(workspaces.kind, "board")));
    const clientWorkspaces = await db
      .select({ workspaceId: workspaces.id, workspaceName: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.clientId, req.auth.cid), ne(workspaces.kind, "board")));

    const byUser = new Map<string, Array<{ workspaceId: string; workspaceName: string; role: string }>>();
    for (const r of wsRows) {
      const list = byUser.get(r.userId) ?? [];
      list.push({ workspaceId: r.workspaceId, workspaceName: r.workspaceName, role: r.role });
      byUser.set(r.userId, list);
    }

    return rows.map(({ homeClientId, ...r }) => withSignedMedia(homeClientId, {
      ...r,
      workspaces: r.role === "owner" || r.role === "admin"
        ? clientWorkspaces.map((workspace) => ({ ...workspace, role: "admin" as const }))
        : byUser.get(r.id) ?? [],
    }));
  });

  app.get("/clients/me/guest-seats", async (req) => {
    assertOrgRole(req.auth, "admin");

    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        lastOnlineAt: users.lastOnlineAt,
        userClientId: users.clientId,
        createdAt: clientGuestSeats.createdAt,
      })
      .from(clientGuestSeats)
      .innerJoin(users, eq(users.id, clientGuestSeats.userId))
      .where(and(
        eq(clientGuestSeats.clientId, req.auth.cid),
        isNull(users.deletedAt),
        notExists(db.select({ userId: clientMembers.userId }).from(clientMembers).where(and(
          eq(clientMembers.clientId, req.auth.cid),
          eq(clientMembers.userId, users.id),
        ))),
      ))
      .orderBy(asc(clientGuestSeats.createdAt));

    if (rows.length === 0) return [];

    const userIds = rows.map((r) => r.userId);
    const boardRows = await db
      .select({
        userId: boardMembers.userId,
        boardId: boards.id,
        boardName: boards.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        role: boardMembers.role,
      })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, req.auth.cid), inArray(boardMembers.userId, userIds), isNull(boards.archivedAt)))
      .orderBy(asc(workspaces.name), asc(boards.name));

    const boardsByUser = new Map<string, Array<{ boardId: string; boardName: string; workspaceId: string; workspaceName: string; role: string }>>();
    for (const row of boardRows) {
      const list = boardsByUser.get(row.userId) ?? [];
      list.push({
        boardId: row.boardId,
        boardName: row.boardName,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        role: row.role,
      });
      boardsByUser.set(row.userId, list);
    }

    return rows.map((row) =>
      withSignedMedia(row.userClientId, {
        ...row,
        boards: boardsByUser.get(row.userId) ?? [],
      }),
    );
  });

  // Archived workspaces are hidden everywhere else in the app, so this admin-only endpoint lets the
  // account settings surface what a plan downgrade archived (read-only; restore happens on upgrade).
  app.get("/clients/me/archived-workspaces", async (req) => {
    assertOrgRole(req.auth, "admin");
    return db
      .select({ id: workspaces.id, name: workspaces.name, archivedAt: workspaces.archivedAt })
      .from(workspaces)
      .where(and(eq(workspaces.clientId, req.auth.cid), isNotNull(workspaces.archivedAt)))
      .orderBy(desc(workspaces.archivedAt));
  });

  app.patch("/clients/me/users/:userId", async (req) => {
    assertOrgRole(req.auth, "admin");
    const { userId } = req.params as { userId: string };
    const body = dto.updateOrgUserBody.parse(req.body);

    const [target] = await db
      .select({ id: clientMembers.userId, clientId: clientMembers.clientId, role: clientMembers.clientRole })
      .from(clientMembers)
      .where(and(
        eq(clientMembers.clientId, req.auth.cid),
        eq(clientMembers.userId, userId),
        isNull(clientMembers.removedAt),
      ))
      .limit(1);
    if (!target || target.clientId !== req.auth.cid) throw notFound();

    if (target.role === "owner" && body.role !== "owner") {
      const owners = await countOwners(req.auth.cid);
      if (owners <= 1) throw badRequest("cannot demote the last owner");
    }

    if (req.auth.role !== "owner" && (body.role === "owner" || target.role === "owner")) {
      throw forbidden("only an owner can change owner roles");
    }

    const [updated] = await db.transaction(async (tx) => {
      const rows = await tx
        .update(clientMembers)
        .set({ clientRole: body.role })
        .where(and(eq(clientMembers.clientId, req.auth.cid), eq(clientMembers.userId, userId)))
        .returning({ id: clientMembers.userId, role: clientMembers.clientRole });
      const updatedUser = rows[0];
      if (!updatedUser) return rows;

      const wasOrgAdmin = target.role === "owner" || target.role === "admin";
      const isOrgAdminNow = updatedUser.role === "owner" || updatedUser.role === "admin";
      // Role and inherited board access change atomically so standalone rosters never observe a
      // promoted admin without their required pinned membership (or a demoted member with one).
      if (isOrgAdminNow) await pinOrgAdminToClientBoards(tx, req.auth.cid, userId);
      else if (wasOrgAdmin) await unpinOrgAdminFromClientBoards(tx, req.auth.cid, userId);
      return rows;
    });

    if (!updated) throw notFound();
    const rolePayload = { clientId: req.auth.cid, userId: updated.id, role: updated.role };
    emitToClient(req.auth.cid, "client:user:role-changed", rolePayload);
    emitToUser(userId, "client:user:role-changed", rolePayload);
    disconnectUserRealtimeSockets(userId);
    return updated;
  });

  async function removeMembership(params: {
    clientId: string;
    userId: string;
    actorId: string;
    actorRole: "owner" | "admin" | "member";
    self: boolean;
  }) {
    const [target] = await db
      .select({ role: clientMembers.clientRole })
      .from(clientMembers)
      .where(and(
        eq(clientMembers.clientId, params.clientId),
        eq(clientMembers.userId, params.userId),
        isNull(clientMembers.removedAt),
      ))
      .limit(1);
    if (!target) throw notFound();
    if (target.role === "owner") {
      const owners = await countOwners(params.clientId);
      if (owners <= 1) throw badRequest(params.self ? "cannot leave as the last owner" : "cannot remove the last owner");
      if (!params.self && params.actorRole !== "owner") throw forbidden("only an owner can remove an owner");
    }

    const cleanup = await db.transaction(async (tx) => {
      const wsRows = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.clientId, params.clientId));
      const workspaceIds = wsRows.map((row) => row.id);
      const ownedBoards = workspaceIds.length
        ? await tx.select({ id: boards.id }).from(boards).where(inArray(boards.workspaceId, workspaceIds))
        : [];
      // Membership removal is tenant-scoped. Guest access and participation in unrelated
      // organisations belong to the same global identity and must survive.
      const participation = await cleanupUserBoardParticipation(tx, {
        userId: params.userId,
        boardIds: ownedBoards.map((board) => board.id),
        actorId: params.actorId,
        clearNotifications: false,
      });
      const removedWorkspaceIds = workspaceIds.length
        ? (await tx.delete(workspaceMembers).where(and(
          eq(workspaceMembers.userId, params.userId),
          inArray(workspaceMembers.workspaceId, workspaceIds),
        )).returning({ workspaceId: workspaceMembers.workspaceId })).map((row) => row.workspaceId)
        : [];
      await tx.delete(clientGuestSeats).where(and(
        eq(clientGuestSeats.clientId, params.clientId),
        eq(clientGuestSeats.userId, params.userId),
      ));
      await clearNotificationsForRevokedAccess(tx, { userId: params.userId, clientId: params.clientId });
      const removedAt = new Date();
      await tx.update(workspaceApiKeys).set({ revokedAt: removedAt, updatedAt: removedAt }).where(and(
        eq(workspaceApiKeys.createdById, params.userId),
        eq(workspaceApiKeys.kind, "personal"),
        eq(workspaceApiKeys.clientId, params.clientId),
        isNull(workspaceApiKeys.revokedAt),
      ));
      await tx.update(clientMembers).set({ removedAt, suspendedAt: null }).where(and(
        eq(clientMembers.clientId, params.clientId),
        eq(clientMembers.userId, params.userId),
      ));
      await repointActiveOrganisation(params.userId, params.clientId, tx);
      return { removedWorkspaceIds, ...participation };
    });

    for (const workspaceId of cleanup.removedWorkspaceIds) {
      await emitToWorkspace(workspaceId, "workspace:member:removed", { workspaceId, userId: params.userId });
    }
    for (const boardId of cleanup.removedBoardIds) {
      await emitToBoard(boardId, "board:member:removed", { boardId, userId: params.userId });
    }
    for (const update of cleanup.assigneeUpdates) await emitToBoard(update.boardId, "card:assignees:set", update);
    for (const update of cleanup.checklistItemUpdates) await emitToBoard(update.boardId, "card:checklistItem:updated", update);
    for (const update of cleanup.activities) {
      await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
    }
    // Losing board access deletes the removed user's queue entries for those cards; their managers
    // (and any surviving sessions of theirs) must refetch or they keep phantom ranked rows.
    if (cleanup.removedPriorityEntries) await emitCardPriorityInvalidated(params.userId);
    const payload = { clientId: params.clientId, userId: params.userId };
    emitToClient(params.clientId, "client:user:removed", payload);
    emitToUser(params.userId, "client:user:removed", payload);
    disconnectUserRealtimeSockets(params.userId);
  }

  app.delete("/clients/me/users/:userId", async (req, reply) => {
    assertOrgRole(req.auth, "admin");
    const { userId } = req.params as { userId: string };
    if (userId === req.auth.sub) throw badRequest("use the leave organisation action to remove yourself");
    await removeMembership({ clientId: req.auth.cid, userId, actorId: req.auth.sub, actorRole: req.auth.role, self: false });
    return reply.status(204).send();
  });

  app.delete("/clients/:clientId/members/me", async (req, reply) => {
    if (req.auth.authKind !== "user") throw forbidden();
    const { clientId } = req.params as { clientId: string };
    await removeMembership({ clientId, userId: req.auth.sub, actorId: req.auth.sub, actorRole: req.auth.role, self: true });
    return reply.status(204).send();
  });
}
