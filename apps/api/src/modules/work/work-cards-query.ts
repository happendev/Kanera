import { DEFAULT_IN_PROGRESS_ALERT_DAYS } from "@kanera/shared/workspace-defaults";
import { dto } from "@kanera/shared";
import type { WorkCatalog, WorkFilters, WorkQueryResponse, WorkSort, WorkTotals } from "@kanera/shared/dto";
import { compactCardSummary } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  activityEvents,
  boardMembers,
  boards,
  cards,
  cardLabels,
  cardPriorities,
  cardSummaryView,
  clientMembers,
  customFields,
  globalWorkSeparators,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { applyWorkScope, type AccessibleBoard } from "../../lib/accessible-boards.js";
import {
  cardAccessCondition as accessCondition,
  cardDueColumns,
  cardSummaryDueColumns as cardColumns,
  dependencyAtRiskSql,
  dueSoonSql,
  overdueChecklistSql,
  overdueSql,
} from "../../lib/card-due-sql.js";
import { loadAssignedChecklistItems } from "../../lib/assigned-checklist-items.js";
import { liveQueueRanksByCardId } from "../card-priorities/routes.js";
import { attachFieldOptions } from "../../lib/custom-fields.js";
import { isDueDateOverdue } from "../../lib/due-date.js";
import { badRequest } from "../../lib/errors.js";
import { isOrgAdmin } from "../../lib/access.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { loadWorkCardSummaries, toWireCardSummary } from "../../lib/card-summary.js";
import { escapedSearchPattern } from "../../lib/search-pattern.js";
import { workspaceFeatureEnabledSql } from "../../lib/workspace-features.js";

type WorkCursor = { asOf: string; seenIds: string[] };

function uuidArray(ids: readonly string[]): SQL {
  return sql`array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`;
}

function encodeCursor(cursor: WorkCursor): string {
  return gzipSync(Buffer.from(JSON.stringify(cursor), "utf8")).toString("base64url");
}

function decodeCursor(raw: string | undefined): WorkCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(gunzipSync(Buffer.from(raw, "base64url")).toString("utf8")) as Partial<WorkCursor>;
    if (
      typeof value.asOf !== "string"
      || !Number.isFinite(new Date(value.asOf).getTime())
      || !Array.isArray(value.seenIds)
      || value.seenIds.length > 10_000
      || value.seenIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
    ) throw new Error();
    return { asOf: value.asOf, seenIds: value.seenIds };
  } catch {
    throw badRequest("invalid work cursor");
  }
}

function customFieldValueCondition(condition: WorkFilters["customFieldConditions"][number], cardId: typeof cardColumns.id): SQL {
  const ids = condition.ids ?? [];
  const rawValue = condition.value ?? "";
  const exists = (predicate?: SQL) => sql`exists (
    select 1
    from card_custom_field_value work_cfv
    where work_cfv.card_id = ${cardId}
      and work_cfv.field_id = ${condition.fieldId}
      ${predicate ? sql`and ${predicate}` : sql``}
  )`;
  const populated = sql`(
    work_cfv.value_text is not null
    or work_cfv.value_number is not null
    or work_cfv.value_checkbox is not null
    or work_cfv.value_date is not null
    or work_cfv.value_url is not null
    or cardinality(coalesce(work_cfv.value_option_ids, '{}'::uuid[])) > 0
    or cardinality(coalesce(work_cfv.value_user_ids, '{}'::uuid[])) > 0
  )`;

  switch (condition.op) {
    case "contains":
      return exists(sql`lower(coalesce(work_cfv.value_text, work_cfv.value_url, '')) like ${escapedSearchPattern(rawValue)} escape '\\'`);
    case "equals":
      return exists(sql`lower(coalesce(work_cfv.value_text, work_cfv.value_url, '')) = ${rawValue.toLowerCase()}`);
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return sql`false`;
      const operator = {
        eq: sql`=`,
        neq: sql`<>`,
        gt: sql`>`,
        gte: sql`>=`,
        lt: sql`<`,
        lte: sql`<=`,
      }[condition.op];
      return exists(sql`work_cfv.value_number ${operator} ${value}`);
    }
    case "on":
      return exists(sql`work_cfv.value_date = ${rawValue}`);
    case "before":
      return exists(sql`work_cfv.value_date < ${rawValue}`);
    case "after":
      return exists(sql`work_cfv.value_date > ${rawValue}`);
    case "between":
      return exists(sql`work_cfv.value_date >= ${rawValue} and work_cfv.value_date <= ${condition.value2 ?? rawValue}`);
    case "checked":
      return exists(sql`work_cfv.value_checkbox = true`);
    case "unchecked":
      return exists(sql`work_cfv.value_checkbox = false`);
    case "isAnyOf":
      return ids.length
        ? exists(sql`(
            coalesce(work_cfv.value_option_ids, '{}'::uuid[]) && ${uuidArray(ids)}
            or coalesce(work_cfv.value_user_ids, '{}'::uuid[]) && ${uuidArray(ids)}
          )`)
        : sql`false`;
    case "isNoneOf":
      return ids.length
        ? sql`not ${exists(sql`(
            coalesce(work_cfv.value_option_ids, '{}'::uuid[]) && ${uuidArray(ids)}
            or coalesce(work_cfv.value_user_ids, '{}'::uuid[]) && ${uuidArray(ids)}
          )`)}`
        : sql`true`;
    case "isEmpty":
      return sql`not ${exists(populated)}`;
    case "isNotEmpty":
      return exists(populated);
  }
}

function customFieldConditions(filters: WorkFilters, cardId: typeof cardColumns.id): SQL | undefined {
  if (filters.customFieldConditions.length === 0) return undefined;
  const grouped = new Map<string, WorkFilters["customFieldConditions"]>();
  for (const condition of filters.customFieldConditions) {
    const rows = grouped.get(condition.workspaceId) ?? [];
    rows.push(condition);
    grouped.set(condition.workspaceId, rows);
  }
  // Conditions describe distinct native vocabularies: cards match the AND-set for their own
  // workspace, while configured workspaces form an OR-union in the consolidated result.
  return or(...[...grouped].map(([workspaceId, conditions]) => and(
    eq(workspaces.id, workspaceId),
    ...conditions.map((condition) => customFieldValueCondition(condition, cardId)),
  )));
}

export function baseCardConditions(
  authUserId: string,
  scopeBoards: AccessibleBoard[],
  rawFilters: unknown,
  // `blockerBoards`: every board the viewer can read, for judging at-risk blockers outside the scope.
  options: { teamUserIds?: string[]; forceUserId?: string; portfolio?: boolean; blockerBoards?: AccessibleBoard[] } = {},
  columns = cardColumns,
): SQL[] {
  const filters = dto.workFiltersSchema.parse(rawFilters ?? {});
  const conditions: SQL[] = [
    accessCondition(authUserId, scopeBoards, columns),
    filters.archived ? isNotNull(columns.archivedAt) : isNull(columns.archivedAt),
  ];

  if (filters.completion === "active") conditions.push(isNull(columns.completedAt));
  else if (filters.completion === "completed") conditions.push(isNotNull(columns.completedAt));
  else if (filters.completion === "activeAndRecentlyCompleted") {
    // The default view mirrors a board's active view (see completedVisibilityPredicate in
    // lib/card-summary.ts): a completed card stays listed until it is older than its own
    // workspace's completed-card window, so completing a card does not make it vanish. The window
    // is per workspace, which is why this reads the joined workspace row rather than one constant.
    conditions.push(sql`(
      ${columns.completedAt} is null
      or ${columns.completedAt} >= now() - make_interval(days => ${workspaces.completedCardsActiveDays})
    )`);
  }
  if (filters.unassignedOnly) conditions.push(sql`not exists (
    select 1 from card_assignee work_unassigned
    where work_unassigned.card_id = ${columns.id}
  )`);
  if (filters.inactiveOnly) {
    // `updatedAt` is the canonical card-activity clock (child-resource changes touch it too), so the
    // drill-down returns exactly the cards counted by Board overview and Portfolio.
    conditions.push(sql`${columns.updatedAt} <= now() - make_interval(days => ${workspaces.inactiveCardsDays})`);
  }
  // Open work in an In progress list. The start is trigger-maintained and non-null exactly while
  // the card sits in one; a completed card there is finished work, not work in progress.
  if (filters.inProgressOnly) conditions.push(isNotNull(columns.inProgressSince), isNull(columns.completedAt));
  if (filters.inProgressTooLongOnly) conditions.push(isNull(columns.completedAt), inProgressTooLongSql(columns.inProgressSince));
  if (filters.blockedOnly) conditions.push(isNull(columns.completedAt), hasOpenBlockerSql(columns.id));
  if (filters.atRiskOnly) conditions.push(isNull(columns.completedAt), dependencyAtRiskSql(authUserId, options.blockerBoards ?? scopeBoards, columns));
  if (filters.completedFrom) conditions.push(gte(columns.completedAt, new Date(filters.completedFrom)));
  if (filters.completedTo) conditions.push(lte(columns.completedAt, new Date(filters.completedTo)));
  if (filters.dueFrom) conditions.push(gte(columns.dueDateLocalDate, filters.dueFrom));
  if (filters.dueTo) conditions.push(lte(columns.dueDateLocalDate, filters.dueTo));
  if (filters.overdueOnly) conditions.push(overdueSql(columns));
  if (filters.lastActivityBefore) {
    conditions.push(sql`not exists (
      select 1 from activity_event work_activity
      where (
        (work_activity.entity_type = 'card' and work_activity.entity_id = ${columns.id})
        or work_activity.payload->>'cardId' = ${columns.id}::text
      )
        and work_activity.feed_visible = true
        and work_activity.created_at >= ${new Date(filters.lastActivityBefore)}
    )`);
  }
  if (filters.lastMovedBefore) {
    conditions.push(sql`not exists (
      select 1 from activity_event work_move
      where work_move.entity_type = 'card'
        and work_move.entity_id = ${columns.id}
        and work_move.action = ${ACTIVITY_ACTION.MOVED}
        and work_move.feed_visible = true
        and work_move.created_at >= ${new Date(filters.lastMovedBefore)}
    )`);
  }
  if (filters.overdueChecklistOnly) {
    const restrictedBoardIds = scopeBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
    conditions.push(restrictedBoardIds.length
      ? or(
          notInArray(columns.boardId, restrictedBoardIds),
          and(
            inArray(columns.boardId, restrictedBoardIds),
            overdueChecklistSql(columns.id, authUserId),
          ),
        )!
      : overdueChecklistSql(columns.id));
  }
  if (filters.q) conditions.push(sql`lower(${columns.title}) like ${escapedSearchPattern(filters.q)} escape '\\'`);
  if (filters.listIds.length) conditions.push(inArray(columns.listId, filters.listIds));
  if (filters.labelIds.length) {
    conditions.push(sql`exists (
      select 1 from card_label_assignment work_cla
      where work_cla.card_id = ${columns.id}
        and work_cla.label_id in (${sql.join(filters.labelIds.map((id) => sql`${id}`), sql`, `)})
    )`);
  }
  if (filters.unreadOnly) {
    conditions.push(sql`exists (
      select 1 from notification work_notification
      where work_notification.card_id = ${columns.id}
        and work_notification.user_id = ${authUserId}
        and work_notification.read_at is null
    )`);
  }
  // "In Up next" always means the signed-in viewer's own queue, matching the same quick filter on
  // boards. Global Work may be focused on a teammate, but that changes the assignee scope only; it
  // must not silently change whose personal priority relation this filter reads.
  if (filters.prioritySetOnly && !filters.archived) {
    conditions.push(sql`exists (
      select 1 from ${cardPriorities} work_priority
      where work_priority.card_id = ${columns.id}
        and work_priority.target_user_id = ${authUserId}
    )`);
  }

  const fieldConditions = customFieldConditions(filters, columns.id);
  if (fieldConditions) conditions.push(fieldConditions);

  const requestedAssignees = options.forceUserId
    ? [options.forceUserId]
    : options.teamUserIds
      ? options.teamUserIds
      : filters.assigneeIds;
  if (requestedAssignees.length) {
    conditions.push(sql`exists (
      select 1 from card_assignee work_assignee
      where work_assignee.card_id = ${columns.id}
        and work_assignee.user_id in (${sql.join(requestedAssignees.map((id) => sql`${id}`), sql`, `)})
    )`);
  } else if (!options.portfolio) {
    // Team with no visible teammate has no rows; this must not degrade to every card.
    conditions.push(sql`false`);
  }

  return conditions;
}

function sortExpression(sort: WorkSort, columns = cardColumns): SQL {
  switch (sort) {
    case "dueAsc":
    case "dueDesc":
      return sql`${columns.dueDateLocalDate}`;
    case "titleAsc":
    case "titleDesc":
      return sql`lower(${columns.title})`;
    case "createdAsc":
    case "createdDesc":
      return sql`${columns.createdAt}`;
    case "updatedAsc":
    case "updatedDesc":
      return sql`${columns.updatedAt}`;
    case "inProgressAsc":
    case "inProgressDesc":
      return sql`${columns.inProgressSince}`;
  }
}

function orderExpressions(sort: WorkSort, columns = cardColumns): SQL[] {
  const expression = sortExpression(sort, columns);
  // Nullable keys sort their nulls last in both directions: undated cards after dated ones, and
  // cards that are not in progress after the ones that are.
  const nullable = sort === "dueAsc" || sort === "dueDesc" || sort === "inProgressAsc" || sort === "inProgressDesc";
  const direction = sort.endsWith("Asc") ? asc(expression) : desc(expression);
  return [
    ...(nullable ? [sql`${expression} is null`] : []),
    direction,
    asc(columns.id),
  ];
}

export async function visibleTeamUsers(boardIds: string[], currentUserId: string): Promise<string[]> {
  if (boardIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(inArray(boardMembers.boardId, boardIds), sql`${boardMembers.userId} <> ${currentUserId}`));
  return rows.map((row) => row.userId);
}

export async function loadCatalog(scopeBoards: AccessibleBoard[], viewerClientId: string): Promise<WorkCatalog> {
  const workspaceIds = [...new Set(scopeBoards.map((board) => board.workspaceId))];
  const workspaceOrder = new Map(workspaceIds.map((workspaceId, index) => [workspaceId, index]));
  const boardIds = scopeBoards.map((board) => board.id);
  // Stage broad catalog reads so concurrent navigation requests share the pool fairly.
  const [listRows, labelRows, memberRows] = await Promise.all([
    workspaceIds.length
      ? db.select().from(lists).where(and(inArray(lists.workspaceId, workspaceIds), isNull(lists.archivedAt))).orderBy(asc(lists.position))
      : [],
    workspaceIds.length
      ? db.select().from(cardLabels).where(and(inArray(cardLabels.workspaceId, workspaceIds), isNull(cardLabels.archivedAt))).orderBy(asc(cardLabels.position))
      : [],
    boardIds.length
      ? db
          .select({
            boardId: boardMembers.boardId,
            userId: users.id,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            clientId: users.clientId,
          })
          .from(boardMembers)
          .innerJoin(users, eq(users.id, boardMembers.userId))
          .where(inArray(boardMembers.boardId, boardIds))
      : [],
  ]);
  const [fieldRows, alertRows] = await Promise.all([
    workspaceIds.length
      ? db.select().from(customFields).where(and(inArray(customFields.workspaceId, workspaceIds), isNull(customFields.archivedAt))).orderBy(asc(customFields.position))
      : [],
    workspaceIds.length
      ? db.select({ id: workspaces.id, inProgressAlertDays: workspaces.inProgressAlertDays, timeZone: workspaces.timeZone }).from(workspaces).where(inArray(workspaces.id, workspaceIds))
      : [],
  ]);
  const alertDaysByWorkspace = new Map(alertRows.map((row) => [row.id, row.inProgressAlertDays]));
  const timeZoneByWorkspace = new Map(alertRows.map((row) => [row.id, row.timeZone]));
  const boardClientIds = new Map(scopeBoards.map((board) => [board.id, board.clientId]));
  const memberUserIds = [...new Set(memberRows.map((member) => member.userId))];
  // Batch field options across workspaces, alongside independent membership enrichment.
  const [wireFields, membershipRows] = await Promise.all([
    attachFieldOptions(fieldRows),
    memberUserIds.length
      ? db
        .select({ userId: clientMembers.userId, clientId: clientMembers.clientId })
        .from(clientMembers)
        .where(and(
          inArray(clientMembers.userId, memberUserIds),
          inArray(clientMembers.clientId, [...new Set(boardClientIds.values())]),
          isNull(clientMembers.removedAt),
        ))
      : [],
  ]);
  const memberships = new Set(membershipRows.map((row) => `${row.userId}:${row.clientId}`));

  const organisations = new Map<string, WorkCatalog["organisations"][number]>();
  const workspaceMap = new Map<string, WorkCatalog["workspaces"][number]>();
  for (const board of scopeBoards) {
    organisations.set(board.clientId, {
      id: board.clientId,
      name: board.clientName,
      external: board.clientId !== viewerClientId,
    });
    workspaceMap.set(board.workspaceId, {
      id: board.workspaceId,
      organisationId: board.clientId,
      name: board.workspaceName,
      icon: board.workspaceIcon,
      accentColor: board.workspaceAccentColor,
      kind: board.workspaceKind,
      viewerCanAccessWorkspace: board.canAccessWorkspace,
      inProgressAlertDays: alertDaysByWorkspace.get(board.workspaceId) ?? DEFAULT_IN_PROGRESS_ALERT_DAYS,
      timeZone: timeZoneByWorkspace.get(board.workspaceId) ?? "UTC",
    });
  }

  const people = new Map<string, WorkCatalog["people"][number]>();
  for (const member of memberRows) {
    const current = people.get(member.userId) ?? {
      userId: member.userId,
      organisationId: member.clientId,
      displayName: member.displayName,
      avatarUrl: signedAvatarUrl(member.clientId, member.avatarUrl),
      boardIds: [],
      guestBoardIds: [],
    };
    current.boardIds.push(member.boardId);
    // Guest is relative to each board's organisation, not the person's home one: a user can belong
    // to several organisations, and users.clientId is only their storage anchor.
    if (!memberships.has(`${member.userId}:${boardClientIds.get(member.boardId)}`)) current.guestBoardIds.push(member.boardId);
    people.set(member.userId, current);
  }
  const byWorkspaceAndPosition = (
    a: { id: string; workspaceId: string; position: string },
    b: { id: string; workspaceId: string; position: string },
  ) =>
    (workspaceOrder.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER)
    - (workspaceOrder.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER)
    || Number(a.position) - Number(b.position)
    || a.id.localeCompare(b.id);

  return {
    organisations: [...organisations.values()].sort((a, b) => Number(a.external) - Number(b.external) || a.name.localeCompare(b.name)),
    // scopeBoards already follows the sidebar's canonical source order. Map insertion preserves
    // the first accessible board for each workspace, including standalone and guest sections.
    workspaces: [...workspaceMap.values()],
    boards: scopeBoards.map((board) => ({
      id: board.id,
      workspaceId: board.workspaceId,
      name: board.name,
      icon: board.icon,
      iconColor: board.iconColor,
      viewerRole: board.viewerRole,
      assignedItemsOnly: board.assignedItemsOnly,
      inProgressEnabled: board.inProgressEnabled,
      dependenciesEnabled: board.dependenciesEnabled,
      timelineEnabled: board.timelineEnabled,
    })),
    // Native metadata follows the sidebar's workspace sequence first, then its own position inside
    // that workspace. Comparing position globally would interleave unrelated workspace vocabularies.
    lists: listRows.sort(byWorkspaceAndPosition).map((list) => ({
      id: list.id,
      workspaceId: list.workspaceId,
      name: list.name,
      icon: list.icon,
      color: list.color,
      position: list.position,
      inProgress: list.inProgress,
    })),
    labels: labelRows.sort(byWorkspaceAndPosition).map((label) => ({
      id: label.id,
      workspaceId: label.workspaceId,
      name: label.name,
      color: label.color,
      position: label.position,
    })),
    customFields: wireFields.sort(byWorkspaceAndPosition),
    people: [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

/**
 * Card ids, from `cardIds`, whose card survives the view's card-level filters.
 *
 * A checklist item is its own work item but it inherits its card's context, so a filtered view must
 * drop items whose card the filters exclude — label, list, custom field, unread state, completion
 * and card visibility all apply. Reusing `baseCardConditions` is what keeps that in step with the
 * card query instead of a second filter chain that silently drifts.
 *
 * Three filters are deliberately dropped:
 * - card assignees: an item assigned to you routinely lives on a card that is not assigned to you;
 * - due date / overdue: the item carries its own due date, applied to the item by the caller;
 * - free text: the caller matches it against the item's text as well as its card's title.
 *
 * `unassignedOnly` goes with the assignee filters: "cards nobody owns" cannot sensibly select items
 * that are, by definition, assigned to someone.
 */
async function visibleChecklistCardIds(
  authUserId: string,
  scopeBoards: AccessibleBoard[],
  filters: WorkFilters,
  cardIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(cardIds)];
  if (unique.length === 0) return new Set();
  const conditions = baseCardConditions(
    authUserId,
    scopeBoards,
    {
      ...filters,
      q: "",
      assigneeIds: [],
      unassignedOnly: false,
      dueFrom: null,
      dueTo: null,
      overdueOnly: false,
      overdueChecklistOnly: false,
    },
    // portfolio: true only means "do not require a card assignee"; the assignee filters are cleared
    // above, so this asks purely "would this card be listed under the current filters?".
    { portfolio: true },
  );
  const rows = await db
    .select({ id: cardSummaryView.id })
    .from(cardSummaryView)
    .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(...conditions, inArray(cardSummaryView.id, unique)));
  return new Set(rows.map((row) => row.id));
}

async function checklistAssignments(
  authUserId: string,
  scopeBoards: AccessibleBoard[],
  targetUserIds: string[] | null,
  filters: WorkFilters,
  includeAllVisible = false,
) {
  if ((!targetUserIds?.length && !includeAllVisible) || filters.archived || filters.completion === "completed") {
    return [];
  }
  const unrestrictedBoardIds = scopeBoards.filter((board) => !board.assignedItemsOnly).map((board) => board.id);
  const restrictedBoardIds = scopeBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  const rowGroups = await Promise.all([
    loadAssignedChecklistItems(db, {
      ...(targetUserIds ? { assigneeIds: targetUserIds } : {}),
      boardIds: unrestrictedBoardIds,
      requireDueDate: false,
      includeCompletedCards: true,
    }),
    // Restricted guest boards never contribute another person's checklist assignment to a
    // consolidated response, even when a portfolio drill-down requests all visible people.
    targetUserIds?.includes(authUserId) || includeAllVisible
      ? loadAssignedChecklistItems(db, {
          assigneeIds: [authUserId],
          boardIds: restrictedBoardIds,
          requireDueDate: false,
          includeCompletedCards: true,
        })
      : Promise.resolve([]),
  ]);
  // Item-level filters first: they need no extra query, and they shrink the id set we ask about.
  const rows = rowGroups.flat()
    .filter((row) => !filters.q || row.text.toLowerCase().includes(filters.q.toLowerCase()) || row.cardTitle.toLowerCase().includes(filters.q.toLowerCase()))
    .filter((row) => !filters.dueFrom || Boolean(row.dueDateLocalDate && row.dueDateLocalDate >= filters.dueFrom))
    .filter((row) => !filters.dueTo || Boolean(row.dueDateLocalDate && row.dueDateLocalDate <= filters.dueTo))
    .filter((row) => !filters.overdueOnly || isDueDateOverdue(row))
    .filter((row) => !filters.overdueChecklistOnly || isDueDateOverdue(row));
  const visibleCardIds = await visibleChecklistCardIds(
    authUserId,
    scopeBoards,
    filters,
    rows.map((row) => row.cardId),
  );
  return rows
    .filter((row) => visibleCardIds.has(row.cardId))
    .map((row) => ({
      itemId: row.itemId,
      text: row.text,
      cardId: row.cardId,
      cardTitle: row.cardTitle,
      cardWorkspaceId: row.cardWorkspaceId,
      organisationKey: row.organisationKey,
      cardNumber: row.cardNumber,
      cardKey: row.cardKey,
      checklistId: row.checklistId,
      listId: row.listId,
      boardId: row.boardId,
      boardName: row.boardName,
      boardIcon: row.boardIcon,
      assigneeId: row.assigneeId,
      dueDateLocalDate: row.dueDateLocalDate,
      dueDateSlot: row.dueDateSlot,
      dueDateTimezone: row.dueDateTimezone,
    }));
}

async function loadVisibleGlobalWorkSeparators(
  auth: AuthClaims,
  targetUserId: string | null,
  scopeBoards: AccessibleBoard[],
) {
  if (!targetUserId) return { separators: [], workspaceIds: [] };
  const workspaceIds = Array.from(new Set(scopeBoards.map((board) => board.workspaceId)));
  if (workspaceIds.length === 0) return { separators: [], workspaceIds: [] };

  // Match the mutation boundary up front so an empty lane still knows whether its Add separator
  // affordance is valid. Another person's layout additionally requires admin authority.
  const [membershipRows, ownedWorkspaceRows, targetRows] = await Promise.all([
    db
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.userId, auth.sub),
        inArray(workspaceMembers.workspaceId, workspaceIds),
      )),
    isOrgAdmin(auth)
      ? db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.clientId, auth.cid), inArray(workspaces.id, workspaceIds)))
      : Promise.resolve([]),
    db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.userId, targetUserId),
        inArray(workspaceMembers.workspaceId, workspaceIds),
      )),
  ]);
  const targetWorkspaceIds = new Set(targetRows.map((row) => row.workspaceId));
  const eligibleWorkspaceIds = new Set<string>(ownedWorkspaceRows.map((row) => row.id));
  for (const membership of membershipRows) {
    if (targetUserId === auth.sub || membership.role === "admin") {
      eligibleWorkspaceIds.add(membership.workspaceId);
    }
  }
  const visibleWorkspaceIds = [...eligibleWorkspaceIds].filter((workspaceId) => targetWorkspaceIds.has(workspaceId));
  if (visibleWorkspaceIds.length === 0) return { separators: [], workspaceIds: [] };

  const separators = await db
    .select()
    .from(globalWorkSeparators)
    .where(and(
      eq(globalWorkSeparators.targetUserId, targetUserId),
      inArray(globalWorkSeparators.workspaceId, visibleWorkspaceIds),
    ))
    .orderBy(asc(globalWorkSeparators.position), asc(globalWorkSeparators.id));
  return { separators, workspaceIds: visibleWorkspaceIds };
}

export async function workCards(auth: AuthClaims, allBoards: AccessibleBoard[], input: unknown): Promise<WorkQueryResponse> {
  const authUserId = auth.sub;
  const viewerClientId = auth.cid;
  const query = dto.workCardsQueryBody.parse(input);
  const scopeBoards = applyWorkScope(allBoards, query.scope);
  const boardIds = scopeBoards.map((board) => board.id);
  const filters = dto.workFiltersSchema.parse(query.filters ?? {});
  const visibleTeamUserIds = query.lens === "team" ? await visibleTeamUsers(boardIds, authUserId) : [];
  const requestedTeamIds = filters.assigneeIds.length
    ? filters.assigneeIds.filter((id) => visibleTeamUserIds.includes(id))
    : visibleTeamUserIds;
  const conditions = baseCardConditions(authUserId, scopeBoards, query.filters, {
    forceUserId: query.lens === "my" ? authUserId : undefined,
    teamUserIds: query.lens === "team" ? requestedTeamIds : undefined,
    portfolio: query.lens === "portfolio",
    blockerBoards: allBoards,
  }, cardDueColumns);
  const cursor = decodeCursor(query.cursor);
  const asOf = cursor ? new Date(cursor.asOf) : new Date();
  // Each cursor carries the already-returned ids. Re-sorting only the unseen set prevents a card
  // updated between pages from being duplicated or skipped when its sort key crosses the prior
  // page boundary. The creation cut-off excludes brand-new cards until the viewer refreshes.
  const pageConditions = [
    ...conditions,
    lte(cards.createdAt, asOf),
    ...(cursor?.seenIds.length ? [notInArray(cards.id, cursor.seenIds)] : []),
  ];

  const [pageRows, totalsRow] = await Promise.all([
    db
      .select({ id: cards.id, workspaceId: workspaces.id })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(...pageConditions))
      .orderBy(...orderExpressions(query.sort, cardDueColumns))
      .limit(query.limit + 1),
    query.includeMetadata ? db
      .select({
        cards: sql<number>`count(*)::integer`,
        overdue: sql<number>`count(*) filter (where ${overdueSql(cardDueColumns)} and ${cards.completedAt} is null)::integer`,
        dueSoon: sql<number>`count(*) filter (where ${dueSoonSql(cardDueColumns)} and ${cards.completedAt} is null)::integer`,
        completed: sql<number>`count(*) filter (where ${cards.completedAt} is not null)::integer`,
      })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(...conditions)) : Promise.resolve([]),
  ]);

  const page = pageRows.slice(0, query.limit);
  // Checklist items are only listed for one person at a time: yourself on My Cards, or the single
  // teammate in focus on Team Cards. Across the whole team the section becomes unusable, and the
  // cards above already carry the team-wide picture. Portfolio has no owner in focus either, so it
  // only surfaces items for its overdue-checklist drill-down, which passes includeAllVisible.
  const singleTeammateInFocus = filters.assigneeIds.length === 1 && requestedTeamIds.length === 1;
  const separatorTargetUserId = query.lens === "my"
    ? authUserId
    : query.lens === "team" && singleTeammateInFocus
      ? requestedTeamIds[0] ?? null
      : null;
  const checklistAssigneeIds = query.lens === "my"
    ? [authUserId]
    : query.lens === "team" && singleTeammateInFocus
      ? requestedTeamIds
      : null;
  const pageCardIds = page.map((row) => row.id);
  const activityCardId = sql<string>`case
    when ${activityEvents.entityType} = 'card' then ${activityEvents.entityId}::text
    else ${activityEvents.payload}->>'cardId'
  end`;
  const [richRows, checklistItems, separatorResult, activityRows, viewerQueueRanks] = await Promise.all([
    pageCardIds.length
      ? loadWorkCardSummaries(pageCardIds)
      : Promise.resolve([]),
    query.includeMetadata ? checklistAssignments(
      authUserId,
      scopeBoards,
      checklistAssigneeIds,
      filters,
      query.lens === "portfolio" && filters.overdueChecklistOnly,
    ) : Promise.resolve([]),
    query.includeMetadata
      ? loadVisibleGlobalWorkSeparators(auth, separatorTargetUserId, scopeBoards)
      : Promise.resolve({ separators: [], workspaceIds: [] }),
    pageCardIds.length
      ? db
          .select({
            cardId: activityCardId,
            lastActivityAt: sql<Date | null>`max(${activityEvents.createdAt})`,
            lastMovedAt: sql<Date | null>`max(${activityEvents.createdAt}) filter (where ${activityEvents.entityType} = 'card' and ${activityEvents.action} = ${ACTIVITY_ACTION.MOVED})`,
          })
          .from(activityEvents)
          .where(and(
            eq(activityEvents.feedVisible, true),
            sql`${activityCardId} in (${sql.join(pageCardIds.map((id) => sql`${id}`), sql`, `)})`,
          ))
          .groupBy(activityCardId)
      : Promise.resolve([]),
    // The caller's own queue only, whatever the lens: `viewerPriorityRank` answers "where does
    // this sit in MY sequence", never "in the assignee's" — that is the priorities endpoint's job
    // and is permission-gated there.
    liveQueueRanksByCardId(authUserId),
  ]);
  const richByCardId = new Map(richRows.map((row) => [row.id, row]));
  const activityByCardId = new Map(activityRows.map((row) => [row.cardId, row]));
  const totals: WorkTotals = {
    cards: totalsRow[0]?.cards ?? 0,
    overdue: totalsRow[0]?.overdue ?? 0,
    dueSoon: totalsRow[0]?.dueSoon ?? 0,
    completed: totalsRow[0]?.completed ?? 0,
    checklistItems: checklistItems.length,
    overdueChecklistItems: checklistItems.filter((item) => isDueDateOverdue(item)).length,
  };

  return {
    // Hydrate only the authorized page. Grouped aggregates and compact JSON reduce driver work
    // without expanding every accessible card or omitting fields needed by Global Work tables.
    cards: page.flatMap((row) => {
      const rich = richByCardId.get(row.id);
      return rich ? [{
        ...compactCardSummary(toWireCardSummary(rich, viewerClientId)),
        workspaceId: row.workspaceId,
        lastActivityAt: activityByCardId.get(row.id)?.lastActivityAt ?? null,
        lastMovedAt: activityByCardId.get(row.id)?.lastMovedAt ?? null,
        viewerPriorityRank: viewerQueueRanks.get(row.id) ?? null,
      }] : [];
    }),
    separators: separatorResult.separators,
    separatorWorkspaceIds: separatorResult.workspaceIds,
    checklistItems,
    totals,
    nextCursor: pageRows.length > query.limit
      ? encodeCursor({
          asOf: asOf.toISOString(),
          seenIds: [...(cursor?.seenIds ?? []), ...page.map((row) => row.id)],
        })
      : null,
  };
}

/**
 * A running in-progress stint past its workspace's alert (`inProgressAlertDays`, 0 = off): the same
 * rule as the board's amber clock and the card_in_progress_too_long sweep. It reads the current
 * stint's start, not the lifetime total. Needs the card's workspace row joined.
 */
export function inProgressTooLongSql(inProgressSince: SQLWrapper) {
  return sql`(${workspaces.inProgressAlertDays} > 0 and ${inProgressSince} <= now() - make_interval(days => ${workspaces.inProgressAlertDays}))`;
}

/**
 * Same definition as card_summary_view.blocked_by_count and lib/card-relations.ts: open blockers
 * only, including ones on boards the viewer cannot open. Callers add the "not completed" condition:
 * a done card is not waiting on anything.
 */
export function hasOpenBlockerSql(cardId: SQLWrapper) {
  return sql`exists (
    select 1 from card_relation work_blocker_link
    inner join card work_blocker on work_blocker.id = work_blocker_link.source_card_id
    where work_blocker_link.target_card_id = ${cardId}
      and work_blocker_link.kind = 'blocks'
      and work_blocker.completed_at is null
      and work_blocker.archived_at is null
      and ${workspaceFeatureEnabledSql("dependencies", sql`work_blocker_link.workspace_id`)}
  )`;
}

/**
 * `POST /work/cards/query` on the app server: the access-filtered card query plus the scope
 * figures its request log reports.
 */
export async function queryWorkCardsForApp({
  auth,
  accessibleBoards,
  body,
}: {
  auth: AuthClaims;
  accessibleBoards: AccessibleBoard[];
  body: unknown;
}): Promise<{ result: WorkQueryResponse; lens: dto.WorkCardsQuery["lens"]; scopedCount: number }> {
  const result = await workCards(auth, accessibleBoards, body);
  const parsed = dto.workCardsQueryBody.parse(body);
  const scopedCount = applyWorkScope(accessibleBoards, parsed.scope).length;
  return { result, lens: parsed.lens, scopedCount };
}
