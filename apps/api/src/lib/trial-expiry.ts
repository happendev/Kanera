import { clients } from "@kanera/shared/schema";
import { and, eq, gte, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { impactFromPlanActions, sendHostedBillingEmail } from "./billing-emails.js";
import type { Mailer } from "./mailer.js";
import { convertClientPlan } from "./plan-conversion.js";
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
        dedupeKey: `pro_trial_warning:${days}:${dateKey(start)}`,
      }, { log });
    }
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

export function startTrialExpiryScheduler(log: FastifyBaseLogger, mailer?: Mailer): () => void {
  return startSweepScheduler({
    name: "trial-expiry",
    // Expiry and warning run sequentially within one tick so they never overlap each other.
    task: async () => {
      await runTrialExpirySweep(log, mailer);
      await runTrialWarningSweep(log, mailer);
    },
    nextDelayMs: () => delayToNextDay(),
    log,
  }).stop;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
