import { dto } from "@kanera/shared";
import {
  boardMembers,
  boards,
  clientGuestSeats,
  refreshTokens,
  users,
  workspaceApiKeys,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertOrgRole } from "../../lib/access.js";
import { emitActivityFeedItem } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { clearNotificationsForRevokedAccess } from "../../lib/notifications.js";
import { pinOrgAdminToClientBoards, unpinOrgAdminFromClientBoards } from "../../lib/board-membership.js";
import { emitToBoard, emitToClient, emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";
import { countOwners } from "../../lib/org-owners.js";

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
        lastOnlineAt: users.lastOnlineAt,
        role: users.clientRole,
        createdAt: users.createdAt,
        // Surfaced so the admin UI can flag members disabled by a plan downgrade. Suspended members
        // are retained (and counted here) but cannot authenticate until the org upgrades.
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      // Exclude platform-admin soft-deleted members alongside org-removed ones.
      .where(and(eq(users.clientId, req.auth.cid), isNull(users.removedAt), isNull(users.deletedAt)))
      .orderBy(asc(users.createdAt));

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
      .where(and(eq(workspaces.clientId, req.auth.cid), inArray(workspaceMembers.userId, userIds)));
    const clientWorkspaces = await db
      .select({ workspaceId: workspaces.id, workspaceName: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.clientId, req.auth.cid));

    const byUser = new Map<string, Array<{ workspaceId: string; workspaceName: string; role: string }>>();
    for (const r of wsRows) {
      const list = byUser.get(r.userId) ?? [];
      list.push({ workspaceId: r.workspaceId, workspaceName: r.workspaceName, role: r.role });
      byUser.set(r.userId, list);
    }

    return rows.map((r) => withSignedMedia(req.auth.cid, {
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
      .where(and(eq(clientGuestSeats.clientId, req.auth.cid), isNull(users.suspendedAt), isNull(users.removedAt), isNull(users.deletedAt)))
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
      .select({ id: users.id, clientId: users.clientId, role: users.clientRole })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.removedAt)))
      .limit(1);
    if (!target || target.clientId !== req.auth.cid) throw notFound();

    if (target.role === "owner" && body.role !== "owner") {
      const owners = await countOwners(req.auth.cid);
      if (owners <= 1) throw badRequest("cannot demote the last owner");
    }

    if (req.auth.role !== "owner" && (body.role === "owner" || target.role === "owner")) {
      throw forbidden("only an owner can change owner roles");
    }

    const [updated] = await db
      .update(users)
      .set({ clientRole: body.role, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, role: users.clientRole });

    if (!updated) throw notFound();
    const wasOrgAdmin = target.role === "owner" || target.role === "admin";
    const isOrgAdminNow = updated.role === "owner" || updated.role === "admin";
    if (isOrgAdminNow) await pinOrgAdminToClientBoards(db, req.auth.cid, userId);
    else if (wasOrgAdmin) await unpinOrgAdminFromClientBoards(db, req.auth.cid, userId);
    emitToClient(req.auth.cid, "client:user:role-changed", { userId: updated.id, role: updated.role });
    disconnectUserRealtimeSockets(userId);
    return updated;
  });

  app.delete("/clients/me/users/:userId", async (req, reply) => {
    assertOrgRole(req.auth, "admin");
    const { userId } = req.params as { userId: string };

    if (userId === req.auth.sub) throw badRequest("cannot remove yourself");

    const [target] = await db
      .select({ id: users.id, clientId: users.clientId, role: users.clientRole })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.removedAt)))
      .limit(1);
    if (!target || target.clientId !== req.auth.cid) throw notFound();

    if (target.role === "owner") {
      const owners = await countOwners(req.auth.cid);
      if (owners <= 1) throw badRequest("cannot remove the last owner");
      if (req.auth.role !== "owner") throw forbidden("only an owner can remove an owner");
    }

    const cleanup = await db.transaction(async (tx) => {
      const wsIds = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.clientId, req.auth.cid));
      const wsList = wsIds.map((w) => w.id);
      const removedWorkspaceIds: string[] = [];
      const ownedBoards = wsList.length > 0
        ? await tx.select({ id: boards.id }).from(boards).where(inArray(boards.workspaceId, wsList))
        : [];
      // Account removal is identity-wide: cross-organisation guest grants must disappear too,
      // otherwise the retained user tombstone remains visible in another client's board roster.
      const explicitMemberships = await tx.select({ id: boardMembers.boardId }).from(boardMembers).where(eq(boardMembers.userId, userId));
      const participation = await cleanupUserBoardParticipation(tx, {
        userId,
        boardIds: [...ownedBoards.map((board) => board.id), ...explicitMemberships.map((board) => board.id)],
        actorId: req.auth.sub,
        // Account removal below clears every notification, including non-board rows.
        clearNotifications: false,
      });

      if (wsList.length > 0) {
        const removedWorkspaceMembers = await tx
          .delete(workspaceMembers)
          .where(and(eq(workspaceMembers.userId, userId), inArray(workspaceMembers.workspaceId, wsList)))
          .returning({ workspaceId: workspaceMembers.workspaceId });
        removedWorkspaceIds.push(...removedWorkspaceMembers.map((row) => row.workspaceId));
      }

      // Clean up rows that were previously removed by the cascade DELETE on users.id.
      // clientGuestSeats and workspaceApiKeys have a RESTRICT FK, so they must be handled
      // explicitly now that the user row is kept as a tombstone.
      await tx.delete(clientGuestSeats).where(eq(clientGuestSeats.userId, userId));
      await clearNotificationsForRevokedAccess(tx, { userId });
      const removedAt = new Date();
      await tx.update(workspaceApiKeys).set({ revokedAt: removedAt }).where(and(eq(workspaceApiKeys.createdById, userId), isNull(workspaceApiKeys.revokedAt)));
      await tx.update(refreshTokens).set({ revokedAt: removedAt }).where(eq(refreshTokens.userId, userId));
      // Keep the user row for historical FKs (activity authors, cards, comments, uploads), while
      // removing all current access paths and seat usage for this organisation. The email is freed so
      // the same person can be invited again later despite the global unique email invariant.
      await tx
        .update(users)
        .set({ email: `removed-${userId}@removed.kanera.invalid`, removedAt, suspendedAt: null, updatedAt: removedAt })
        .where(eq(users.id, userId));

      return { removedWorkspaceIds, ...participation };
    });

    for (const workspaceId of cleanup.removedWorkspaceIds) {
      await emitToWorkspace(workspaceId, "workspace:member:removed", { workspaceId, userId });
    }
    for (const boardId of cleanup.removedBoardIds) {
      await emitToBoard(boardId, "board:member:removed", { boardId, userId });
    }
    for (const update of cleanup.assigneeUpdates) {
      await emitToBoard(update.boardId, "card:assignees:set", update);
    }
    for (const update of cleanup.checklistItemUpdates) {
      await emitToBoard(update.boardId, "card:checklistItem:updated", update);
    }
    for (const update of cleanup.activities) {
      await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
    }
    emitToClient(req.auth.cid, "client:user:removed", { userId });
    disconnectUserRealtimeSockets(userId);
    // Removing a member frees a seat in the purchased pool (used count drops) but does NOT reduce the
    // billed seat_limit — the seat stays available to assign to someone else, and reducing capacity is
    // a separate explicit admin action (setSeatCapacity). So no Stripe quantity change here.
    return reply.status(204).send();
  });
}
