import { MCP_REMINDER_EVENT_NAME, type McpReminderEventOccurrence, type WireCardReminder } from "@kanera/shared/dto";
import {
  NOTIFICATION_REASON,
  boards,
  cardReminders,
  cards,
  lists,
  mcpEventDeliveries,
  mcpEventSubscriptions,
  notifications,
  workspaces,
  type CardReminder,
} from "@kanera/shared/schema";
import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, type Db, type Tx } from "../db.js";
import { env } from "../env.js";
import { emitToUser } from "../realtime/emit.js";
import { enqueueCardReminderOutbound } from "./assignee-email-notifications.js";
import { createMailer } from "./mailer.js";
import { enrichNotifications, inboxVisibleNotificationCondition } from "./notifications.js";
import { resolveSmtpConfig } from "./smtp-resolve.js";
import { startSweepScheduler } from "./sweep-scheduler.js";
import { absoluteCardUrl } from "./wire-card.js";

const REMINDER_BATCH = 200;
const REMINDER_SWEEP_INTERVAL_MS = 30_000;

export function serializeCardReminder(row: CardReminder): WireCardReminder {
  return {
    id: row.id,
    cardId: row.cardId,
    remindAt: row.remindAt.toISOString(),
    firedAt: row.firedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ClearedCardReminder = { id: string; cardId: string; userId: string };

/**
 * Completing a card clears every reminder on it, for every person, pending or already fired. A
 * reminder is a nudge to come back to unfinished work, so one that fires after the work is done is
 * noise. Call it inside the completion transaction and pass the result to
 * `emitClearedCardReminders` after commit. Reopening the card does not bring reminders back, and a
 * reminder set on a card that is already complete is left alone: that is a deliberate choice.
 */
export async function clearRemindersOnCompletedCards(tx: Tx, cardIds: readonly string[]): Promise<ClearedCardReminder[]> {
  if (cardIds.length === 0) return [];
  return tx
    .delete(cardReminders)
    .where(inArray(cardReminders.cardId, [...cardIds]))
    .returning({ id: cardReminders.id, cardId: cardReminders.cardId, userId: cardReminders.userId });
}

/** Tells each owner's open sessions that their reminder is gone, so the alarm on the card turns off. */
export function emitClearedCardReminders(cleared: readonly ClearedCardReminder[]): void {
  for (const row of cleared) emitToUser(row.userId, "cardReminder:deleted", { cardId: row.cardId, reminderId: row.id });
}

type FiredReminder = { reminder: CardReminder; notificationId: string | null; url: string };

/**
 * Claim every reminder that has come due and deliver it once.
 *
 * Claiming stamps `firedAt` under `for update skip locked` in the same transaction that writes the
 * notification, the outbound email/push rows and the agent webhook deliveries, so a second worker
 * never double-delivers and a crash part-way through leaves the reminder pending for the next run.
 *
 * Delivery is decided at fire time, not when the reminder was set: the card may have been archived,
 * or the user may have lost access to its board since. Those reminders are still marked fired (they
 * will never become deliverable on their own) but produce no notification, email, push or webhook,
 * so nothing describes a card the user can no longer see.
 */
export async function runCardReminderSweep(now = new Date(), log?: FastifyBaseLogger): Promise<number> {
  const fired = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: cardReminders.id })
      .from(cardReminders)
      .where(and(isNull(cardReminders.firedAt), lte(cardReminders.remindAt, now)))
      .orderBy(asc(cardReminders.remindAt))
      .limit(REMINDER_BATCH)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const claimed = await tx
      .update(cardReminders)
      .set({ firedAt: now })
      .where(inArray(cardReminders.id, due.map((row) => row.id)))
      .returning();
    return deliverReminders(tx, claimed, now);
  });

  for (const { reminder } of fired) {
    emitToUser(reminder.userId, "cardReminder:updated", { reminder: serializeCardReminder(reminder) });
  }
  const notificationIds = fired.flatMap((row) => (row.notificationId ? [row.notificationId] : []));
  for (const row of await enrichNotifications(db, notificationIds)) {
    emitToUser(row.userId, "notification:created", { notification: row });
  }
  if (fired.length > 0) log?.info({ fired: fired.length, delivered: notificationIds.length }, "fired card reminders");
  return fired.length;
}

async function deliverReminders(tx: Tx, claimed: CardReminder[], now: Date): Promise<FiredReminder[]> {
  if (claimed.length === 0) return [];
  const contexts = await tx
    .select({
      cardId: cards.id,
      listId: cards.listId,
      boardId: cards.boardId,
      workspaceId: lists.workspaceId,
      clientId: workspaces.clientId,
      organisationKey: cards.organisationKey,
      key: cards.key,
      archivedAt: cards.archivedAt,
      boardArchivedAt: boards.archivedAt,
    })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, lists.workspaceId))
    .where(inArray(cards.id, Array.from(new Set(claimed.map((row) => row.cardId)))));
  const ctxByCard = new Map(contexts.map((row) => [row.cardId, row]));

  const live = claimed.filter((reminder) => {
    const ctx = ctxByCard.get(reminder.cardId);
    return ctx && !ctx.archivedAt && !ctx.boardArchivedAt;
  });
  const inserted = live.length === 0 ? [] : await tx
    .insert(notifications)
    .values(live.map((reminder) => {
      const ctx = ctxByCard.get(reminder.cardId)!;
      return {
        userId: reminder.userId,
        clientId: ctx.clientId,
        activityId: null,
        cardId: ctx.cardId,
        listId: ctx.listId,
        boardId: ctx.boardId,
        workspaceId: ctx.workspaceId,
        reason: NOTIFICATION_REASON.REMINDER,
      };
    }))
    .returning({ id: notifications.id, userId: notifications.userId, cardId: notifications.cardId });

  // The inbox's own visibility rule is the access check: membership, guest assigned-items-only
  // restrictions, suspended members and organisations. A reminder the inbox would hide is dropped
  // here rather than delivered to channels the inbox filter cannot reach (email, push, webhooks).
  const visibleIds = new Set(inserted.length === 0 ? [] : (await tx
    .select({ id: notifications.id })
    .from(notifications)
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(inArray(notifications.id, inserted.map((row) => row.id)), inboxVisibleNotificationCondition())))
    .map((row) => row.id));
  const hidden = inserted.filter((row) => !visibleIds.has(row.id)).map((row) => row.id);
  if (hidden.length > 0) await tx.delete(notifications).where(inArray(notifications.id, hidden));
  const notificationByUserCard = new Map(
    inserted.filter((row) => visibleIds.has(row.id)).map((row) => [`${row.userId}:${row.cardId}`, row.id]),
  );

  const results = claimed.map((reminder): FiredReminder => {
    const ctx = ctxByCard.get(reminder.cardId);
    return {
      reminder,
      notificationId: notificationByUserCard.get(`${reminder.userId}:${reminder.cardId}`) ?? null,
      url: ctx ? absoluteCardUrl(ctx.organisationKey, ctx.key) : "",
    };
  });
  const delivered = results.filter((row) => row.notificationId);
  if (delivered.length === 0) return results;

  await enqueueCardReminderOutbound({
    tx,
    mailer: createMailer({
      db: tx as Db,
      resolveSmtpConfig,
      webOrigin: env.WEB_ORIGIN,
      log: { info() { }, error() { }, warn() { }, debug() { } } as never,
    }),
    webOrigin: env.WEB_ORIGIN,
    reminders: delivered.map(({ reminder }) => ({ cardId: reminder.cardId, userId: reminder.userId, reminderId: reminder.id })),
  });
  await enqueueReminderMcpEvents(tx, delivered, now);
  return results;
}

/**
 * Queue `reminder.due` for the reminder owner's own agent subscriptions. Written in the sweep's
 * transaction (there is no outbox row for a private reminder), and the partial unique index on
 * (subscription, reminderId) keeps a retried sweep from posting the same reminder twice.
 */
async function enqueueReminderMcpEvents(tx: Tx, delivered: FiredReminder[], now: Date): Promise<void> {
  const userIds = Array.from(new Set(delivered.map(({ reminder }) => reminder.userId)));
  const subscriptions = await tx.select().from(mcpEventSubscriptions).where(and(
    inArray(mcpEventSubscriptions.targetUserId, userIds),
    eq(mcpEventSubscriptions.name, MCP_REMINDER_EVENT_NAME),
    gt(mcpEventSubscriptions.expiresAt, now), lte(mcpEventSubscriptions.startsAt, now),
  ));
  if (subscriptions.length === 0) return;
  const rows = delivered.flatMap(({ reminder, url }) => subscriptions
    // Pinned to the subscriber by a database check; filtering on both keeps that true here too.
    .filter((sub) => sub.targetUserId === reminder.userId && sub.userId === reminder.userId)
    .map((sub) => ({
      subscriptionId: sub.id,
      outboxEventId: null,
      payload: {
        eventId: `evt_${crypto.randomUUID()}`, name: MCP_REMINDER_EVENT_NAME, timestamp: now.toISOString(), cursor: null,
        data: {
          targetUserId: reminder.userId,
          reminderId: reminder.id,
          cardId: reminder.cardId,
          remindAt: reminder.remindAt.toISOString(),
          ...(url ? { url } : {}),
          actor: { kind: "system" as const, userId: null, self: false },
        },
      } satisfies McpReminderEventOccurrence,
    })));
  if (rows.length > 0) await tx.insert(mcpEventDeliveries).values(rows).onConflictDoNothing();
}

/** Reminders fire within a minute of their time; the 30s cadence keeps the worst case under that. */
export function startCardReminderScheduler(log: FastifyBaseLogger): () => Promise<void> {
  return startSweepScheduler({
    name: "card-reminder",
    task: () => runCardReminderSweep(new Date(), log),
    // A full batch means more are already due, so drain back-to-back instead of waiting.
    nextDelayMs: (fired) => (fired === REMINDER_BATCH ? 0 : REMINDER_SWEEP_INTERVAL_MS),
    log,
  }).stop;
}

