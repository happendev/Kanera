import { clientGuestSeats, clients, stripeEvents, users, type ClientBillingInterval, type ClientBillingStatus } from "@kanera/shared/schema";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import Stripe from "stripe";
import { db, type Db } from "../db.js";
import { env, type Env } from "../env.js";
import { impactFromPlanActions, previewDowngradeImpact, sendHostedBillingEmail, sendHostedSeatCapacityEmail } from "./billing-emails.js";
import { AppError, badRequest } from "./errors.js";
import { canAddPaidSeat, isPaidTier } from "./entitlements.js";
import type { Mailer } from "./mailer.js";
import { convertClientPlan } from "./plan-conversion.js";
import { emitClientEntitlementsChanged } from "../realtime/emit.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type BillingPortalIntent = "home" | "invoices" | "cancel_subscription" | "payment_method";

type StripeEnv = Pick<
  Env,
  | "KANERA_DEPLOYMENT_MODE"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_PUBLISHABLE_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "STRIPE_PRICE_ID_PRO_MONTHLY"
  | "STRIPE_PRICE_ID_PRO_ANNUAL"
  | "WEB_ORIGIN"
>;

// Result of a seat-capacity change. "applied" means Stripe took payment (or none was due) and the new
// limit is persisted. "requires_confirmation" means the proration invoice needs the customer to confirm
// the payment in-app via Stripe.js (3DS/SCA, or a redirect wallet like Revolut Pay); seat_limit is NOT
// persisted until the payment settles (see settleSeatCapacity, driven from the client after confirmation
// and idempotently by the invoice.paid webhook).
export type SetSeatCapacityResult =
  | { status: "applied"; seatLimit: number }
  | { status: "requires_confirmation"; seatLimit: number; clientSecret: string; publishableKey: string };

type SubscriptionLike = Stripe.Subscription & {
  items: { data: Stripe.SubscriptionItem[] };
};

const STRIPE_API_VERSION = "2026-05-27.dahlia";
const STRIPE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let stripeClient: Stripe | null = null;

export function setStripeClientForTests(client: Stripe | null): void {
  if (env.NODE_ENV !== "test") throw new Error("setStripeClientForTests is test-only");
  stripeClient = client;
}

function stripe(config: StripeEnv = env): Stripe {
  if (!config.STRIPE_SECRET_KEY) throw badRequest("Stripe is not configured");
  stripeClient ??= new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  return stripeClient;
}

function isStripeCardError(err: unknown): boolean {
  const error = err as { type?: unknown; raw?: { type?: unknown } } | null;
  return error?.type === "StripeCardError" || error?.raw?.type === "card_error";
}

function paymentActionRequired(): AppError {
  return new AppError(
    402,
    "BILLING_PAYMENT_ACTION_REQUIRED",
    "Your payment method needs attention before we can add seats. Update your payment method, then try again.",
    { portalIntent: "payment_method" },
  );
}

// Stripe API 2026-05-27.dahlia removed the top-level Invoice.payment_intent. The client_secret used to
// confirm a finalized invoice's payment in-app (3DS/SCA cards, or redirect wallets like Revolut Pay) now
// lives on invoice.confirmation_secret, which is only populated when expanded. We use it both to drive the
// Stripe.js confirmation modal and — by deriving the PaymentIntent id from it — to read the live payment
// status, since the invoice's own status can briefly lag a successful confirmation.
type InvoiceWithSecret = Stripe.Invoice & { confirmation_secret?: Stripe.Invoice.ConfirmationSecret | null };

function invoiceClientSecret(invoice: InvoiceWithSecret | null | undefined): string | null {
  return invoice?.confirmation_secret?.client_secret ?? null;
}

// A PaymentIntent client_secret has the shape `{paymentIntentId}_secret_{...}`.
function paymentIntentIdFromClientSecret(clientSecret: string | null): string | null {
  if (!clientSecret) return null;
  const marker = clientSecret.indexOf("_secret_");
  return marker > 0 ? clientSecret.slice(0, marker) : null;
}

async function updateSubscriptionItemForSeatQuantity(
  itemId: string,
  params: Stripe.SubscriptionItemUpdateParams,
  opts: { mapPaymentErrors: boolean },
  config: StripeEnv = env,
): Promise<void> {
  try {
    await stripe(config).subscriptionItems.update(itemId, params);
  } catch (err) {
    if (opts.mapPaymentErrors && isStripeCardError(err)) throw paymentActionRequired();
    throw err;
  }
}

function requireHostedStripe(config: StripeEnv = env): void {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") throw badRequest("billing is only available in hosted mode");
  if (!config.STRIPE_SECRET_KEY || !config.STRIPE_PRICE_ID_PRO_MONTHLY || !config.STRIPE_PRICE_ID_PRO_ANNUAL) {
    throw badRequest("Stripe is not configured");
  }
}

export function priceIdForInterval(interval: ClientBillingInterval, config: StripeEnv = env): string {
  const priceId = interval === "annual" ? config.STRIPE_PRICE_ID_PRO_ANNUAL : config.STRIPE_PRICE_ID_PRO_MONTHLY;
  if (!priceId) throw badRequest("Stripe price is not configured");
  return priceId;
}

export function intervalForPrice(priceId: string | null | undefined, config: StripeEnv = env): ClientBillingInterval | null {
  if (priceId === config.STRIPE_PRICE_ID_PRO_ANNUAL) return "annual";
  if (priceId === config.STRIPE_PRICE_ID_PRO_MONTHLY) return "monthly";
  return null;
}

// The number of seats currently *occupied*: active org members + active paid guest seats (floored at 1).
// This is the "used" count, gated against the purchased clients.seat_limit; it is no longer the Stripe
// billed quantity (seat_limit is). Kept named countActiveSeats for call-site stability.
export async function countActiveSeats(clientId: string, tx: Tx = db): Promise<number> {
  const [memberRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt)));
  const [guestSeatRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(clientGuestSeats)
    .innerJoin(users, eq(users.id, clientGuestSeats.userId))
    .where(and(eq(clientGuestSeats.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt)));
  return Math.max(1, (memberRow?.count ?? 0) + (guestSeatRow?.count ?? 0));
}

// Set the org's purchased seat capacity (seat_limit) — the "buy more" / "reduce seats" operation.
// Capacity, not headcount, is what Stripe bills, so this is the only interactive path that changes the
// subscription quantity. Returns whether the change was applied immediately or needs in-app payment
// confirmation (see SetSeatCapacityResult).
export async function setSeatCapacity(
  clientId: string,
  newLimit: number,
  config: StripeEnv = env,
  notify?: { mailer?: Mailer; log?: FastifyBaseLogger },
): Promise<SetSeatCapacityResult> {
  type TxResult =
    | { kind: "unchanged" }
    | { kind: "applied"; isIncrease: boolean }
    | { kind: "requires_confirmation"; clientSecret: string; currentLimit: number };
  const result = await db.transaction(async (tx): Promise<TxResult> => {
    // Serialize capacity changes with member/guest assignment paths, which take the same tenant row lock
    // before checking the pool. Without this, a reduction and a concurrent assignment could both pass
    // their count checks and leave used seats above seat_limit.
    await tx.execute(sql`select 1 from ${clients} where ${clients.id} = ${clientId} for update`);
    const [client] = await tx
      .select({
        billingStatus: clients.billingStatus,
        stripeSubscriptionId: clients.stripeSubscriptionId,
        stripeSubscriptionItemId: clients.stripeSubscriptionItemId,
        seatLimit: clients.seatLimit,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) throw badRequest("client not found");
    if (
      config.KANERA_DEPLOYMENT_MODE !== "hosted" ||
      !client.stripeSubscriptionItemId ||
      (client.billingStatus !== "active" && client.billingStatus !== "past_due")
    ) {
      throw badRequest("Seat capacity can only be changed for paid subscriptions");
    }

    // You cannot provision fewer seats than are already assigned; free a member/guest first.
    const usedSeats = await countActiveSeats(clientId, tx);
    if (newLimit < usedSeats) {
      throw new AppError(402, "SEAT_LIMIT_BELOW_USAGE", "You have more assigned seats than that — remove members or guests first.", {
        limit: "seats",
        current: usedSeats,
        requested: newLimit,
      });
    }
    if (newLimit === client.seatLimit) return { kind: "unchanged" };

    // Only paid subscription-backed orgs can change purchased capacity. Trials are unlimited until
    // checkout, and Free uses the configured member allowance instead of clients.seat_limit.
    const increased = newLimit > client.seatLimit;
    if (config.KANERA_DEPLOYMENT_MODE === "hosted" && config.STRIPE_SECRET_KEY && client.stripeSubscriptionItemId && isPaidTier(client.billingStatus)) {
      // canAddPaidSeat (not isPaidTier) excludes past_due: a dunning org cannot make a new billing addition
      // against a failing card. Reductions are always allowed (they credit the next cycle).
      if (increased && !canAddPaidSeat(client.billingStatus)) {
        // Diagnostic: this block fires when our stored billingStatus is past_due. Pull what Stripe currently
        // reports about the subscription and its latest invoice so we can see whether Stripe actually agrees,
        // or whether a stale/out-of-order webhook left us stuck in past_due after a successful SCA payment.
        if (notify?.log && client.stripeSubscriptionId) {
          try {
            const liveSub = (await stripe(config).subscriptions.retrieve(client.stripeSubscriptionId, {
              expand: ["latest_invoice.confirmation_secret"],
            })) as Stripe.Subscription & { latest_invoice?: InvoiceWithSecret | null };
            const inv = liveSub.latest_invoice;
            notify.log.warn(
              {
                clientId,
                storedBillingStatus: client.billingStatus,
                stripeSubscriptionStatus: liveSub.status,
                latestInvoiceStatus: inv?.status,
                hasConfirmationSecret: invoiceClientSecret(inv) !== null,
                amountDue: inv?.amount_due,
                amountRemaining: inv?.amount_remaining,
              },
              "seat increase blocked (SEAT_PURCHASE_UNAVAILABLE): live Stripe subscription state",
            );
          } catch (logErr) {
            notify.log.warn({ clientId, err: logErr }, "seat increase blocked: failed to read live Stripe subscription for diagnostics");
          }
        }
        throw new AppError(402, "SEAT_PURCHASE_UNAVAILABLE", "Update your billing details before adding seats.", { upgradePlan: "paid" });
      }
      if (increased) {
        // always_invoice bills the proration now; pending_if_incomplete (NOT default_incomplete) is what
        // keeps a failed seat-add from harming the existing subscription. With pending_if_incomplete the
        // quantity bump is held as a Stripe *pending update* and is applied ONLY once the invoice is paid:
        // the live subscription quantity, status, and dunning are untouched until then. If the customer
        // rejects/abandons the payment (3DS/SCA, or a redirect wallet like Revolut Pay), the pending update
        // simply expires and the subscription continues unchanged — it never enters dunning, so it can't be
        // cancelled by an "if all retries fail, cancel the subscription" Stripe setting. (default_incomplete
        // instead applies the bump immediately and dunns the unpaid invoice, which could cancel the whole
        // subscription on a single failed seat-add.)
        await updateSubscriptionItemForSeatQuantity(
          client.stripeSubscriptionItemId,
          { quantity: newLimit, proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" },
          { mapPaymentErrors: true },
          config,
        );
        // If the charge didn't settle synchronously, Stripe leaves the pending-update invoice "open" with a
        // confirmation_secret carrying the PaymentIntent client_secret. We persist seat_limit only once that
        // invoice is paid (settleSeatCapacity / the invoice.paid webhook), so capacity never outruns payment.
        const sub = await stripe(config).subscriptions.retrieve(client.stripeSubscriptionId!, {
          expand: ["latest_invoice.confirmation_secret"],
        });
        const invoice = sub.latest_invoice as InvoiceWithSecret | null;
        const clientSecret = invoiceClientSecret(invoice);
        if (invoice?.status !== "paid") {
          notify?.log?.info(
            { clientId, stripeSubscriptionStatus: sub.status, latestInvoiceStatus: invoice?.status, hasConfirmationSecret: clientSecret !== null },
            "seat increase proration invoice not yet paid; awaiting in-app payment confirmation",
          );
          // Hand the PaymentIntent client_secret to the browser to confirm in-app. We do NOT persist
          // seat_limit here: settleSeatCapacity (called once the client confirms, and idempotently by the
          // invoice.paid webhook) promotes the pending update's quantity into seat_limit. If the customer
          // abandons, the pending update expires on Stripe's side and the subscription is left unchanged —
          // there is no raised quantity to reconcile back down.
          if (clientSecret && config.STRIPE_PUBLISHABLE_KEY) {
            return { kind: "requires_confirmation", clientSecret, currentLimit: client.seatLimit };
          }
          // No client_secret to confirm against (or Stripe.js not configured): fall back to the payment-
          // method portal so the admin can fix the method, then retry.
          throw paymentActionRequired();
        }
      } else {
        // A decrease credits the next cycle (create_prorations) and never charges, so it cannot fail on payment.
        await updateSubscriptionItemForSeatQuantity(
          client.stripeSubscriptionItemId,
          { quantity: newLimit, proration_behavior: "create_prorations" },
          { mapPaymentErrors: false },
          config,
        );
      }
    }

    // Persist only after Stripe confirms payment (or none was due). The requires_confirmation path above
    // returns before reaching here, leaving seat_limit untouched until the payment settles.
    await tx.update(clients).set({ seatLimit: newLimit, updatedAt: new Date() }).where(eq(clients.id, clientId));
    return { kind: "applied", isIncrease: increased };
  });

  if (result.kind === "unchanged") return { status: "applied", seatLimit: newLimit };
  if (result.kind === "requires_confirmation") {
    // seat_limit is unchanged; the new capacity is applied on settlement after the browser confirms payment.
    return { status: "requires_confirmation", seatLimit: result.currentLimit, clientSecret: result.clientSecret, publishableKey: config.STRIPE_PUBLISHABLE_KEY! };
  }
  emitClientEntitlementsChanged(clientId);
  if (result.isIncrease && notify?.mailer) {
    await sendHostedSeatCapacityEmail(notify.mailer, { clientId, seatLimit: newLimit, dedupeKey: `seats:${clientId}:${newLimit}` }, { log: notify.log });
  }
  return { status: "applied", seatLimit: newLimit };
}

// Promote a raised-but-unpaid Stripe quantity into seat_limit once the proration invoice is paid. Called
// from the client right after it confirms the payment in-app (so the UI updates without waiting for the
// webhook), and idempotently by the invoice.paid webhook. Returns the resolved seat_limit. Throws if the
// payment has not completed yet, so the caller can keep prompting for confirmation.
export async function settleSeatCapacity(clientId: string, config: StripeEnv = env, notify?: { mailer?: Mailer; log?: FastifyBaseLogger }): Promise<number> {
  const seatLimit = await db.transaction(async (tx): Promise<number | null> => {
    await tx.execute(sql`select 1 from ${clients} where ${clients.id} = ${clientId} for update`);
    const [client] = await tx
      .select({ stripeSubscriptionId: clients.stripeSubscriptionId, stripeSubscriptionItemId: clients.stripeSubscriptionItemId, billingStatus: clients.billingStatus, seatLimit: clients.seatLimit })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client?.stripeSubscriptionId || !client.stripeSubscriptionItemId || !isPaidTier(client.billingStatus)) {
      throw badRequest("No pending seat payment to confirm");
    }
    const sub = await stripe(config).subscriptions.retrieve(client.stripeSubscriptionId, { expand: ["latest_invoice.confirmation_secret"] });
    const invoice = (sub as SubscriptionLike).latest_invoice as InvoiceWithSecret | null;
    // The invoice's status can briefly lag a successful in-app confirmation, so also accept a succeeded
    // PaymentIntent (resolved from the confirmation secret) as proof the proration payment completed.
    let paymentSettled = invoice?.status === "paid";
    if (!paymentSettled) {
      const paymentIntentId = paymentIntentIdFromClientSecret(invoiceClientSecret(invoice));
      if (paymentIntentId) {
        const paymentIntent = await stripe(config).paymentIntents.retrieve(paymentIntentId);
        paymentSettled = paymentIntent.status === "succeeded";
      }
    }
    if (!paymentSettled) {
      throw new AppError(402, "BILLING_PAYMENT_INCOMPLETE", "We haven't received confirmation of your payment yet. Complete it and try again.");
    }
    // The seat increase is a Stripe pending update, applied to the live item only once the invoice is paid.
    // When we settle off a succeeded PaymentIntent before Stripe has applied it, the live item still shows
    // the old quantity, so prefer the pending update's target quantity when one is still present.
    const item = (sub as SubscriptionLike).items.data.find((i) => i.id === client.stripeSubscriptionItemId) ?? null;
    const pendingItem = sub.pending_update?.subscription_items?.find((i) => i.id === client.stripeSubscriptionItemId) ?? null;
    const targetQuantity = pendingItem?.quantity ?? item?.quantity ?? client.seatLimit;
    // Never drop below the assigned headcount, mirroring applySubscription's re-upgrade true-up.
    const used = await countActiveSeats(clientId, tx);
    const resolved = Math.max(targetQuantity, used);
    if (resolved === client.seatLimit) return null; // already settled (e.g. webhook beat us here)
    await tx.update(clients).set({ seatLimit: resolved, updatedAt: new Date() }).where(eq(clients.id, clientId));
    return resolved;
  });
  if (seatLimit === null) {
    const [client] = await db.select({ seatLimit: clients.seatLimit }).from(clients).where(eq(clients.id, clientId)).limit(1);
    return client?.seatLimit ?? 0;
  }
  emitClientEntitlementsChanged(clientId);
  if (notify?.mailer) {
    await sendHostedSeatCapacityEmail(notify.mailer, { clientId, seatLimit, dedupeKey: `seats:${clientId}:${seatLimit}` }, { log: notify.log });
  }
  return seatLimit;
}

export async function createCheckoutSession(
  clientId: string,
  userEmail: string,
  interval: ClientBillingInterval,
  seatLimit: number,
  config: StripeEnv = env,
): Promise<{ url: string }> {
  requireHostedStripe(config);
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw badRequest("client not found");

  // The admin chooses how many seats to buy, but they cannot buy fewer than are already assigned (which
  // can happen on a re-purchase after a downgrade restored members).
  const usedSeats = await countActiveSeats(clientId);
  const quantity = Math.max(seatLimit, usedSeats);

  const api = stripe(config);
  let customerId = client.stripeCustomerId;
  if (!customerId) {
    const customer = await api.customers.create({
      name: client.name,
      email: userEmail,
      metadata: { clientId },
    });
    customerId = customer.id;
  }

  // Persist the chosen interval, but NOT seat_limit — the user may abandon Checkout. seat_limit is set
  // from the live subscription quantity in applySubscription when the webhook confirms the purchase.
  await db
    .update(clients)
    .set({ stripeCustomerId: customerId, billingInterval: interval, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const session = await api.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    success_url: `${config.WEB_ORIGIN}/settings/account-plan?billing=success`,
    cancel_url: `${config.WEB_ORIGIN}/settings/account-plan?billing=cancelled`,
    client_reference_id: clientId,
    line_items: [{ price: priceIdForInterval(interval, config), quantity }],
    metadata: { clientId, interval },
    subscription_data: { metadata: { clientId, interval } },
  });

  if (!session.url) throw badRequest("Stripe did not return a checkout URL");
  return { url: session.url };
}

export async function createBillingPortalSession(
  clientId: string,
  intent: BillingPortalIntent = "home",
  config: StripeEnv = env,
): Promise<{ url: string }> {
  requireHostedStripe(config);
  const [client] = await db
    .select({
      stripeCustomerId: clients.stripeCustomerId,
      stripeSubscriptionId: clients.stripeSubscriptionId,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client?.stripeCustomerId) throw badRequest("No Stripe customer exists for this organisation");
  const returnUrl = `${config.WEB_ORIGIN}/settings/account-plan`;
  const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
    customer: client.stripeCustomerId,
    return_url: returnUrl,
  };

  if (intent === "cancel_subscription") {
    if (!client.stripeSubscriptionId) throw badRequest("No Stripe subscription exists for this organisation");
    sessionParams.flow_data = {
      type: "subscription_cancel",
      subscription_cancel: { subscription: client.stripeSubscriptionId },
      after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
    };
  } else if (intent === "payment_method") {
    sessionParams.flow_data = {
      type: "payment_method_update",
      after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
    };
  }

  const session = await stripe(config).billingPortal.sessions.create(sessionParams);
  return { url: session.url };
}

// Drives the Stripe subscription quantity to the org's purchased seat_limit. Capacity changes are
// normally made through setSeatCapacity (which invoices increases); this is the idempotent repair used
// by the reconcile sweep and after a webhook true-up. reconcileOnly uses proration_behavior:"none" so a
// pure drift repair can never produce a surprise mid-cycle invoice.
export async function syncStripeSeatQuantity(clientId: string, config: StripeEnv = env, opts: { reconcileOnly?: boolean } = {}): Promise<void> {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted" || !config.STRIPE_SECRET_KEY) return;
  const [client] = await db
    .select({
      billingStatus: clients.billingStatus,
      stripeSubscriptionItemId: clients.stripeSubscriptionItemId,
      seatLimit: clients.seatLimit,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client?.stripeSubscriptionItemId || !isPaidTier(client.billingStatus)) return;
  const desiredQuantity = client.seatLimit;
  const item = await stripe(config).subscriptionItems.retrieve(client.stripeSubscriptionItemId);
  if (item.quantity === desiredQuantity) return;
  if (opts.reconcileOnly) {
    await updateSubscriptionItemForSeatQuantity(
      client.stripeSubscriptionItemId,
      { quantity: desiredQuantity, proration_behavior: "none" },
      { mapPaymentErrors: false },
      config,
    );
    return;
  }
  // An increase must bill the prorated amount now: always_invoice creates and finalizes an immediate
  // proration invoice, which auto-charges the card on file (Checkout subscriptions use
  // collection_method=charge_automatically). A decrease keeps create_prorations so the credit offsets
  // the next renewal instead of generating an immediate $0/credit invoice.
  const isIncrease = (item.quantity ?? 0) < desiredQuantity;
  await updateSubscriptionItemForSeatQuantity(
    client.stripeSubscriptionItemId,
    {
      quantity: desiredQuantity,
      proration_behavior: isIncrease ? "always_invoice" : "create_prorations",
      ...(isIncrease ? { payment_behavior: "error_if_incomplete" as const } : {}),
    },
    { mapPaymentErrors: isIncrease },
    config,
  );
}

function statusForStripe(status: Stripe.Subscription.Status): { plan: "free" | "paid"; billingStatus: ClientBillingStatus } {
  switch (status) {
    case "trialing":
      return { plan: "paid", billingStatus: "trialing" };
    case "active":
      return { plan: "paid", billingStatus: "active" };
    case "past_due":
    case "incomplete":
      // Keep access during Stripe's dunning/retry window; the status still lets the UI prompt for a
      // payment method update without archiving resources on a transient renewal failure.
      return { plan: "paid", billingStatus: "past_due" };
    case "unpaid":
    case "incomplete_expired":
    case "canceled":
    case "paused":
      return { plan: "free", billingStatus: "canceled" };
  }
}

function subscriptionPeriodEnd(subscription: SubscriptionLike): Date | null {
  const timestamp = subscription.items.data[0]?.current_period_end;
  return typeof timestamp === "number" ? new Date(timestamp * 1000) : null;
}

type InvoiceWithSubscriptionReference = Stripe.Invoice & {
  parent?: {
    subscription_details?: {
      subscription?: string | Stripe.Subscription | null;
    } | null;
  } | null;
  subscription?: string | Stripe.Subscription | null;
};

function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  const invoiceWithSubscription = invoice as InvoiceWithSubscriptionReference;
  // Stripe's 2026 API shape moved the subscription reference under invoice.parent; keep the
  // top-level fallback only so old fixtures or unexpected snapshots do not become no-ops.
  const subscription = invoiceWithSubscription.parent?.subscription_details?.subscription ?? invoiceWithSubscription.subscription;
  return typeof subscription === "string" ? subscription : (subscription?.id ?? null);
}

async function applySubscription(
  subscription: Stripe.Subscription,
  config: StripeEnv = env,
  notifications?: { mailer?: Mailer; eventId?: string; allowUnpaidSeatIncrease?: boolean },
): Promise<void> {
  const sub = subscription as SubscriptionLike;
  const clientId = typeof sub.metadata?.clientId === "string" ? sub.metadata.clientId : null;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const firstItem = sub.items.data[0] ?? null;
  const interval = intervalForPrice(firstItem?.price?.id, config);
  const target = statusForStripe(sub.status);

  const [client] = clientId
    ? await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).limit(1)
    : customerId
      ? await db.select({ id: clients.id }).from(clients).where(eq(clients.stripeCustomerId, customerId)).limit(1)
      : [];
  if (!client) return;

  const [previous] = await db
    .select({
      billingStatus: clients.billingStatus,
      billingInterval: clients.billingInterval,
      stripeSubscriptionId: clients.stripeSubscriptionId,
      stripeSubscriptionItemId: clients.stripeSubscriptionItemId,
      currentPeriodEnd: clients.currentPeriodEnd,
      seatLimit: clients.seatLimit,
    })
    .from(clients)
    .where(eq(clients.id, client.id))
    .limit(1);
  const downgradeImpact = !isPaidTier(target.billingStatus) ? await previewDowngradeImpact(client.id) : null;
  const restoreImpact = isPaidTier(target.billingStatus) ? await impactFromPlanActions(client.id) : null;

  await convertClientPlan(client.id, target);
  const nextPeriodEnd = isPaidTier(target.billingStatus) ? subscriptionPeriodEnd(sub) : null;
  // On a paid webhook, Stripe is authoritative for the purchased capacity only after the relevant invoice
  // is paid. A seat increase first raises the Stripe quantity to create the proration invoice; subscription
  // webhooks can arrive before invoice.paid, so existing paid orgs keep their current seat_limit until the
  // paid invoice or explicit confirmation path settles it.
  const restoredUsedSeats = isPaidTier(target.billingStatus) ? await countActiveSeats(client.id) : 0;
  const stripeQuantity = firstItem?.quantity ?? 1;
  const latestInvoice = typeof sub.latest_invoice === "object" ? sub.latest_invoice as Stripe.Invoice | null : null;
  const invoicePaid = latestInvoice?.status === "paid";
  const unpaidExistingSeatIncrease = previous && isPaidTier(previous.billingStatus) && isPaidTier(target.billingStatus)
    && stripeQuantity > previous.seatLimit
    && !invoicePaid
    && notifications?.allowUnpaidSeatIncrease !== true;
  const nextSeatLimit = isPaidTier(target.billingStatus)
    ? unpaidExistingSeatIncrease
      ? previous!.seatLimit
      : Math.max(stripeQuantity, restoredUsedSeats)
    : undefined;
  await db
    .update(clients)
    .set({
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: isPaidTier(target.billingStatus) ? sub.id : null,
      stripeSubscriptionItemId: isPaidTier(target.billingStatus) ? (firstItem?.id ?? null) : null,
      billingInterval: interval,
      currentPeriodEnd: nextPeriodEnd,
      ...(nextSeatLimit !== undefined ? { seatLimit: nextSeatLimit } : {}),
      updatedAt: new Date(),
    })
    .where(eq(clients.id, client.id));
  if (isPaidTier(target.billingStatus) && !unpaidExistingSeatIncrease) await syncStripeSeatQuantity(client.id, config, { reconcileOnly: true });
  emitClientEntitlementsChanged(client.id);
  if (notifications?.mailer && previous) {
    await queueSubscriptionEmail({
      clientId: client.id,
      previous,
      target,
      sub,
      firstItem,
      interval,
      currentPeriodEnd: nextPeriodEnd,
      downgradeImpact,
      restoreImpact,
      mailer: notifications.mailer,
      eventId: notifications.eventId,
    });
  }
}

export async function handleStripeEvent(event: Stripe.Event, config: StripeEnv = env, mailer?: Mailer): Promise<void> {
  const [handled] = await db.select({ id: stripeEvents.id }).from(stripeEvents).where(eq(stripeEvents.id, event.id)).limit(1);
  if (handled) return;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      const clientId = session.client_reference_id ?? session.metadata?.clientId;
      if (clientId && typeof session.customer === "string") {
        await db.update(clients).set({ stripeCustomerId: session.customer, updatedAt: new Date() }).where(eq(clients.id, clientId));
      }
      if (subscriptionId) {
        await applySubscription(await stripe(config).subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] }), config, {
          mailer,
          eventId: event.id,
          allowUnpaidSeatIncrease: true,
        });
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      // Stripe events can arrive out of order, so subscription webhooks reconcile from the live
      // subscription where possible instead of trusting the event's frozen snapshot.
      if (subscription.status === "canceled") {
        await applySubscription(subscription, config, { mailer, eventId: event.id });
      } else {
        await applySubscription(await stripe(config).subscriptions.retrieve(subscription.id, { expand: ["latest_invoice"] }), config, { mailer, eventId: event.id });
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = subscriptionIdForInvoice(invoice);
      if (subscriptionId) {
        await applySubscription(await stripe(config).subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] }), config, { mailer, eventId: event.id });
      }
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = subscriptionIdForInvoice(invoice);
      if (subscriptionId) {
        await applySubscription(await stripe(config).subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] }), config, {
          mailer,
          eventId: event.id,
          allowUnpaidSeatIncrease: true,
        });
      }
      break;
    }
  }

  await db.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing();
  await cleanupStripeEvents();
}

async function queueSubscriptionEmail(params: {
  clientId: string;
  previous: {
    billingStatus: ClientBillingStatus;
    billingInterval: ClientBillingInterval | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionItemId: string | null;
    currentPeriodEnd: Date | null;
  };
  target: { plan: "free" | "paid"; billingStatus: ClientBillingStatus };
  sub: SubscriptionLike;
  firstItem: Stripe.SubscriptionItem | null;
  interval: ClientBillingInterval | null;
  currentPeriodEnd: Date | null;
  downgradeImpact: Awaited<ReturnType<typeof previewDowngradeImpact>> | null;
  restoreImpact: Awaited<ReturnType<typeof impactFromPlanActions>> | null;
  mailer: Mailer;
  eventId?: string;
}) {
  const wasPaid = isPaidTier(params.previous.billingStatus);
  const isPaid = isPaidTier(params.target.billingStatus);
  const periodEnd = subscriptionPeriodEnd(params.sub);
  const daysRemaining = periodEnd ? Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86_400_000)) : null;
  const quantity = params.firstItem?.quantity ?? null;
  const intervalLabel = params.interval === "annual" ? "annual" : params.interval === "monthly" ? "monthly" : null;
  const dedupeSuffix = params.eventId ?? `${params.sub.id}:${params.target.billingStatus}:${periodEnd?.toISOString() ?? "none"}`;

  if (!wasPaid && params.target.billingStatus === "active") {
    await sendHostedBillingEmail(params.mailer, {
      clientId: params.clientId,
      kind: "upgraded_to_pro",
      billingSummary: billingSummary(intervalLabel, quantity, periodEnd),
      impact: params.restoreImpact,
      dedupeKey: `upgraded_to_pro:${params.sub.id}:active`,
    });
    return;
  }

  if (wasPaid && !isPaid) {
    await sendHostedBillingEmail(params.mailer, {
      clientId: params.clientId,
      kind: "pro_cancelled",
      daysRemaining,
      trialEndsAt: periodEnd,
      impact: params.downgradeImpact,
      dedupeKey: `pro_cancelled:${dedupeSuffix}`,
    });
    return;
  }

  if (isPaid && params.sub.cancel_at_period_end) {
    await sendHostedBillingEmail(params.mailer, {
      clientId: params.clientId,
      kind: "pro_cancelled",
      daysRemaining,
      trialEndsAt: periodEnd,
      impact: await previewDowngradeImpact(params.clientId),
      dedupeKey: `pro_cancelled:${params.sub.id}:${periodEnd?.toISOString() ?? "period_end"}`,
    });
    return;
  }

  if (params.previous.billingStatus === "trialing" && params.target.billingStatus === "active") {
    // Trialing already counts as paid for entitlement purposes, so trial-to-active needs
    // its own branch before the generic paid-plan billing change email.
    await sendHostedBillingEmail(params.mailer, {
      clientId: params.clientId,
      kind: "welcome_to_pro",
      billingSummary: billingSummary(intervalLabel, quantity, periodEnd),
      impact: null,
      dedupeKey: `welcome_to_pro:${params.sub.id}:active`,
    });
    return;
  }

  const changed = params.previous.billingInterval !== params.interval
    || params.previous.stripeSubscriptionId !== params.sub.id
    || params.previous.stripeSubscriptionItemId !== params.firstItem?.id
    || params.previous.currentPeriodEnd?.getTime() !== params.currentPeriodEnd?.getTime();
  if (wasPaid && isPaid && changed) {
    await sendHostedBillingEmail(params.mailer, {
      clientId: params.clientId,
      kind: "billing_changed",
      billingSummary: billingSummary(intervalLabel, quantity, periodEnd),
      dedupeKey: `billing_changed:${dedupeSuffix}`,
      impact: null,
    });
  }
}

function billingSummary(interval: string | null, quantity: number | null, periodEnd: Date | null): string {
  const parts = [
    interval ? `billing interval: ${interval}` : null,
    quantity ? `${quantity} active seat${quantity === 1 ? "" : "s"}` : null,
    periodEnd ? `current period ends ${new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(periodEnd)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Stripe confirmed ${parts.join(", ")}.` : "Stripe confirmed a subscription change.";
}

export async function cleanupStripeEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STRIPE_EVENT_RETENTION_MS);
  const deleted = await db.delete(stripeEvents).where(lt(stripeEvents.createdAt, cutoff)).returning({ id: stripeEvents.id });
  return deleted.length;
}

export function constructStripeWebhookEvent(rawBody: string | Buffer | undefined, signature: string | undefined, config: StripeEnv = env): Stripe.Event {
  if (!config.STRIPE_WEBHOOK_SECRET) throw badRequest("Stripe webhook secret is not configured");
  if (!rawBody || !signature) throw badRequest("Invalid Stripe webhook");
  try {
    return stripe(config).webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw badRequest("Invalid Stripe webhook signature");
  }
}
