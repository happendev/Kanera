import { dto } from "@kanera/shared";
import {
  USER_PROFILE_ACTIVITY_DAYS,
  USER_PROFILE_BOARD_LIMIT,
  USER_PROFILE_COMPLETED_DAYS,
  USER_PROFILE_RECENT_CARD_LIMIT,
  type UserProfileResponse,
  type UserProfileRole,
} from "@kanera/shared/dto";
import {
  activityEvents,
  boardMembers,
  cardAssignees,
  cardSummaryView,
  clientMembers,
  clients,
  lists,
  users,
  workspaceMembers,
} from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { assignedCardVisibility } from "../../lib/access.js";
import { loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { cardAccessCondition, cardSummaryDueColumns, overdueSql } from "../../lib/card-due-sql.js";
import { addDays, localDateInTimezone } from "../../lib/due-date.js";
import { notFound } from "../../lib/errors.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { loadWorkDoneSummary } from "../../lib/work-done.js";

const userIdParam = z.object({ userId: z.uuid() });

/**
 * The card an activity row is about: the row itself for card events, the parent card for child
 * entities (comments, checklists, attachments) that carry it in their payload. Same expression as
 * `activity_events_card_lookup_created_at_idx`, so both stay one definition of "this row's card".
 */
const activityCardIdSql = sql<string | null>`(case when ${activityEvents.entityType} = 'card' then ${activityEvents.entityId}::text else ${activityEvents.payload}->>'cardId' end)`;

/**
 * Rows that are this person's own doing. `actor_id` alone is not enough: system rows and support
 * sessions (a superadmin acting *as* the user) both carry it, and crediting either to the person
 * would put work on their profile that they never did. Agents and personal keys stay in, because
 * they act for the person and the rest of the product (Home, Work Done) credits them the same way.
 */
function ownActivity(userId: string): SQL {
  return and(
    eq(activityEvents.actorId, userId),
    notInArray(activityEvents.actorKind, ["system", "support"]),
  )!;
}

/**
 * Restricts activity rows to what the viewer may see. Whole boards for normal access; on boards
 * where the viewer only sees cards assigned to them, only rows about one of those cards, so the grid
 * cannot reveal how busy someone is on work the viewer is not allowed to know exists.
 *
 * `workspace_id` is listed even though the board filter implies it: together with `actor_id` it is
 * the prefix of `activity_events_coalesce_probe_idx`, which bounds the scan to this person's rows
 * instead of walking every event on every board the viewer can see.
 */
function visibleActivity(viewerId: string, scopeBoards: AccessibleBoard[]): SQL {
  const boardIds = scopeBoards.map((board) => board.id);
  const workspaceIds = [...new Set(scopeBoards.map((board) => board.workspaceId))];
  const restrictedBoardIds = scopeBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  return and(
    inArray(activityEvents.workspaceId, workspaceIds),
    inArray(activityEvents.boardId, boardIds),
    // A personal priority-queue entry is one person's private sequencing; see ACTIVITY_ENTITY_TYPES.
    sql`${activityEvents.entityType} <> 'cardPriority'`,
    restrictedBoardIds.length
      ? or(
          notInArray(activityEvents.boardId, restrictedBoardIds),
          assignedCardVisibility(viewerId, sql`${activityCardIdSql}::uuid`),
        )
      : undefined,
  )!;
}

/** Start of the grid window as an instant, anchored to a local midnight in the bucketing zone. */
function windowStartSql(timeZone: string, days: number): SQL {
  return sql`(
    date_trunc('day', now() at time zone ${timeZone}::text) - make_interval(days => ${days - 1})
  ) at time zone ${timeZone}::text`;
}

function profileRole(
  membership: { clientRole: "owner" | "admin" | "member" } | undefined,
  workspaceRole: "admin" | "member" | null,
): UserProfileRole {
  if (!membership) return "guest";
  if (membership.clientRole === "owner" || membership.clientRole === "admin") return membership.clientRole;
  return workspaceRole === "admin" ? "workspaceAdmin" : "member";
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /**
   * A person's profile card as the viewer is allowed to see it.
   *
   * People are only discoverable through shared work: yourself, anyone in your current organisation,
   * or anyone who is a member of a board you can open. Everyone else is a 404 rather than a 403 so
   * the endpoint cannot be used to probe which user ids exist.
   */
  app.get("/users/:userId/profile", async (req): Promise<UserProfileResponse> => {
    const params = userIdParam.safeParse(req.params);
    if (!params.success) throw notFound("user not found");
    const targetId = params.data.userId;
    const query = dto.userProfileQuery.parse(req.query ?? {});
    const viewerId = req.auth.sub;
    const isSelf = targetId === viewerId;

    const [accessibleBoards, [target], [viewer]] = await Promise.all([
      loadAccessibleBoards(req.auth),
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          email: users.email,
          timezone: users.timezone,
          lastOnlineAt: users.lastOnlineAt,
          homeClientId: users.clientId,
          homeOrganisationName: clients.name,
        })
        .from(users)
        .innerJoin(clients, eq(clients.id, users.clientId))
        .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
        .limit(1),
      db.select({ timezone: users.timezone }).from(users).where(eq(users.id, viewerId)).limit(1),
    ]);
    if (!target) throw notFound("user not found");

    const accessibleIds = accessibleBoards.map((board) => board.id);
    // The clicked surface decides which organisation the role and email are described against, but
    // only when the viewer can actually reach it; otherwise fall back to the viewer's current org.
    const contextBoard = query.workspaceId
      ? accessibleBoards.find((board) => board.workspaceId === query.workspaceId)
      : undefined;
    const contextClientId = contextBoard?.clientId ?? req.auth.cid;
    const accessibleClientIds = [...new Set(accessibleBoards.map((board) => board.clientId))];

    const [memberBoardRows, membershipRows, targetAdminOrgRows, workspaceRoleRows] = await Promise.all([
      accessibleIds.length
        ? db
            .select({ boardId: boardMembers.boardId })
            .from(boardMembers)
            .where(and(eq(boardMembers.userId, targetId), inArray(boardMembers.boardId, accessibleIds)))
        : Promise.resolve([]),
      db
        .select({ userId: clientMembers.userId, clientId: clientMembers.clientId, clientRole: clientMembers.clientRole })
        .from(clientMembers)
        .where(and(
          inArray(clientMembers.userId, [...new Set([targetId, viewerId])]),
          inArray(clientMembers.clientId, [...new Set([contextClientId, req.auth.cid])]),
          isNull(clientMembers.suspendedAt),
          isNull(clientMembers.removedAt),
        )),
      // Organisation owners/admins reach every board in their organisation without a board_member
      // row of their own, so membership rows alone would show an owner sharing no boards at all.
      accessibleClientIds.length
        ? db
            .select({ clientId: clientMembers.clientId })
            .from(clientMembers)
            .where(and(
              eq(clientMembers.userId, targetId),
              inArray(clientMembers.clientId, accessibleClientIds),
              inArray(clientMembers.clientRole, ["owner", "admin"]),
              isNull(clientMembers.suspendedAt),
              isNull(clientMembers.removedAt),
            ))
        : Promise.resolve([]),
      contextBoard && contextBoard.workspaceKind === "standard"
        ? db
            .select({ role: workspaceMembers.role })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, contextBoard.workspaceId), eq(workspaceMembers.userId, targetId)))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const membership = (userId: string, clientId: string) =>
      membershipRows.find((row) => row.userId === userId && row.clientId === clientId);
    const targetAdminOrgIds = new Set(targetAdminOrgRows.map((row) => row.clientId));
    const memberBoardIds = new Set(memberBoardRows.map((row) => row.boardId));
    const sharedBoards = accessibleBoards.filter((board) =>
      memberBoardIds.has(board.id) || targetAdminOrgIds.has(board.clientId)
    );

    const sameOrganisation = Boolean(membership(targetId, req.auth.cid));
    if (!isSelf && !sameOrganisation && sharedBoards.length === 0) throw notFound("user not found");

    const targetContextMembership = membership(targetId, contextClientId);
    const viewerContextMembership = membership(viewerId, contextClientId);
    const role = profileRole(targetContextMembership, workspaceRoleRows[0]?.role ?? null);
    // Email follows the organisation directory: colleagues already see each other's addresses on the
    // members pages, while a cross-organisation guest relationship exposes neither side's address.
    const showEmail = isSelf || Boolean(targetContextMembership && viewerContextMembership);

    const timeZone = query.timeZone ?? viewer?.timezone ?? "UTC";
    const today = localDateInTimezone(new Date(), timeZone);

    const base = {
      user: {
        id: target.id,
        displayName: target.displayName,
        avatarUrl: signedAvatarUrl(target.homeClientId, target.avatarUrl),
        email: showEmail ? target.email : null,
        timezone: target.timezone,
        lastOnlineAt: target.lastOnlineAt?.toISOString() ?? null,
        homeOrganisationName: role === "guest" && viewerContextMembership && target.homeClientId !== contextClientId
          ? target.homeOrganisationName
          : null,
      },
      isSelf,
      role,
      timeZone,
      today,
      sharedBoards: {
        total: sharedBoards.length,
        // accessibleBoards is already in sidebar order, so the first few read like the viewer's nav.
        boards: sharedBoards.slice(0, USER_PROFILE_BOARD_LIMIT).map((board) => ({
          id: board.id,
          name: board.name,
          icon: board.icon,
          iconColor: board.iconColor,
          workspaceId: board.workspaceId,
          workspaceName: board.workspaceName,
          workspaceKind: board.workspaceKind,
        })),
      },
    };

    if (accessibleBoards.length === 0) {
      return {
        ...base,
        stats: { openCards: 0, overdueCards: 0, completedCards: 0, completedDays: USER_PROFILE_COMPLETED_DAYS },
        activity: { days: USER_PROFILE_ACTIVITY_DAYS, total: 0, byDay: [] },
        recentCards: [],
      };
    }

    const cardAccess = cardAccessCondition(viewerId, accessibleBoards, cardSummaryDueColumns);
    const overdue = overdueSql(cardSummaryDueColumns);
    const activityScope = and(ownActivity(targetId), visibleActivity(viewerId, accessibleBoards));
    const gridStart = windowStartSql(timeZone, USER_PROFILE_ACTIVITY_DAYS);

    // The grid window as instants: local midnight USER_PROFILE_ACTIVITY_DAYS - 1 days ago up to the
    // start of tomorrow, both in the bucketing zone, so the oldest and newest columns are whole days.
    const [window] = await db.execute<{ from: Date; to: Date }>(sql`
      select ${gridStart} as "from",
        (date_trunc('day', now() at time zone ${timeZone}::text) + interval '1 day') at time zone ${timeZone}::text as "to"
    `).then((result) => result.rows);

    const [[cardCounts], completions, recentRows] = await Promise.all([
      // Open work, driven from card_assignee so the (user_id, card_id) index bounds the scan to this
      // person's assignments before the summary view expands anything (same drive order as Home).
      db
        .select({
          open: sql<number>`count(*)::integer`,
          overdue: sql<number>`count(*) filter (where ${overdue})::integer`,
        })
        .from(cardAssignees)
        .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardAssignees.cardId))
        .innerJoin(lists, eq(lists.id, cardSummaryView.listId))
        .where(and(
          eq(cardAssignees.userId, targetId),
          cardAccess,
          isNull(cardSummaryDueColumns.archivedAt),
          isNull(cardSummaryDueColumns.completedAt),
          isNull(lists.archivedAt),
        )),
      // Completions per day through the Work done summary itself, so the profile grid and the Work
      // done "Completed" strip count the same events for the same person on the same boards: one
      // definition of a completion, of its actor, and of the restricted-board boundary.
      loadWorkDoneSummary({
        clientId: req.auth.cid,
        boardIds: accessibleIds,
        actorUserId: targetId,
        from: new Date(window!.from),
        to: new Date(window!.to),
        timeZone,
        visibilityUserId: viewerId,
        visibilityRestrictedBoardIds: accessibleBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id),
      }),
      // Oversampled: archived cards and restricted-board cards are only filtered when hydrating below,
      // and a handful of extra ids is far cheaper than a second round trip when the first few drop out.
      db
        .select({
          cardId: activityCardIdSql,
          lastActivityAt: sql<Date>`max(${activityEvents.createdAt})`,
        })
        .from(activityEvents)
        .where(and(
          activityScope,
          eq(activityEvents.feedVisible, true),
          gte(activityEvents.createdAt, gridStart),
          sql`${activityCardIdSql} is not null`,
        ))
        .groupBy(sql`1`)
        .orderBy(sql`2 desc`)
        .limit(USER_PROFILE_RECENT_CARD_LIMIT * 4),
    ]);

    const recentIds = recentRows
      .map((row) => row.cardId)
      .filter((id): id is string => typeof id === "string" && z.uuid().safeParse(id).success);
    const recentCardRows = recentIds.length
      ? await db
          .select({
            id: cardSummaryView.id,
            boardId: cardSummaryView.boardId,
            title: cardSummaryView.title,
            cardKey: cardSummaryView.key,
            organisationKey: cardSummaryView.organisationKey,
            completedAt: cardSummaryView.completedAt,
          })
          .from(cardSummaryView)
          .where(and(inArray(cardSummaryView.id, recentIds), isNull(cardSummaryDueColumns.archivedAt), cardAccess))
      : [];
    const boardsById = new Map(accessibleBoards.map((board) => [board.id, board]));
    const cardsById = new Map(recentCardRows.map((row) => [row.id, row]));
    const recentCards = recentRows.flatMap((row) => {
      const card = row.cardId ? cardsById.get(row.cardId) : undefined;
      const board = card ? boardsById.get(card.boardId) : undefined;
      if (!card || !board) return [];
      return [{
        id: card.id,
        boardId: card.boardId,
        boardName: board.name,
        title: card.title,
        cardKey: card.cardKey,
        organisationKey: card.organisationKey,
        completed: card.completedAt !== null,
        lastActivityAt: new Date(row.lastActivityAt).toISOString(),
      }];
    }).slice(0, USER_PROFILE_RECENT_CARD_LIMIT);

    const completedDays = completions.days.filter((day) => day.completed > 0);
    // "Completed · 30d" is the tail of the same series the grid draws, so the tile and the last few
    // weeks of the grid can never disagree.
    const recentFloor = addDays(today, -(USER_PROFILE_COMPLETED_DAYS - 1));
    return {
      ...base,
      stats: {
        openCards: cardCounts?.open ?? 0,
        overdueCards: cardCounts?.overdue ?? 0,
        completedCards: completedDays.filter((day) => day.date >= recentFloor).reduce((sum, day) => sum + day.completed, 0),
        completedDays: USER_PROFILE_COMPLETED_DAYS,
      },
      activity: {
        days: USER_PROFILE_ACTIVITY_DAYS,
        total: completedDays.reduce((sum, day) => sum + day.completed, 0),
        byDay: completedDays.map((day) => ({ date: day.date, count: day.completed })),
      },
      recentCards,
    };
  });
}
