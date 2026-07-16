import { dto } from "@kanera/shared";
import type { ListNotificationsQuery, NotificationGroupCountsResponse, NotificationsPage, PushTestResponse, WatcherUser } from "@kanera/shared/dto";
import { activityEvents, boards, boardWatchers, cardChecklistItems, cards, cardWatchers, lists, notificationSettings, notifications, users } from "@kanera/shared/schema";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { assignedCardVisibility, assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { notFound } from "../../lib/errors.js";
import {
  countUnreadNotifications,
  enrichNotifications,
  inboxVisibleNotificationCondition,
} from "../../lib/notifications.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { getNotificationSettings, toEffectiveNotificationSettings } from "../../lib/notification-settings.js";
import { deliverPushRow, enqueuePushImmediate } from "../../lib/push-queue.js";
import {
  deletePushSubscriptionForUser,
  getWebPushPublicConfig,
  refreshPushSubscription,
  upsertPushSubscriptionForUser
} from "../../lib/web-push.js";
import { emitToUser } from "../../realtime/emit.js";

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
  req: FastifyRequest,
  query: Pick<ListNotificationsQuery, "includeRead" | "boardId" | "actorId" | "q">,
  options?: { includeRead?: boolean; cursor?: { createdAt: Date; id: string } | null },
): SQL[] {
  const includeRead = options?.includeRead ?? query.includeRead;
  const recentReadCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const conditions: SQL[] = [
    eq(notifications.userId, req.auth.sub),
    or(isNull(notifications.readAt), gte(notifications.createdAt, recentReadCutoff))!,
  ];
  if (!includeRead) conditions.push(isNull(notifications.readAt));
  if (query.boardId) conditions.push(eq(notifications.boardId, query.boardId));
  if (query.actorId) conditions.push(eq(activityEvents.actorId, query.actorId));
  if (query.q) {
    const pattern = notificationSearchPattern(query.q);
    // Search deliberately stays on work-item context. Actor names and comment
    // bodies are excluded so the drawer's search semantics remain predictable.
    conditions.push(or(
      ilike(boards.name, pattern),
      ilike(lists.name, pattern),
      ilike(cards.title, pattern),
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
  conditions.push(sql`(
    ${notifications.cardId} is null
    or not exists (select 1 from board_member restricted_member
      where restricted_member.board_id = ${notifications.boardId}
        and restricted_member.user_id = ${req.auth.sub}
        and restricted_member.assigned_items_only = true)
    or ${assignedCardVisibility(req.auth.sub, notifications.cardId)}
  )`);
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

async function listNotificationsPage(req: FastifyRequest, options?: { includeRead?: boolean }): Promise<NotificationsPage> {
  const query = dto.listNotificationsQuery.parse(req.query ?? {});
  const cursor = query.cursor ? decodeNotificationCursor(query.cursor) : null;
  const conditions = notificationFeedConditions(req, query, { includeRead: options?.includeRead, cursor });

  const rows = await notificationFeedQueryJoins()
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const items = await enrichNotifications(db, pageRows.map((r) => r.id));
  // enrichNotifications orders by the same (createdAt, id) tuple, so the
  // returned order already matches the page query and what the client expects.
  const unreadCount = await countUnreadNotifications(req.auth.sub);
  return {
    items,
    nextCursor: hasMore ? encodeNotificationCursor(pageRows[pageRows.length - 1]!) : null,
    unreadCount,
  };
}

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Legacy/default listing still honours includeRead=false. The web drawer uses
  // includeRead=true here for All and /notifications/unread below for Unread, so
  // the two tabs page independently and never share a cursor.
  app.get("/notifications", async (req): Promise<NotificationsPage> => {
    return listNotificationsPage(req);
  });

  app.get("/notifications/unread", async (req): Promise<NotificationsPage> => {
    return listNotificationsPage(req, { includeRead: false });
  });

  app.get("/notifications/group-counts", async (req): Promise<NotificationGroupCountsResponse> => {
    const query = dto.notificationGroupCountsQuery.parse(req.query ?? {});
    const conditions = notificationFeedConditions(req, query);
    const groupKey = query.groupBy === "day"
      ? sql<string>`'day:' || to_char(timezone(${query.timeZone}, ${notifications.createdAt}), 'YYYY-MM-DD')`
      : query.groupBy === "board"
        ? sql<string>`case when ${notifications.boardId} is not null then 'board:' || ${notifications.boardId}::text else 'workspace:' || ${notifications.workspaceId}::text end`
        : sql<string>`case
            when ${activityEvents.actorKind} = 'user' and ${activityEvents.actorId} is not null then 'user:' || ${activityEvents.actorId}::text
            when ${activityEvents.actorKind} = 'apiKey' then 'apiKey:' || coalesce(${activityEvents.apiKeyId}::text, ${activityEvents.apiKeyName}, 'unknown')
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
  });

  app.get("/notifications/unread-count", async (req) => {
    const count = await countUnreadNotifications(req.auth.sub);
    return { count };
  });

  app.get("/notifications/board-unread-counts", async (req) => {
    const rows = await db
      .select({
        boardId: notifications.boardId,
        count: sql<number>`count(distinct ${notifications.cardId})::int`,
      })
      .from(notifications)
      .leftJoin(cards, eq(cards.id, notifications.cardId))
      .where(and(
        eq(notifications.userId, req.auth.sub),
        isNull(notifications.readAt),
        isNotNull(notifications.boardId),
        isNotNull(notifications.cardId),
        inboxVisibleNotificationCondition(),
        sql`(${notifications.cardId} is null or not exists (select 1 from board_member bm where bm.board_id = ${notifications.boardId} and bm.user_id = ${req.auth.sub} and bm.assigned_items_only = true) or ${assignedCardVisibility(req.auth.sub, notifications.cardId)})`,
      ))
      .groupBy(notifications.boardId);
    return rows.filter((row): row is { boardId: string; count: number } => row.boardId !== null);
  });

  app.get("/notifications/card-unread-counts", async (req) => {
    const rows = await db
      .select({
        cardId: notifications.cardId,
        count: sql<number>`count(*)::int`,
      })
      .from(notifications)
      .leftJoin(cards, eq(cards.id, notifications.cardId))
      .where(and(
        eq(notifications.userId, req.auth.sub),
        isNull(notifications.readAt),
        isNotNull(notifications.cardId),
        inboxVisibleNotificationCondition(),
        sql`(${notifications.cardId} is null or not exists (select 1 from board_member bm where bm.board_id = ${notifications.boardId} and bm.user_id = ${req.auth.sub} and bm.assigned_items_only = true) or ${assignedCardVisibility(req.auth.sub, notifications.cardId)})`,
      ))
      .groupBy(notifications.cardId);
    return rows.filter((row): row is { cardId: string; count: number } => row.cardId !== null);
  });

  app.get("/notifications/settings", async (req) => {
    const [settings, push] = await Promise.all([
      getNotificationSettings(db, req.auth.sub),
      getWebPushPublicConfig(req.auth.cid),
    ]);
    return dto.notificationSettingsResponse.parse({ ...settings, push });
  });

  app.patch("/notifications/settings", async (req) => {
    const body = dto.updateNotificationSettingsBody.parse(req.body ?? {});
    const values = {
      ...(body.emailEnabled !== undefined ? { emailEnabled: body.emailEnabled } : {}),
      ...(body.pushEnabled !== undefined ? { pushEnabled: body.pushEnabled } : {}),
      ...(body.types?.cardAssigned?.email !== undefined ? { cardAssignedEmail: body.types.cardAssigned.email } : {}),
      ...(body.types?.cardAssigned?.push !== undefined ? { cardAssignedPush: body.types.cardAssigned.push } : {}),
      ...(body.types?.cardCommentAdded?.email !== undefined ? { cardCommentAddedEmail: body.types.cardCommentAdded.email } : {}),
      ...(body.types?.cardCommentAdded?.push !== undefined ? { cardCommentAddedPush: body.types.cardCommentAdded.push } : {}),
      ...(body.types?.commentMentioned?.email !== undefined ? { commentMentionedEmail: body.types.commentMentioned.email } : {}),
      ...(body.types?.commentMentioned?.push !== undefined ? { commentMentionedPush: body.types.commentMentioned.push } : {}),
      ...(body.types?.cardDueDateChanged?.email !== undefined ? { cardDueDateChangedEmail: body.types.cardDueDateChanged.email } : {}),
      ...(body.types?.cardDueDateChanged?.push !== undefined ? { cardDueDateChangedPush: body.types.cardDueDateChanged.push } : {}),
      ...(body.types?.cardOverdue?.email !== undefined ? { cardOverdueEmail: body.types.cardOverdue.email } : {}),
      ...(body.types?.cardOverdue?.push !== undefined ? { cardOverduePush: body.types.cardOverdue.push } : {}),
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(notificationSettings)
      .values({ userId: req.auth.sub, ...values })
      .onConflictDoUpdate({
        target: notificationSettings.userId,
        set: values,
      })
      .returning();
    const push = await getWebPushPublicConfig(req.auth.cid);
    return dto.notificationSettingsResponse.parse({ ...toEffectiveNotificationSettings(row, req.auth.sub), push });
  });

  app.get("/notifications/push/config", async (req) => {
    return dto.pushNotificationsConfigResponse.parse(await getWebPushPublicConfig(req.auth.cid));
  });

  app.put("/notifications/push/subscription", async (req, reply) => {
    const body = dto.pushSubscriptionBody.parse(req.body);
    const userAgentHeader = req.headers["user-agent"];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader.join(" ") : userAgentHeader;
    await upsertPushSubscriptionForUser({
      clientId: req.auth.cid,
      userId: req.auth.sub,
      subscription: body,
      userAgent,
    });
    return reply.status(204).send();
  });

  app.delete("/notifications/push/subscription", async (req, reply) => {
    const body = dto.deletePushSubscriptionBody.parse(req.body);
    await deletePushSubscriptionForUser({
      clientId: req.auth.cid,
      userId: req.auth.sub,
      endpoint: body.endpoint,
    });
    return reply.status(204).send();
  });

  app.post("/notifications/push/test", async (req): Promise<PushTestResponse> => {
    const body = dto.pushTestBody.parse(req.body ?? {});
    const row = await enqueuePushImmediate(db, {
      clientId: req.auth.cid,
      userId: req.auth.sub,
      reason: "test",
      payload: body,
    });
    const result = await deliverPushRow(db, row);
    return {
      attempted: result.delivered + result.disabled + result.failed,
      ...result,
    };
  });

  app.get("/notifications/boards", async (req) => {
    const recentReadCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .selectDistinctOn([notifications.boardId], {
        boardId: notifications.boardId,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardIconColor: boards.iconColor,
      })
      .from(notifications)
      .innerJoin(boards, eq(boards.id, notifications.boardId))
      .leftJoin(cards, eq(cards.id, notifications.cardId))
      .where(
        and(
          eq(notifications.userId, req.auth.sub),
          or(isNull(notifications.readAt), gte(notifications.createdAt, recentReadCutoff)),
          inboxVisibleNotificationCondition(),
        ),
      )
      .orderBy(notifications.boardId, desc(notifications.createdAt));
    return rows.sort((a, b) => a.boardName.localeCompare(b.boardName) || (a.boardId ?? "").localeCompare(b.boardId ?? ""));
  });

  app.get("/notifications/users", async (req) => {
    const recentReadCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .selectDistinctOn([activityEvents.actorId], {
        userId: activityEvents.actorId,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(notifications)
      .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
      .innerJoin(users, eq(users.id, activityEvents.actorId))
      .leftJoin(cards, eq(cards.id, notifications.cardId))
      .where(
        and(
          eq(notifications.userId, req.auth.sub),
          or(isNull(notifications.readAt), gte(notifications.createdAt, recentReadCutoff)),
          inboxVisibleNotificationCondition(),
        ),
      )
      .orderBy(activityEvents.actorId, desc(notifications.createdAt));
    return rows
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || (a.userId ?? "").localeCompare(b.userId ?? ""))
      .map((row) => withSignedMedia(req.auth.cid, row));
  });

  app.post("/notifications/read", async (req) => {
    const body = dto.markNotificationsReadBody.parse(req.body);
    const readAt = new Date();
    const updated = await db
      .update(notifications)
      .set({ readAt })
      .where(
        and(
          eq(notifications.userId, req.auth.sub),
          inArray(notifications.id, body.notificationIds),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    if (updated.length > 0) {
      emitToUser(req.auth.sub, "notification:read", {
        notificationIds: updated.map((r) => r.id),
        readAt: readAt.toISOString(),
      });
    }
    return { readIds: updated.map((r) => r.id) };
  });

  app.post("/notifications/cards/:cardId/read", async (req) => {
    const { cardId } = req.params as { cardId: string };
    const [card] = await db
      .select({ id: cards.id, boardId: cards.boardId })
      .from(cards)
      .where(eq(cards.id, cardId))
      .limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id);

    const readAt = new Date();
    const updated = await db
      .update(notifications)
      .set({ readAt })
      .where(
        and(
          eq(notifications.userId, req.auth.sub),
          eq(notifications.cardId, cardId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    const readIds = updated.map((r) => r.id);
    if (readIds.length > 0) {
      emitToUser(req.auth.sub, "notification:read", {
        notificationIds: readIds,
        readAt: readAt.toISOString(),
      });
    }
    return { readIds, readAt: readAt.toISOString() };
  });

  app.post("/notifications/boards/:boardId/read", async (req) => {
    const { boardId } = req.params as { boardId: string };
    await assertBoardAccess(req.auth, boardId);

    const readAt = new Date();
    const updated = await db
      .update(notifications)
      .set({ readAt })
      .where(
        and(
          eq(notifications.userId, req.auth.sub),
          eq(notifications.boardId, boardId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    const readIds = updated.map((row) => row.id);
    if (readIds.length > 0) {
      // Emit the affected ids rather than the global all-read event so sibling
      // tabs preserve unread notifications belonging to every other board.
      emitToUser(req.auth.sub, "notification:read", {
        notificationIds: readIds,
        readAt: readAt.toISOString(),
      });
    }
    return { readIds, readAt: readAt.toISOString() };
  });

  app.post("/notifications/unread", async (req) => {
    const body = dto.markNotificationsReadBody.parse(req.body);
    const updated = await db
      .update(notifications)
      .set({ readAt: null })
      .where(
        and(
          eq(notifications.userId, req.auth.sub),
          inArray(notifications.id, body.notificationIds),
          isNotNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    if (updated.length > 0) {
      emitToUser(req.auth.sub, "notification:unread", {
        notificationIds: updated.map((r) => r.id),
      });
    }
    return { unreadIds: updated.map((r) => r.id) };
  });

  app.post("/notifications/read-all", async (req) => {
    const readAt = new Date();
    const updated = await db
      .update(notifications)
      .set({ readAt })
      .where(and(eq(notifications.userId, req.auth.sub), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    emitToUser(req.auth.sub, "notification:allRead", { readAt: readAt.toISOString() });
    return { readIds: updated.map((r) => r.id) };
  });

  app.get("/card-watches", async (req) => {
    const rows = await db
      .select({ cardId: cardWatchers.cardId, boardId: cards.boardId, workspaceId: lists.workspaceId })
      .from(cardWatchers)
      .innerJoin(cards, eq(cards.id, cardWatchers.cardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(eq(cardWatchers.userId, req.auth.sub));
    return rows;
  });

  app.get("/board-watches", async (req) => {
    const rows = await db
      .select({ boardId: boardWatchers.boardId, workspaceId: boards.workspaceId })
      .from(boardWatchers)
      .innerJoin(boards, eq(boards.id, boardWatchers.boardId))
      .where(eq(boardWatchers.userId, req.auth.sub));
    return rows;
  });

  app.get("/boards/:id/watchers", async (req): Promise<WatcherUser[]> => {
    const { id } = req.params as { id: string };
    await assertBoardAccess(req.auth, id);
    const rows = await db
      .select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(boardWatchers)
      .innerJoin(users, eq(users.id, boardWatchers.userId))
      .where(eq(boardWatchers.boardId, id))
      .orderBy(asc(users.displayName));
    return rows.map((row) => withSignedMedia(req.auth.cid, row));
  });

  app.get("/cards/:id/watchers", async (req): Promise<WatcherUser[]> => {
    const { id } = req.params as { id: string };
    const [card] = await db
      .select({ id: cards.id, boardId: cards.boardId })
      .from(cards)
      .where(eq(cards.id, id))
      .limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id);
    const rows = await db
      .select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(cardWatchers)
      .innerJoin(users, eq(users.id, cardWatchers.userId))
      .where(eq(cardWatchers.cardId, id))
      .orderBy(asc(users.displayName));
    return rows.map((row) => withSignedMedia(req.auth.cid, row));
  });

  app.put("/cards/:id/watch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [card] = await db
      .select({ id: cards.id, boardId: cards.boardId, workspaceId: lists.workspaceId })
      .from(cards)
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(eq(cards.id, id))
      .limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id);
    await db
      .insert(cardWatchers)
      .values({ cardId: id, userId: req.auth.sub })
      .onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete("/cards/:id/watch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [card] = await db
      .select({ id: cards.id, boardId: cards.boardId, workspaceId: lists.workspaceId })
      .from(cards)
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(eq(cards.id, id))
      .limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id);
    await db
      .delete(cardWatchers)
      .where(and(eq(cardWatchers.cardId, id), eq(cardWatchers.userId, req.auth.sub)));
    return reply.status(204).send();
  });

  app.put("/boards/:id/watch", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertBoardAccess(req.auth, id);
    await db
      .insert(boardWatchers)
      .values({ boardId: id, userId: req.auth.sub })
      .onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete("/boards/:id/watch", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertBoardAccess(req.auth, id);
    await db
      .delete(boardWatchers)
      .where(and(eq(boardWatchers.boardId, id), eq(boardWatchers.userId, req.auth.sub)));
    return reply.status(204).send();
  });

}

/**
 * Unauthenticated push routes — registered outside app.authenticate scope.
 * The subscription-refresh endpoint is called directly by the service worker
 * when the browser rotates a push subscription (pushsubscriptionchange event).
 */
export async function pushPublicRoutes(app: FastifyInstance) {
  app.post("/notifications/push/subscription-refresh", async (req, reply) => {
    const body = dto.pushSubscriptionRefreshBody.parse(req.body);
    const updated = await refreshPushSubscription({
      oldEndpoint: body.oldEndpoint,
      endpoint: body.endpoint,
      keys: body.keys,
      expirationTime: body.expirationTime,
      contentEncoding: body.contentEncoding,
    });
    if (!updated) return reply.status(404).send({ message: "subscription not found" });
    return reply.status(204).send();
  });
}
