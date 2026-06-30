import "../../test/setup.integration.js";
import { boards, clients, emailQueue, planActions, stripeEvents, users, workspaces } from "@kanera/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { cleanupStripeEvents, handleStripeEvent, setStripeClientForTests, syncStripeSeatQuantity } from "../../lib/billing.js";
import { buildIntegrationServer } from "../../test/integration.js";

const periodEnd = 1_893_456_000;
type SignupResponse = { accessToken: string };

async function createClient(email: string, values: Partial<typeof clients.$inferInsert> = {}) {
  const [client] = await db
    .insert(clients)
    .values({ name: email, ...values })
    .returning({ id: clients.id });
  assert.ok(client);
  await db.insert(users).values({
    clientId: client.id,
    clientRole: "owner",
    email,
    passwordHash: "x",
    displayName: email,
  });
  return client.id;
}

async function createWorkspaceWithBoard(clientId: string, name: string, createdAt: Date) {
  const [workspace] = await db.insert(workspaces).values({ clientId, name, createdAt }).returning({ id: workspaces.id });
  assert.ok(workspace);
  await db.insert(boards).values({ workspaceId: workspace.id, name, position: "1000.0000000000", createdAt });
  return workspace.id;
}

function subscription(
  status: Stripe.Subscription.Status,
  options: {
    id?: string;
    clientId: string;
    customerId?: string;
    itemId?: string;
    periodEnd?: number;
    quantity?: number;
    priceId?: string;
  },
): Stripe.Subscription {
  return {
    id: options.id ?? "sub_test",
    object: "subscription",
    status,
    customer: options.customerId ?? "cus_test",
    metadata: { clientId: options.clientId },
    items: {
      object: "list",
      data: [
        {
          id: options.itemId ?? "si_test",
          object: "subscription_item",
          quantity: options.quantity ?? 1,
          current_period_end: options.periodEnd ?? periodEnd,
          price: { id: options.priceId ?? "price_monthly" },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function event(type: Stripe.Event.Type, object: unknown, id = `evt_${type.replaceAll(".", "_")}`): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2026-05-27.dahlia",
    created: 1,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as Stripe.Event;
}

function subscriptionInvoice(id: string, subscriptionRef: string | Pick<Stripe.Subscription, "id" | "object">): Stripe.Invoice {
  return {
    id,
    object: "invoice",
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: subscriptionRef },
    },
  } as unknown as Stripe.Invoice;
}

async function withHostedStripe<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    mode: env.KANERA_DEPLOYMENT_MODE,
    secret: env.STRIPE_SECRET_KEY,
    publishable: env.STRIPE_PUBLISHABLE_KEY,
    monthly: env.STRIPE_PRICE_ID_PRO_MONTHLY,
    annual: env.STRIPE_PRICE_ID_PRO_ANNUAL,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    maxBoards: env.HOSTED_FREE_MAX_BOARDS,
    maxMembers: env.HOSTED_FREE_MAX_ORG_MEMBERS,
  };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_fake";
  env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
  env.STRIPE_PRICE_ID_PRO_MONTHLY = "price_monthly";
  env.STRIPE_PRICE_ID_PRO_ANNUAL = "price_annual";
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  env.HOSTED_FREE_MAX_BOARDS = 1;
  env.HOSTED_FREE_MAX_ORG_MEMBERS = 1;
  try {
    return await fn();
  } finally {
    setStripeClientForTests(null);
    env.KANERA_DEPLOYMENT_MODE = prev.mode;
    env.STRIPE_SECRET_KEY = prev.secret;
    env.STRIPE_PUBLISHABLE_KEY = prev.publishable;
    env.STRIPE_PRICE_ID_PRO_MONTHLY = prev.monthly;
    env.STRIPE_PRICE_ID_PRO_ANNUAL = prev.annual;
    env.STRIPE_WEBHOOK_SECRET = prev.webhookSecret;
    env.HOSTED_FREE_MAX_BOARDS = prev.maxBoards;
    env.HOSTED_FREE_MAX_ORG_MEMBERS = prev.maxMembers;
  }
}

async function withSelfHosted<T>(fn: () => Promise<T>): Promise<T> {
  const previous = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous;
  }
}

async function signupOwner(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: email, email, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(res.statusCode, 200);
  return res.json<SignupResponse>().accessToken;
}

void test("self-hosted billing routes reject before Stripe handling", async () => {
  await withSelfHosted(async () => {
    const app = await buildIntegrationServer();
    const token = await signupOwner(app, "self-hosted-billing@example.com");
    const auth = { authorization: `Bearer ${token}` };

    for (const request of [
      { method: "GET" as const, url: "/billing/me", headers: auth },
      { method: "POST" as const, url: "/billing/checkout", headers: auth, payload: { interval: "monthly" } },
      { method: "POST" as const, url: "/billing/portal", headers: auth, payload: { intent: "home" } },
      {
        method: "POST" as const,
        url: "/billing/webhook",
        headers: { "content-type": "application/json", "stripe-signature": "invalid" },
        payload: "{}",
      },
    ]) {
      const res = await app.inject(request);
      assert.equal(res.statusCode, 400, `${request.method} ${request.url}: ${res.body}`);
      assert.equal(res.json<{ message: string }>().message, "billing is only available in hosted mode");
    }
  });
});

void test("hosted free billing summary exposes the Free member allowance as effective seats", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const token = await signupOwner(app, "free-seat-summary@example.com");
    const [ownerUser] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.email, "free-seat-summary@example.com")).limit(1);
    assert.ok(ownerUser);
    await db
      .update(clients)
      .set({ plan: "free", billingStatus: "none", seatLimit: 99 })
      .where(eq(clients.id, ownerUser.clientId));

    const summary = await app.inject({
      method: "GET",
      url: "/billing/me",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json<{ seatLimit: number }>().seatLimit, env.HOSTED_FREE_MAX_ORG_MEMBERS);
    assert.equal(summary.json<{ usedSeats: number }>().usedSeats, 1);
  });
});

void test("POST /billing/seats rejects trial capacity changes, invoices active increases, and rejects below usage", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const token = await signupOwner(app, "seat-capacity-owner@example.com");
    const auth = { authorization: `Bearer ${token}` };
    const [ownerUser] = await db.select({ clientId: users.clientId }).from(users).where(eq(users.email, "seat-capacity-owner@example.com")).limit(1);
    assert.ok(ownerUser);
    const clientId = ownerUser.clientId;

    // Trials are unlimited until checkout; there is no purchased capacity to adjust.
    let stripeCalled = false;
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => { stripeCalled = true; return { id: "si_seats", quantity: 5 }; },
        update: async () => { stripeCalled = true; return { id: "si_seats" }; },
      },
    } as unknown as Stripe);
    const trialBump = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 8 } });
    assert.equal(trialBump.statusCode, 400, trialBump.body);
    assert.equal(trialBump.json<{ message: string }>().message, "Seat capacity can only be changed for paid subscriptions");
    assert.equal(stripeCalled, false);

    await db
      .update(clients)
      .set({ plan: "free", billingStatus: "none", stripeSubscriptionId: "sub_stale", stripeSubscriptionItemId: "si_stale", seatLimit: 5 })
      .where(eq(clients.id, clientId));
    const freeBump = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 6 } });
    assert.equal(freeBump.statusCode, 400, freeBump.body);
    assert.equal(freeBump.json<{ message: string }>().message, "Seat capacity can only be changed for paid subscriptions");

    // Activate with a subscription item; an increase now invoices the prorated amount immediately.
    await db.update(clients).set({ plan: "paid", billingStatus: "active", stripeSubscriptionId: "sub_seats", stripeSubscriptionItemId: "si_seats" }).where(eq(clients.id, clientId));
    let updateQuantity: number | undefined;
    let payment: Stripe.SubscriptionItemUpdateParams.PaymentBehavior | undefined;
    let proration: Stripe.SubscriptionItemUpdateParams.ProrationBehavior | undefined;
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 8 }),
        update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => {
          updateQuantity = params.quantity ?? undefined;
          payment = params.payment_behavior;
          proration = params.proration_behavior;
          return { id: "si_seats" };
        },
      },
      // The proration invoice was paid immediately (no SCA), so the increase persists.
      subscriptions: { retrieve: async () => ({ id: "sub_seats", latest_invoice: { status: "paid" } }) },
    } as unknown as Stripe);
    const activeBump = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 10 } });
    assert.equal(activeBump.statusCode, 200, activeBump.body);
    assert.equal(activeBump.json<{ seatLimit: number }>().seatLimit, 10);
    assert.equal(updateQuantity, 10);
    // pending_if_incomplete holds the seat bump as a Stripe pending update until paid, so a failed/abandoned
    // payment can never put the existing subscription into dunning (and thus never cancels it).
    assert.equal(payment, "pending_if_incomplete");
    assert.equal(proration, "always_invoice");

    // If the proration charge needs the customer to act (3DS/SCA or a redirect wallet), the invoice stays
    // open and its confirmation_secret carries the PaymentIntent client_secret. Hand it back for in-app
    // confirmation and leave capacity untouched until paid.
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 10 }),
        update: async () => ({ id: "si_seats" }),
      },
      subscriptions: {
        retrieve: async () => ({
          id: "sub_seats",
          latest_invoice: { status: "open", confirmation_secret: { client_secret: "pi_seats_secret_123", type: "payment_intent" } },
        }),
      },
      // The premature /confirm below resolves the PaymentIntent from the confirmation secret; it is still
      // unconfirmed, so settlement must report the payment as incomplete.
      paymentIntents: { retrieve: async () => ({ id: "pi_seats", status: "requires_action" }) },
    } as unknown as Stripe);
    const actionRequired = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 11 } });
    assert.equal(actionRequired.statusCode, 200, actionRequired.body);
    const confirmation = actionRequired.json<{ paymentConfirmation?: { clientSecret: string; publishableKey: string } }>().paymentConfirmation;
    assert.equal(confirmation?.clientSecret, "pi_seats_secret_123");
    assert.equal(confirmation?.publishableKey, "pk_test_fake");
    const [afterAuthRequired] = await db.select({ seatLimit: clients.seatLimit }).from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(afterAuthRequired?.seatLimit, 10);

    const prematureConfirm = await app.inject({ method: "POST", url: "/billing/seats/confirm", headers: auth, payload: {} });
    assert.equal(prematureConfirm.statusCode, 402, prematureConfirm.body);
    assert.equal(prematureConfirm.json<{ code: string }>().code, "BILLING_PAYMENT_INCOMPLETE");

    let webhookSyncCalled = false;
    setStripeClientForTests({
      subscriptions: {
        retrieve: async () => ({
          ...subscription("active", { clientId, id: "sub_seats", itemId: "si_seats", quantity: 11 }),
          latest_invoice: { status: "open" },
        }),
      },
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 11 }),
        update: async () => {
          webhookSyncCalled = true;
          return { id: "si_seats" };
        },
      },
    } as unknown as Stripe);
    await handleStripeEvent(event("customer.subscription.updated", { id: "sub_seats", status: "active" }, "evt_pending_seat_update"));
    const [afterPendingWebhook] = await db.select({ seatLimit: clients.seatLimit }).from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(afterPendingWebhook?.seatLimit, 10);
    assert.equal(webhookSyncCalled, false, "pending payment webhook should not reconcile the in-flight Stripe quantity");

    // POST /billing/seats/confirm settles the increase once Stripe reports the proration invoice paid.
    setStripeClientForTests({
      subscriptions: {
        retrieve: async () => ({
          id: "sub_seats",
          items: { data: [{ id: "si_seats", quantity: 11 }] },
          latest_invoice: { status: "paid" },
        }),
      },
    } as unknown as Stripe);
    const settled = await app.inject({ method: "POST", url: "/billing/seats/confirm", headers: auth, payload: {} });
    assert.equal(settled.statusCode, 200, settled.body);
    assert.equal(settled.json<{ seatLimit: number }>().seatLimit, 11);
    const [afterSettle] = await db.select({ seatLimit: clients.seatLimit }).from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(afterSettle?.seatLimit, 11);

    // Settling off a succeeded PaymentIntent can race ahead of Stripe applying the pending update, so the
    // live item still shows the old quantity (11) while pending_update carries the new target (13). Settle
    // must resolve to the pending target, not the stale live quantity.
    setStripeClientForTests({
      subscriptions: {
        retrieve: async () => ({
          id: "sub_seats",
          items: { data: [{ id: "si_seats", quantity: 11 }] },
          pending_update: { subscription_items: [{ id: "si_seats", quantity: 13 }] },
          latest_invoice: { status: "open", confirmation_secret: { client_secret: "pi_pending_secret_xyz", type: "payment_intent" } },
        }),
      },
      paymentIntents: { retrieve: async () => ({ id: "pi_pending", status: "succeeded" }) },
    } as unknown as Stripe);
    const settledPending = await app.inject({ method: "POST", url: "/billing/seats/confirm", headers: auth, payload: {} });
    assert.equal(settledPending.statusCode, 200, settledPending.body);
    assert.equal(settledPending.json<{ seatLimit: number }>().seatLimit, 13);
    // Restore capacity so the scenarios below keep their starting seat_limit of 11.
    await db.update(clients).set({ seatLimit: 11 }).where(eq(clients.id, clientId));

    // No client_secret to confirm against (e.g. Stripe couldn't even start the charge) → route to the
    // payment-method portal so the admin can fix the method, and leave capacity untouched.
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 11 }),
        update: async () => ({ id: "si_seats" }),
      },
      subscriptions: {
        retrieve: async () => ({ id: "sub_seats", latest_invoice: { status: "open", confirmation_secret: null } }),
      },
    } as unknown as Stripe);
    const declined = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 12 } });
    assert.equal(declined.statusCode, 402, declined.body);
    assert.equal(declined.json<{ code: string }>().code, "BILLING_PAYMENT_ACTION_REQUIRED");
    assert.equal(declined.json<{ portalIntent: string }>().portalIntent, "payment_method");
    const [afterDecline] = await db.select({ seatLimit: clients.seatLimit }).from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(afterDecline?.seatLimit, 11);

    // Reduce back down so the reduction assertion below starts from a clean, higher capacity.
    await db.update(clients).set({ seatLimit: 10 }).where(eq(clients.id, clientId));

    updateQuantity = undefined;
    payment = undefined;
    proration = undefined;
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 10 }),
        update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => {
          updateQuantity = params.quantity ?? undefined;
          payment = params.payment_behavior;
          proration = params.proration_behavior;
          return { id: "si_seats" };
        },
      },
    } as unknown as Stripe);
    const activeReduction = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 9 } });
    assert.equal(activeReduction.statusCode, 200, activeReduction.body);
    assert.equal(updateQuantity, 9);
    assert.equal(payment, undefined);
    assert.equal(proration, "create_prorations");

    // Add a second member (used = 2). Reducing capacity below the assigned count is refused.
    await db.insert(users).values({ clientId, clientRole: "member", email: "seat-capacity-member@example.com", passwordHash: "x", displayName: "Member" });
    const tooLow = await app.inject({ method: "POST", url: "/billing/seats", headers: auth, payload: { seatLimit: 1 } });
    assert.equal(tooLow.statusCode, 402);
    assert.equal(tooLow.json<{ code: string }>().code, "SEAT_LIMIT_BELOW_USAGE");
  });
});

function setStripeSubscription(subscriptionForRetrieve: Stripe.Subscription, itemQuantity = 1) {
  let retrieveCount = 0;
  let updateCount = 0;
  setStripeClientForTests({
    subscriptions: {
      retrieve: async () => {
        retrieveCount += 1;
        return subscriptionForRetrieve;
      },
    },
    subscriptionItems: {
      retrieve: async () => ({ id: "si_test", quantity: itemQuantity }),
      update: async () => {
        updateCount += 1;
        return { id: "si_test" };
      },
    },
  } as unknown as Stripe);
  return {
    retrieveCount: () => retrieveCount,
    updateCount: () => updateCount,
  };
}

void test("Stripe webhook stores subscription item period end for trialing subscriptions", async () => {
  await withHostedStripe(async () => {
    const clientId = await createClient("stripe-trial@example.com");
    const sub = subscription("trialing", { clientId, periodEnd });
    const calls = setStripeSubscription(sub);

    await handleStripeEvent(event("customer.subscription.created", { id: sub.id }));

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(client?.plan, "paid");
    assert.equal(client?.billingStatus, "trialing");
    assert.equal(client?.currentPeriodEnd?.toISOString(), new Date(periodEnd * 1000).toISOString());
    assert.equal(calls.updateCount(), 0, "unchanged seat quantity does not create prorations");
  });
});

void test("Stripe checkout completion persists customer, applies subscription, queues email, and dedupes event ids", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const clientId = await createClient("stripe-checkout@example.com", { billingStatus: "none", plan: "free" });
    await db.insert(users).values({
      clientId,
      clientRole: "member",
      email: "stripe-checkout-seat@example.com",
      passwordHash: "x",
      displayName: "Checkout Seat",
    });
    const sub = subscription("active", { clientId, customerId: "cus_checkout", itemId: "si_checkout", priceId: "price_annual", quantity: 2 });
    const calls = setStripeSubscription(sub, 1);

    await handleStripeEvent(
      event("checkout.session.completed", {
        id: "cs_test",
        customer: "cus_checkout",
        subscription: "sub_test",
        client_reference_id: clientId,
        metadata: { clientId },
      }, "evt_checkout_completed"),
      env,
      app.mailer,
    );
    await handleStripeEvent(
      event("checkout.session.completed", {
        id: "cs_test",
        customer: "cus_checkout",
        subscription: "sub_test",
        client_reference_id: clientId,
      }, "evt_checkout_completed"),
      env,
      app.mailer,
    );

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(client?.plan, "paid");
    assert.equal(client?.billingStatus, "active");
    assert.equal(client?.stripeCustomerId, "cus_checkout");
    assert.equal(client?.stripeSubscriptionId, "sub_test");
    assert.equal(client?.stripeSubscriptionItemId, "si_checkout");
    assert.equal(client?.billingInterval, "annual");
    assert.equal(calls.retrieveCount(), 1);
    assert.equal(calls.updateCount(), 1);
    assert.equal(await db.$count(stripeEvents, eq(stripeEvents.id, "evt_checkout_completed")), 1);
    assert.equal(await db.$count(emailQueue, eq(emailQueue.type, "upgraded_to_pro")), 1);
  });
});

void test("Stripe checkout completion is a no-op for unknown clients but still records the event", async () => {
  await withHostedStripe(async () => {
    setStripeSubscription(subscription("active", { clientId: "00000000-0000-0000-0000-000000000001" }));

    await handleStripeEvent(
      event("checkout.session.completed", {
        customer: "cus_unknown",
        subscription: "sub_unknown",
        client_reference_id: "00000000-0000-0000-0000-000000000001",
      }, "evt_checkout_unknown"),
    );

    assert.equal(await db.$count(stripeEvents, eq(stripeEvents.id, "evt_checkout_unknown")), 1);
    assert.equal(await db.$count(clients, eq(clients.stripeCustomerId, "cus_unknown")), 0);
  });
});

void test("Stripe payment_failed keeps paid access during dunning", async () => {
  await withHostedStripe(async () => {
    const clientId = await createClient("stripe-dunning@example.com", {
      plan: "paid",
      billingStatus: "active",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      stripeSubscriptionItemId: "si_test",
      currentPeriodEnd: new Date(periodEnd * 1000),
    });
    await createWorkspaceWithBoard(clientId, "First", new Date("2026-01-01T00:00:00.000Z"));
    await createWorkspaceWithBoard(clientId, "Second", new Date("2026-01-02T00:00:00.000Z"));
    setStripeSubscription(subscription("past_due", { clientId }));

    await handleStripeEvent(
      event("invoice.payment_failed", subscriptionInvoice("in_failed", "sub_test"), "evt_payment_failed"),
    );

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(client?.plan, "paid");
    assert.equal(client?.billingStatus, "past_due");
    assert.equal(await db.$count(workspaces, and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt))), 2);
  });
});

void test("Stripe invoice paid recovers from dunning and active updates restore previous downgrade actions", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const clientId = await createClient("stripe-recovery@example.com", {
      plan: "paid",
      billingStatus: "past_due",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      stripeSubscriptionItemId: "si_test",
    });
    const [suspended] = await db.insert(users).values({
      clientId,
      clientRole: "member",
      email: "stripe-recovery-suspended@example.com",
      passwordHash: "x",
      displayName: "Suspended",
      suspendedAt: new Date(),
    }).returning({ id: users.id });
    await db.insert(planActions).values({ clientId, kind: "user_suspended", payload: { userId: suspended!.id } });
    setStripeSubscription(subscription("active", { clientId, priceId: "price_monthly" }));

    await handleStripeEvent(event("invoice.paid", subscriptionInvoice("in_paid", "sub_test"), "evt_invoice_paid"), env, app.mailer);

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(client?.plan, "paid");
    assert.equal(client?.billingStatus, "active");
    assert.equal(client?.billingInterval, "monthly");
    assert.equal(await db.$count(planActions, eq(planActions.clientId, clientId)), 0);
    assert.equal(await db.$count(emailQueue, eq(emailQueue.type, "billing_changed")), 1);
  });
});

void test("Stripe invoice webhooks accept expanded parent subscription references", async () => {
  await withHostedStripe(async () => {
    const clientId = await createClient("stripe-expanded-invoice@example.com", {
      plan: "paid",
      billingStatus: "past_due",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      stripeSubscriptionItemId: "si_test",
    });
    let retrievedSubscriptionId: string | undefined;
    setStripeClientForTests({
      subscriptions: {
        retrieve: async (id: string) => {
          retrievedSubscriptionId = id;
          return subscription("active", { clientId, id, priceId: "price_monthly" });
        },
      },
      subscriptionItems: {
        retrieve: async () => ({ id: "si_test", quantity: 1 }),
        update: async () => ({ id: "si_test" }),
      },
    } as unknown as Stripe);

    await handleStripeEvent(
      event("invoice.paid", subscriptionInvoice("in_expanded", { id: "sub_test", object: "subscription" }), "evt_invoice_expanded_subscription"),
    );

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(retrievedSubscriptionId, "sub_test");
    assert.equal(client?.billingStatus, "active");
  });
});

void test("Stripe subscription deleted downgrades and clears stale subscription ids", async () => {
  await withHostedStripe(async () => {
    const clientId = await createClient("stripe-cancel@example.com", {
      plan: "paid",
      billingStatus: "active",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      stripeSubscriptionItemId: "si_test",
      currentPeriodEnd: new Date(periodEnd * 1000),
    });
    await createWorkspaceWithBoard(clientId, "First", new Date("2026-01-01T00:00:00.000Z"));
    await createWorkspaceWithBoard(clientId, "Second", new Date("2026-01-02T00:00:00.000Z"));

    await handleStripeEvent(event("customer.subscription.deleted", subscription("canceled", { clientId }), "evt_deleted"));

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(client?.plan, "free");
    assert.equal(client?.billingStatus, "canceled");
    assert.equal(client?.stripeSubscriptionId, null);
    assert.equal(client?.stripeSubscriptionItemId, null);
    assert.equal(client?.currentPeriodEnd, null);
    assert.equal(await db.$count(workspaces, and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt))), 2);
  });
});

void test("Stripe terminal subscription statuses downgrade to free and active/incomplete statuses map as expected", async () => {
  await withHostedStripe(async () => {
    const terminalStatuses: Stripe.Subscription.Status[] = ["unpaid", "incomplete_expired", "paused"];
    for (const status of terminalStatuses) {
      const clientId = await createClient(`stripe-${status}@example.com`, {
        plan: "paid",
        billingStatus: "active",
        stripeCustomerId: `cus_${status}`,
        stripeSubscriptionId: `sub_${status}`,
        stripeSubscriptionItemId: `si_${status}`,
      });
      setStripeSubscription(subscription(status, { clientId, id: `sub_${status}`, customerId: `cus_${status}` }));
      await handleStripeEvent(event("customer.subscription.updated", subscription(status, { clientId, id: `sub_${status}` }), `evt_${status}`));
      const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
      assert.equal(client?.plan, "free");
      assert.equal(client?.billingStatus, "canceled");
      assert.equal(client?.stripeSubscriptionId, null);
    }

    const incompleteClientId = await createClient("stripe-incomplete@example.com", { plan: "free", billingStatus: "none" });
    setStripeSubscription(subscription("incomplete", { clientId: incompleteClientId }));
    await handleStripeEvent(event("customer.subscription.updated", subscription("incomplete", { clientId: incompleteClientId }), "evt_incomplete"));
    const [incomplete] = await db.select().from(clients).where(eq(clients.id, incompleteClientId)).limit(1);
    assert.equal(incomplete?.plan, "paid");
    assert.equal(incomplete?.billingStatus, "past_due");
  });
});

void test("Stripe subscription interval detection handles annual and unknown prices", async () => {
  await withHostedStripe(async () => {
    const annualClient = await createClient("stripe-annual@example.com");
    setStripeSubscription(subscription("active", { clientId: annualClient, priceId: "price_annual" }));
    await handleStripeEvent(event("customer.subscription.updated", subscription("active", { clientId: annualClient }), "evt_annual"));
    const [annual] = await db.select().from(clients).where(eq(clients.id, annualClient)).limit(1);
    assert.equal(annual?.billingInterval, "annual");

    const unknownClient = await createClient("stripe-unknown-price@example.com");
    setStripeSubscription(subscription("active", { clientId: unknownClient, priceId: "price_enterprise" }));
    await handleStripeEvent(event("customer.subscription.updated", subscription("active", { clientId: unknownClient }), "evt_unknown_price"));
    const [unknown] = await db.select().from(clients).where(eq(clients.id, unknownClient)).limit(1);
    assert.equal(unknown?.billingInterval, null);
  });
});

void test("Stripe subscription updates reconcile against live state and processed event ids", async () => {
  await withHostedStripe(async () => {
    const clientId = await createClient("stripe-ordering@example.com", {
      plan: "paid",
      billingStatus: "active",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      stripeSubscriptionItemId: "si_test",
    });
    const calls = setStripeSubscription(subscription("canceled", { clientId }));

    const staleActiveSnapshot = subscription("active", { clientId });
    await handleStripeEvent(event("customer.subscription.updated", staleActiveSnapshot, "evt_out_of_order"));
    await handleStripeEvent(event("customer.subscription.updated", staleActiveSnapshot, "evt_out_of_order"));

    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    assert.equal(client?.plan, "free");
    assert.equal(client?.billingStatus, "canceled");
    assert.equal(calls.retrieveCount(), 1);
    assert.equal(await db.$count(stripeEvents, eq(stripeEvents.id, "evt_out_of_order")), 1);
  });
});

void test("Stripe seat quantity sync targets the purchased seat_limit on hosted paid subscriptions", async () => {
  await withHostedStripe(async () => {
    // Quantity is now driven by the purchased seat_limit, NOT by live headcount. The pool here is 3.
    const paidClient = await createClient("stripe-seat-sync@example.com", {
      billingStatus: "active",
      stripeSubscriptionItemId: "si_seats",
      seatLimit: 3,
    });
    let quantity: number | undefined;
    let paymentBehavior: Stripe.SubscriptionItemUpdateParams.PaymentBehavior | undefined;
    let prorationBehavior: Stripe.SubscriptionItemUpdateParams.ProrationBehavior | undefined;
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 1 }),
        update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => {
          quantity = params.quantity ?? undefined;
          paymentBehavior = params.payment_behavior;
          prorationBehavior = params.proration_behavior;
          return { id: "si_seats" };
        },
      },
    } as unknown as Stripe);
    await syncStripeSeatQuantity(paidClient);
    assert.equal(quantity, 3);
    assert.equal(paymentBehavior, "error_if_incomplete");
    assert.equal(prorationBehavior, "always_invoice");

    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 1 }),
        update: async () => {
          const err = new Error("Payment for this subscription requires additional user action.") as Error & { type: string; raw: { type: string; code: string } };
          err.type = "StripeCardError";
          err.raw = { type: "card_error", code: "subscription_payment_intent_requires_action" };
          throw err;
        },
      },
    } as unknown as Stripe);
    await assert.rejects(
      () => syncStripeSeatQuantity(paidClient),
      (err: unknown) => (err as { code?: string }).code === "BILLING_PAYMENT_ACTION_REQUIRED",
    );

    // reconcileOnly must repair drift without a surprise mid-cycle invoice.
    quantity = undefined;
    paymentBehavior = undefined;
    prorationBehavior = undefined;
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_seats", quantity: 1 }),
        update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => {
          quantity = params.quantity ?? undefined;
          paymentBehavior = params.payment_behavior;
          prorationBehavior = params.proration_behavior;
          return { id: "si_seats" };
        },
      },
    } as unknown as Stripe);
    await syncStripeSeatQuantity(paidClient, env, { reconcileOnly: true });
    assert.equal(quantity, 3);
    assert.equal(paymentBehavior, undefined);
    assert.equal(prorationBehavior, "none");

    quantity = undefined;
    const freeClient = await createClient("stripe-seat-free@example.com", { billingStatus: "none", stripeSubscriptionItemId: "si_free", seatLimit: 5 });
    await syncStripeSeatQuantity(freeClient);
    assert.equal(quantity, undefined);

    const noItemClient = await createClient("stripe-seat-no-item@example.com", { billingStatus: "active" });
    await syncStripeSeatQuantity(noItemClient);
    assert.equal(quantity, undefined);
  });

  const clientId = await createClient("stripe-seat-selfhosted@example.com", { billingStatus: "active", stripeSubscriptionItemId: "si_selfhosted" });
  await syncStripeSeatQuantity(clientId);
});

void test("billing webhook route validates signature configuration and passes raw bodies to Stripe", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const clientId = await createClient("stripe-route@example.com");
    const sub = subscription("active", { clientId });
    let sawRawBody = false;
    setStripeClientForTests({
      webhooks: {
        constructEvent: (rawBody: string | Buffer | undefined, signature: string | undefined, secret: string) => {
          sawRawBody = Buffer.isBuffer(rawBody) || typeof rawBody === "string";
          assert.equal(signature, "sig_valid");
          assert.equal(secret, "whsec_test");
          return event("customer.subscription.created", sub, "evt_route_valid");
        },
      },
      subscriptions: { retrieve: async () => sub },
      subscriptionItems: {
        retrieve: async () => ({ id: "si_test", quantity: 1 }),
        update: async () => ({ id: "si_test" }),
      },
    } as unknown as Stripe);

    const missingSignature = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(missingSignature.statusCode, 400);

    const valid = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "stripe-signature": "sig_valid", "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_route_valid" }),
    });
    assert.equal(valid.statusCode, 200);
    assert.equal(sawRawBody, true);
    assert.equal(await db.$count(stripeEvents, eq(stripeEvents.id, "evt_route_valid")), 1);

    setStripeClientForTests({
      webhooks: {
        constructEvent: () => {
          throw new Error("bad signature");
        },
      },
    } as unknown as Stripe);
    const invalid = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "stripe-signature": "sig_bad", "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(invalid.statusCode, 400);
  });

  await withHostedStripe(async () => {
    const prevSecret = env.STRIPE_WEBHOOK_SECRET;
    env.STRIPE_WEBHOOK_SECRET = "";
    try {
      const app = await buildIntegrationServer();
      const missingSecret = await app.inject({
        method: "POST",
        url: "/billing/webhook",
        headers: { "stripe-signature": "sig_any", "content-type": "application/json" },
        payload: "{}",
      });
      assert.equal(missingSecret.statusCode, 400);
    } finally {
      env.STRIPE_WEBHOOK_SECRET = prevSecret;
    }
  });
});

void test("Stripe event cleanup purges old dedup rows only", async () => {
  await db.insert(stripeEvents).values([
    { id: "evt_old", type: "customer.subscription.updated", createdAt: new Date("2026-04-01T00:00:00.000Z") },
    { id: "evt_recent", type: "customer.subscription.updated", createdAt: new Date("2026-05-20T00:00:00.000Z") },
  ]);

  const deleted = await cleanupStripeEvents(new Date("2026-06-06T00:00:00.000Z"));

  assert.equal(deleted, 1);
  assert.equal(await db.$count(stripeEvents, eq(stripeEvents.id, "evt_old")), 0);
  assert.equal(await db.$count(stripeEvents, eq(stripeEvents.id, "evt_recent")), 1);
});
