import type { dto } from "@kanera/shared";
import { activityEvents, NOTIFICATION_REASON, notifications } from "@kanera/shared/schema";
import { and, eq, exists, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import { db } from "../../db.js";
import { emitToUser } from "../../realtime/emit.js";

/** `POST /notifications/read`: marks the listed notifications read and tells the user's other tabs. */
export async function markNotificationsRead({ userId, body }: { userId: string; body: dto.MarkNotificationsReadBody }) {
  const readAt = new Date();
  const updated = await db
    .update(notifications)
    .set({ readAt })
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, body.notificationIds),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length > 0) {
    emitToUser(userId, "notification:read", {
      notificationIds: updated.map((r) => r.id),
      readAt: readAt.toISOString(),
    });
  }
  return { readIds: updated.map((r) => r.id) };
}

/** `POST /notifications/cards/:cardId/read`; the route has already checked card access. */
export async function markCardNotificationsRead({ userId, cardId }: { userId: string; cardId: string }) {
  const readAt = new Date();
  const updated = await db
    .update(notifications)
    .set({ readAt })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.cardId, cardId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  const readIds = updated.map((r) => r.id);
  if (readIds.length > 0) {
    emitToUser(userId, "notification:read", {
      notificationIds: readIds,
      readAt: readAt.toISOString(),
    });
  }
  return { readIds, readAt: readAt.toISOString() };
}

/** `POST /notifications/boards/:boardId/read`; the route has already checked board access. */
export async function markBoardNotificationsRead({ userId, boardId }: { userId: string; boardId: string }) {
  const readAt = new Date();
  const updated = await db
    .update(notifications)
    .set({ readAt })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.boardId, boardId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  const readIds = updated.map((row) => row.id);
  if (readIds.length > 0) {
    // Emit the affected ids rather than the global all-read event so sibling
    // tabs preserve unread notifications belonging to every other board.
    emitToUser(userId, "notification:read", {
      notificationIds: readIds,
      readAt: readAt.toISOString(),
    });
  }
  return { readIds, readAt: readAt.toISOString() };
}

/** `POST /notifications/unread`: reverses `markNotificationsRead` for the listed ids. */
export async function markNotificationsUnread({ userId, body }: { userId: string; body: dto.MarkNotificationsReadBody }) {
  const updated = await db
    .update(notifications)
    .set({ readAt: null })
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, body.notificationIds),
        isNotNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length > 0) {
    emitToUser(userId, "notification:unread", {
      notificationIds: updated.map((r) => r.id),
    });
  }
  return { unreadIds: updated.map((r) => r.id) };
}

/** `POST /notifications/read-all`, optionally scoped to the Agent or Mentions feed. */
export async function markAllNotificationsRead({ userId, body }: { userId: string; body: dto.MarkAllNotificationsReadBody }) {
  const readAt = new Date();
  const conditions: SQL[] = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  // Same agent test as the Agent feed in notificationFeedConditions: the triggering activity's actor.
  if (body.agentOnly) {
    conditions.push(exists(
      db.select({ id: activityEvents.id }).from(activityEvents)
        .where(and(eq(activityEvents.id, notifications.activityId), eq(activityEvents.actorKind, "agent"))),
    ));
  }
  if (body.mentionsOnly) conditions.push(eq(notifications.reason, NOTIFICATION_REASON.MENTIONED));
  const updated = await db
    .update(notifications)
    .set({ readAt })
    .where(and(...conditions))
    .returning({ id: notifications.id });
  const readIds = updated.map((r) => r.id);
  if (body.agentOnly || body.mentionsOnly) {
    // Per-id read event, like the board-scoped read, so sibling tabs re-sync every badge and
    // keep the user's other unread notifications.
    if (readIds.length > 0) emitToUser(userId, "notification:read", { notificationIds: readIds, readAt: readAt.toISOString() });
    return { readIds };
  }
  // Exact ids preserve notifications created after this UPDATE but before its event is delivered.
  emitToUser(userId, "notification:allRead", { readAt: readAt.toISOString(), notificationIds: readIds });
  return { readIds };
}
