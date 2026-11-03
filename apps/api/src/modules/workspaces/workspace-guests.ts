import type { CreateBoardInvitationBody } from "@kanera/shared/dto";
import type { Locale } from "@kanera/shared/locales";
import { boardInvitationGrants, boardInvitations, boardMembers, boards, clientMembers, clients, users, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { recipientLocale } from "../../lib/i18n/request-locale.js";
import { serverMessages } from "../../lib/i18n/messages/index.js";
import type { Mailer } from "../../lib/mailer.js";
import { captureWorkspaceInvitationCreated, captureWorkspaceMemberJoined } from "../../lib/analytics-milestones.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { cleanupUserBoardParticipation } from "../../lib/board-participation-cleanup.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { ensureGuestBoardCapacity, previewGuestBoardsCapacity, prunePaidGuestSeatIfBelowLimit } from "../../lib/paid-guest-seats.js";
import { capturePremiumFeatureUsed } from "../../lib/product-analytics.js";
import { newOpaqueToken } from "../../lib/tokens.js";
import { emitCardPriorityInvalidated, emitToBoard, emitToUser } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";

interface GuestInvitationParams {
  workspaceId: string;
  clientId: string;
  // The route has already checked the raw body for a string boardId before DTO parsing.
  boardId: string;
  body: CreateBoardInvitationBody;
}

export async function previewGuestInvitationSeat({ workspaceId: id, clientId, boardId, body }: GuestInvitationParams) {

  const [boardRow] = await db
    .select({ id: boards.id })
    .from(boards)
    .where(and(eq(boards.id, boardId), eq(boards.workspaceId, id), isNull(boards.archivedAt)))
    .limit(1);
  if (!boardRow) throw notFound("board not found");

  const [pendingInvite] = await db
    .select({ id: boardInvitations.id })
    .from(boardInvitations)
    .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
    .where(and(
      eq(boardInvitations.clientId, clientId),
      eq(boardInvitationGrants.boardId, boardRow.id),
      sql`lower(${boardInvitations.email}) = lower(${body.email})`,
      isNull(boardInvitations.revokedAt),
      isNull(boardInvitations.acceptedAt),
      sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
    ))
    .limit(1);
  if (pendingInvite) throw conflict("There is already a pending invite for this email and board.");

  const [existingUser] = await db
    .select({ id: users.id, clientId: users.clientId, membershipClientId: clientMembers.clientId })
    .from(users)
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, users.id),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .where(eq(users.email, body.email))
    .limit(1);
  if (!existingUser) {
    const pendingGrantRows = await db
      .select({ boardId: boardInvitationGrants.boardId })
      .from(boardInvitations)
      .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
      .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
      .where(and(
        eq(boardInvitations.clientId, clientId),
        sql`lower(${boardInvitations.email}) = lower(${body.email})`,
        isNull(boards.archivedAt),
        isNull(boardInvitations.revokedAt),
        isNull(boardInvitations.acceptedAt),
        sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
      ));
    return previewGuestBoardsCapacity({
      hostClientId: clientId,
      boardIds: [boardRow.id, ...pendingGrantRows.map((row) => row.boardId)],
    });
  }
  const [existingBoardAccess] = await db
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardRow.id), eq(boardMembers.userId, existingUser.id)))
    .limit(1);
  if (existingBoardAccess) throw conflict("This person already has access to this board.");
  if (existingUser.membershipClientId) throw badRequest("Organisation members are added directly to the board, not invited as guests.");

  return previewGuestBoardsCapacity({
    hostClientId: clientId,
    boardIds: [boardRow.id],
    userId: existingUser.id,
    targetClientId: existingUser.clientId,
  });
}

type InviteWorkspaceGuestResult = Awaited<ReturnType<typeof inviteWorkspaceGuest>>;

export async function inviteWorkspaceGuest({ auth, workspaceId: id, clientId, boardId, body }: GuestInvitationParams & { auth: AuthClaims }) {
  const [boardRow] = await db
    .select({
      id: boards.id,
      boardName: boards.name,
      clientName: clients.name,
    })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(and(eq(boards.id, boardId), eq(boards.workspaceId, id), isNull(boards.archivedAt)))
    .limit(1);
  if (!boardRow) throw notFound("board not found");

  // Account existence wins over any stale pending invitation: known users receive access
  // immediately and an access-granted notification, never another onboarding invite.
  const [existingUser] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      lastOnlineAt: users.lastOnlineAt,
      clientId: users.clientId,
      locale: users.locale,
      membershipClientId: clientMembers.clientId,
    })
    .from(users)
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, users.id),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .where(eq(users.email, body.email))
    .limit(1);

  const [pendingInvite] = await db
    .select({ id: boardInvitations.id, expiresAt: boardInvitations.expiresAt, createdAt: boardInvitations.createdAt })
    .from(boardInvitations)
    .where(
      and(
        eq(boardInvitations.clientId, clientId),
        sql`lower(${boardInvitations.email}) = lower(${body.email})`,
        isNull(boardInvitations.revokedAt),
        isNull(boardInvitations.acceptedAt),
        sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
      ),
    )
    .limit(1);
  if (pendingInvite && !existingUser) {
    const existingGrants = await db
      .select({ boardId: boardInvitationGrants.boardId })
      .from(boardInvitationGrants)
      .where(eq(boardInvitationGrants.invitationId, pendingInvite.id));
    if (existingGrants.some((grant) => grant.boardId === boardRow.id)) {
      throw conflict("There is already a pending invite for this email and board.");
    }
    // The preview endpoint is advisory; enforce the same capacity rule in the mutation so a stale,
    // skipped, or raced preview cannot produce a link that is already impossible to accept.
    await previewGuestBoardsCapacity({
      hostClientId: clientId,
      boardIds: [boardRow.id, ...existingGrants.map((grant) => grant.boardId)],
    });
    const token = newOpaqueToken();
    await db.transaction(async (tx) => {
      await tx
        .insert(boardInvitationGrants)
        .values({ invitationId: pendingInvite.id, boardId: boardRow.id, role: body.role, assignedItemsOnly: body.assignedItemsOnly });
      // Only token hashes are persisted. Rotate the link when the invitation changes so the
      // complete, updated invitation can be emailed without storing a reusable secret.
      await tx
        .update(boardInvitations)
        .set({ tokenHash: token.hash })
        .where(eq(boardInvitations.id, pendingInvite.id));
    });
    const [inviter, grants] = await Promise.all([
      db.select({ displayName: users.displayName }).from(users).where(eq(users.id, auth.sub)).limit(1),
      db
        .select({ boardName: boards.name, role: boardInvitationGrants.role })
        .from(boardInvitationGrants)
        .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
        .where(eq(boardInvitationGrants.invitationId, pendingInvite.id))
        .orderBy(asc(boards.position)),
    ]);
    return {
      kind: "invitationExtended" as const,
      workspaceId: id,
      clientId,
      email: body.email,
      boardRow,
      inviterName: inviter[0]?.displayName,
      inviteBoards: grants,
      acceptToken: token.raw,
      response: {
        status: "invited" as const,
        token: token.raw,
        invite: {
          id: pendingInvite.id,
          boardId: boardRow.id,
          boardName: boardRow.boardName,
          email: body.email,
          role: body.role,
          expiresAt: pendingInvite.expiresAt,
          createdAt: pendingInvite.createdAt,
          boards: [{ boardId: boardRow.id, boardName: boardRow.boardName, role: body.role, assignedItemsOnly: body.assignedItemsOnly }],
        },
      },
    };
  }


  if (existingUser) {
    const [existingBoardAccess] = await db
      .select({ userId: boardMembers.userId })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardRow.id), eq(boardMembers.userId, existingUser.id)))
      .limit(1);
    if (existingBoardAccess) throw conflict("This person already has access to this board.");
    if (existingUser.membershipClientId) throw badRequest("Organisation members are added directly to the board, not invited as guests.");
    // Seat-pool gate + membership insert in one transaction so the capacity check is race-safe.
    // Crossing the free guest-board cap consumes a pooled seat; a full pool throws 402 SEAT_LIMIT_REACHED.
    const { row: member, guestSeat } = await db.transaction(async (tx) => {
      const seat = await ensureGuestBoardCapacity({
        hostClientId: clientId,
        boardId: boardRow.id,
        userId: existingUser.id,
        targetClientId: existingUser.clientId,
        createdById: auth.sub,
        tx,
      });
      const [inserted] = await tx
        .insert(boardMembers)
        .values({ boardId: boardRow.id, userId: existingUser.id, role: body.role, assignedItemsOnly: body.assignedItemsOnly })
        .onConflictDoUpdate({
          target: [boardMembers.boardId, boardMembers.userId],
          set: { role: body.role, assignedItemsOnly: body.assignedItemsOnly },
        })
        .returning();
      return { row: inserted, guestSeat: seat };
    });

    const [inviter] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    return {
      kind: "guestAdded" as const,
      workspaceId: id,
      clientId,
      email: body.email,
      boardRow,
      inviterName: inviter?.displayName,
      existingUser,
      member: member!,
      response: {
        status: "added" as const,
        // Organisation members were rejected above, so this path only ever adds a guest.
        guest: {
          boardId: boardRow.id,
          boardName: boardRow.boardName,
          userId: existingUser.id,
          role: member!.role,
          addedAt: member!.addedAt,
          email: body.email,
          displayName: existingUser.displayName,
          avatarUrl: withSignedMedia(existingUser.clientId, { avatarUrl: existingUser.avatarUrl }).avatarUrl,
          lastOnlineAt: existingUser.lastOnlineAt,
          clientId: existingUser.clientId,
          paidGuestSeat: guestSeat.paidGuestSeatActive,
        },
      },
    };
  }


  // This is normally free for the first board, but keeping the capacity check in the mutation also
  // covers deployments with a different free-board allowance and avoids relying on the UI preview.
  await previewGuestBoardsCapacity({ hostClientId: clientId, boardIds: [boardRow.id] });
  const token = newOpaqueToken();
  const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
  const [invitation] = await db
    .insert(boardInvitations)
    .values({
      clientId,
      boardId: boardRow.id,
      email: body.email,
      role: body.role,
      assignedItemsOnly: body.assignedItemsOnly,
      tokenHash: token.hash,
      invitedById: auth.sub,
      expiresAt,
    })
    .returning();
  await db.insert(boardInvitationGrants).values({ invitationId: invitation!.id, boardId: boardRow.id, role: body.role, assignedItemsOnly: body.assignedItemsOnly });

  const [inviter] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, auth.sub))
    .limit(1);
  return {
    kind: "invitationCreated" as const,
    workspaceId: id,
    clientId,
    email: body.email,
    boardRow,
    inviterName: inviter?.displayName,
    inviteBoards: [{ boardName: boardRow.boardName, role: body.role }],
    acceptToken: token.raw,
    response: {
      status: "invited" as const,
      token: token.raw,
      invite: {
        id: invitation!.id,
        boardId: boardRow.id,
        boardName: boardRow.boardName,
        email: invitation!.email,
        role: invitation!.role,
        expiresAt: invitation!.expiresAt,
        createdAt: invitation!.createdAt,
        boards: [{ boardId: boardRow.id, boardName: boardRow.boardName, role: invitation!.role, assignedItemsOnly: invitation!.assignedItemsOnly }],
      },
    },
  };
}

export async function emitInviteWorkspaceGuest({ auth, mailer, locale, result }: {
  auth: AuthClaims;
  mailer: Mailer;
  // The inviter's on-screen language, used for invites to people without an account.
  locale: Locale;
  result: InviteWorkspaceGuestResult;
}) {
  const { workspaceId: id, clientId, boardRow } = result;
  if (result.kind === "guestAdded") {
    const { existingUser, member } = result;
    // Each newly granted board is actionable access in its own right, including when the
    // recipient is already a guest on another board in this organisation.
    const recipientLanguage = recipientLocale(existingUser.locale);
    await mailer.sendBoardAccessGranted(result.email, {
      locale: recipientLanguage,
      displayName: existingUser.displayName,
      boardName: boardRow.boardName,
      orgName: boardRow.clientName,
      invitedByName: result.inviterName ?? serverMessages(recipientLanguage).common.fallbackInviterName,
      role: member.role,
      boardUrl: `${env.WEB_ORIGIN}/b/${boardRow.id}`,
    });

    const payload = {
      boardId: boardRow.id,
      member,
      user: {
        userId: existingUser.id,
        displayName: existingUser.displayName,
        avatarUrl: withSignedMedia(existingUser.clientId, { avatarUrl: existingUser.avatarUrl }).avatarUrl,
        lastOnlineAt: existingUser.lastOnlineAt,
        role: member.role,
        source: "board" as const,
        clientId: existingUser.clientId,
        isOrganisationMember: false,
      },
    };
    await emitToBoard(boardRow.id, "board:member:added", payload);
    emitToUser(existingUser.id, "board:member:added", payload);
    await captureWorkspaceMemberJoined({
      organizationId: clientId,
      workspaceIds: [id],
      actorId: existingUser.id,
      joinSource: "direct",
      supportSession: auth.authKind === "support",
    });
  } else {
    // The invitee has no account yet, so the invite is written in the inviter's on-screen language.
    await mailer.sendBoardInvite(result.email, {
      locale,
      boards: result.inviteBoards,
      orgName: boardRow.clientName,
      invitedByName: result.inviterName ?? serverMessages(locale).common.fallbackInviterName,
      acceptUrl: `${env.WEB_ORIGIN}/board-invite?token=${encodeURIComponent(result.acceptToken)}`,
    });
    if (result.kind === "invitationCreated") {
      await captureWorkspaceInvitationCreated({
        organizationId: clientId,
        workspaceIds: [id],
        actorId: auth.sub,
        supportSession: auth.authKind === "support",
      });
    }
  }
  void capturePremiumFeatureUsed({
    organizationId: clientId,
    workspaceId: id,
    actorId: auth.sub,
    premiumFeature: "guests",
    supportSession: auth.authKind === "support",
  });
}

export async function revokeWorkspaceGuestInvitation({ workspaceId: id, invitationId }: { workspaceId: string; invitationId: string }) {
  const [invitation] = await db
    .select({ id: boardInvitations.id })
    .from(boardInvitations)
    .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
    .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
    .where(and(eq(boardInvitations.id, invitationId), eq(boards.workspaceId, id)))
    .limit(1);
  if (!invitation) throw notFound();
  await db.update(boardInvitations).set({ revokedAt: new Date() }).where(eq(boardInvitations.id, invitationId));
}

export async function removeWorkspaceGuest({ auth, workspaceId: id, clientId, boardId, userId }: {
  auth: AuthClaims;
  workspaceId: string;
  clientId: string;
  boardId: string;
  userId: string;
}) {
  const [member] = await db
    .select({ role: boardMembers.role, pinned: boardMembers.pinned, membershipUserId: clientMembers.userId })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .leftJoin(clientMembers, and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, users.id),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .where(and(eq(boards.workspaceId, id), eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
    .limit(1);
  if (!member) throw notFound();
  // This route has guest-seat side effects and must never bypass the pinned-admin protections on
  // the general board-members endpoint for a same-organisation user.
  if (member.membershipUserId || member.pinned) throw badRequest("target is not a removable board guest");
  const cleanup = await db.transaction(async (tx) => {
    const participation = await cleanupUserBoardParticipation(tx, {
      userId,
      boardIds: [boardId],
      actorId: auth.sub,
    });
    await recordActivity(tx, {
      boardId,
      workspaceId: id,
      actorId: auth.sub,
      entityType: "board",
      entityId: userId,
      action: "removed",
      payload: { userId, role: member.role },
    });
    return participation;
  });
  // Frees the guest's pooled seat (used count) without reducing the purchased seat_limit / bill —
  // the freed seat stays available for the admin to assign to someone else.
  const guestSeat = await prunePaidGuestSeatIfBelowLimit({ hostClientId: clientId, userId });
  return { cleanup, guestSeat };
}

export async function emitRemoveWorkspaceGuest({ boardId, userId, cleanup }: {
  boardId: string;
  userId: string;
  cleanup: Awaited<ReturnType<typeof removeWorkspaceGuest>>["cleanup"];
}) {
  await emitToBoard(boardId, "board:member:removed", { boardId, userId });
  for (const update of cleanup.assigneeUpdates) await emitToBoard(boardId, "card:assignees:set", update);
  for (const update of cleanup.checklistItemUpdates) await emitToBoard(boardId, "card:checklistItem:updated", update);
  for (const update of cleanup.activities) await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
  // A guest's own queue can hold this board's cards; their surviving sessions must refetch it.
  if (cleanup.removedPriorityEntries) await emitCardPriorityInvalidated(userId);
  disconnectUserRealtimeSockets(userId);
}
