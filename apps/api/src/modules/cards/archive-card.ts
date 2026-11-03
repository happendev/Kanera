import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import type { assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { emitAutomationEffects, runCardBlockedAutomations, runCardUnblockedAutomations, type AutomationEffects } from "../../lib/automations.js";
import { invalidateQueuesForCards } from "../../lib/card-priority-invalidation.js";
import { captureBlockedDependents, captureUnblockedDependents, emitDependentsChanged } from "../../lib/card-relations.js";
import { notifyDependencyHandoffs, recordBlockersCleared, type DependencyHandoff } from "../../lib/dependency-notifications.js";
import type { Mailer } from "../../lib/mailer.js";
import { clearNotificationsForCards, emitDeletedNotifications } from "../../lib/notifications.js";
import { requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitToBoard } from "../../realtime/emit.js";
import { emitCardActivityFeedItem } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Archives or restores one card. The caller has already returned early when the card is in the
 * requested state; archived cards are deliberately accepted here.
 */
export async function archiveCard({ auth, card, ctx, archived }: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  archived: boolean;
}) {
  const id = card.id;
  const archivedAt = archived ? (card.archivedAt ?? new Date()) : null;
  const result = await db.transaction(async (tx) => {
    const before = await captureBlockedDependents(tx, ctx.workspaceId, [id]);
    const readyBefore = archived ? [] : await captureUnblockedDependents(tx, ctx.workspaceId, [id]);
    const [updated] = await tx
      .update(cards)
      .set({ archivedAt, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    await requestScheduleRecheckForCards(tx, [id]);

    const activity = await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: id,
      action: archived ? ACTIVITY_ACTION.ARCHIVED : ACTIVITY_ACTION.UNARCHIVED,
      payload: { title: card.title, archivedAt },
    });
    const deletedNotifications = archived ? await clearNotificationsForCards(tx, [id]) : [];
    // An archived blocker no longer blocks, so archiving can unblock the cards waiting on it.
    // Restoring it blocks those cards again; that handoff is recorded by the blocked runner.
    const handoffs: DependencyHandoff[] = archived
      ? await recordBlockersCleared(tx, { before, actorId: auth.sub })
      : [];
    let unblockedEffects: AutomationEffects;
    if (archived) {
      unblockedEffects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId: ctx.workspaceId, clientId: auth.cid, triggerActorId: auth.sub });
    } else {
      const run = await runCardBlockedAutomations(tx, { cardIds: readyBefore, workspaceId: ctx.workspaceId, clientId: auth.cid, triggerActorId: auth.sub, blocker: updated! });
      handoffs.push(...run.handoffs);
      unblockedEffects = run;
    }
    return { updated: updated!, activity, deletedNotifications, handoffs, unblockedEffects };
  });
  return { card, ...result };
}

/** Post-commit fanout for `archiveCard`; returns the wire card the route responds with. */
export async function emitArchivedCard(
  { card, updated, activity, deletedNotifications, handoffs, unblockedEffects }: Awaited<ReturnType<typeof archiveCard>>,
  { auth, mailer, log }: { auth: AuthClaims; mailer: Mailer; log: { warn(obj: object, msg: string): void } },
) {
  const id = card.id;
  emitDeletedNotifications(deletedNotifications);
  await emitCardActivityFeedItem(card.boardId, id, activity, { notify: false });
  const wireCard = toWireCard(updated, auth.cid);
  await emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: card.boardId, card: wireCard });
  // An archived blocker no longer blocks; restoring it blocks again.
  await emitDependentsChanged([id], auth.cid);
  await notifyDependencyHandoffs({ handoffs, mailer, webOrigin: env.WEB_ORIGIN })
    .catch((err: unknown) => log.warn({ err }, "failed to send blockers-cleared notifications"));
  await emitAutomationEffects(unblockedEffects);
  // Archiving hides the card from any "Up next" queue holding it (and restoring brings it back)
  // without touching the queue rows, so those audiences are pinged separately.
  await invalidateQueuesForCards([id]);
  return wireCard;
}
