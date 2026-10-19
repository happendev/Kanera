import { ACTIVITY_ACTION, activityEvents, boardMembers, boards, cards, clientMembers, notifications, workspaces, type CommentReactionType } from "@kanera/shared/schema";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { assignedCardVisibility } from "./access.js";
import { recordActivity } from "./activity.js";
import { enqueueReactionAddedNotifications } from "./assignee-email-notifications.js";
import type { Mailer } from "./mailer.js";
import { emitDeletedNotifications, enrichNotifications } from "./notifications.js";
import { emitToUsersDurable } from "../realtime/emit.js";

/** What was reacted to, and who hears about it (the comment's author or the file's uploader). */
export type ReactionTarget =
  | { kind: "comment"; commentId: string; recipientId: string; body: string }
  | { kind: "attachment"; attachmentId: string; recipientId: string; fileName: string };

// Comment reactions hang off the comment; attachment reactions off the card, keyed by attachmentId
// in the payload, because attachments are not an activity entity of their own.
function targetCondition(target: ReactionTarget, cardId: string) {
  return target.kind === "comment"
    ? and(eq(activityEvents.entityType, "comment"), eq(activityEvents.entityId, target.commentId))
    : and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, cardId), sql`${activityEvents.payload}->>'attachmentId' = ${target.attachmentId}`);
}

async function reactionActivities(actorId: string, cardId: string, target: ReactionTarget) {
  return db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.action, ACTIVITY_ACTION.REACTION_ADDED), eq(activityEvents.actorId, actorId), targetCondition(target, cardId)));
}

// The inbox's own access rule (notification-visibility.ts): an active organisation owner/admin, or a
// board member who can see this card. Checked before sending because push and email carry the card
// title with no later check; the inbox re-applies the full rule when it reads.
export async function recipientCanSeeCard(userId: string, clientId: string, boardId: string, cardId: string): Promise<boolean> {
  // Plan-archived boards keep their cards and grants, but neither direct reads nor inbox entries
  // expose them. Check before the administrator override so email/push use the same visibility.
  const [activeBoard] = await db.select({ id: boards.id }).from(boards)
    .where(and(eq(boards.id, boardId), isNull(boards.archivedAt))).limit(1);
  if (!activeBoard) return false;
  const [admin] = await db
    .select({ userId: clientMembers.userId })
    .from(clientMembers)
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, userId),
      inArray(clientMembers.clientRole, ["owner", "admin"]),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .limit(1);
  if (admin) return true;
  const [member] = await db
    .select({ assignedItemsOnly: boardMembers.assignedItemsOnly })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
    .limit(1);
  if (!member) return false;
  // Board membership survives suspension or removal from the organisation (a board row is kept so
  // access can be restored), but the person is denied at the door (access.ts), so nothing may be
  // sent to them either. Only no organisation membership at all is true guest access.
  const [inactive] = await db
    .select({ userId: clientMembers.userId })
    .from(clientMembers)
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, userId),
      or(isNotNull(clientMembers.suspendedAt), isNotNull(clientMembers.removedAt)),
    ))
    .limit(1);
  if (inactive) return false;
  if (!member.assignedItemsOnly) return true;
  const [visible] = await db
    .select({ ok: assignedCardVisibility(userId, sql`${cardId}::uuid`) })
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);
  return Boolean(visible?.ok);
}

/**
 * A thumbs-up tells the author, like a reply would. The audit row is hidden from feeds and exists to
 * carry the "reacted" notification. Only the first reaction by a person on an item sends push or
 * email; un-reacting withdraws the inbox entry and re-reacting restores it silently, so toggling the
 * button cannot spam anyone.
 */
export async function notifyReactionAdded(params: {
  actorId: string;
  card: { id: string; boardId: string; listId: string };
  target: ReactionTarget;
  type: CommentReactionType;
  mailer: Mailer;
  webOrigin: string;
}): Promise<void> {
  const { actorId, card, target } = params;
  if (target.recipientId === actorId) return;

  const [context] = await db
    .select({ workspaceId: boards.workspaceId, clientId: workspaces.clientId })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(eq(cards.id, card.id))
    .limit(1);
  if (!context) return;
  if (!(await recipientCanSeeCard(target.recipientId, context.clientId, card.boardId, card.id))) return;

  const [previous] = await reactionActivities(actorId, card.id, target);
  const activity = previous ?? await recordActivity(db, {
    boardId: card.boardId,
    workspaceId: context.workspaceId,
    actorId,
    entityType: target.kind === "comment" ? "comment" : "card",
    entityId: target.kind === "comment" ? target.commentId : card.id,
    action: ACTIVITY_ACTION.REACTION_ADDED,
    payload: target.kind === "comment"
      ? { cardId: card.id, commentId: target.commentId, reactionType: params.type }
      : { cardId: card.id, attachmentId: target.attachmentId, fileName: target.fileName, reactionType: params.type },
    feedVisible: false,
  });

  const [row] = await db
    .insert(notifications)
    .values({
      userId: target.recipientId,
      clientId: context.clientId,
      activityId: activity.id,
      cardId: card.id,
      listId: card.listId,
      boardId: card.boardId,
      workspaceId: context.workspaceId,
      reason: "reacted",
    })
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.activityId],
      set: { readAt: null },
    })
    .returning({ id: notifications.id });
  if (row) {
    const enriched = await enrichNotifications(db, [row.id]);
    await emitToUsersDurable("notification:created", enriched.map((notification) => ({ userId: notification.userId, payload: { notification } })));
  }

  if (previous) return;
  await enqueueReactionAddedNotifications({
    tx: db,
    mailer: params.mailer,
    webOrigin: params.webOrigin,
    cardId: card.id,
    actorId,
    recipientUserId: target.recipientId,
    target: target.kind === "comment" ? { kind: "comment", body: target.body } : { kind: "attachment", fileName: target.fileName },
  });
}

/** Removing a thumbs-up takes back its inbox entry; the audit row stays so a re-react is silent. */
export async function withdrawReactionNotification(params: {
  actorId: string;
  cardId: string;
  target: ReactionTarget;
}): Promise<void> {
  const activities = await reactionActivities(params.actorId, params.cardId, params.target);
  if (activities.length === 0) return;
  const deleted = await db
    .delete(notifications)
    .where(inArray(notifications.activityId, activities.map((activity) => activity.id)))
    .returning({ id: notifications.id, userId: notifications.userId });
  emitDeletedNotifications(deleted);
}
