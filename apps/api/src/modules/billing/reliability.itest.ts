import "../../test/setup.integration.js";
import "../../test/integration.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { clients, stripeEvents } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { createCheckoutSession, handleStripeEvent, reconcileStripeSubscription, setSeatCapacity, setStripeClientForTests } from "../../lib/billing.js";

// These regressions require exact Stripe response ordering, ambiguous network failures, and a failure
// mid-transaction. Browser E2E cannot reliably force those provider/DB interleavings.
const original = { ...env };
beforeEach(() => {
  Object.assign(env, { KANERA_DEPLOYMENT_MODE: "hosted", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_PUBLISHABLE_KEY: "pk_test_fake", STRIPE_PRICE_ID_PRO_MONTHLY: "price_monthly", STRIPE_PRICE_ID_PRO_ANNUAL: "price_annual" });
});
afterEach(() => { setStripeClientForTests(null); Object.assign(env, original); });

async function org() {
  const [row] = await db.insert(clients).values({ name: "Billing reliability", plan: "paid", billingStatus: "active", stripeCustomerId: "cus_review", stripeSubscriptionId: "sub_review", stripeSubscriptionItemId: "si_review", seatLimit: 5 }).returning();
  return row!;
}
function subscription(clientId: string, quantity: number, invoiceStatus = "paid"): Stripe.Subscription {
  return { id: "sub_review", customer: "cus_review", status: "active", metadata: { clientId }, cancel_at_period_end: false, latest_invoice: { status: invoiceStatus }, items: { data: [{ id: "si_review", quantity, current_period_end: 1893456000, price: { id: "price_monthly" } }] } } as unknown as Stripe.Subscription;
}
function event(id: string, object: Stripe.Subscription): Stripe.Event {
  return { id, type: "customer.subscription.updated", data: { object } } as Stripe.Event;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}
function list<T>(data: T[]) {
  return Object.assign(Promise.resolve({ data }), { async *[Symbol.asyncIterator]() { yield* data; } });
}

void test("a stale webhook read cannot undo a paid seat purchase committed while the read was in flight", async () => {
  const client = await org();
  let quantity = 5;
  let reads = 0;
  const entered = deferred();
  const release = deferred();
  const writes: Stripe.SubscriptionItemUpdateParams[] = [];
  setStripeClientForTests({
    subscriptions: { retrieve: async () => {
      const snapshot = subscription(client.id, quantity);
      if (++reads === 1) { entered.resolve(); await release.promise; }
      return snapshot;
    } },
    subscriptionItems: {
      retrieve: async () => ({ id: "si_review", quantity }),
      update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => { writes.push(params); quantity = params.quantity!; return { id: "si_review", quantity }; },
    },
  } as unknown as Stripe);
  const webhook = handleStripeEvent(event("evt_race", subscription(client.id, 5)));
  try {
    await entered.promise;
    assert.equal((await setSeatCapacity(client.id, 10)).status, "applied");
  } finally { release.resolve(); }
  await webhook;
  const [after] = await db.select().from(clients).where(eq(clients.id, client.id));
  assert.equal(after!.seatLimit, 10);
  assert.equal(quantity, 10);
  assert.deepEqual(writes.map(x => [x.quantity, x.proration_behavior]), [[10, "always_invoice"]]);
});

void test("reconciliation adopts paid Stripe capacity and leaves an unpaid pending increase unprovisioned", async () => {
  const client = await org();
  let live = subscription(client.id, 10);
  setStripeClientForTests({ subscriptions: { retrieve: async () => live } } as unknown as Stripe);
  // No subscriptionItems.update stub: any attempt to overwrite Stripe instead of reading it fails.
  await reconcileStripeSubscription(client.id);
  let [after] = await db.select().from(clients).where(eq(clients.id, client.id));
  assert.equal(after!.seatLimit, 10);
  live = { ...subscription(client.id, 10, "open"), pending_update: { subscription_items: [{ id: "si_review", quantity: 15 }] } } as Stripe.Subscription;
  await reconcileStripeSubscription(client.id);
  [after] = await db.select().from(clients).where(eq(clients.id, client.id));
  assert.equal(after!.seatLimit, 10);
  // /seats/confirm may already have observed a succeeded PaymentIntent before Stripe promotes it.
  await db.update(clients).set({ seatLimit: 15 }).where(eq(clients.id, client.id));
  await reconcileStripeSubscription(client.id);
  [after] = await db.select().from(clients).where(eq(clients.id, client.id));
  assert.equal(after!.seatLimit, 15);
});

void test("webhook failure rolls back the processing claim and plan writes so redelivery can finish", async () => {
  const client = await org();
  await db.update(clients).set({ plan: "free", billingStatus: "none", seatLimit: 1 }).where(eq(clients.id, client.id));
  for (const i of [1, 2]) await insertTestUsers(db, { clientId: client.id, clientRole: i === 1 ? "owner" : "member", email: `rollback-${i}@example.test`, passwordHash: "x", displayName: "Member" });
  let fail = true;
  let updates = 0;
  setStripeClientForTests({
    subscriptions: { retrieve: async () => subscription(client.id, 1) },
    subscriptionItems: {
      retrieve: async () => { if (fail) throw new Error("injected failure after plan update"); return { quantity: 1 }; },
      update: async () => { updates++; return { id: "si_review", quantity: 2 }; },
    },
  } as unknown as Stripe);
  const delivery = event("evt_interrupted", subscription(client.id, 1));
  await assert.rejects(handleStripeEvent(delivery), /injected failure/);
  assert.equal(await db.$count(stripeEvents), 0);
  const [rolledBack] = await db.select().from(clients).where(eq(clients.id, client.id));
  assert.equal(rolledBack!.plan, "free");
  assert.equal(rolledBack!.seatLimit, 1);
  fail = false;
  await Promise.all([handleStripeEvent(delivery), handleStripeEvent(delivery)]);
  const [completed] = await db.select().from(clients).where(eq(clients.id, client.id));
  assert.equal(completed!.plan, "paid");
  assert.equal(completed!.seatLimit, 2);
  assert.equal(updates, 1);
  assert.equal(await db.$count(stripeEvents), 1);
});

void test("concurrent Checkout requests share one customer/session and completed subscriptions go to the portal", async () => {
  const client = await org();
  await db.update(clients).set({ stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionItemId: null, plan: "free", billingStatus: "none" }).where(eq(clients.id, client.id));
  let customers = 0;
  let sessionsCreated = 0;
  let active = false;
  const sessions: Stripe.Checkout.Session[] = [];
  const keys: string[] = [];
  setStripeClientForTests({
    customers: { create: async (_params: unknown, opts: Stripe.RequestOptions) => { customers++; assert.equal(opts.idempotencyKey, `billing-customer:${client.id}`); return { id: "cus_review" }; } },
    subscriptions: { list: () => list(active ? [subscription(client.id, 5)] : []) },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.test/existing" }) } },
    checkout: { sessions: {
      list: (params: Stripe.Checkout.SessionListParams) => list(params.status === "open" ? sessions.filter(s => s.status === "open") : sessions.slice(-1)),
      expire: async (id: string) => { sessions.find(s => s.id === id)!.status = "expired"; },
      create: async (params: Stripe.Checkout.SessionCreateParams, opts: Stripe.RequestOptions) => {
        keys.push(opts.idempotencyKey!);
        const session = { id: `cs_${++sessionsCreated}`, mode: "subscription", status: "open", metadata: params.metadata, url: `https://checkout.test/${sessionsCreated}` } as Stripe.Checkout.Session;
        sessions.push(session);
        return session;
      },
    } },
  } as unknown as Stripe);
  const [a, b] = await Promise.all([createCheckoutSession(client.id, "owner@example.test", "monthly", 5), createCheckoutSession(client.id, "owner@example.test", "monthly", 5)]);
  assert.deepEqual(a, b);
  assert.equal(customers, 1);
  assert.equal(sessionsCreated, 1);
  await createCheckoutSession(client.id, "owner@example.test", "annual", 7);
  assert.equal(sessions[0]!.status, "expired");
  assert.equal(sessionsCreated, 2);
  assert.notEqual(keys[0], keys[1]);
  active = true; // Payment completed; Kanera's webhook has not arrived yet.
  const next = await createCheckoutSession(client.id, "owner@example.test", "monthly", 5);
  assert.equal(next.url, "https://billing.test/existing");
  assert.equal(sessionsCreated, 2);
});

void test("Checkout retries recover a session created before an ambiguous network failure", async () => {
  const client = await org();
  let created = 0;
  let saved: Stripe.Checkout.Session | undefined;
  setStripeClientForTests({
    subscriptions: { list: () => list([]) },
    checkout: { sessions: {
      list: () => list(saved ? [saved] : []),
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        created++;
        saved = { id: "cs_ambiguous", mode: "subscription", status: "open", metadata: params.metadata, url: "https://checkout.test/recovered" } as Stripe.Checkout.Session;
        throw new Error("network response lost");
      },
    } },
  } as unknown as Stripe);
  await assert.rejects(createCheckoutSession(client.id, "owner@example.test", "monthly", 5), /response lost/);
  assert.equal((await createCheckoutSession(client.id, "owner@example.test", "monthly", 5)).url, saved!.url);
  assert.equal(created, 1);
});

void test("seat reduction credits only a paid invoice even when local dunning status is stale", async () => {
  const client = await org();
  let paid = false;
  const writes: Stripe.SubscriptionItemUpdateParams[] = [];
  setStripeClientForTests({
    subscriptions: { retrieve: async () => subscription(client.id, 5, paid ? "paid" : "open") },
    subscriptionItems: { update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => { writes.push(params); return { id: "si_review" }; } },
  } as unknown as Stripe);
  await setSeatCapacity(client.id, 3);
  assert.equal(writes[0]!.proration_behavior, "none");
  await db.update(clients).set({ billingStatus: "past_due" }).where(eq(clients.id, client.id));
  paid = true;
  await setSeatCapacity(client.id, 2);
  assert.equal(writes[1]!.proration_behavior, "create_prorations");
});
