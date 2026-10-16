import { ACTIVITY_ACTION, cardInProgressAlerts } from "@kanera/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

type AlertCandidate = {
  cardId: string;
  boardId: string;
  workspaceId: string;
  inProgressSince: Date;
  alertDays: number;
};

/**
 * Tells followers once when a card is in progress too long, until an admin resets its time.
 * The card's current stint must pass its workspace's `inProgressAlertDays` (the moment its clock turns amber).
 * It records a system activity on the card and publishes it like any card activity, so assignees,
 * card watchers and board watchers get it through their usual inbox, push and personal channels and
 * their own delivery preferences. The alert is 0 = off, so nothing fires then.
 *
 * A durable claim survives activity retention, timestamp precision loss and later list moves.
 * Only a qualifying admin time correction rearms it. Card locks serialize concurrent sweeps.
 */
export async function runInProgressAlertNotificationSweep(log?: FastifyBaseLogger, now = new Date()): Promise<number> {
  let alerted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const activities = await db.transaction(async (tx) => {
      const { rows } = await tx.execute<AlertCandidate>(sql`
        select c.id as "cardId", c.board_id as "boardId", c.workspace_id as "workspaceId",
               c.in_progress_since as "inProgressSince", w.in_progress_alert_days as "alertDays"
        from card c
        inner join workspace w on w.id = c.workspace_id
        inner join list l on l.id = c.list_id
        inner join board b on b.id = c.board_id
        where c.in_progress_since is not null
          and c.completed_at is null
          and c.archived_at is null
          and l.archived_at is null
          and b.archived_at is null
          and w.in_progress_alert_days > 0
          and c.in_progress_since <= ${now.toISOString()}::timestamptz - make_interval(days => w.in_progress_alert_days)
          and not exists (select 1 from card_in_progress_alert a where a.card_id = c.id)
        order by c.in_progress_since, c.id
        limit ${BATCH_SIZE}
        for update of c skip locked
      `);
      const recorded = [];
      for (const candidate of rows) {
        // The unique claim also protects against a candidate snapshot taken before another
        // sweep committed. Store it with the activity so neither can succeed on its own.
        const [claim] = await tx.insert(cardInProgressAlerts)
          .values({ cardId: candidate.cardId })
          .onConflictDoNothing()
          .returning({ cardId: cardInProgressAlerts.cardId });
        if (!claim) continue;
        const activity = await recordActivity(tx, {
          boardId: candidate.boardId,
          workspaceId: candidate.workspaceId,
          actorId: null,
          actorKind: "system",
          entityType: "card",
          entityId: candidate.cardId,
          action: ACTIVITY_ACTION.IN_PROGRESS_TOO_LONG,
          payload: { inProgressSince: new Date(candidate.inProgressSince).toISOString(), alertDays: candidate.alertDays },
        });
        recorded.push({ candidate, activity });
      }
      return recorded;
    });
    for (const { candidate, activity } of activities) {
      await emitActivityFeedItem(candidate.boardId, candidate.cardId, activity);
      alerted++;
    }
    if (activities.length < BATCH_SIZE) break;
  }
  if (alerted > 0) log?.info({ alerted }, "notified followers of cards in progress too long");
  return alerted;
}

export function startInProgressAlertNotificationScheduler(log: FastifyBaseLogger): () => Promise<void> {
  return startSweepScheduler({
    name: "in-progress-alert-notification",
    task: () => runInProgressAlertNotificationSweep(log),
    nextDelayMs: 60 * 60 * 1000,
    log,
  }).stop;
}
