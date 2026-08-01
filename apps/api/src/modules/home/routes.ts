import { dto } from "@kanera/shared";
import type {
  HomeCounts,
  HomeDueBucket,
  HomeItem,
  HomeItemLabel,
  HomeTodayResponse,
  HomeTrendDay,
} from "@kanera/shared/dto";
import { HOME_HORIZON_LIMIT, HOME_TREND_DAYS } from "@kanera/shared/dto";
import {
  activityEvents,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardLabelAssignments,
  cardLabels,
  cardSummaryView,
  lists,
  users,
} from "@kanera/shared/schema";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { loadAssignedChecklistItems } from "../../lib/assigned-checklist-items.js";
import { cardAccessCondition, cardSummaryDueColumns, overdueSql } from "../../lib/card-due-sql.js";
import { addDays, isDueDateOverdue, localDateInTimezone } from "../../lib/due-date.js";
import { activityCompletedPredicate, activityDayExpr } from "../../lib/work-done.js";

/** Slot cut-off ordering, matching the table the due-soon projections already use. */
const SLOT_RANK = { morning: 0, afternoon: 1, endOfWorkDay: 2, anyTime: 3 } as const;

/** Bucket precedence: overdue always wins, then the calendar buckets in date order. */
const BUCKET_RANK: Record<HomeDueBucket, number> = {
  overdue: 0,
  today: 1,
  tomorrow: 2,
  laterThisWeek: 3,
};

const EMPTY_COUNTS: HomeCounts = {
  overdueCards: 0,
  overdueChecklistItems: 0,
  dueTodayCards: 0,
  dueTodayChecklistItems: 0,
  dueTomorrowCards: 0,
  dueTomorrowChecklistItems: 0,
  dueLaterThisWeekCards: 0,
  dueLaterThisWeekChecklistItems: 0,
  dueWithin7DaysCards: 0,
  dueWithin7DaysChecklistItems: 0,
  assignedCards: 0,
  assignedChecklistItems: 0,
};

/** Sort key for a slot, used both in SQL and when merging the two item streams in JS. */
function slotRank(slot: keyof typeof SLOT_RANK | null): number {
  return SLOT_RANK[slot ?? "anyTime"];
}

/**
 * Which bucket a dated, non-overdue item falls in, in the *viewer's* zone.
 *
 * `dueDateLocalDate` is a wall-clock date, not an instant, so this is a string comparison — never
 * convert it. Returns null for work outside the 7-day horizon, which the agenda does not show.
 */
function calendarBucket(
  dueDateLocalDate: string,
  today: string,
  tomorrow: string,
  horizonEnd: string,
): HomeDueBucket | null {
  if (dueDateLocalDate === today) return "today";
  if (dueDateLocalDate === tomorrow) return "tomorrow";
  if (dueDateLocalDate > tomorrow && dueDateLocalDate <= horizonEnd) return "laterThisWeek";
  return null;
}

/**
 * Start of the trend window as a timestamptz, computed entirely in SQL.
 *
 * Deliberately not the JS form (`Date.now() - 28 * 86400000`): that starts mid-day, so the oldest
 * heatmap column would be a partial day and silently under-report. `date_trunc` in the viewer's
 * zone anchors the window to a local midnight, then converting back to timestamptz makes it
 * comparable with the `created_at` / `completed_at` instants.
 */
function trendWindowStartSql(timeZone: string): SQL {
  return sql`(
    date_trunc('day', now() at time zone ${timeZone}::text) - make_interval(days => ${HOME_TREND_DAYS - 1})
  ) at time zone ${timeZone}::text`;
}

function emptyResponse(timeZone: string, today: string, horizonEnd: string): HomeTodayResponse {
  return {
    timeZone,
    today,
    horizonEnd,
    counts: { ...EMPTY_COUNTS },
    items: [],
    itemsTruncated: false,
    trend: {
      days: HOME_TREND_DAYS,
      byDay: [],
      thisWeek: { completedCards: 0, completedChecklistItems: 0 },
      lastWeek: { completedCards: 0, completedChecklistItems: 0 },
    },
    boardCount: 0,
  };
}

export async function homeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /**
   * The signed-in user's day: what is overdue or due within a week, and how much they have
   * completed recently. Internal only — deliberately not registered on the public API server, and
   * not listed in the public OpenAPI document.
   *
   * GET rather than POST because home is a fixed, opinionated view with no scope or filter body,
   * unlike the `/work/*` family.
   */
  app.get("/home/today", async (req) => {
    const startedAt = performance.now();
    const query = dto.homeTodayQuery.parse(req.query ?? {});
    const userId = req.auth.sub;

    const [accessibleBoards, userRows] = await Promise.all([
      loadAccessibleBoards(req.auth),
      db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1),
    ]);

    // Request zone wins so a client that knows the browser zone is authoritative; the profile zone
    // is the fallback because it is what the daily digest and overdue emails already use, keeping
    // home's "today" aligned with the mail when the client sends nothing.
    const timeZone = query.timeZone ?? userRows[0]?.timezone ?? "UTC";
    const today = localDateInTimezone(new Date(), timeZone);
    const tomorrow = addDays(today, 1);
    const horizonEnd = addDays(today, 7);

    // New user, or a guest whose last board access was revoked. Returning the zeroed payload here
    // also sidesteps building `inArray(x, [])` predicates below.
    if (accessibleBoards.length === 0) {
      req.log.info({
        event: "home_today_loaded",
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        boardCount: 0,
        itemCount: 0,
        overdueCount: 0,
        trendDayCount: 0,
        timeZone,
        timeZoneSource: query.timeZone ? "request" : "profile",
        accessFilteredSources: 0,
      });
      return emptyResponse(timeZone, today, horizonEnd);
    }

    const boardIds = accessibleBoards.map((board) => board.id);
    const boardsById = new Map(accessibleBoards.map((board) => [board.id, board]));
    const overdue = overdueSql(cardSummaryDueColumns);
    const cardAccess = cardAccessCondition(userId, accessibleBoards, cardSummaryDueColumns);
    const windowStart = trendWindowStartSql(timeZone);

    /**
     * Active assigned cards, driven from `card_assignee`.
     *
     * The drive order is load-bearing: `card_summary_view.assignee_ids` is produced by a lateral
     * aggregate, so `$me = any(assignee_ids)` cannot use an index and Postgres would scan every
     * card on every accessible board. Starting from `card_assignee` lets
     * `card_assignees_user_card_idx (user_id, card_id)` bound the scan to the viewer's own rows
     * before the view expands anything. This is the same drive order `/home/boards` uses, and it
     * is why this endpoint needs no new index.
     *
     * `cardAccess` is technically redundant here — filtering to the viewer's own assignments is
     * strictly stronger than the assigned-items-only boundary — but it is kept as belt and braces:
     * the planner folds it away, and a future relaxation of the assignee join then cannot silently
     * leak cards on restricted boards.
     */
    const activeAssignedCards = and(
      eq(cardAssignees.userId, userId),
      cardAccess,
      isNull(cardSummaryDueColumns.archivedAt),
      isNull(cardSummaryDueColumns.completedAt),
      isNull(lists.archivedAt),
    );

    const [cardCountRows, horizonCardRows, checklistItems, cardTrendRows, checklistTrendRows] = await Promise.all([
      // Q1: every count in one pass of `count(*) filter`.
      db
        .select({
          assigned: sql<number>`count(*)::integer`,
          overdue: sql<number>`count(*) filter (where ${overdue})::integer`,
          dueToday: sql<number>`count(*) filter (where not ${overdue} and ${cardSummaryDueColumns.dueDateLocalDate} = ${today})::integer`,
          dueTomorrow: sql<number>`count(*) filter (where not ${overdue} and ${cardSummaryDueColumns.dueDateLocalDate} = ${tomorrow})::integer`,
          dueLaterThisWeek: sql<number>`count(*) filter (where not ${overdue} and ${cardSummaryDueColumns.dueDateLocalDate} > ${tomorrow} and ${cardSummaryDueColumns.dueDateLocalDate} <= ${horizonEnd})::integer`,
        })
        .from(cardAssignees)
        .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardAssignees.cardId))
        .innerJoin(lists, eq(lists.id, cardSummaryView.listId))
        .where(activeAssignedCards),

      // Q2: the card half of the agenda. Narrow projection on purpose — `toWireCardSummary` would
      // sign cover media and carry labels and custom-field values that a due list never renders.
      db
        .select({
          id: cardSummaryView.id,
          organisationKey: cardSummaryView.organisationKey,
          cardKey: cardSummaryView.key,
          title: cardSummaryView.title,
          boardId: cardSummaryView.boardId,
          listId: cardSummaryView.listId,
          listName: lists.name,
          dueDateLocalDate: cardSummaryView.dueDateLocalDate,
          dueDateSlot: cardSummaryView.dueDateSlot,
          dueDateTimezone: cardSummaryView.dueDateTimezone,
          // Reuse the same predicate that drove the counts so bucket assignment can never
          // re-derive overdue-ness slightly differently from the tile above it.
          isOverdue: sql<boolean>`${overdue}`,
        })
        .from(cardAssignees)
        .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardAssignees.cardId))
        .innerJoin(lists, eq(lists.id, cardSummaryView.listId))
        .where(and(
          activeAssignedCards,
          or(
            overdue,
            and(
              gte(cardSummaryDueColumns.dueDateLocalDate, today),
              lte(cardSummaryDueColumns.dueDateLocalDate, horizonEnd),
            ),
          ),
        ))
        // Prefix of the final total order: overdue first, then by date and slot. The board
        // `navigationOrder` and kind tiebreaks are applied in JS after the two streams merge,
        // since navigation order is not a column.
        .orderBy(
          sql`${overdue} desc`,
          sql`${cardSummaryDueColumns.dueDateLocalDate} asc`,
          sql`case coalesce(${cardSummaryDueColumns.dueDateSlot}, 'anyTime')
            when 'morning' then 0 when 'afternoon' then 1 when 'endOfWorkDay' then 2 else 3 end asc`,
          sql`${cardSummaryView.id} asc`,
        )
        .limit(HOME_HORIZON_LIMIT),

      // Q3: assigned checklist items. The full accessible board set is safe to pass because
      // `assigneeIds: [userId]` *is* the assignee branch of `assignedCardVisibility` — the
      // assigned-items-only boundary is satisfied by construction. (`checklistAssignments()` in
      // work/routes.ts has to split restricted from unrestricted only because it serves other
      // people's items.) `requireDueDate: false` so undated items still reach `assignedChecklistItems`,
      // matching `assignedCards`; they are skipped when building the horizon below.
      // The loader caps at 5000 rows internally, which is far above any realistic personal load.
      loadAssignedChecklistItems(db, {
        assigneeIds: [userId],
        boardIds,
        requireDueDate: false,
      }),

      // Q4a: cards the viewer completed, per viewer-local day.
      //
      // `count(*)`, never `sum(coalesced_count)`: a coalesced row's count includes the toggles and
      // un-completions folded into it, so summing it would credit un-completing a card as work.
      //
      // `actor_kind` is deliberately not filtered, matching `loadWorkDone`: an integration acting
      // with a personal API key credits the human whose id it borrows. Changing that here alone
      // would make home and the work-done timeline disagree.
      //
      // `completed_cards_active_days` deliberately does NOT apply. That workspace setting answers
      // "does this completed card still render on a board", not "did I finish it" — the trend
      // counts completion events over a fixed window and must ignore it.
      db
        .select({
          date: activityDayExpr(activityEvents.createdAt, timeZone),
          count: sql<number>`count(*)::integer`,
        })
        .from(activityEvents)
        .innerJoin(cardSummaryView, eq(cardSummaryView.id, activityEvents.entityId))
        .where(and(
          eq(activityEvents.entityType, "card"),
          // Coalesced/suppressed rows are hidden from the card feed, so they must not inflate the grid.
          eq(activityEvents.feedVisible, true),
          eq(activityEvents.actorId, userId),
          activityCompletedPredicate(),
          inArray(activityEvents.boardId, boardIds),
          gte(activityEvents.createdAt, windowStart),
          // Unlike Q1/Q2 this is NOT redundant: on a restricted board the viewer may have
          // completed a card they are no longer assigned to.
          cardAccess,
        ))
        // Grouped by output ordinal: repeating the expression would emit fresh parameter
        // placeholders for the zone, and Postgres then no longer recognises it as the same
        // grouped expression.
        .groupBy(sql`1`)
        .orderBy(sql`1`),

      // Q4b: checklist items the viewer completed. Sourced from the item's own columns rather than
      // activity, matching `loadWorkDone`'s checklist branch — including its documented behaviour
      // that reopening an item retroactively removes it from history.
      //
      // Kept as its own statement rather than a `union all` with Q4a: the union would bind the zone
      // parameter twice inside the grouped `to_char`, which is exactly the hazard the `GROUP BY 1`
      // comment above warns about. The two day maps are merged in JS.
      db
        .select({
          date: activityDayExpr(cardChecklistItems.completedAt, timeZone),
          count: sql<number>`count(*)::integer`,
        })
        .from(cardChecklistItems)
        .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
        .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardChecklists.cardId))
        .where(and(
          eq(cardChecklistItems.completedById, userId),
          gte(cardChecklistItems.completedAt, windowStart),
          isNull(cardSummaryDueColumns.archivedAt),
          inArray(cardSummaryDueColumns.boardId, boardIds),
          cardAccess,
        ))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
    ]);

    const cardItems: HomeItem[] = [];
    for (const row of horizonCardRows) {
      const board = boardsById.get(row.boardId);
      // Undated cards never enter the horizon, and the board must be one we resolved above.
      if (!board || !row.dueDateLocalDate) continue;
      const bucket = row.isOverdue
        ? "overdue"
        : calendarBucket(row.dueDateLocalDate, today, tomorrow, horizonEnd);
      if (!bucket) continue;
      cardItems.push({
        kind: "card",
        id: row.id,
        cardId: row.id,
        cardKey: row.cardKey,
        organisationKey: row.organisationKey,
        title: row.title,
        cardTitle: null,
        bucket,
        listId: row.listId,
        listName: row.listName,
        // Filled in by the labels statement below, once the horizon is known.
        labels: [],
        dueDateLocalDate: row.dueDateLocalDate,
        dueDateSlot: row.dueDateSlot,
        dueDateTimezone: row.dueDateTimezone,
        ...boardFields(board, req.auth.cid),
      });
    }

    const checklistItemRows: HomeItem[] = [];
    const checklistCounts = { overdue: 0, today: 0, tomorrow: 0, laterThisWeek: 0 };
    for (const item of checklistItems) {
      const board = boardsById.get(item.boardId);
      if (!board || !item.dueDateLocalDate) continue;
      // Overdue-ness uses the item's *own* stored zone with the same slot cut-offs as cards;
      // `isDueDateOverdue` is the documented app-level twin of `overdueChecklistSql`.
      const bucket = isDueDateOverdue(item)
        ? "overdue" as const
        : calendarBucket(item.dueDateLocalDate, today, tomorrow, horizonEnd);
      if (!bucket) continue;
      checklistCounts[bucket] += 1;
      checklistItemRows.push({
        kind: "checklistItem",
        id: item.itemId,
        cardId: item.cardId,
        cardKey: item.cardKey,
        organisationKey: item.organisationKey,
        title: item.text,
        cardTitle: item.cardTitle,
        bucket,
        listId: item.listId,
        listName: item.listName,
        labels: [],
        dueDateLocalDate: item.dueDateLocalDate,
        dueDateSlot: item.dueDateSlot,
        dueDateTimezone: item.dueDateTimezone,
        ...boardFields(board, req.auth.cid),
      });
    }

    // Labels for exactly the cards that made the horizon, in one bounded follow-up statement.
    //
    // Dependent on Q2/Q3 rather than folded into them: the card half could use a lateral, but the
    // checklist half would then need a second definition of the same join, and a checklist row
    // shows its *parent card's* labels. At most HOME_HORIZON_LIMIT cards are involved. No extra
    // access check is needed — these are labels on cards the two queries above already cleared.
    const labelledCardIds = [...new Set([
      ...cardItems.map((item) => item.cardId),
      ...checklistItemRows.map((item) => item.cardId),
    ])];
    const labelsByCardId = new Map<string, HomeItemLabel[]>();
    if (labelledCardIds.length > 0) {
      const labelRows = await db
        .select({
          cardId: cardLabelAssignments.cardId,
          id: cardLabels.id,
          name: cardLabels.name,
          color: cardLabels.color,
        })
        .from(cardLabelAssignments)
        .innerJoin(cardLabels, eq(cardLabels.id, cardLabelAssignments.labelId))
        .where(inArray(cardLabelAssignments.cardId, labelledCardIds))
        .orderBy(asc(cardLabelAssignments.assignedAt), asc(cardLabels.id));
      for (const row of labelRows) {
        const existing = labelsByCardId.get(row.cardId) ?? [];
        existing.push({ id: row.id, name: row.name, color: row.color });
        labelsByCardId.set(row.cardId, existing);
      }
    }
    for (const item of [...cardItems, ...checklistItemRows]) {
      item.labels = labelsByCardId.get(item.cardId) ?? [];
    }

    const cardCounts = cardCountRows[0] ?? { assigned: 0, overdue: 0, dueToday: 0, dueTomorrow: 0, dueLaterThisWeek: 0 };
    const counts: HomeCounts = {
      overdueCards: cardCounts.overdue,
      overdueChecklistItems: checklistCounts.overdue,
      dueTodayCards: cardCounts.dueToday,
      dueTodayChecklistItems: checklistCounts.today,
      dueTomorrowCards: cardCounts.dueTomorrow,
      dueTomorrowChecklistItems: checklistCounts.tomorrow,
      dueLaterThisWeekCards: cardCounts.dueLaterThisWeek,
      dueLaterThisWeekChecklistItems: checklistCounts.laterThisWeek,
      dueWithin7DaysCards: cardCounts.dueToday + cardCounts.dueTomorrow + cardCounts.dueLaterThisWeek,
      dueWithin7DaysChecklistItems: checklistCounts.today + checklistCounts.tomorrow + checklistCounts.laterThisWeek,
      assignedCards: cardCounts.assigned,
      assignedChecklistItems: checklistItems.length,
    };

    // Total order, no ties: bucket → date → slot → board navigation order (the canonical sidebar
    // order, so the agenda and the sidebar agree) → kind (cards before checklist items) → id.
    const merged = [...cardItems, ...checklistItemRows].sort((a, b) =>
      BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]
      || a.dueDateLocalDate.localeCompare(b.dueDateLocalDate)
      || slotRank(a.dueDateSlot) - slotRank(b.dueDateSlot)
      || (boardsById.get(a.boardId)?.navigationOrder ?? 0) - (boardsById.get(b.boardId)?.navigationOrder ?? 0)
      || (a.kind === b.kind ? 0 : a.kind === "card" ? -1 : 1)
      || a.id.localeCompare(b.id)
    );

    // Capped after merging both streams so the list is a true top-N of the combined agenda.
    // Known boundary imprecision: Q2 already capped cards at HOME_HORIZON_LIMIT pre-merge, so with
    // more than that many cards *and* many checklist items, a checklist item can displace a card
    // that was already cut. Pathological, and the counts stay exact either way.
    const items = merged.slice(0, HOME_HORIZON_LIMIT);
    const totalHorizon = counts.overdueCards + counts.overdueChecklistItems
      + counts.dueWithin7DaysCards + counts.dueWithin7DaysChecklistItems;

    const byDayMap = new Map<string, HomeTrendDay>();
    for (const row of cardTrendRows) {
      byDayMap.set(row.date, { date: row.date, completedCards: row.count, completedChecklistItems: 0 });
    }
    for (const row of checklistTrendRows) {
      const existing = byDayMap.get(row.date);
      if (existing) existing.completedChecklistItems = row.count;
      else byDayMap.set(row.date, { date: row.date, completedCards: 0, completedChecklistItems: row.count });
    }
    const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Rolling 7-day windows ending today rather than calendar weeks: no Monday cliff, and no third
    // and fourth boundary definition that could drift from the heatmap the delta sits beside.
    const sumWindow = (fromDate: string, toDate: string) =>
      byDay.reduce(
        (sum, day) => (day.date >= fromDate && day.date <= toDate
          ? {
              completedCards: sum.completedCards + day.completedCards,
              completedChecklistItems: sum.completedChecklistItems + day.completedChecklistItems,
            }
          : sum),
        { completedCards: 0, completedChecklistItems: 0 },
      );

    const response: HomeTodayResponse = {
      timeZone,
      today,
      horizonEnd,
      counts,
      items,
      itemsTruncated: totalHorizon > items.length,
      trend: {
        days: HOME_TREND_DAYS,
        byDay,
        thisWeek: sumWindow(addDays(today, -6), today),
        lastWeek: sumWindow(addDays(today, -13), addDays(today, -7)),
      },
      boardCount: accessibleBoards.length,
    };

    req.log.info({
      event: "home_today_loaded",
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      boardCount: accessibleBoards.length,
      itemCount: items.length,
      overdueCount: counts.overdueCards + counts.overdueChecklistItems,
      trendDayCount: byDay.length,
      timeZone,
      timeZoneSource: query.timeZone ? "request" : "profile",
      // Home has no scope selector, so nothing is ever filtered out of the accessible set.
      // Reported anyway to keep the work-read log schema uniform.
      accessFilteredSources: 0,
    });

    return response;
  });
}

/** Board, workspace and guest-organisation display fields, resolved once from the access list. */
function boardFields(board: AccessibleBoard, viewerClientId: string) {
  return {
    boardId: board.id,
    boardName: board.name,
    boardIcon: board.icon,
    boardIconColor: board.iconColor,
    workspaceId: board.workspaceId,
    workspaceName: board.workspaceName,
    // Only cross-organisation guest boards carry an owning-org label; own-org boards would just
    // repeat the viewer's own organisation name on every row.
    guestOrganisationName: board.clientId !== viewerClientId ? board.clientName : null,
  };
}
