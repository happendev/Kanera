import type { AddBoardMemberBody, UpdateBoardMemberBody } from "@kanera/shared/dto";
import { boardMembers, clientGuestSeats, clientMembers, notifications, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { enrichNotifications } from "../../lib/notifications.js";
import { ensureGuestBoardCapacity, prunePaidGuestSeatIfBelowLimit } from "../../lib/paid-guest-seats.js";
import { capturePremiumFeatureUsed } from "../../lib/product-analytics.js";
import { assertGuestsAllowed, lockTenant } from "../../lib/tier-limits.js";
import { emitCardPriorityInvalidated, emitToBoard, emitToUser, emitToUserDurable, emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";
import type { BoardAccessContext } from "./route-support.js";

type AddedBoardMember = Awaited<ReturnType<typeof addBoardMember>>;
type UpdatedBoardMember = Awaited<ReturnType<typeof updateBoardMember>>;
type RemovedBoardMember = Awaited<ReturnType<typeof removeBoardMember>>;

export async function addBoardMember({
  auth,
  ctx,
  boardId: id,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  body: AddBoardMemberBody;
}) {
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      lastOnlineAt: users.lastOnlineAt,
      clientId: users.clientId,
      membershipClientId: clientMembers.clientId,
      email: users.email,
      orgRole: clientMembers.clientRole,
    })
    .from(users)
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, ctx.clientId),
      eq(clientMembers.userId, users.id),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .where(eq(users.id, body.userId))
    .limit(1);
  if (!user) throw notFound("user not found");
  const [workspace] = await db
    .select({ kind: workspaces.kind })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!workspace) throw notFound();

  if (
    workspace.kind === "board"
    && (user.orgRole === "owner" || user.orgRole === "admin")
  ) {
    throw badRequest("organisation owners and admins already inherit standalone board access");
  }

  // Same-org users are added directly as board members. Cross-org guests additionally clear the
  // guest entitlement check and may consume a seat based on their board-access breadth.
  if (!user.membershipClientId) {
    await assertGuestsAllowed(ctx.clientId);
  }
  // Seat-pool gate + membership insert in one transaction so the capacity check cannot race a
  // concurrent assignment into the last seat. For cross-org guests, crossing the free guest-board
  // cap consumes a pooled seat; a full pool throws 402 SEAT_LIMIT_REACHED. Same-org members skip
  // the seat pool (ensureGuestBoardCapacity is a no-op when targetClientId === hostClientId).
  const { member, hiddenWorkspaceMember } = await db.transaction(async (tx) => {
    await ensureGuestBoardCapacity({
      hostClientId: ctx.clientId,
      boardId: id,
      userId: body.userId,
      targetClientId: user.membershipClientId ?? user.clientId,
      createdById: auth.sub,
      tx,
    });
    const [row] = await tx
      .insert(boardMembers)
      // Explicit grants are never pinned; pinned rows are reserved for workspace admins. If the
      // user already has a row (e.g. an admin's pinned row, or a prior grant) this is a no-op and
      // we surface a clear conflict rather than a PK error.
      .values({ boardId: id, userId: body.userId, role: body.role, assignedItemsOnly: body.assignedItemsOnly })
      .onConflictDoNothing()
      .returning();
    let hiddenWorkspaceMember: typeof workspaceMembers.$inferSelect | null = null;
    if (row && workspace.kind === "board" && user.membershipClientId && user.orgRole === "member") {
      // Home discovery is workspace-membership based. Materialize that row for same-org users,
      // but keep it coupled to the sole board permission so no workspace concept leaks into UI.
      const [inserted] = await tx
        .insert(workspaceMembers)
        .values({ workspaceId: ctx.workspaceId, userId: user.id, role: "member" })
        .onConflictDoNothing()
        .returning();
      hiddenWorkspaceMember = inserted ?? null;
    }
    return { member: row, hiddenWorkspaceMember };
  });
  if (!member) throw badRequest("user is already a board member");
  return { user, member, hiddenWorkspaceMember };
}

export async function emitBoardMemberAdded({
  auth,
  ctx,
  boardId: id,
  user,
  member,
  hiddenWorkspaceMember,
}: AddedBoardMember & { auth: AuthClaims; ctx: BoardAccessContext; boardId: string }) {
  if (hiddenWorkspaceMember) {
    const workspaceMemberPayload = withSignedMedia(user.clientId, {
      ...hiddenWorkspaceMember,
      orgRole: user.orgRole,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      lastOnlineAt: user.lastOnlineAt,
    });
    await emitToWorkspace(ctx.workspaceId, "workspace:member:added", { workspaceId: ctx.workspaceId, member: workspaceMemberPayload });
    emitToUser(user.id, "workspace:member:added", { workspaceId: ctx.workspaceId, member: workspaceMemberPayload });
  }

  const payload = {
    boardId: id,
    member: member!,
    user: {
      userId: user!.id,
      displayName: user!.displayName,
      avatarUrl: withSignedMedia(user!.clientId, { avatarUrl: user!.avatarUrl }).avatarUrl,
      lastOnlineAt: user!.lastOnlineAt,
      role: member!.role,
      source: "board" as const,
      clientId: user!.clientId,
      isOrganisationMember: user!.orgRole !== null,
    },
  };
  await emitToBoard(id, "board:member:added", payload);
  emitToUser(user.id, "board:member:added", payload);
  if (!user.membershipClientId) void capturePremiumFeatureUsed({
    organizationId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    premiumFeature: "guests",
    supportSession: auth.authKind === "support",
  });
}

export async function updateBoardMember({
  auth,
  ctx,
  boardId: id,
  userId,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  userId: string;
  body: UpdateBoardMemberBody;
}) {
  const [existing] = await db
    .select({
      role: boardMembers.role,
      assignedItemsOnly: boardMembers.assignedItemsOnly,
      pinned: boardMembers.pinned,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      lastOnlineAt: users.lastOnlineAt,
      clientId: users.clientId,
      orgRole: clientMembers.clientRole,
    })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, ctx.clientId),
      eq(clientMembers.userId, boardMembers.userId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
    .limit(1);
  if (!existing) throw notFound("board membership not found");
  // A workspace admin's pinned editor row is fixed while they remain an admin; change their
  // workspace role to alter board access instead.
  if (existing.pinned || existing.orgRole === "owner" || existing.orgRole === "admin") {
    throw badRequest("cannot change an inherited board admin role");
  }

  const [member] = await db
    .update(boardMembers)
    .set({ role: body.role, ...(body.assignedItemsOnly !== undefined && { assignedItemsOnly: body.assignedItemsOnly }) })
    .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
    .returning();

  await recordActivity(db, {
    boardId: id,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    entityType: "board",
    entityId: userId,
    action: "updated",
    payload: { userId, role: member!.role, prevRole: existing.role, assignedItemsOnly: member!.assignedItemsOnly, prevAssignedItemsOnly: existing.assignedItemsOnly },
  });
  return { boardId: id, userId, existing, member: member! };
}

export async function emitBoardMemberUpdated({ boardId: id, userId, existing, member }: UpdatedBoardMember) {
  const payload = {
    boardId: id,
    member,
    user: {
      userId,
      displayName: existing.displayName,
      avatarUrl: withSignedMedia(existing.clientId, { avatarUrl: existing.avatarUrl }).avatarUrl,
      lastOnlineAt: existing.lastOnlineAt,
      role: member.role,
      source: "board" as const,
      clientId: existing.clientId,
      isOrganisationMember: existing.orgRole !== null,
    },
  };
  // A live role change is enough: every board mutation re-runs assertBoardAccess, so the new
  // role takes effect on the member's next action. Unlike a workspace-role change (which gates
  // room membership), there is no need to force-disconnect the user's sockets.
  const published = emitToBoard(id, "board:member:updated", payload);
  emitToUser(userId, "board:member:updated", payload);
  // Room membership is part of the confidentiality boundary: switching this flag must eject
  // any socket that may still be sitting in the unfiltered board room (or needs to rejoin it).
  if (member.assignedItemsOnly !== existing.assignedItemsOnly) disconnectUserRealtimeSockets(userId);
  // Eject restricted sockets immediately; only then wait for the durable role-change event.
  await published;
}

export async function removeBoardMember({
  auth,
  ctx,
  boardId: id,
  userId,
  voluntary,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  userId: string;
  voluntary: boolean;
}) {
  const cleanup = await db.transaction(async (tx) => {
    // Serialize capacity changes with guest grants so the recorded seat impact is authoritative.
    await lockTenant(ctx.clientId, tx);
    const [member] = await tx
      .select({ role: boardMembers.role, pinned: boardMembers.pinned, orgRole: clientMembers.clientRole, clientId: users.clientId })
      .from(boardMembers)
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .leftJoin(clientMembers, and(
        eq(clientMembers.clientId, ctx.clientId),
        eq(clientMembers.userId, boardMembers.userId),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
      ))
      .where(and(eq(boardMembers.boardId, id), eq(boardMembers.userId, userId)))
      .limit(1)
      .for("update", { of: boardMembers });
    if (!member) throw notFound();
    // A workspace admin's pinned row cannot be removed board-by-board; change their workspace role.
    if ((voluntary && ctx.isWorkspaceAdmin) || member.pinned || member.orgRole === "owner" || member.orgRole === "admin") {
      throw badRequest("cannot remove an inherited board admin");
    }
    const [workspace] = await tx
      .select({ kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    if (!workspace) throw notFound();
    const participation = await cleanupUserBoardParticipation(tx, {
      userId,
      boardIds: [id],
      actorId: auth.sub,
    });
    if (participation.removedBoardIds.length === 0) throw notFound();
    const seat = await prunePaidGuestSeatIfBelowLimit({ hostClientId: ctx.clientId, userId, tx });
    const [retainedSeat] = await tx.select({ userId: clientGuestSeats.userId }).from(clientGuestSeats)
      .where(and(eq(clientGuestSeats.clientId, ctx.clientId), eq(clientGuestSeats.userId, userId)));
    const seatImpact = seat.paidGuestSeatRemoved ? "guest_capacity_freed" : retainedSeat ? "guest_capacity_retained" : "none";
    const activity = await recordActivity(tx, {
      boardId: id,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "board",
      entityId: userId,
      action: "removed",
      payload: { userId, role: member.role, ...(voluntary ? { voluntary: true, seatImpact } : {}) },
    });
    const notificationIds: string[] = [];
    if (voluntary) {
      const workspaceAdmins = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
        .leftJoin(clientMembers, and(eq(clientMembers.clientId, ctx.clientId), eq(clientMembers.userId, workspaceMembers.userId)))
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.role, "admin"),
          isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt)));
      const organisationAdmins = await tx.select({ userId: clientMembers.userId }).from(clientMembers)
        .where(and(eq(clientMembers.clientId, ctx.clientId), inArray(clientMembers.clientRole, ["owner", "admin"]),
          isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt)));
      const adminIds = [...new Set([...workspaceAdmins, ...organisationAdmins].map(row => row.userId))];
      // Administrative alerts bypass card preferences and delivery queues: durable, in-app only.
      if (adminIds.length) {
        const inserted = await tx.insert(notifications).values(adminIds.map(adminId => ({
          userId: adminId, clientId: ctx.clientId, boardId: id, workspaceId: ctx.workspaceId,
          activityId: activity.id, reason: "board_member_left" as const,
        }))).returning({ id: notifications.id });
        notificationIds.push(...inserted.map(row => row.id));
      }
    }
    const removedHiddenWorkspaceMember = workspace.kind === "board" && member.clientId === ctx.clientId
      ? await tx
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)))
        .returning({ userId: workspaceMembers.userId })
      : [];
    return { ...participation, notificationIds, removedHiddenWorkspaceMember: removedHiddenWorkspaceMember.length > 0 };
  });
  return { workspaceId: ctx.workspaceId, boardId: id, userId, cleanup };
}

export async function emitBoardMemberRemoved({ workspaceId, boardId: id, userId, cleanup }: RemovedBoardMember) {
  if (cleanup.removedHiddenWorkspaceMember) {
    await emitToWorkspace(workspaceId, "workspace:member:removed", { workspaceId, userId });
  }
  await emitToBoard(id, "board:member:removed", { boardId: id, userId });
  // Direct delivery reaches tabs outside the board room before their sockets are disconnected.
  await emitToUserDurable(userId, "board:member:removed", { boardId: id, userId });
  for (const notification of await enrichNotifications(db, cleanup.notificationIds)) {
    await emitToUserDurable(notification.userId, "notification:created", { notification });
  }
  for (const update of cleanup.assigneeUpdates) {
    await emitToBoard(id, "card:assignees:set", update);
  }
  for (const update of cleanup.checklistItemUpdates) {
    await emitToBoard(id, "card:checklistItem:updated", update);
  }
  for (const update of cleanup.activities) {
    await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
  }
  // Losing board access deletes the removed user's queue entries for its cards; anyone with that
  // queue open (the user, their managers) must refetch or they keep phantom ranked rows.
  if (cleanup.removedPriorityEntries) await emitCardPriorityInvalidated(userId);
  disconnectUserRealtimeSockets(userId);
}
