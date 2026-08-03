import { dto } from "@kanera/shared";
import { cardPath } from "@kanera/shared/card-links";
import type {
  AgentWorkHistoryQuery,
  PortfolioActivityDay,
  PortfolioBucket,
  PortfolioSummary,
  SavedWorkView,
  WorkCatalog,
  WorkDoneEvent,
  WorkDoneSummaryResponse,
  WorkFilters,
  WorkQueryResponse,
  WorkSort,
  WorkTotals,
  WorkViewDefinition,
} from "@kanera/shared/dto";
import { compactCardSummary } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  activityEvents,
  boardMembers,
  boards,
  cardLabels,
  cardSummaryView,
  clientMembers,
  customFields,
  globalWorkSeparators,
  lists,
  users,
  workspaceMembers,
  workspaces,
  workViewShares,
  workViews,
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
} from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { applyWorkScope, loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import {
  cardAccessCondition as accessCondition,
  cardSummaryDueColumns as cardColumns,
  dueSoonSql,
  overdueChecklistSql,
  overdueSql,
} from "../../lib/card-due-sql.js";
import { loadAssignedChecklistItems } from "../../lib/assigned-checklist-items.js";
import { loadWorkspaceCustomFields } from "../../lib/custom-fields.js";
import { addDays, isDueDateOverdue, localDateInTimezone } from "../../lib/due-date.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { isOrgAdmin } from "../../lib/access.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { toWireCardSummary } from "../../lib/card-summary.js";
import {
  activityCompletedPredicate,
  activityDayExpr,
  assertWorkDoneWindow,
  loadWorkDone,
  loadWorkDoneSummary,
  type LoadWorkDoneOptions,
} from "../../lib/work-done.js";

type WorkCursor = { asOf: string; seenIds: string[] };

function uuidArray(ids: readonly string[]): SQL {
  return sql`array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`;
}

function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
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

function customFieldValueCondition(condition: WorkFilters["customFieldConditions"][number], cardId: typeof cardSummaryView.id): SQL {
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

function customFieldConditions(filters: WorkFilters, cardId: typeof cardSummaryView.id): SQL | undefined {
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

function baseCardConditions(
  authUserId: string,
  scopeBoards: AccessibleBoard[],
  rawFilters: unknown,
  options: { teamUserIds?: string[]; forceUserId?: string; portfolio?: boolean } = {},
): SQL[] {
  const filters = dto.workFiltersSchema.parse(rawFilters ?? {});
  const conditions: SQL[] = [
    accessCondition(authUserId, scopeBoards, cardColumns),
    filters.archived ? isNotNull(cardColumns.archivedAt) : isNull(cardColumns.archivedAt),
  ];

  if (filters.completion === "active") conditions.push(isNull(cardColumns.completedAt));
  else if (filters.completion === "completed") conditions.push(isNotNull(cardColumns.completedAt));
  else if (filters.completion === "activeAndRecentlyCompleted") {
    // The default view mirrors a board's active view (see completedVisibilityPredicate in
    // lib/card-summary.ts): a completed card stays listed until it is older than its own
    // workspace's completed-card window, so completing a card does not make it vanish. The window
    // is per workspace, which is why this reads the joined workspace row rather than one constant.
    conditions.push(sql`(
      ${cardColumns.completedAt} is null
      or ${cardColumns.completedAt} >= now() - make_interval(days => ${workspaces.completedCardsActiveDays})
    )`);
  }
  if (filters.unassignedOnly) conditions.push(sql`cardinality(${cardSummaryView.assigneeIds}) = 0`);
  if (filters.completedFrom) conditions.push(gte(cardColumns.completedAt, new Date(filters.completedFrom)));
  if (filters.completedTo) conditions.push(lte(cardColumns.completedAt, new Date(filters.completedTo)));
  if (filters.dueFrom) conditions.push(gte(cardColumns.dueDateLocalDate, filters.dueFrom));
  if (filters.dueTo) conditions.push(lte(cardColumns.dueDateLocalDate, filters.dueTo));
  if (filters.overdueOnly) conditions.push(overdueSql(cardColumns));
  if (filters.lastActivityBefore) {
    conditions.push(sql`not exists (
      select 1 from activity_event work_activity
      where (
        (work_activity.entity_type = 'card' and work_activity.entity_id = ${cardColumns.id})
        or work_activity.payload->>'cardId' = ${cardColumns.id}::text
      )
        and work_activity.feed_visible = true
        and work_activity.created_at >= ${new Date(filters.lastActivityBefore)}
    )`);
  }
  if (filters.lastMovedBefore) {
    conditions.push(sql`not exists (
      select 1 from activity_event work_move
      where work_move.entity_type = 'card'
        and work_move.entity_id = ${cardColumns.id}
        and work_move.action = ${ACTIVITY_ACTION.MOVED}
        and work_move.feed_visible = true
        and work_move.created_at >= ${new Date(filters.lastMovedBefore)}
    )`);
  }
  if (filters.overdueChecklistOnly) {
    const restrictedBoardIds = scopeBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
    conditions.push(restrictedBoardIds.length
      ? or(
          notInArray(cardColumns.boardId, restrictedBoardIds),
          and(
            inArray(cardColumns.boardId, restrictedBoardIds),
            overdueChecklistSql(cardColumns.id, authUserId),
          ),
        )!
      : overdueChecklistSql(cardColumns.id));
  }
  if (filters.q) conditions.push(sql`lower(${cardColumns.title}) like ${escapedSearchPattern(filters.q)} escape '\\'`);
  if (filters.listIds.length) conditions.push(inArray(cardColumns.listId, filters.listIds));
  if (filters.labelIds.length) {
    conditions.push(sql`exists (
      select 1 from card_label_assignment work_cla
      where work_cla.card_id = ${cardColumns.id}
        and work_cla.label_id in (${sql.join(filters.labelIds.map((id) => sql`${id}`), sql`, `)})
    )`);
  }
  if (filters.unreadOnly) {
    conditions.push(sql`exists (
      select 1 from notification work_notification
      where work_notification.card_id = ${cardColumns.id}
        and work_notification.user_id = ${authUserId}
        and work_notification.read_at is null
    )`);
  }

  const fieldConditions = customFieldConditions(filters, cardColumns.id);
  if (fieldConditions) conditions.push(fieldConditions);

  const requestedAssignees = options.forceUserId
    ? [options.forceUserId]
    : options.teamUserIds
      ? options.teamUserIds
      : filters.assigneeIds;
  if (requestedAssignees.length) {
    conditions.push(sql`exists (
      select 1 from card_assignee work_assignee
      where work_assignee.card_id = ${cardColumns.id}
        and work_assignee.user_id in (${sql.join(requestedAssignees.map((id) => sql`${id}`), sql`, `)})
    )`);
  } else if (!options.portfolio) {
    // Team with no visible teammate has no rows; this must not degrade to every card.
    conditions.push(sql`false`);
  }

  return conditions;
}

function sortExpression(sort: WorkSort): SQL {
  switch (sort) {
    case "dueAsc":
    case "dueDesc":
      return sql`${cardSummaryView.dueDateLocalDate}`;
    case "titleAsc":
    case "titleDesc":
      return sql`lower(${cardSummaryView.title})`;
    case "createdAsc":
    case "createdDesc":
      return sql`${cardSummaryView.createdAt}`;
    case "updatedAsc":
    case "updatedDesc":
      return sql`${cardSummaryView.updatedAt}`;
  }
}

function orderExpressions(sort: WorkSort): SQL[] {
  const expression = sortExpression(sort);
  const nullable = sort === "dueAsc" || sort === "dueDesc";
  const direction = sort.endsWith("Asc") ? asc(expression) : desc(expression);
  return [
    ...(nullable ? [sql`${expression} is null`] : []),
    direction,
    asc(cardSummaryView.id),
  ];
}

async function visibleTeamUsers(boardIds: string[], currentUserId: string): Promise<string[]> {
  if (boardIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(inArray(boardMembers.boardId, boardIds), sql`${boardMembers.userId} <> ${currentUserId}`));
  return rows.map((row) => row.userId);
}

async function loadCatalog(scopeBoards: AccessibleBoard[], viewerClientId: string): Promise<WorkCatalog> {
  const workspaceIds = [...new Set(scopeBoards.map((board) => board.workspaceId))];
  const workspaceOrder = new Map(workspaceIds.map((workspaceId, index) => [workspaceId, index]));
  const boardIds = scopeBoards.map((board) => board.id);
  const [listRows, labelRows, memberRows, fieldGroups] = await Promise.all([
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
    Promise.all(workspaceIds.map((workspaceId) => loadWorkspaceCustomFields(workspaceId))),
  ]);

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
    };
    current.boardIds.push(member.boardId);
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
    })),
    labels: labelRows.sort(byWorkspaceAndPosition).map((label) => ({
      id: label.id,
      workspaceId: label.workspaceId,
      name: label.name,
      color: label.color,
      position: label.position,
    })),
    customFields: fieldGroups.flat(),
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

async function workCards(auth: AuthClaims, allBoards: AccessibleBoard[], input: unknown): Promise<WorkQueryResponse> {
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
  });
  const cursor = decodeCursor(query.cursor);
  const asOf = cursor ? new Date(cursor.asOf) : new Date();
  // Each cursor carries the already-returned ids. Re-sorting only the unseen set prevents a card
  // updated between pages from being duplicated or skipped when its sort key crosses the prior
  // page boundary. The creation cut-off excludes brand-new cards until the viewer refreshes.
  const pageConditions = [
    ...conditions,
    lte(cardSummaryView.createdAt, asOf),
    ...(cursor?.seenIds.length ? [notInArray(cardSummaryView.id, cursor.seenIds)] : []),
  ];

  const [rows, totalsRow] = await Promise.all([
    db
      .select()
      .from(cardSummaryView)
      .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(...pageConditions))
      .orderBy(...orderExpressions(query.sort))
      .limit(query.limit + 1),
    db
      .select({
        cards: sql<number>`count(*)::integer`,
        overdue: sql<number>`count(*) filter (where ${overdueSql(cardColumns)} and ${cardSummaryView.completedAt} is null)::integer`,
        dueSoon: sql<number>`count(*) filter (where ${dueSoonSql(cardColumns)} and ${cardSummaryView.completedAt} is null)::integer`,
        completed: sql<number>`count(*) filter (where ${cardSummaryView.completedAt} is not null)::integer`,
      })
      .from(cardSummaryView)
      .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(...conditions)),
  ]);

  const page = rows.slice(0, query.limit);
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
  const pageCardIds = page.map((row) => row.card_summary_view.id);
  const activityCardId = sql<string>`case
    when ${activityEvents.entityType} = 'card' then ${activityEvents.entityId}::text
    else ${activityEvents.payload}->>'cardId'
  end`;
  const [checklistItems, separatorResult, activityRows] = await Promise.all([
    checklistAssignments(
      authUserId,
      scopeBoards,
      checklistAssigneeIds,
      filters,
      query.lens === "portfolio" && filters.overdueChecklistOnly,
    ),
    loadVisibleGlobalWorkSeparators(auth, separatorTargetUserId, scopeBoards),
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
  ]);
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
    cards: page.map((row) => ({
      ...compactCardSummary(toWireCardSummary(row.card_summary_view, viewerClientId)),
      workspaceId: row.workspace.id,
      lastActivityAt: activityByCardId.get(row.card_summary_view.id)?.lastActivityAt ?? null,
      lastMovedAt: activityByCardId.get(row.card_summary_view.id)?.lastMovedAt ?? null,
    })),
    separators: separatorResult.separators,
    separatorWorkspaceIds: separatorResult.workspaceIds,
    checklistItems,
    totals,
    nextCursor: rows.length > query.limit
      ? encodeCursor({
          asOf: asOf.toISOString(),
          seenIds: [...(cursor?.seenIds ?? []), ...page.map((row) => row.card_summary_view.id)],
        })
      : null,
  };
}

async function portfolio(authUserId: string, allBoards: AccessibleBoard[], input: unknown): Promise<PortfolioSummary> {
  const query = dto.workPortfolioQueryBody.parse(input);
  const scopeBoards = applyWorkScope(allBoards, query.scope);
  const from = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
  const filters = dto.workFiltersSchema.parse({ ...(query.filters ?? {}), completion: "all" });
  const conditions = baseCardConditions(authUserId, scopeBoards, filters, { portfolio: true });

  const rows = await db
    .select({
      organisationId: workspaces.clientId,
      workspaceId: workspaces.id,
      boardId: boards.id,
      active: sql<number>`count(*) filter (where ${cardSummaryView.completedAt} is null)::integer`,
      overdue: sql<number>`count(*) filter (where ${cardSummaryView.completedAt} is null and ${overdueSql(cardColumns)})::integer`,
      dueSoon: sql<number>`count(*) filter (where ${cardSummaryView.completedAt} is null and ${dueSoonSql(cardColumns)})::integer`,
      unassigned: sql<number>`count(*) filter (where ${cardSummaryView.completedAt} is null and cardinality(${cardSummaryView.assigneeIds}) = 0)::integer`,
      completed: sql<number>`count(*) filter (where ${cardSummaryView.completedAt} >= ${from})::integer`,
    })
    .from(cardSummaryView)
    .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(...conditions))
    .groupBy(workspaces.clientId, workspaces.id, boards.id);

  const boardById = new Map(scopeBoards.map((board) => [board.id, board]));
  const checklistRows = await loadAssignedChecklistItems(db, {
    boardIds: scopeBoards.map((board) => board.id),
    requireDueDate: true,
  });
  const overdueChecklistByBoard = new Map<string, number>();
  for (const item of checklistRows) {
    const board = boardById.get(item.boardId);
    if (!board || (board.assignedItemsOnly && item.assigneeId !== authUserId) || !isDueDateOverdue(item)) continue;
    overdueChecklistByBoard.set(item.boardId, (overdueChecklistByBoard.get(item.boardId) ?? 0) + 1);
  }

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

  const activity = await portfolioActivity(scopeBoards, conditions, query.timeZone);

  const totals = buckets.reduce((sum, bucket) => ({
    cards: sum.cards + bucket.active + bucket.completed,
    overdue: sum.overdue + bucket.overdue,
    dueSoon: sum.dueSoon + bucket.dueSoon,
    completed: sum.completed + bucket.completed,
    overdueChecklistItems: sum.overdueChecklistItems + bucket.overdueChecklistItems,
    unassigned: sum.unassigned + bucket.unassigned,
  }), { cards: 0, overdue: 0, dueSoon: 0, completed: 0, overdueChecklistItems: 0, unassigned: 0 });

  return { days: query.days, totals, buckets, activityDays: PORTFOLIO_ACTIVITY_DAYS, activity };
}

/** Heatmap window. Matches WORK_DONE_MAX_DAYS so both history surfaces look back equally far. */
const PORTFOLIO_ACTIVITY_DAYS = 60;

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
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, activityEvents.entityId))
    // boards/workspaces are joined for the card conditions' sake: workspace-scoped custom-field and
    // completion-window predicates read the workspace row.
    .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
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

async function sanitizedDefinition(
  definition: WorkViewDefinition,
  accessibleBoards: AccessibleBoard[],
  viewerUserId: string,
): Promise<WorkViewDefinition> {
  const accessibleBoardIds = new Set(accessibleBoards.map((board) => board.id));
  const accessibleWorkspaceIds = new Set(accessibleBoards.map((board) => board.workspaceId));
  const accessibleOrganisationIds = new Set(accessibleBoards.map((board) => board.clientId));
  const selectedBoardIds = applyWorkScope(accessibleBoards, definition.scope).map((board) => board.id);
  const workspaceIds = [...accessibleWorkspaceIds];
  const [listRows, labelRows, fieldRows, visibleAssigneeRows] = await Promise.all([
    workspaceIds.length
      ? db.select({ id: lists.id }).from(lists).where(inArray(lists.workspaceId, workspaceIds))
      : Promise.resolve([] as Array<{ id: string }>),
    workspaceIds.length
      ? db.select({ id: cardLabels.id }).from(cardLabels).where(inArray(cardLabels.workspaceId, workspaceIds))
      : Promise.resolve([] as Array<{ id: string }>),
    workspaceIds.length
      ? db.select({
          id: customFields.id,
          workspaceId: customFields.workspaceId,
          type: customFields.type,
          archivedAt: customFields.archivedAt,
        }).from(customFields).where(inArray(customFields.workspaceId, workspaceIds))
      : Promise.resolve([] as Array<{ id: string; workspaceId: string; type: string; archivedAt: Date | null }>),
    selectedBoardIds.length
      ? db.selectDistinct({ userId: boardMembers.userId }).from(boardMembers).where(inArray(boardMembers.boardId, selectedBoardIds))
      : Promise.resolve([]),
  ]);
  const listIds = new Set(listRows.map((row) => row.id));
  const labelIds = new Set(labelRows.map((row) => row.id));
  const fieldIds = new Set(fieldRows.filter((row) => !row.archivedAt).map((row) => row.id));
  const numericFieldIds = new Set(
    fieldRows.filter((row) => row.type === "number" && !row.archivedAt).map((row) => row.id),
  );
  const visibleAssigneeIds = new Set(visibleAssigneeRows.map((row) => row.userId));
  visibleAssigneeIds.add(viewerUserId);
  const validCollapsedSectionIds = (() => {
    switch (definition.groupBy) {
      case "organisation": return accessibleOrganisationIds;
      case "workspace": return accessibleWorkspaceIds;
      case "board": return accessibleBoardIds;
      case "assignee": return new Set([...visibleAssigneeIds, "unassigned"]);
      case "list": return listIds;
      case "completion": return new Set(["active", "completed"]);
      case "dueDate": return new Set(["0-overdue", "1-today", "2-upcoming", "3-later", "5-undated"]);
      case "none": return new Set(["all"]);
    }
  })();
  const builtinTableColumns = new Set([
    "status", "board", "assignees", "due", "labels", "checklist", "description", "created", "updated",
  ]);
  const validTableColumn = (id: string) =>
    builtinTableColumns.has(id) || (id.startsWith("cf:") && fieldIds.has(id.slice(3)));
  const tableSplit = definition.table.aggregateSplitBy;
  const validTableSplit = !tableSplit.startsWith("cf:") || fieldIds.has(tableSplit.slice(3));
  const validCollapsedTableGroupKeys = (() => {
    switch (definition.groupBy) {
      case "organisation": return new Set([...accessibleOrganisationIds, "__none__"].map((id) => `organisation:${id}`));
      case "workspace": return new Set([...accessibleWorkspaceIds, "__none__"].map((id) => `workspace:${id}`));
      case "board": return new Set([...accessibleBoardIds, "__none__"].map((id) => `board:${id}`));
      case "assignee": return new Set([...visibleAssigneeIds, "__none__"].map((id) => `assignee:${id}`));
      case "list": return new Set([...listIds].map((id) => `list:${id}`));
      case "dueDate": return new Set(["overdue", "today", "tomorrow", "thisWeek", "later", "noDate"].map((id) => `due:${id}`));
      case "completion": return new Set(["completion:open", "completion:done"]);
      case "none": return new Set(["all"]);
    }
  })();
  return dto.workViewDefinitionSchema.parse({
    ...definition,
    scope: {
      ...definition.scope,
      organisationIds: definition.scope.organisationIds.filter((id) => accessibleOrganisationIds.has(id)),
      workspaceIds: definition.scope.workspaceIds.filter((id) => accessibleWorkspaceIds.has(id)),
      boardIds: definition.scope.boardIds.filter((id) => accessibleBoardIds.has(id)),
    },
    filters: {
      ...definition.filters,
      assigneeIds: definition.filters.assigneeIds.filter((id) => visibleAssigneeIds.has(id)),
      listIds: definition.filters.listIds.filter((id) => listIds.has(id)),
      labelIds: definition.filters.labelIds.filter((id) => labelIds.has(id)),
      customFieldConditions: definition.filters.customFieldConditions.filter((condition) =>
        accessibleWorkspaceIds.has(condition.workspaceId) && fieldIds.has(condition.fieldId)
      ),
    },
    table: {
      ...definition.table,
      columnVisibility: Object.fromEntries(
        Object.entries(definition.table.columnVisibility).filter(([id]) => validTableColumn(id)),
      ),
      columnOrder: definition.table.columnOrder.filter(validTableColumn),
      columnWidths: Object.fromEntries(
        Object.entries(definition.table.columnWidths).filter(([id]) => id === "title" || validTableColumn(id)),
      ),
      aggregates: Object.fromEntries(
        Object.entries(definition.table.aggregates).filter(([fieldId]) => numericFieldIds.has(fieldId)),
      ),
      aggregateSplitBy: validTableSplit ? tableSplit : "none",
      collapsedGroupKeys: definition.table.collapsedGroupKeys.filter((key) => validCollapsedTableGroupKeys.has(key)),
    },
    collapsedOrganisationIds: definition.collapsedOrganisationIds.filter((id) => accessibleOrganisationIds.has(id)),
    collapsedWorkspaceIds: definition.collapsedWorkspaceIds.filter((id) => accessibleWorkspaceIds.has(id)),
    collapsedSectionIds: definition.collapsedSectionIds.filter((id) => validCollapsedSectionIds.has(id)),
  });
}

async function shapeSavedViews(rows: Array<typeof workViews.$inferSelect & { ownerName: string }>, userId: string, accessibleBoards: AccessibleBoard[]): Promise<SavedWorkView[]> {
  if (rows.length === 0) return [];
  const shareRows = await db
    .select()
    .from(workViewShares)
    .where(inArray(workViewShares.viewId, rows.map((row) => row.id)));
  const sharesByView = new Map<string, string[]>();
  for (const share of shareRows) {
    const ids = sharesByView.get(share.viewId) ?? [];
    ids.push(share.userId);
    sharesByView.set(share.viewId, ids);
  }
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    clientId: row.clientId,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    name: row.name,
    lens: row.lens,
    visibility: row.visibility,
    definitionVersion: row.definitionVersion,
    definition: await sanitizedDefinition(dto.workViewDefinitionSchema.parse(row.definition), accessibleBoards, userId),
    editable: row.ownerId === userId,
    sharedUserIds: sharesByView.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })));
}

async function accessibleSavedViewRows(userId: string, clientId: string) {
  return db
    .selectDistinct({
      id: workViews.id,
      clientId: workViews.clientId,
      ownerId: workViews.ownerId,
      name: workViews.name,
      lens: workViews.lens,
      visibility: workViews.visibility,
      definitionVersion: workViews.definitionVersion,
      definition: workViews.definition,
      createdAt: workViews.createdAt,
      updatedAt: workViews.updatedAt,
      ownerName: users.displayName,
    })
    .from(workViews)
    .innerJoin(users, eq(users.id, workViews.ownerId))
    .leftJoin(workViewShares, and(eq(workViewShares.viewId, workViews.id), eq(workViewShares.userId, userId)))
    .where(and(
      eq(workViews.clientId, clientId),
      or(
        eq(workViews.ownerId, userId),
        eq(workViews.visibility, "organisation"),
        isNotNull(workViewShares.userId),
      ),
    ))
    .orderBy(desc(workViews.updatedAt));
}

type AgentWorkCursor = {
  kind: "agentWorkHistory";
  signature: string;
  from: string;
  to: string;
  timeZone: string;
  at: string;
  id: string;
};

function encodeAgentWorkCursor(cursor: AgentWorkCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAgentWorkCursor(raw: string | undefined): AgentWorkCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<AgentWorkCursor>;
    if (
      value.kind !== "agentWorkHistory"
      || typeof value.signature !== "string"
      || typeof value.from !== "string"
      || !Number.isFinite(new Date(value.from).getTime())
      || typeof value.to !== "string"
      || !Number.isFinite(new Date(value.to).getTime())
      || typeof value.timeZone !== "string"
      || typeof value.at !== "string"
      || !Number.isFinite(new Date(value.at).getTime())
      || typeof value.id !== "string"
    ) throw new Error();
    return value as AgentWorkCursor;
  } catch {
    throw badRequest("invalid personal work-history cursor");
  }
}

function isoWeekStart(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return addDays(localDate, -(weekday === 0 ? 6 : weekday - 1));
}

function monthStart(localDate: string, offset = 0): string {
  const [year, month] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function presetLocalRange(preset: NonNullable<AgentWorkHistoryQuery["preset"]>, today: string): { from: string; to: string } {
  switch (preset) {
    case "today": return { from: today, to: addDays(today, 1) };
    case "yesterday": return { from: addDays(today, -1), to: today };
    case "this_week": {
      const from = isoWeekStart(today);
      return { from, to: addDays(from, 7) };
    }
    case "last_week": {
      const to = isoWeekStart(today);
      return { from: addDays(to, -7), to };
    }
    case "this_month": return { from: monthStart(today), to: monthStart(today, 1) };
    case "last_month": return { from: monthStart(today, -1), to: monthStart(today) };
  }
}

async function localRangeInstants(range: { from: string; to: string }, timeZone: string): Promise<{ from: Date; to: Date }> {
  const result = await db.execute<{ from: Date; to: Date }>(sql`
    select
      (${range.from}::date::timestamp at time zone ${timeZone}::text) as "from",
      (${range.to}::date::timestamp at time zone ${timeZone}::text) as "to"
  `);
  const row = result.rows[0];
  if (!row) throw badRequest("could not resolve work-history range");
  return { from: new Date(row.from), to: new Date(row.to) };
}

async function resolvedAgentWorkRange(auth: AuthClaims, query: AgentWorkHistoryQuery): Promise<{ from: Date; to: Date; timeZone: string }> {
  const [profile] = await db.select({ timeZone: users.timezone }).from(users).where(eq(users.id, auth.sub)).limit(1);
  const timeZone = query.timeZone ?? profile?.timeZone ?? "UTC";
  if (query.from && query.to) return { from: new Date(query.from), to: new Date(query.to), timeZone };
  const today = localDateInTimezone(new Date(), timeZone);
  const localRange = presetLocalRange(query.preset ?? "today", today);
  return { ...(await localRangeInstants(localRange, timeZone)), timeZone };
}

function cardWithUrl<T extends { organisationKey: string; key: string }>(card: T): T & { url: string } {
  return { ...card, url: new URL(cardPath(card.organisationKey, card.key), env.WEB_ORIGIN).toString() };
}

async function agentWorkSources(
  scopedBoards: AccessibleBoard[],
  cardsInResult: Array<{ boardId: string; listId: string; labelIds?: string[]; assigneeIds?: string[] }>,
) {
  const boardIds = new Set(cardsInResult.map((card) => card.boardId));
  const listIds = new Set(cardsInResult.map((card) => card.listId));
  const labelIds = new Set(cardsInResult.flatMap((card) => card.labelIds ?? []));
  const peopleIds = new Set(cardsInResult.flatMap((card) => card.assigneeIds ?? []));
  const [listRows, labelRows, peopleRows] = await Promise.all([
    listIds.size ? db.select({ id: lists.id, workspaceId: lists.workspaceId, name: lists.name }).from(lists).where(inArray(lists.id, [...listIds])) : [],
    labelIds.size ? db.select({ id: cardLabels.id, workspaceId: cardLabels.workspaceId, name: cardLabels.name, color: cardLabels.color }).from(cardLabels).where(inArray(cardLabels.id, [...labelIds])) : [],
    peopleIds.size ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, [...peopleIds])) : [],
  ]);
  return {
    boards: scopedBoards.filter((board) => boardIds.has(board.id)).map((board) => ({
      id: board.id,
      name: board.name,
      workspaceId: board.workspaceId,
      workspaceName: board.workspaceName,
      organisationId: board.clientId,
      organisationName: board.clientName,
    })),
    lists: listRows,
    labels: labelRows,
    people: peopleRows,
  };
}

function workHistorySummary(events: WorkDoneEvent[]) {
  const counts = { created: 0, moved: 0, completed: 0, checklistItemCompleted: 0 };
  const cardIds = new Set<string>();
  for (const event of events) {
    counts[event.type] += 1;
    cardIds.add(event.card.id);
  }
  return { ...counts, cardsTouched: cardIds.size, totalEvents: events.length };
}

/**
 * Public/MCP-safe personal projections. These routes deliberately expose only the connected
 * user's history and current work, while reusing Global Work's cross-board access boundary.
 */
export async function agentWorkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/me/work-history", async (req) => {
    const query = dto.agentWorkHistoryQueryBody.parse(req.body ?? {});
    const cursor = decodeAgentWorkCursor(query.cursor);
    // Preset pages may cross local midnight while an agent is paging. Carry the first page's exact
    // boundaries in the opaque cursor so later pages continue the same report instead of failing or
    // silently switching to a new day.
    const range = cursor
      ? { from: new Date(cursor.from), to: new Date(cursor.to), timeZone: cursor.timeZone }
      : await resolvedAgentWorkRange(req.auth, query);
    assertWorkDoneWindow(range.from, range.to);
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const scopedBoards = applyWorkScope(accessibleBoards, query.scope);
    const restrictedBoardIds = scopedBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
    const signature = createHash("sha256").update(JSON.stringify({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      timeZone: range.timeZone,
      boardIds: scopedBoards.map((board) => board.id),
      q: query.q ?? null,
      requestedRange: query.from && query.to
        ? { from: query.from, to: query.to }
        : { preset: query.preset ?? "today" },
    })).digest("base64url");
    if (cursor && cursor.signature !== signature) throw badRequest("work-history cursor does not match this query");

    const result = await loadWorkDone({
      clientId: req.auth.cid,
      boardIds: scopedBoards.map((board) => board.id),
      from: range.from,
      to: range.to,
      q: query.q,
      timeZone: range.timeZone,
      actorUserId: req.auth.sub,
      visibilityUserId: req.auth.sub,
      visibilityRestrictedBoardIds: restrictedBoardIds,
    });
    const remaining = cursor
      ? result.events.filter((event) => event.at < cursor.at || (event.at === cursor.at && event.id > cursor.id))
      : result.events;
    const page = remaining.slice(0, query.limit);
    const hasMore = remaining.length > query.limit;
    const events = page.map((event) => ({ ...event, card: cardWithUrl(event.card) }));
    return {
      actor: { userId: req.auth.sub },
      range: { from: range.from.toISOString(), to: range.to.toISOString(), timeZone: range.timeZone },
      summary: workHistorySummary(result.events),
      events,
      sources: await agentWorkSources(scopedBoards, events.map((event) => event.card)),
      nextCursor: hasMore
        ? encodeAgentWorkCursor({
            kind: "agentWorkHistory",
            signature,
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            timeZone: range.timeZone,
            at: page.at(-1)!.at,
            id: page.at(-1)!.id,
          })
        : null,
    };
  });

  app.post("/me/current-work", async (req) => {
    const query = dto.agentCurrentWorkQueryBody.parse(req.body ?? {});
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const scopedBoards = applyWorkScope(accessibleBoards, query.scope);
    const result = await workCards(req.auth, accessibleBoards, {
      lens: "my",
      scope: query.scope,
      filters: { q: query.q ?? "", completion: "active" },
      sort: "updatedDesc",
      cursor: query.cursor,
      limit: query.limit,
    });
    const cards = result.cards.map(cardWithUrl);
    const sourceCards = [
      ...cards,
      ...result.checklistItems.map((item) => ({
        boardId: item.boardId,
        listId: item.listId,
        assigneeIds: [item.assigneeId],
      })),
    ];
    return {
      ...result,
      cards,
      sources: await agentWorkSources(scopedBoards, sourceCards),
    };
  });
}

/**
 * Bounded cross-board projections for public agents. Keep this registration separate from
 * workRoutes: saved-view and layout administration remain app-only even though both surfaces share
 * the same access-filtered query implementation.
 */
export async function agentWorkQueryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/work/cards/query", async (req) => {
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    return workCards(req.auth, accessibleBoards, req.body);
  });

  app.post("/work/portfolio/query", async (req) => {
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    return portfolio(req.auth.sub, accessibleBoards, req.body);
  });
}

export async function workRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/work/catalog", async (req) => {
    const startedAt = performance.now();
    const scope = dto.workScopeSchema.partial().parse(req.query);
    const normalized = dto.workScopeSchema.parse(scope);
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const boardsInScope = applyWorkScope(accessibleBoards, normalized);
    const catalog = await loadCatalog(boardsInScope, req.auth.cid);
    req.log.info({
      event: "work_catalog_loaded",
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      boardCount: catalog.boards.length,
      accessFilteredSources: accessibleBoards.length - boardsInScope.length,
    });
    return catalog;
  });

  app.post("/work/cards/query", async (req) => {
    const startedAt = performance.now();
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    try {
      const result = await workCards(req.auth, accessibleBoards, req.body);
      const parsed = dto.workCardsQueryBody.parse(req.body);
      const scopedCount = applyWorkScope(accessibleBoards, parsed.scope).length;
      req.log.info({
        event: "work_cards_queried",
        lens: parsed.lens,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        resultCount: result.cards.length,
        checklistResultCount: result.checklistItems.length,
        total: result.totals.cards,
        hasNextCursor: Boolean(result.nextCursor),
        accessFilteredSources: accessibleBoards.length - scopedCount,
      });
      return result;
    } catch (error) {
      if ((req.body as { cursor?: unknown } | null)?.cursor) {
        req.log.warn({
          event: "work_cursor_failure",
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        });
      }
      throw error;
    }
  });

  /**
   * Lens, scope and the card-level access boundary for the global work-done surfaces.
   *
   * Shared by the timeline and its activity strip: the strip must narrow with exactly the same
   * lens and visibility rules, or its counts would describe a different set of cards than the rows
   * beneath it — and for a restricted viewer could disclose the volume of hidden work.
   */
  const globalWorkDoneOptions = async (
    req: FastifyRequest,
    query: dto.GlobalWorkDoneQuery | dto.GlobalWorkDoneSummaryQuery,
  ): Promise<{ options: LoadWorkDoneOptions; filters: dto.WorkFilters; accessibleCount: number; scopedCount: number }> => {
    const from = new Date(query.from);
    const to = new Date(query.to);
    assertWorkDoneWindow(from, to);

    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const scopeBoards = applyWorkScope(accessibleBoards, query.scope);
    const boardIds = scopeBoards.map((board) => board.id);
    const filters = dto.workFiltersSchema.parse(query.filters ?? {});
    const visibleTeammateIds = query.lens === "team"
      ? await visibleTeamUsers(boardIds, req.auth.sub)
      : [];
    const actorUserIds = filters.assigneeIds.length
      ? filters.assigneeIds.filter((id) => visibleTeammateIds.includes(id))
      : visibleTeammateIds;
    const restrictedBoardIds = scopeBoards
      .filter((board) => board.assignedItemsOnly)
      .map((board) => board.id);

    return {
      options: {
        clientId: req.auth.cid,
        boardIds,
        from,
        to,
        q: filters.q || undefined,
        timeZone: query.timeZone,
        // Applied in SQL so the activity strip narrows with the timeline. The timeline additionally
        // re-applies these in JS below, which is redundant but harmless.
        listIds: filters.listIds,
        labelIds: filters.labelIds,
        ...(query.lens === "my"
          ? { actorUserId: req.auth.sub }
          : { actorUserIds }),
        // Historical activity must obey the same card-level boundary as the live global views.
        visibilityUserId: req.auth.sub,
        visibilityRestrictedBoardIds: restrictedBoardIds,
      },
      filters,
      accessibleCount: accessibleBoards.length,
      scopedCount: scopeBoards.length,
    };
  };

  app.post("/work/work-done/query", async (req) => {
    const startedAt = performance.now();
    const query = dto.globalWorkDoneQueryBody.parse(req.body);
    const { options, filters, accessibleCount, scopedCount } = await globalWorkDoneOptions(req, query);
    const boardIds = options.boardIds;

    const result = await loadWorkDone(options);
    const listIds = new Set(filters.listIds);
    const labelIds = new Set(filters.labelIds);
    const events = result.events.filter((event) =>
      (listIds.size === 0 || listIds.has(event.card.listId))
      && (labelIds.size === 0 || event.card.labelIds.some((id) => labelIds.has(id)))
    );

    req.log.info({
      event: "work_done_queried",
      lens: query.lens,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      resultCount: events.length,
      boardCount: boardIds.length,
      accessFilteredSources: accessibleCount - scopedCount,
    });
    return { events };
  });

  app.post("/work/work-done/summary/query", async (req) => {
    const query = dto.globalWorkDoneSummaryQueryBody.parse(req.body);
    const { options } = await globalWorkDoneOptions(req, query);
    // The list/label narrowing the timeline applies in JS cannot be expressed on an aggregate, so
    // the strip reports the unnarrowed day totals for the same lens, scope and access boundary.
    const response: WorkDoneSummaryResponse = await loadWorkDoneSummary(options);
    return response;
  });

  app.post("/work/portfolio/query", async (req) => {
    const startedAt = performance.now();
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const result = await portfolio(req.auth.sub, accessibleBoards, req.body);
    req.log.info({
      event: "work_portfolio_queried",
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      days: result.days,
      bucketCount: result.buckets.length,
      resultSize: result.totals.cards,
    });
    return result;
  });

  app.get("/work-views/share-candidates", async (req) => {
    const rows = await db
      .select({
        userId: users.id,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
      })
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(
        eq(clientMembers.clientId, req.auth.cid),
        isNull(clientMembers.removedAt),
        isNull(clientMembers.suspendedAt),
        isNull(users.deletedAt),
      ))
      .orderBy(asc(users.displayName), asc(users.id));

    // Sharing is organisation-scoped rather than board-scoped. Keep this roster separate from
    // the work catalog so board-visible people and assignment candidates cannot be conflated.
    return rows.map(({ homeClientId, ...user }) => ({
      ...user,
      avatarUrl: signedAvatarUrl(homeClientId, user.avatarUrl),
    }));
  });

  app.get("/work-views", async (req) => {
    const [rows, accessibleBoards] = await Promise.all([
      accessibleSavedViewRows(req.auth.sub, req.auth.cid),
      loadAccessibleBoards(req.auth),
    ]);
    const result = await shapeSavedViews(rows, req.auth.sub, accessibleBoards);
    req.log.info({ event: "work_saved_views_loaded", resultCount: result.length });
    return result;
  });

  app.post("/work-views", async (req, reply) => {
    const body = dto.createWorkViewBody.parse(req.body);
    const [row] = await db
      .insert(workViews)
      .values({
        clientId: req.auth.cid,
        ownerId: req.auth.sub,
        name: body.name,
        lens: body.lens,
        visibility: body.visibility,
        definition: body.definition,
      })
      .returning();
    const [owner, accessibleBoards] = await Promise.all([
      db.select({ displayName: users.displayName }).from(users).where(eq(users.id, req.auth.sub)).limit(1),
      loadAccessibleBoards(req.auth),
    ]);
    const [shaped] = await shapeSavedViews([{ ...row!, ownerName: owner[0]?.displayName ?? "Unknown" }], req.auth.sub, accessibleBoards);
    req.log.info({ event: "work_saved_view_created", lens: body.lens, visibility: body.visibility });
    return reply.status(201).send(shaped);
  });

  app.patch("/work-views/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateWorkViewBody.parse(req.body);
    const [current] = await db.select().from(workViews).where(eq(workViews.id, id)).limit(1);
    if (!current) throw notFound("work view not found");
    if (current.ownerId !== req.auth.sub || current.clientId !== req.auth.cid) throw forbidden();
    const [row] = await db
      .update(workViews)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.lens !== undefined ? { lens: body.lens } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.definition !== undefined ? { definition: body.definition } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workViews.id, id))
      .returning();
    const [owner, accessibleBoards] = await Promise.all([
      db.select({ displayName: users.displayName }).from(users).where(eq(users.id, req.auth.sub)).limit(1),
      loadAccessibleBoards(req.auth),
    ]);
    const [shaped] = await shapeSavedViews([{ ...row!, ownerName: owner[0]?.displayName ?? "Unknown" }], req.auth.sub, accessibleBoards);
    return shaped;
  });

  app.delete("/work-views/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(workViews).where(eq(workViews.id, id)).limit(1);
    if (!current) throw notFound("work view not found");
    if (current.ownerId !== req.auth.sub || current.clientId !== req.auth.cid) throw forbidden();
    await db.delete(workViews).where(eq(workViews.id, id));
    return reply.status(204).send();
  });

  app.post("/work-views/:id/shares", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = dto.shareWorkViewBody.parse(req.body);
    const [current] = await db.select().from(workViews).where(eq(workViews.id, id)).limit(1);
    if (!current) throw notFound("work view not found");
    if (current.ownerId !== req.auth.sub || current.clientId !== req.auth.cid) throw forbidden();
    const [target] = await db
      .select({ id: users.id })
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(
        eq(clientMembers.userId, userId),
        eq(clientMembers.clientId, req.auth.cid),
        isNull(clientMembers.removedAt),
        isNull(clientMembers.suspendedAt),
        isNull(users.deletedAt),
      ))
      .limit(1);
    if (!target) throw badRequest("share target must be an active user in your organisation");
    if (target.id === current.ownerId) throw badRequest("the owner already has access");
    await db.insert(workViewShares).values({ viewId: id, userId }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete("/work-views/:id/shares/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const [current] = await db.select().from(workViews).where(eq(workViews.id, id)).limit(1);
    if (!current) throw notFound("work view not found");
    if (current.ownerId !== req.auth.sub || current.clientId !== req.auth.cid) throw forbidden();
    await db.delete(workViewShares).where(and(eq(workViewShares.viewId, id), eq(workViewShares.userId, userId)));
    return reply.status(204).send();
  });
}
