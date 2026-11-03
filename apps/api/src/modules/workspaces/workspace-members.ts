import type { AddWorkspaceMemberBody, UpdateWorkspaceMemberBody } from "@kanera/shared/dto";
import { boards, clientMembers, users, workspaceMembers } from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { captureWorkspaceMemberJoined } from "../../lib/analytics-milestones.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { pinAdminToWorkspaceBoards, unpinAdminFromWorkspaceBoards } from "../../lib/board-membership.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { clearNotificationsForRevokedAccess } from "../../lib/notifications.js";
import { emitCardPriorityInvalidated, emitToBoard, emitToUser, emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";


// A workspace must retain at least one admin, otherwise no one can manage it or its boards.
// Block removing or demoting the final admin.
async function assertNotLastAdmin(workspaceId: string, targetUserId: string) {
  if (await workspaceMemberRole(workspaceId, targetUserId) !== "admin") return;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  if ((row?.count ?? 0) <= 1) throw badRequest("cannot remove or downgrade the last workspace admin");
}

async function workspaceMemberRole(workspaceId: string, userId: string) {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

export async function addWorkspaceMember({ auth, workspaceId: id, clientId, body }: { auth: AuthClaims; workspaceId: string; clientId: string; body: AddWorkspaceMemberBody }) {
  // Verify the target user belongs to the same organisation
  const [targetUser] = await db
    .select({ id: users.id, membershipClientId: clientMembers.clientId, homeClientId: users.clientId, email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, lastOnlineAt: users.lastOnlineAt, orgRole: clientMembers.clientRole })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, body.userId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ))
    .limit(1);
  if (!targetUser || targetUser.membershipClientId !== clientId) throw notFound("user not found");

  // Check they're not already a member
  const [existing] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, body.userId)))
    .limit(1);
  if (existing) throw badRequest("user is already a workspace member");

  const effectiveRole = targetUser.orgRole === "owner" || targetUser.orgRole === "admin" ? "admin" as const : body.role;
  const [member] = await db
    .insert(workspaceMembers)
    .values({ workspaceId: id, userId: body.userId, role: effectiveRole })
    .returning();
  if (!member) throw badRequest("could not add workspace member");
  // A new admin is on every board: materialize their pinned editor rows immediately.
  if (member.role === "admin") await pinAdminToWorkspaceBoards(db, id, body.userId);
  const payload = withSignedMedia(targetUser.homeClientId, { ...member, orgRole: targetUser.orgRole, email: targetUser.email, displayName: targetUser.displayName, avatarUrl: targetUser.avatarUrl, lastOnlineAt: targetUser.lastOnlineAt });
  await recordActivity(db, {
    boardId: null,
    workspaceId: id,
    actorId: auth.sub,
    entityType: "workspaceMember",
    entityId: body.userId,
    action: "added",
    payload: { userId: body.userId, role: member.role, email: targetUser.email, displayName: targetUser.displayName },
  });
  return payload;
}

export async function emitAddWorkspaceMember({ auth, workspaceId: id, clientId, userId, payload }: {
  auth: AuthClaims;
  workspaceId: string;
  clientId: string;
  userId: string;
  payload: Awaited<ReturnType<typeof addWorkspaceMember>>;
}) {
  await emitToWorkspace(id, "workspace:member:added", { workspaceId: id, member: payload });
  // The newly added user was not in workspace:${id} while this mutation was emitted, so send the
  // same event to their user room. The web shell uses this to join the workspace room immediately.
  emitToUser(userId, "workspace:member:added", { workspaceId: id, member: payload });
  await captureWorkspaceMemberJoined({
    organizationId: clientId,
    workspaceIds: [id],
    actorId: userId,
    joinSource: "direct",
    supportSession: auth.authKind === "support",
  });
}

export async function updateWorkspaceMemberRole({ auth, workspaceId: id, userId, body }: { auth: AuthClaims; workspaceId: string; userId: string; body: UpdateWorkspaceMemberBody }) {
  const targetRole = await workspaceMemberRole(id, userId);
  if (!targetRole) throw notFound();
  const [targetUser] = await db.select({ orgRole: clientMembers.clientRole }).from(clientMembers).where(and(
    eq(clientMembers.clientId, auth.cid),
    eq(clientMembers.userId, userId),
    isNull(clientMembers.suspendedAt),
    isNull(clientMembers.removedAt),
  )).limit(1);
  if (!targetUser) throw notFound();
  if (targetUser.orgRole === "owner" || targetUser.orgRole === "admin") {
    throw badRequest("organisation owners and admins are always workspace admins");
  }
  // Demoting the final admin would leave the workspace unmanageable.
  if (targetRole === "admin" && body.role !== "admin") await assertNotLastAdmin(id, userId);
  const [member] = await db
    .update(workspaceMembers)
    .set({ role: body.role })
    .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)))
    .returning();
  if (!member) throw notFound();
  // Keep board membership in sync with the workspace role change: promotion materializes pinned
  // editor rows; demotion retains them as ordinary editor access so the member remains on boards.
  if (member.role === "admin") await pinAdminToWorkspaceBoards(db, id, userId);
  else if (targetRole === "admin") await unpinAdminFromWorkspaceBoards(db, id, userId);
  await recordActivity(db, {
    boardId: null,
    workspaceId: id,
    actorId: auth.sub,
    entityType: "workspaceMember",
    entityId: userId,
    action: "updated",
    payload: { userId, fromRole: targetRole, toRole: member.role },
  });
  return member;
}

export async function removeWorkspaceMember({ auth, workspaceId: id, userId }: { auth: AuthClaims; workspaceId: string; userId: string }) {
  const targetRole = await workspaceMemberRole(id, userId);
  if (!targetRole) throw notFound();
  const [targetUser] = await db.select({ orgRole: clientMembers.clientRole }).from(clientMembers).where(and(
    eq(clientMembers.clientId, auth.cid),
    eq(clientMembers.userId, userId),
    isNull(clientMembers.suspendedAt),
    isNull(clientMembers.removedAt),
  )).limit(1);
  if (!targetUser) throw notFound();
  if (targetUser.orgRole === "owner" || targetUser.orgRole === "admin") {
    throw badRequest("organisation owners and admins cannot be removed from a workspace");
  }
  await assertNotLastAdmin(id, userId);

  return db.transaction(async (tx) => {
    const workspaceBoards = await tx.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, id));
    const boardIds = workspaceBoards.map((board) => board.id);
    const participation = await cleanupUserBoardParticipation(tx, {
      userId,
      boardIds,
      actorId: auth.sub,
      // The workspace-wide cleanup below also removes non-board notification rows.
      clearNotifications: false,
    });

    await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
    await clearNotificationsForRevokedAccess(tx, { userId, workspaceIds: [id] });
    await recordActivity(tx, {
      boardId: null,
      workspaceId: id,
      actorId: auth.sub,
      entityType: "workspaceMember",
      entityId: userId,
      action: "removed",
      payload: { userId, role: targetRole },
    });

    return participation;
  });
}

export async function emitRemoveWorkspaceMember({ workspaceId: id, userId, cleanup }: {
  workspaceId: string;
  userId: string;
  cleanup: Awaited<ReturnType<typeof removeWorkspaceMember>>;
}) {
  await emitToWorkspace(id, "workspace:member:removed", { workspaceId: id, userId });
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
  // Losing board access deletes the removed user's queue entries for those cards; anyone with
  // that queue open (the user, their managers) must refetch or they keep phantom ranked rows.
  if (cleanup.removedPriorityEntries) await emitCardPriorityInvalidated(userId);
  disconnectUserRealtimeSockets(userId);
}
