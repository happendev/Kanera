import { clients } from "@kanera/shared/schema";
import { isNotNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { reconcileStripeSubscription } from "./billing.js";
import { sendOpsAlert } from "./ops-alerts.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

// Recover delayed or missed payment/status webhooks from live Stripe state. Never push a stale local
// seat_limit to Stripe: a paid increase may have settled there while its webhook is still in flight.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

export async function runSeatReconcileSweep(log?: FastifyBaseLogger): Promise<number> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted" || !env.STRIPE_SECRET_KEY) return 0;

  const orgs = await db
    .select({ id: clients.id })
    .from(clients)
    .where(isNotNull(clients.stripeSubscriptionId));

  let reconciled = 0;
  for (const org of orgs) {
    try {
      await reconcileStripeSubscription(org.id, env);
      reconciled += 1;
    } catch (err) {
      log?.warn({ err, clientId: org.id }, "seat reconcile sync failed");
      void sendOpsAlert({
        service: "api",
        type: "error",
        title: "Billing reconciliation failed",
        error: new Error(`Stripe seat reconciliation failed for organisation ${org.id}`),
        throttleKey: `billing:seat-reconcile:${org.id}`,
      }, { log });
    }
  }
  return reconciled;
}

export function startSeatReconcileScheduler(log: FastifyBaseLogger): () => Promise<void> {
  return startSweepScheduler({
    name: "seat-reconcile",
    task: () => runSeatReconcileSweep(log),
    nextDelayMs: RECONCILE_INTERVAL_MS,
    log,
  }).stop;
}
