import { clients } from "@kanera/shared/schema";
import { isNotNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { syncStripeSeatQuantity } from "./billing.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

// Stripe's subscription quantity should always equal the org's purchased seat_limit, which only changes
// through setSeatCapacity (which invoices increases) or a billing webhook. This hourly sweep is the
// safety net for any drift — e.g. a setSeatCapacity that updated Stripe but failed to persist, or vice
// versa. It runs syncStripeSeatQuantity in reconcileOnly mode (proration_behavior:"none") so a pure
// drift repair can never produce a surprise mid-cycle invoice; it is idempotent (no-ops when the
// quantity already matches) and self-guards non-paid orgs.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

export async function runSeatReconcileSweep(log?: FastifyBaseLogger): Promise<number> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted" || !env.STRIPE_SECRET_KEY) return 0;

  const orgs = await db
    .select({ id: clients.id })
    .from(clients)
    .where(isNotNull(clients.stripeSubscriptionItemId));

  let reconciled = 0;
  for (const org of orgs) {
    try {
      // syncStripeSeatQuantity itself guards paid-tier + quantity-equality, so a no-op is cheap and
      // a single org's Stripe failure must not abort the rest of the sweep. reconcileOnly avoids any
      // surprise proration invoice — this is drift repair, not a billing event.
      await syncStripeSeatQuantity(org.id, env, { reconcileOnly: true });
      reconciled += 1;
    } catch (err) {
      log?.warn({ err, clientId: org.id }, "seat reconcile sync failed");
    }
  }
  return reconciled;
}

export function startSeatReconcileScheduler(log: FastifyBaseLogger): () => void {
  return startSweepScheduler({
    name: "seat-reconcile",
    task: () => runSeatReconcileSweep(log),
    nextDelayMs: RECONCILE_INTERVAL_MS,
    log,
  }).stop;
}
