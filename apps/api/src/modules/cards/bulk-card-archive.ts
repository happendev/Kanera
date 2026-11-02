import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cards, type ActivityEvent } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import type { assertBoardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { emitAutomationEffects, runCardUnblockedAutomations } from "../../lib/automations.js";
import { invalidateQueuesForCards } from "../../lib/card-priority-invalidation.js";
import { captureBlockedDependents, emitDependentsChanged } from "../../lib/card-relations.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { notifyDependencyHandoffs, recordBlockersCleared } from "../../lib/dependency-notifications.js";
import type { Mailer } from "../../lib/mailer.js";
import { clearNotificationsForCards, emitDeletedNotifications } from "../../lib/notifications.js";
import { requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitToBoard } from "../../realtime/emit.js";
import { emitCardActivityFeedItem } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type Card = typeof cards.$inferSelect;

/** Archives the given unarchived cards and releases the dependents they were blocking. */
export async function archiveBulkCards({
  auth,
  ctx,
  boardId,
  cards: targetCards,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  cards: Card[];
}) {
  const archivedAt = new Date();
  return db.transaction(async (tx) => {
    const before = await captureBlockedDependents(tx, ctx.workspaceId, targetCards.map((card) => card.id));
    await lockCardsForWrite(tx, [...targetCards.map((card) => card.id), ...before.map((row) => row.dependentId)]);
    const rows: { card: Card; activity: ActivityEvent }[] = [];
    for (const current of targetCards) {
      const [card] = await tx
        .update(cards)
        .set({ archivedAt, updatedAt: archivedAt })
        .where(eq(cards.id, current.id))
        .returning();
      await requestScheduleRecheckForCards(tx, [current.id]);
      const activity = await recordActivity(tx, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: auth.sub,
        entityType: "card",
        entityId: current.id,
        action: ACTIVITY_ACTION.ARCHIVED,
        payload: { title: current.title, archivedAt, bulk: true },
      });
      rows.push({ card: card!, activity });
    }
    const deletedNotifications = await clearNotificationsForCards(tx, targetCards.map((card) => card.id));
    const handoffs = await recordBlockersCleared(tx, { before, actorId: auth.sub });
    const unblockedEffects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId: ctx.workspaceId, clientId: auth.cid, triggerActorId: auth.sub });
    return { rows, deletedNotifications, handoffs, unblockedEffects };
  });
}

/** Post-commit fanout for `archiveBulkCards`, including the queue audiences board rooms miss. */
export async function emitBulkCardArchive(
  { rows: updates, deletedNotifications, handoffs, unblockedEffects }: Awaited<ReturnType<typeof archiveBulkCards>>,
  opts: { boardId: string; auth: AuthClaims; mailer: Mailer; log: { warn(obj: unknown, msg: string): void } },
): Promise<void> {
  const { boardId, auth } = opts;
  emitDeletedNotifications(deletedNotifications);

  for (const { card, activity } of updates) {
    await emitCardActivityFeedItem(boardId, card.id, activity);
    await emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: toWireCard(card, auth.cid) });
  }
  await emitDependentsChanged(updates.map(({ card }) => card.id), auth.cid);
  await notifyDependencyHandoffs({ handoffs, mailer: opts.mailer, webOrigin: env.WEB_ORIGIN })
    .catch((err: unknown) => opts.log.warn({ err }, "failed to send blockers-cleared notifications"));
  await emitAutomationEffects(unblockedEffects);
  // Archival removes cards from "Up next" queues without touching their rows, so the queue
  // audiences must be pinged separately from the board room above.
  await invalidateQueuesForCards(updates.map(({ card }) => card.id));
}
