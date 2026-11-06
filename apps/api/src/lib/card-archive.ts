import { SERVER_EVENTS, type WireCard } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cards, type ActivityEvent } from "@kanera/shared/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, type TxOnly } from "../db.js";
import { env } from "../env.js";
import { emitToBoard } from "../realtime/emit.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { EMPTY_EFFECTS, emitAutomationEffects, runCardBlockedAutomations, runCardUnblockedAutomations, type AutomationEffect, type AutomationEffects } from "./automations.js";
import { invalidateQueuesForCards } from "./card-priority-invalidation.js";
import { captureBlockedDependents, captureUnblockedDependents, emitDependentsChanged, lockWorkspaceRelations } from "./card-relations.js";
import { lockCardsForWrite } from "./card-write-lock.js";
import { notifyDependencyHandoffs, recordBlockersCleared, type DependencyHandoff } from "./dependency-notifications.js";
import type { Mailer } from "./mailer.js";
import { clearNotificationsForCards, emitDeletedNotifications } from "./notifications.js";
import { requestScheduleRecheckForCards } from "./schedule-events.js";
import { toWireCard } from "./wire-card.js";

type Card = typeof cards.$inferSelect;

type CardArchiveOptions = {
  cardIds: readonly string[];
  archived: boolean;
  workspaceId: string;
  /** The workspace's organisation: it owns the dependents' rules and their execution quota. */
  clientId: string;
  actorId: string;
  /** Selection and whole-list archives mark each audit row as one of many. */
  bulk: boolean;
};

export type CardArchiveTransition = {
  /** The cards that changed state, as written, in id order, each with its audit row. */
  rows: { card: Card; activity: ActivityEvent }[];
  deletedNotifications: Awaited<ReturnType<typeof clearNotificationsForCards>>;
  handoffs: DependencyHandoff[];
  /** The dependents' card_unblocked (archive) or card_blocked (restore) rules. */
  dependentEffects: AutomationEffects;
};

/**
 * Card archival (archive ⇄ restore): the one in-transaction implementation, used by the single-card
 * route, the selection route and the whole-list route. Board mirrors converge archival together with
 * other facets in one write (board-mirror/converge.ts) and imports create cards already archived.
 *
 * State: `archivedAt` null is active. An archived card is read-only (assertCardActive) and hidden
 * from boards, queues, schedules and notifications, and it no longer blocks anything. It keeps its
 * list, completion and reminders, so a restore returns it as it was: reminders stay in place and are
 * skipped at fire time (runCardReminderSweep), not cleared as completion clears them. The card SQL
 * trigger (migration 0092) stops and resumes the in-progress clock, so no clock column is written here.
 *
 * Guard: only cards of this workspace not already in the requested state transition; the others are
 * left out of `rows`. The rows are read after the workspace graph lock, which every completion,
 * archive and move writer takes first, so the state read cannot change before the write. The
 * whole-list route selects its cards after taking that lock itself, so a blocker moved into the list
 * while it waited is archived with its handoff.
 *
 * Consequences, in order: the write and a schedule recheck; one audit row per card; archiving clears
 * the cards' notifications; then the dependency handoff. Archiving clears blockers (handoff rows, then
 * card_unblocked rules); restoring re-blocks each card's ready dependents with that card named as the
 * blocker (card_blocked rules with "blocked again"). Post-commit fanout is `emitCardArchiveTransition`.
 */
export async function applyCardArchiveTransition(tx: TxOnly, opts: CardArchiveOptions): Promise<CardArchiveTransition> {
  const { archived, workspaceId, clientId, actorId } = opts;
  await lockWorkspaceRelations(tx, workspaceId);
  const ids = [...new Set(opts.cardIds)];
  const changing = ids.length === 0 ? [] : await tx.select({ id: cards.id }).from(cards).where(and(
    inArray(cards.id, ids),
    eq(cards.workspaceId, workspaceId),
    archived ? isNull(cards.archivedAt) : isNotNull(cards.archivedAt),
  ));
  if (changing.length === 0) return { rows: [], deletedNotifications: [], handoffs: [], dependentEffects: EMPTY_EFFECTS };
  const changingIds = changing.map((card) => card.id);

  const before = archived ? await captureBlockedDependents(tx, workspaceId, changingIds) : [];
  // Captured per card before any write, so each restored card is named as its own dependents' blocker.
  const readyBefore = new Map<string, string[]>();
  if (!archived) for (const id of changingIds) readyBefore.set(id, await captureUnblockedDependents(tx, workspaceId, [id]));
  // The audit and handoff rows below write through every card and dependent; hold them in one order.
  await lockCardsForWrite(tx, [...changingIds, ...before.map((row) => row.dependentId), ...[...readyBefore.values()].flat()]);

  const now = new Date();
  const archivedAt = archived ? now : null;
  const updated = await tx.update(cards).set({ archivedAt, updatedAt: now }).where(inArray(cards.id, changingIds)).returning();
  updated.sort((a, b) => a.id.localeCompare(b.id));
  await requestScheduleRecheckForCards(tx, changingIds);
  const rows: CardArchiveTransition["rows"] = [];
  for (const card of updated) {
    const activity = await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId,
      actorId,
      entityType: "card",
      entityId: card.id,
      action: archived ? ACTIVITY_ACTION.ARCHIVED : ACTIVITY_ACTION.UNARCHIVED,
      payload: { title: card.title, archivedAt, ...(opts.bulk && { bulk: true }) },
    });
    rows.push({ card, activity });
  }

  if (archived) {
    const deletedNotifications = await clearNotificationsForCards(tx, changingIds);
    // An archived blocker no longer blocks, so archiving can unblock the cards waiting on it.
    const handoffs = await recordBlockersCleared(tx, { before, actorId });
    const dependentEffects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId, clientId, triggerActorId: actorId });
    return { rows, deletedNotifications, handoffs, dependentEffects };
  }
  // Restoring blocks those cards again; the blocked runner records that handoff.
  const handoffs: DependencyHandoff[] = [];
  const effects: AutomationEffect[] = [];
  for (const card of updated) {
    const run = await runCardBlockedAutomations(tx, { cardIds: readyBefore.get(card.id) ?? [], workspaceId, clientId, triggerActorId: actorId, blocker: card });
    handoffs.push(...run.handoffs);
    effects.push(...run.effects);
  }
  return { rows, deletedNotifications: [], handoffs, dependentEffects: { effects } };
}

/** `applyCardArchiveTransition` in a transaction of its own. */
export function archiveCards(opts: CardArchiveOptions): Promise<CardArchiveTransition> {
  return db.transaction((tx) => applyCardArchiveTransition(tx, opts));
}

/**
 * Post-commit fanout for `applyCardArchiveTransition`, including the audiences board rooms miss.
 * Returns the written cards as wire cards, in the transition's order. `clientId` signs their media.
 */
export async function emitCardArchiveTransition(
  { rows, deletedNotifications, handoffs, dependentEffects }: CardArchiveTransition,
  opts: { clientId: string; mailer: Mailer; log: { warn(obj: object, msg: string): void } },
): Promise<WireCard[]> {
  emitDeletedNotifications(deletedNotifications);
  const wireCards: WireCard[] = [];
  for (const { card, activity } of rows) {
    // Fanout skips archived cards anyway, and a restore is not news for watchers.
    await emitActivityFeedItem(card.boardId, card.id, activity, { notify: false });
    const wireCard = toWireCard(card, opts.clientId);
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: card.boardId, card: wireCard });
    wireCards.push(wireCard);
  }
  if (rows.length === 0) return wireCards;
  const cardIds = rows.map(({ card }) => card.id);
  // The cards these block, possibly on other boards, gain or lose their Blocked badge.
  await emitDependentsChanged(cardIds, opts.clientId);
  await notifyDependencyHandoffs({ handoffs, mailer: opts.mailer, webOrigin: env.WEB_ORIGIN })
    .catch((err: unknown) => opts.log.warn({ err }, "failed to send blockers-cleared notifications"));
  await emitAutomationEffects(dependentEffects);
  // Archiving hides cards from any "Up next" queue holding them (and restoring brings them back)
  // without touching the queue rows, so those audiences are pinged separately.
  await invalidateQueuesForCards(cardIds);
  return wireCards;
}
