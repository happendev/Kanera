import { dto } from "@kanera/shared";
import type { PortfolioActivityDay, PortfolioBucket, PortfolioListCount, PortfolioSummary, ScheduleHealth } from "@kanera/shared/dto";
import { ACTIVITY_ACTION, activityEvents, boards, cards, cardChecklistItems, cardChecklists, lists, workspaces } from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { applyWorkScope, loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { cardDueColumns, dependencyAtRiskSql, dueSoonSql, overdueChecklistItemSql, overdueSql } from "../../lib/card-due-sql.js";
import { loadViewerBoardSchedules, scheduleHealthOf, summarizeSchedule } from "../../lib/schedule-graph.js";
import { activityCompletedPredicate, activityDayExpr } from "../../lib/work-done.js";
import { baseCardConditions, hasOpenBlockerSql, inProgressTooLongSql } from "./work-cards-query.js";

/**
 * The cross-board rollup behind `work.portfolio_summary` (MCP), `kanera portfolio` and the SDK. It
 * is agent-only: the web app has no Portfolio page, but keeps the same predicates in the board
 * overview and board tile summaries so an agent's numbers match what members see per board.
 */
export async function portfolio(auth: AuthClaims, allBoards: AccessibleBoard[], input: unknown): Promise<PortfolioSummary> {
  const authUserId = auth.sub;
  const query = dto.workPortfolioQueryBody.parse(input);
  const scopeBoards = applyWorkScope(allBoards, query.scope);
  const from = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
  // Portfolio health uses each joined workspace's active-card inactivity boundary, matching the
  // board UI even when an organisation's workspaces intentionally have different thresholds.
  const filters = dto.workFiltersSchema.parse({ ...(query.filters ?? {}), completion: "all" });
  const conditions = baseCardConditions(authUserId, scopeBoards, filters, { portfolio: true, blockerBoards: allBoards }, cardDueColumns);

  const restrictedBoardIds = scopeBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  // These projections are independent, but running all of them at once increases queueing
  // for other UI requests. Use pairs while retaining the same resolved access scope.
  const [rows, checklistCountRows] = await Promise.all([
    db
      .select({
        organisationId: workspaces.clientId,
        workspaceId: workspaces.id,
        boardId: boards.id,
        active: sql<number>`count(*) filter (where ${cards.completedAt} is null)::integer`,
        overdue: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${overdueSql(cardDueColumns)})::integer`,
        dueSoon: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${dueSoonSql(cardDueColumns)})::integer`,
        unassigned: sql<number>`count(*) filter (where ${cards.completedAt} is null and not exists (
          select 1 from card_assignee portfolio_assignee where portfolio_assignee.card_id = ${cards.id}
        ))::integer`,
        inactive: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${cards.updatedAt} <= now() - make_interval(days => ${workspaces.inactiveCardsDays}))::integer`,
        inProgress: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${cards.inProgressSince} is not null)::integer`,
        inProgressTooLong: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${inProgressTooLongSql(cards.inProgressSince)})::integer`,
        blocked: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${hasOpenBlockerSql(cards.id)})::integer`,
        atRisk: sql<number>`count(*) filter (where ${cards.completedAt} is null and ${dependencyAtRiskSql(authUserId, allBoards, cardDueColumns)})::integer`,
        completed: sql<number>`count(*) filter (where ${cards.completedAt} >= ${from})::integer`,
      })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(...conditions))
      .groupBy(workspaces.clientId, workspaces.id, boards.id),

    db
      .select({
        boardId: cards.boardId,
        count: sql<number>`count(*)::integer`,
      })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(and(
        ...conditions,
        isNull(cards.completedAt),
        isNull(cardChecklistItems.completedAt),
        isNotNull(cardChecklistItems.assigneeId),
        isNull(lists.archivedAt),
        overdueChecklistItemSql(),
        restrictedBoardIds.length
          ? or(
              notInArray(cards.boardId, restrictedBoardIds),
              eq(cardChecklistItems.assigneeId, authUserId),
            )
          : undefined,
      ))
      .groupBy(cards.boardId),
  ]);
  const [listRows, activity] = await Promise.all([
    // Open work per workflow list, for the segmented status bar. Same conditions as the buckets so
    // the bar reports on exactly the cards the tiles count; archived lists are dropped as the board
    // overview drops them, so a card parked in a retired list is in the Active tile but no segment.
    db
      .select({
        workspaceId: workspaces.id,
        listId: lists.id,
        name: lists.name,
        icon: lists.icon,
        color: lists.color,
        inProgress: lists.inProgress,
        position: lists.position,
        open: sql<number>`count(*)::integer`,
      })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(and(...conditions, isNull(cards.completedAt), isNull(lists.archivedAt)))
      .groupBy(workspaces.id, lists.id),
    portfolioActivity(scopeBoards, conditions, query.timeZone),
  ]);
  const boardById = new Map(scopeBoards.map((board) => [board.id, board]));
  const overdueChecklistByBoard = new Map(checklistCountRows.map((row) => [row.boardId, row.count]));

  const buckets: PortfolioBucket[] = rows.flatMap((row) => {
    const board = boardById.get(row.boardId);
    if (!board) return [];
    return [{
      organisationId: row.organisationId,
      organisationName: board.clientName,
      workspaceId: row.workspaceId,
      workspaceName: board.workspaceName,
      boardId: row.boardId,
      boardName: board.name,
      active: row.active,
      overdue: row.overdue,
      dueSoon: row.dueSoon,
      unassigned: row.unassigned,
      inactive: row.inactive,
      inProgress: row.inProgress,
      inProgressTooLong: row.inProgressTooLong,
      blocked: row.blocked,
      atRisk: row.atRisk,
      completed: row.completed,
      overdueChecklistItems: overdueChecklistByBoard.get(row.boardId) ?? 0,
    }];
  }).sort((a, b) =>
    // Portfolio uses the same canonical source hierarchy as the sidebar and work catalog. The
    // numeric rank is internal access metadata, so the response does not disclose hidden groups.
    (boardById.get(a.boardId)?.navigationOrder ?? Number.MAX_SAFE_INTEGER)
    - (boardById.get(b.boardId)?.navigationOrder ?? Number.MAX_SAFE_INTEGER)
    || a.boardId.localeCompare(b.boardId)
  );

  // One graph read for all buckets, including their complete accessible cross-board chains.
  const health = await portfolioScheduleHealth(auth, buckets.map((bucket) => bucket.boardId));
  for (const bucket of buckets) {
    const boardHealth = health.get(bucket.boardId);
    if (boardHealth) bucket.schedule = boardHealth;
  }

  const totals = buckets.reduce((sum, bucket) => ({
    cards: sum.cards + bucket.active + bucket.completed,
    overdue: sum.overdue + bucket.overdue,
    dueSoon: sum.dueSoon + bucket.dueSoon,
    completed: sum.completed + bucket.completed,
    overdueChecklistItems: sum.overdueChecklistItems + bucket.overdueChecklistItems,
    unassigned: sum.unassigned + bucket.unassigned,
    inactive: sum.inactive + bucket.inactive,
    inProgress: sum.inProgress + bucket.inProgress,
    inProgressTooLong: sum.inProgressTooLong + bucket.inProgressTooLong,
    blocked: sum.blocked + bucket.blocked,
    atRisk: sum.atRisk + bucket.atRisk,
    scheduleConflicts: sum.scheduleConflicts + (bucket.schedule?.conflictCount ?? 0),
    criticalCards: sum.criticalCards + (bucket.schedule?.criticalCount ?? 0),
  }), { cards: 0, overdue: 0, dueSoon: 0, completed: 0, overdueChecklistItems: 0, unassigned: 0, inactive: 0, inProgress: 0, inProgressTooLong: 0, blocked: 0, atRisk: 0, scheduleConflicts: 0, criticalCards: 0 });

  // Workspace order is the first board's navigation order, the same rank the buckets sort by, so
  // the bars stack in the order the table lists the workspaces.
  const workspaceRank = new Map<string, { order: number; name: string }>();
  for (const board of scopeBoards) {
    const current = workspaceRank.get(board.workspaceId);
    const order = board.navigationOrder ?? Number.MAX_SAFE_INTEGER;
    if (!current || order < current.order) workspaceRank.set(board.workspaceId, { order, name: board.workspaceName });
  }
  const listCounts: PortfolioListCount[] = listRows
    .flatMap((row) => {
      const workspace = workspaceRank.get(row.workspaceId);
      if (!workspace) return [];
      return [{ row, workspace }];
    })
    .sort((a, b) =>
      a.workspace.order - b.workspace.order
      || a.row.workspaceId.localeCompare(b.row.workspaceId)
      || Number(a.row.position) - Number(b.row.position)
      || a.row.listId.localeCompare(b.row.listId),
    )
    .map(({ row, workspace }) => ({
      workspaceId: row.workspaceId,
      workspaceName: workspace.name,
      listId: row.listId,
      name: row.name,
      icon: row.icon,
      color: row.color,
      inProgress: row.inProgress,
      open: row.open,
    }));

  return { days: query.days, totals, buckets, lists: listCounts, activityDays: PORTFOLIO_ACTIVITY_DAYS, activity };
}

/** Heatmap window. Matches WORK_DONE_MAX_DAYS so both history surfaces look back equally far. */
const PORTFOLIO_ACTIVITY_DAYS = 60;

/** Compute once across the accessible connected components, then summarize each board's own cards. */
async function portfolioScheduleHealth(auth: AuthClaims, boardIds: readonly string[]): Promise<Map<string, ScheduleHealth>> {
  const { scope, schedule } = await loadViewerBoardSchedules(auth, boardIds);
  const idsByBoard = new Map<string, string[]>();
  for (const card of scope.cards) {
    const ids = idsByBoard.get(card.boardId) ?? [];
    ids.push(card.id);
    idsByBoard.set(card.boardId, ids);
  }
  // Boards whose workspace has the timeline switched off report no schedule health at all.
  const scheduled = new Set((await loadAccessibleBoards(auth)).filter((board) => board.timelineEnabled).map((board) => board.id));
  return new Map(boardIds.filter((id) => scheduled.has(id)).map((id) => [id, scheduleHealthOf(summarizeSchedule(schedule, idsByBoard.get(id) ?? []))]));
}

/**
 * Per-day card movement and completion counts for the heatmaps, bucketed in the viewer's zone.
 *
 * Runs against the same card conditions as the summary buckets, so the strips answer for exactly the
 * cards the rest of the page is reporting on — filter the portfolio by label or assignee and the
 * heatmaps narrow with it. Those conditions also carry the access boundary, so restricted
 * (assigned-items-only) boards contribute only activity on cards the viewer may see and the counts
 * cannot be used to infer the volume of hidden work.
 */
async function portfolioActivity(
  scopeBoards: AccessibleBoard[],
  cardConditions: SQL[],
  timeZone: string,
): Promise<PortfolioActivityDay[]> {
  if (scopeBoards.length === 0) return [];
  const boardIds = scopeBoards.map((board) => board.id);
  const from = new Date(Date.now() - PORTFOLIO_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
  // Day bucketing and the definition of "completed" are shared with the work-done surfaces so the
  // two activity strips in the product can never disagree about what a day or a completion is.
  const day = activityDayExpr(activityEvents.createdAt, timeZone);
  const completedSql = activityCompletedPredicate();

  const rows = await db
    .select({
      date: day,
      moved: sql<number>`count(*) filter (where ${activityEvents.action} = ${ACTIVITY_ACTION.MOVED})::integer`,
      completed: sql<number>`count(*) filter (where ${completedSql})::integer`,
    })
    .from(activityEvents)
    .innerJoin(cards, eq(cards.id, activityEvents.entityId))
    // boards/workspaces are joined for the card conditions' sake: workspace-scoped custom-field and
    // completion-window predicates read the workspace row.
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(
      eq(activityEvents.entityType, "card"),
      // Coalesced/suppressed rows are hidden from the card feed, so they must not inflate the grid.
      eq(activityEvents.feedVisible, true),
      or(eq(activityEvents.action, ACTIVITY_ACTION.MOVED), completedSql),
      // Redundant with the card conditions' board filter, but it lets Postgres use the
      // (board_id, created_at) activity index instead of scanning the window across every board.
      inArray(activityEvents.boardId, boardIds),
      gte(activityEvents.createdAt, from),
      ...cardConditions,
    ))
    // Grouped by output ordinal: repeating the expression would emit fresh parameter placeholders
    // for the zone, and Postgres then no longer recognises it as the same grouped expression.
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows.map((row) => ({ date: row.date, moved: row.moved, completed: row.completed }));
}
