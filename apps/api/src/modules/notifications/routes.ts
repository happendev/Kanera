import { dto } from "@kanera/shared";
import type { NotificationGroupCountsResponse, NotificationsPage, PersonalNotificationTestResponse, PushTestResponse, WatcherUser } from "@kanera/shared/dto";
import { activityEvents, boards, boardWatchers, cards, cardWatchers, lists, NOTIFICATION_REASON, notificationSettings, notifications, users } from "@kanera/shared/schema";
import { and, asc, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { requestLocale } from "../../lib/i18n/request-locale.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { enforcePushSubscriptionRefreshRateLimit } from "../../lib/lookup-rate-limit.js";
import {
  countUnreadNotifications,
  inboxVisibleNotificationCondition,
} from "../../lib/notifications.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { getNotificationSettings } from "../../lib/notification-settings.js";
import {
  deletePushSubscriptionForUser,
  getWebPushPublicConfig,
  refreshPushSubscription,
} from "../../lib/web-push.js";
import { verifyLifecycleUnsubscribeToken } from "../../lib/lifecycle-emails.js";
import { markAllNotificationsRead, markBoardNotificationsRead, markCardNotificationsRead, markNotificationsRead, markNotificationsUnread } from "./mark-notifications-read.js";
import { boardUnreadCounts, cardUnreadCounts, feedCounts, listNotificationsPage, notificationGroupCounts, orgUnreadCounts } from "./notification-feed.js";
import { visibleWorkspaceRuleResponses } from "./notification-rules.js";
import { deleteNotificationWorkspaceRule, putNotificationWorkspaceRule } from "./notification-workspace-rules.js";
import { rotateWebhookSecret, testPersonalChannel } from "./personal-channels.js";
import { savePushSubscription, testPush } from "./push-subscriptions.js";
import { updateNotificationSettings } from "./update-notification-settings.js";

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Legacy/default listing still honours includeRead=false. The web drawer uses
  // includeRead=true here for All and /notifications/unread below for Unread, so
  // the two tabs page independently and never share a cursor.
  app.get("/notifications", async (req): Promise<NotificationsPage> => {
    return listNotificationsPage({ userId: req.auth.sub, rawQuery: req.query });
  });

  app.get("/notifications/unread", async (req): Promise<NotificationsPage> => {
    return listNotificationsPage({ userId: req.auth.sub, rawQuery: req.query, includeRead: false });
  });

  app.get("/notifications/group-counts", async (req): Promise<NotificationGroupCountsResponse> => {
    return notificationGroupCounts(req.auth.sub, req.query);
  });

  app.get("/notifications/unread-count", async (req) => {
    const count = await countUnreadNotifications(req.auth.sub);
    return { count };
  });

  app.get("/notifications/agent-counts", (req) => feedCounts(req.auth.sub, eq(activityEvents.actorKind, "agent")));
  app.get("/notifications/mention-counts", (req) => feedCounts(req.auth.sub, eq(notifications.reason, NOTIFICATION_REASON.MENTIONED)));

  app.get("/notifications/org-unread-counts", async (req) => {
    return orgUnreadCounts(req.auth.sub);
  });

  app.get("/notifications/board-unread-counts", async (req) => {
    return boardUnreadCounts(req.auth.sub);
  });

  app.get("/notifications/card-unread-counts", async (req) => {
    return cardUnreadCounts(req.auth.sub);
  });

  app.get("/notifications/settings", async (req) => {
    const [settings, push, workspaceRules] = await Promise.all([
      getNotificationSettings(db, req.auth.sub),
      getWebPushPublicConfig(req.auth.cid),
      visibleWorkspaceRuleResponses(req.auth),
    ]);
    return dto.notificationSettingsResponse.parse({ ...settings, push, workspaceRules });
  });

  app.patch("/notifications/settings", async (req) => {
    const body = dto.updateNotificationSettingsBody.parse(req.body ?? {});
    return updateNotificationSettings({ auth: req.auth, body });
  });

  app.put("/notifications/settings/workspaces/:workspaceId", async (req) => {
    const rawWorkspaceId = (req.params as { workspaceId: string }).workspaceId;
    const workspaceId = dto.notificationWorkspaceRule.shape.workspaceId.parse(rawWorkspaceId);
    const body = dto.putNotificationWorkspaceRuleBody.parse(req.body);
    return putNotificationWorkspaceRule({ auth: req.auth, workspaceId, body });
  });

  app.delete("/notifications/settings/workspaces/:workspaceId", async (req, reply) => {
    const rawWorkspaceId = (req.params as { workspaceId: string }).workspaceId;
    const workspaceId = dto.notificationWorkspaceRule.shape.workspaceId.parse(rawWorkspaceId);
    await deleteNotificationWorkspaceRule({ auth: req.auth, workspaceId });
    return reply.status(204).send();
  });

  app.post("/notifications/channels/webhook/secret", async (req) => {
    return rotateWebhookSecret({ auth: req.auth });
  });

  app.post("/notifications/channels/:channel/test", async (req): Promise<PersonalNotificationTestResponse> => {
    const { channel } = req.params as { channel: string };
    const parsedChannel = dto.personalNotificationChannel.parse(channel);
    return testPersonalChannel({ auth: req.auth, channel: parsedChannel, locale: requestLocale(req) });
  });

  app.get("/notifications/push/config", async (req) => {
    return dto.pushNotificationsConfigResponse.parse(await getWebPushPublicConfig(req.auth.cid));
  });

  app.put("/notifications/push/subscription", async (req, reply) => {
    const body = dto.pushSubscriptionBody.parse(req.body);
    await savePushSubscription({ auth: req.auth, body, userAgentHeader: req.headers["user-agent"] });
    return reply.status(204).send();
  });

  app.delete("/notifications/push/subscription", async (req, reply) => {
    const body = dto.deletePushSubscriptionBody.parse(req.body);
    await deletePushSubscriptionForUser({
      userId: req.auth.sub,
      endpoint: body.endpoint,
    });
    return reply.status(204).send();
  });

  app.post("/notifications/push/test", async (req): Promise<PushTestResponse> => {
    const body = dto.pushTestBody.parse(req.body ?? {});
    return testPush({ auth: req.auth, body, locale: requestLocale(req) });
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
        userClientId: users.clientId,
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
      .map(({ userClientId, avatarUrl, ...row }) => ({
        ...row,
        avatarUrl: signedAvatarUrl(userClientId, avatarUrl),
      }));
  });

  app.post("/notifications/read", async (req) => {
    const body = dto.markNotificationsReadBody.parse(req.body);
    return markNotificationsRead({ userId: req.auth.sub, body });
  });

  app.post("/notifications/cards/:cardId/read", async (req) => {
    const { cardId } = req.params as { cardId: string };
    const [card] = await db
      .select({ id: cards.id, boardId: cards.boardId })
      .from(cards)
      .where(eq(cards.id, cardId))
      .limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card);
    return markCardNotificationsRead({ userId: req.auth.sub, cardId });
  });

  app.post("/notifications/boards/:boardId/read", async (req) => {
    const { boardId } = req.params as { boardId: string };
    await assertBoardAccess(req.auth, boardId);
    return markBoardNotificationsRead({ userId: req.auth.sub, boardId });
  });

  app.post("/notifications/unread", async (req) => {
    const body = dto.markNotificationsReadBody.parse(req.body);
    return markNotificationsUnread({ userId: req.auth.sub, body });
  });

  app.post("/notifications/read-all", async (req) => {
    const body = dto.markAllNotificationsReadBody.parse(req.body ?? {});
    return markAllNotificationsRead({ userId: req.auth.sub, body });
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
      .select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, userClientId: users.clientId })
      .from(boardWatchers)
      .innerJoin(users, eq(users.id, boardWatchers.userId))
      .where(eq(boardWatchers.boardId, id))
      .orderBy(asc(users.displayName));
    return rows.map(({ userClientId, avatarUrl, ...row }) => ({
      ...row,
      avatarUrl: signedAvatarUrl(userClientId, avatarUrl),
    }));
  });

  app.get("/cards/:id/watchers", async (req): Promise<WatcherUser[]> => {
    const { id } = req.params as { id: string };
    const [card] = await db
      .select({ id: cards.id, boardId: cards.boardId })
      .from(cards)
      .where(eq(cards.id, id))
      .limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card);
    const rows = await db
      .select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, userClientId: users.clientId })
      .from(cardWatchers)
      .innerJoin(users, eq(users.id, cardWatchers.userId))
      .where(eq(cardWatchers.cardId, id))
      .orderBy(asc(users.displayName));
    return rows.map(({ userClientId, avatarUrl, ...row }) => ({
      ...row,
      avatarUrl: signedAvatarUrl(userClientId, avatarUrl),
    }));
  });

}

/**
 * Unauthenticated push routes — registered outside app.authenticate scope.
 * The subscription-refresh endpoint is called directly by the service worker
 * when the browser rotates a push subscription (pushsubscriptionchange event).
 */
export async function pushPublicRoutes(app: FastifyInstance) {
  // Throttled per IP before any database access; see enforcePushSubscriptionRefreshRateLimit.
  app.post("/notifications/push/subscription-refresh", { preHandler: enforcePushSubscriptionRefreshRateLimit }, async (req, reply) => {
    const body = dto.pushSubscriptionRefreshBody.parse(req.body);
    const updated = await refreshPushSubscription({
      oldEndpoint: body.oldEndpoint,
      oldAuth: body.oldAuth,
      endpoint: body.endpoint,
      keys: body.keys,
      expirationTime: body.expirationTime,
      contentEncoding: body.contentEncoding,
    });
    // Thrown rather than hand-rolled so the response carries the same `{ code, message }`
    // envelope as every other error. A failed background refresh opens the app, whose
    // authenticated startup sync repairs the durable subscription row.
    if (!updated) throw notFound("subscription not found");
    return reply.status(204).send();
  });
}

/**
 * Unauthenticated unsubscribe for lifecycle (onboarding/check-in) emails. The signed token is the only
 * authority: it names one user and can only clear that user's lifecycle flag, so a leaked link cannot
 * read anything or touch card notification preferences. Bare GETs never unsubscribe, so inbox link
 * scanners that prefetch URLs cannot opt someone out.
 */
export async function emailPreferencePublicRoutes(app: FastifyInstance) {
  // RFC 8058 one-click requests arrive as a form post. Scoped to this plugin, like the OAuth parser.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body.toString())));
  });

  // The web app's /email/unsubscribe page posts here after an explicit click.
  app.post("/email/unsubscribe", async (req, reply) => {
    const body = dto.emailUnsubscribeBody.parse(req.body);
    await unsubscribeFromLifecycleEmail(body.token);
    return reply.status(204).send();
  });

  // Target of the List-Unsubscribe header. Mail providers POST `List-Unsubscribe=One-Click` here
  // with the token in the URL, from their own "Unsubscribe" control and without a session.
  app.post("/email/unsubscribe/one-click", async (req, reply) => {
    const query = dto.emailUnsubscribeBody.parse(req.query);
    await unsubscribeFromLifecycleEmail(query.token);
    return reply.status(200).send({ ok: true });
  });
}

async function unsubscribeFromLifecycleEmail(token: string): Promise<void> {
  const userId = verifyLifecycleUnsubscribeToken(token);
  if (!userId) throw badRequest("unsubscribe link is invalid");
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
  // Answer the same way for a deleted account: there is nothing left to email.
  if (!user) return;
  await db.insert(notificationSettings)
    .values({ userId, lifecycleEmail: false })
    .onConflictDoUpdate({ target: notificationSettings.userId, set: { lifecycleEmail: false, updatedAt: new Date() } });
}
