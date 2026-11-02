import { dto } from "@kanera/shared";
import type { ListNotificationsQuery, NotificationGroupCountsResponse, NotificationsPage } from "@kanera/shared/dto";
import { activityEvents, boards, cardChecklistItems, cardKeyPrefixReservations, cards, lists, NOTIFICATION_REASON, notifications } from "@kanera/shared/schema";
import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db.js";
import {
  countUnreadNotifications,
  enrichNotifications,
  inboxVisibleNotificationCondition,
} from "../../lib/notifications.js";

// Keyset pagination cursor. createdAt alone is not unique, so a createdAt-only
// cursor silently skips any rows that share the boundary timestamp. We encode
// the row id as a tiebreaker and page on the (createdAt, id) tuple instead.
function encodeNotificationCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function decodeNotificationCursor(raw: string): { createdAt: Date; id: string } | null {
  const sep = raw.indexOf("|");
  const iso = sep === -1 ? raw : raw.slice(0, sep);
  // Legacy createdAt-only cursors carry no id. An empty id never satisfies
  // `id < ''`, so the keyset condition below degrades to createdAt-only — the
  // old behaviour — keeping any in-flight cursor from a prior deploy working.
  const id = sep === -1 ? "" : raw.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

function notificationSearchPattern(query: string): string {
  // Treat SQL wildcard characters as ordinary search text. Notification search
  // is a substring search, not a user-authored LIKE expression.
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

function notificationFeedConditions(
  userId: string,
  query: Pick<ListNotificationsQuery, "includeRead" | "agentOnly" | "mentionsOnly" | "boardId" | "actorId" | "q">,
  options?: { includeRead?: boolean; cursor?: { createdAt: Date; id: string } | null },
): SQL[] {
  const includeRead = options?.includeRead ?? query.includeRead;
  const recentReadCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const conditions: SQL[] = [
    eq(notifications.userId, userId),
    or(isNull(notifications.readAt), gte(notifications.createdAt, recentReadCutoff))!,
  ];
  if (!includeRead) conditions.push(isNull(notifications.readAt));
  if (query.boardId) conditions.push(eq(notifications.boardId, query.boardId));
  if (query.actorId) conditions.push(eq(activityEvents.actorId, query.actorId));
  if (query.agentOnly) conditions.push(eq(activityEvents.actorKind, "agent"));
  if (query.mentionsOnly) conditions.push(eq(notifications.reason, NOTIFICATION_REASON.MENTIONED));
  if (query.q) {
    const pattern = notificationSearchPattern(query.q);
    const keyMatch = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]*)$/.exec(query.q.trim());
    const historicalKeyMatch = keyMatch
      ? sql`(${cards.number} = ${Number(keyMatch[2])} and exists (
          select 1 from ${cardKeyPrefixReservations} notification_key_alias
          where notification_key_alias.workspace_id = ${cards.workspaceId}
            and notification_key_alias.prefix = ${keyMatch[1]!.toUpperCase()}
        ))`
      : sql`false`;
    // Search deliberately stays on work-item context. Actor names and comment
    // bodies are excluded so the drawer's search semantics remain predictable.
    conditions.push(or(
      ilike(boards.name, pattern),
      ilike(lists.name, pattern),
      ilike(cards.title, pattern),
      ilike(cards.key, pattern),
      historicalKeyMatch,
      ilike(cardChecklistItems.text, pattern),
    )!);
  }
  if (options?.cursor) {
    conditions.push(
      or(
        lt(notifications.createdAt, options.cursor.createdAt),
        and(eq(notifications.createdAt, options.cursor.createdAt), lt(notifications.id, options.cursor.id)),
      )!,
    );
  }
  conditions.push(inboxVisibleNotificationCondition());
  return conditions;
}

function notificationFeedQueryJoins() {
  return db
    .select({ id: notifications.id, createdAt: notifications.createdAt })
    .from(notifications)
    .leftJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .leftJoin(cardChecklistItems, eq(cardChecklistItems.id, notifications.checklistItemId))
    .leftJoin(lists, eq(lists.id, notifications.listId))
    .leftJoin(boards, eq(boards.id, notifications.boardId));
}

export async function listNotificationsPage({
  userId,
  rawQuery,
  includeRead,
}: {
  userId: string;
  rawQuery: unknown;
  includeRead?: boolean;
}): Promise<NotificationsPage> {
  const query = dto.listNotificationsQuery.parse(rawQuery ?? {});
  const cursor = query.cursor ? decodeNotificationCursor(query.cursor) : null;
  const conditions = notificationFeedConditions(userId, query, { includeRead, cursor });

  // The badge count is independent of paging and notification hydration.
  const [{ items, hasMore, pageRows }, unreadCount] = await Promise.all([
    (async () => {
      const rows = await notificationFeedQueryJoins()
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
      const enrichedItems = await enrichNotifications(db, pageRows.map((r) => r.id));
      // The browser also filters realtime rows locally. Preserve that this fetched page matched the
      // server predicate because only the server knows permanent historical card-prefix aliases.
      const items = query.q
        ? enrichedItems.map((item) => ({ ...item, searchMatched: true }))
        : enrichedItems;
      // enrichNotifications orders by the same (createdAt, id) tuple, so the
      // returned order already matches the page query and what the client expects.
      return { items, hasMore, pageRows };
    })(),
    countUnreadNotifications(userId),
  ]);
  return {
    items,
    nextCursor: hasMore ? encodeNotificationCursor(pageRows[pageRows.length - 1]!) : null,
    unreadCount,
  };
}

export async function notificationGroupCounts(userId: string, rawQuery: unknown): Promise<NotificationGroupCountsResponse> {
  const query = dto.notificationGroupCountsQuery.parse(rawQuery ?? {});
  const conditions = notificationFeedConditions(userId, query);
  const groupKey = query.groupBy === "day"
    ? sql<string>`'day:' || to_char(timezone(${query.timeZone}, ${notifications.createdAt}), 'YYYY-MM-DD')`
    : query.groupBy === "organisation"
      ? sql<string>`'organisation:' || ${notifications.clientId}::text`
    : query.groupBy === "board"
      ? sql<string>`case when ${notifications.boardId} is not null then 'board:' || ${notifications.boardId}::text else 'workspace:' || ${notifications.workspaceId}::text end`
      : sql<string>`case
          when ${activityEvents.actorKind} = 'user' and ${activityEvents.actorId} is not null then 'user:' || ${activityEvents.actorId}::text
          when ${activityEvents.actorKind} = 'apiKey' then 'apiKey:' || coalesce(${activityEvents.apiKeyId}::text, ${activityEvents.apiKeyName}, 'unknown')
          when ${activityEvents.actorKind} = 'agent' then 'agent:' || coalesce(${activityEvents.agentGrantId}::text, ${activityEvents.agentName}, 'unknown') || ':' || coalesce(${activityEvents.actorId}::text, '')
          when ${activityEvents.actorKind} = 'support' then 'support:' || coalesce(${activityEvents.supportSessionId}::text, ${activityEvents.supportActorEmail}, 'unknown')
          else 'system'
        end`;

  const groups = await db
    .select({
      key: groupKey,
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date>`max(${notifications.createdAt})`,
    })
    .from(notifications)
    .leftJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .leftJoin(cardChecklistItems, eq(cardChecklistItems.id, notifications.checklistItemId))
    .leftJoin(lists, eq(lists.id, notifications.listId))
    .leftJoin(boards, eq(boards.id, notifications.boardId))
    .where(and(...conditions))
    // Group by the selected key's ordinal. Repeating the day expression would
    // bind the same timezone twice as distinct SQL parameters, which Postgres
    // does not consider the same GROUP BY expression.
    .groupBy(sql.raw("1"))
    .orderBy(desc(sql`max(${notifications.createdAt})`));

  return { groups: groups.map(({ key, count }) => ({ key, count })) };
}

// Whether the drawer should offer an Agent or Mentions tab at all, and its unread badge. `total`
// deliberately ignores the seven-day read window used by the feed: once a person has ever received
// such a notification the tab stays, so it never flickers in and out as old rows age past the window.
export async function feedCounts(userId: string, condition: SQL): Promise<dto.NotificationFeedCounts> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`,
    })
    .from(notifications)
    .leftJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(eq(notifications.userId, userId), condition, inboxVisibleNotificationCondition()));
  return { total: row?.total ?? 0, unread: row?.unread ?? 0 };
}

export async function orgUnreadCounts(userId: string) {
  return db
    .select({
      clientId: notifications.clientId,
      count: sql<number>`count(*)::int`,
    })
    .from(notifications)
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      inboxVisibleNotificationCondition(),
    ))
    .groupBy(notifications.clientId);
}

export async function boardUnreadCounts(userId: string) {
  const rows = await db
    .select({
      boardId: notifications.boardId,
      count: sql<number>`count(distinct ${notifications.cardId})::int`,
    })
    .from(notifications)
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      isNotNull(notifications.boardId),
      isNotNull(notifications.cardId),
      inboxVisibleNotificationCondition(),
    ))
    .groupBy(notifications.boardId);
  return rows.filter((row): row is { boardId: string; count: number } => row.boardId !== null);
}

export async function cardUnreadCounts(userId: string) {
  const rows = await db
    .select({
      cardId: notifications.cardId,
      count: sql<number>`count(*)::int`,
    })
    .from(notifications)
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      isNotNull(notifications.cardId),
      inboxVisibleNotificationCondition(),
    ))
    .groupBy(notifications.cardId);
  return rows.filter((row): row is { cardId: string; count: number } => row.cardId !== null);
}
