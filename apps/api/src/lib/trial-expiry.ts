import { activityEvents, clientMembers, clients, users } from "@kanera/shared/schema";
import { and, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { impactFromPlanActions, sendHostedBillingEmail, trialUsageSummary } from "./billing-emails.js";
import { sendInternalTrialEndingNotification } from "./internal-notification-emails.js";
import type { Mailer } from "./mailer.js";
import { convertClientPlan } from "./plan-conversion.js";
import { ANALYTICS_EVENT_VERSION, productAnalytics } from "./product-analytics.js";
import { emitClientEntitlementsChanged } from "../realtime/emit.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

// One sweep: find hosted-mode orgs whose trial has lapsed and revert them to the free plan. The
// downgrade itself (resource reconciliation + plan_action audit) is owned by convertClientPlan; this
// only decides *when* a trial ends. No payment is involved — a lapsed trial simply becomes free.
export async function runTrialExpirySweep(log?: FastifyBaseLogger, mailer?: Mailer): Promise<number> {
  // Caps and trials only exist in hosted mode; self-hosted orgs are always unlimited.
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return 0;

  const expired = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.billingStatus, "trialing"), lt(clients.currentPeriodEnd, new Date())));

  for (const client of expired) {
    await convertClientPlan(client.id, { plan: "free", billingStatus: "none" });
    // Commercial lifecycle signal: an internal trial lapsed without converting to a paid plan. Claimed
    // once via analyticsTrialEndedAt so a re-run (or overlapping sweep) cannot emit it twice; the
    // capture itself still honours the org's analyticsExcluded flag inside productAnalytics.
    const claimed = await db.update(clients)
      .set({ analyticsTrialEndedAt: new Date() })
      .where(and(eq(clients.id, client.id), isNull(clients.analyticsTrialEndedAt)))
      .returning({ id: clients.id });
    if (claimed.length > 0) {
      void productAnalytics.capture({
        event: "trial_ended",
        organizationId: client.id,
        properties: {
          workspace_id: client.id,
          plan_code: "pro_trial",
          cancellation_category: "trial_expired",
          event_version: ANALYTICS_EVENT_VERSION,
        },
      });
    }
    emitClientEntitlementsChanged(client.id);
    if (mailer) {
      await sendHostedBillingEmail(mailer, {
        clientId: client.id,
        kind: "downgraded_to_free",
        impact: await impactFromPlanActions(client.id),
        dedupeKey: `downgraded_to_free:${client.id}`,
      }, { log });
    }
  }

  if (expired.length > 0) log?.info({ convertedCount: expired.length }, "reverted expired trials to free");
  return expired.length;
}

export async function runTrialWarningSweep(log?: FastifyBaseLogger, mailer?: Mailer, now = new Date()): Promise<number> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted" || !mailer) return 0;

  let sent = 0;
  for (const days of [10, 1]) {
    const start = new Date(now.getTime() + days * 86_400_000);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(24, 0, 0, 0);
    const trials = await db
      .select({ id: clients.id, currentPeriodEnd: clients.currentPeriodEnd })
      .from(clients)
      .where(and(eq(clients.billingStatus, "trialing"), gte(clients.currentPeriodEnd, start), lt(clients.currentPeriodEnd, end)));

    for (const trial of trials) {
      sent += await sendHostedBillingEmail(mailer, {
        clientId: trial.id,
        kind: "pro_trial_warning",
        daysRemaining: days,
        trialEndsAt: trial.currentPeriodEnd,
        // Marketing's "trial nearing end" moment: summarise achieved value next to the plan options.
        usage: await trialUsageSummary(trial.id),
        dedupeKey: `pro_trial_warning:${days}:${dateKey(start)}`,
      }, { log });
    }
  }
  return sent;
}

// Three days leaves time for a personal conversation before the organisation drops to Free.
const TRIAL_ENDING_NOTICE_DAYS = 3;

/**
 * Tells the team (INTERNAL_NOTIFICATION_EMAILS) about each self-serve trial ending within three days
 * without a subscription, with enough usage context to decide who to contact. Nothing is claimed while
 * no recipients are configured, so turning the setting on later still covers trials already in range.
 */
export async function runTrialEndingNoticeSweep(
  log?: FastifyBaseLogger,
  now = new Date(),
  send: typeof sendInternalTrialEndingNotification = sendInternalTrialEndingNotification,
): Promise<number> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted" || env.INTERNAL_NOTIFICATION_EMAILS.length === 0) return 0;
  const trials = await db
    .select({ id: clients.id, name: clients.name, currentPeriodEnd: clients.currentPeriodEnd })
    .from(clients)
    .where(and(
      eq(clients.billingStatus, "trialing"),
      gt(clients.currentPeriodEnd, now),
      lte(clients.currentPeriodEnd, new Date(now.getTime() + TRIAL_ENDING_NOTICE_DAYS * 86_400_000)),
      isNull(clients.trialEndingNotifiedAt),
      isNull(clients.deletedAt),
      eq(clients.analyticsExcluded, false),
      // Operator-provisioned organisations are handled directly, not through self-serve follow-up.
      sql`${clients.createdByUserId} is not null`,
    ));

  let sent = 0;
  for (const trial of trials) {
    const [claimed] = await db.update(clients)
      .set({ trialEndingNotifiedAt: now })
      .where(and(eq(clients.id, trial.id), isNull(clients.trialEndingNotifiedAt)))
      .returning({ id: clients.id });
    if (!claimed || !trial.currentPeriodEnd) continue;
    const usage = await trialUsageSummary(trial.id);
    const owners = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(eq(clientMembers.clientId, trial.id), eq(clientMembers.clientRole, "owner"), isNull(clientMembers.removedAt), isNull(users.deletedAt)));
    const [activity] = await db.execute<{ lastActiveAt: string | Date | null }>(sql`
      select greatest(
        (select max(ae.created_at) from ${activityEvents} ae where ae.client_id = ${trial.id}),
        (select max(u.last_online_at) from ${clientMembers} cm inner join ${users} u on u.id = cm.user_id
           where cm.client_id = ${trial.id} and cm.removed_at is null)
      ) as "lastActiveAt"
    `).then((result) => result.rows);
    sent += await send({
      orgName: trial.name,
      clientId: trial.id,
      trialEndsAt: trial.currentPeriodEnd,
      owners,
      ...usage,
      lastActiveAt: activity?.lastActiveAt ? new Date(activity.lastActiveAt) : null,
    }, { log });
  }
  return sent;
}

// Trial expiry is day-granular, so a coarse cadence is plenty. Wait until the start of the next day
// (local time), matching the "trial ends at midnight" mental model and keeping the sweep cheap.
function delayToNextDay(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}

export function startTrialExpiryScheduler(log: FastifyBaseLogger, mailer?: Mailer): () => Promise<void> {
  return startSweepScheduler({
    name: "trial-expiry",
    // Expiry and warning run sequentially within one tick so they never overlap each other.
    task: async () => {
      await runTrialExpirySweep(log, mailer);
      await runTrialWarningSweep(log, mailer);
      await runTrialEndingNoticeSweep(log);
    },
    nextDelayMs: () => delayToNextDay(),
    log,
  }).stop;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
