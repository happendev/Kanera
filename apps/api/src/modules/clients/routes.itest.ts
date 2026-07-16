import "../../test/setup.integration.js";
import { activityEvents, boardMembers, boardWatchers, boards, cardAssignees, cardChecklistItems, cardChecklists, cardMentions, cards, cardWatchers, clientGuestSeats, clients, directRealtimeOutbox, eventOutbox, lists, notifications, refreshTokens, standaloneBoardGroups, SYSTEM_CONFIG_ROW_ID, systemConfigs, users, workspaceApiKeys, workspaceMembers, workspaces } from "@kanera/shared/schema";
import type { ServerToClientEvents } from "@kanera/shared/events";
import { and, asc, eq, sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { hashRefresh } from "../../auth/jwt.js";
import { hashPassword } from "../../auth/password.js";
import { setStripeClientForTests } from "../../lib/billing.js";
import { buildIntegrationServer } from "../../test/integration.js";

async function signupOwner(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string, orgName: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName,
      email,
      password: "Abc12345",
      displayName: orgName,
    },
  });

  assert.equal(signup.statusCode, 200);
  const body = signup.json() as {
    accessToken: string;
    user: { id: string; clientId: string; email: string; displayName: string; deploymentMode: "self_hosted" | "hosted" };
  };
  assert.equal(body.user.deploymentMode, env.KANERA_DEPLOYMENT_MODE);
  return body;
}

async function signupOrgMember(app: Awaited<ReturnType<typeof buildIntegrationServer>>, clientId: string, email: string) {
  await db.insert(users).values({
    clientId,
    clientRole: "member",
    email,
    passwordHash: await hashPassword("Abc12345"),
    displayName: "Billing Member",
  });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email,
      password: "Abc12345",
    },
  });
  assert.equal(login.statusCode, 200);
  return login.json() as { accessToken: string };
}

async function insertOrgUser(
  clientId: string,
  email: string,
  role: "owner" | "admin" | "member" = "member",
  values: Partial<typeof users.$inferInsert> = {},
) {
  const [user] = await db
    .insert(users)
    .values({
      clientId,
      clientRole: role,
      email,
      passwordHash: await hashPassword("Abc12345"),
      displayName: email,
      ...values,
    })
    .returning();
  return user!;
}

async function withHostedMode<T>(fn: () => Promise<T>): Promise<T> {
  const prev = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = prev;
  }
}

async function withHostedStripe<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    mode: env.KANERA_DEPLOYMENT_MODE,
    secret: env.STRIPE_SECRET_KEY,
    monthly: env.STRIPE_PRICE_ID_PRO_MONTHLY,
    annual: env.STRIPE_PRICE_ID_PRO_ANNUAL,
  };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_fake";
  env.STRIPE_PRICE_ID_PRO_MONTHLY = "price_monthly";
  env.STRIPE_PRICE_ID_PRO_ANNUAL = "price_annual";
  try {
    return await fn();
  } finally {
    setStripeClientForTests(null);
    env.KANERA_DEPLOYMENT_MODE = prev.mode;
    env.STRIPE_SECRET_KEY = prev.secret;
    env.STRIPE_PRICE_ID_PRO_MONTHLY = prev.monthly;
    env.STRIPE_PRICE_ID_PRO_ANNUAL = prev.annual;
  }
}

async function waitForBoardOutboxEvent(boardId: string, eventType: keyof ServerToClientEvents) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await db
      .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.boardId, boardId), eq(eventOutbox.eventType, eventType)))
      .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db
    .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
    .from(eventOutbox)
    .where(and(eq(eventOutbox.boardId, boardId), eq(eventOutbox.eventType, eventType)))
    .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
}

async function waitForUserDirectOutboxEvent(userId: string, eventType: keyof ServerToClientEvents) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await db
      .select({ eventType: directRealtimeOutbox.eventType, payload: directRealtimeOutbox.payload })
      .from(directRealtimeOutbox)
      .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, userId), eq(directRealtimeOutbox.eventType, eventType)));
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db
    .select({ eventType: directRealtimeOutbox.eventType, payload: directRealtimeOutbox.payload })
    .from(directRealtimeOutbox)
    .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, userId), eq(directRealtimeOutbox.eventType, eventType)));
}

void test("standalone board group names create, reuse, and remove implicit groups with tenant-safe board assignment", async () => {
  const app = await buildIntegrationServer();
  try {
    const owner = await signupOwner(app, "standalone-groups-owner@example.com", "Grouped Org");
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    const member = await signupOrgMember(app, owner.user.clientId, "standalone-groups-member@example.com");
    const [standaloneWorkspace, standardWorkspace] = await db.insert(workspaces).values([
      { clientId: owner.user.clientId, name: "Solo config", kind: "board" },
      { clientId: owner.user.clientId, name: "Team", kind: "standard" },
    ]).returning();
    const [standaloneBoard, standardBoard] = await db.insert(boards).values([
      { workspaceId: standaloneWorkspace!.id, name: "Solo", position: "1000" },
      { workspaceId: standardWorkspace!.id, name: "Team board", position: "1000" },
    ]).returning();

    const denied = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${standaloneBoard!.id}/group`, headers: { authorization: `Bearer ${member.accessToken}` }, payload: { groupTitle: "Nope" } });
    assert.equal(denied.statusCode, 403);

    const standardRejected = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${standardBoard!.id}/group`, headers: auth, payload: { groupTitle: "Product" } });
    assert.equal(standardRejected.statusCode, 400);

    const other = await signupOwner(app, "standalone-groups-other@example.com", "Other Org");
    const crossTenantRejected = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${standaloneBoard!.id}/group`, headers: { authorization: `Bearer ${other.accessToken}` }, payload: { groupTitle: "Product" } });
    assert.equal(crossTenantRejected.statusCode, 404);

    const assigned = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${standaloneBoard!.id}/group`, headers: auth, payload: { groupTitle: "  Product  " } });
    assert.equal(assigned.statusCode, 200);
    const createdGroupId = assigned.json<{ standaloneGroupId: string | null }>().standaloneGroupId!;
    const [created] = await db.select().from(standaloneBoardGroups).where(eq(standaloneBoardGroups.id, createdGroupId));
    assert.equal(created?.title, "Product");
    const boardEvents = await waitForBoardOutboxEvent(standaloneBoard!.id, "board:updated");
    assert.ok(boardEvents.some((row) => (row.payload as { board?: { standaloneGroupId?: string } }).board?.standaloneGroupId === createdGroupId));

    const memberClaims = app.jwt.verify<{ sub: string }>(member.accessToken);
    await db.insert(workspaceMembers).values({ workspaceId: standaloneWorkspace!.id, userId: memberClaims.sub, role: "member" });
    await db.insert(boardMembers).values({ boardId: standaloneBoard!.id, userId: memberClaims.sub, role: "editor" });
    await db.insert(standaloneBoardGroups).values({ clientId: owner.user.clientId, title: "Empty" });
    const memberHome = await app.inject({ method: "GET", url: "/home/boards", headers: { authorization: `Bearer ${member.accessToken}` } });
    assert.equal(memberHome.statusCode, 200);
    const memberHomeBody = memberHome.json<{ standaloneBoardGroups: Array<{ id: string; title: string }> }>();
    assert.deepEqual(memberHomeBody.standaloneBoardGroups.map((group) => group.id), [createdGroupId]);

    const [secondWorkspace] = await db.insert(workspaces).values({ clientId: owner.user.clientId, name: "Second solo config", kind: "board" }).returning();
    const [secondBoard] = await db.insert(boards).values({ workspaceId: secondWorkspace!.id, name: "Second solo", position: "1000" }).returning();
    const reused = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${secondBoard!.id}/group`, headers: auth, payload: { groupTitle: "product" } });
    assert.equal(reused.statusCode, 200);
    assert.equal(reused.json<{ standaloneGroupId: string | null }>().standaloneGroupId, createdGroupId);
    assert.equal(await db.$count(standaloneBoardGroups, and(eq(standaloneBoardGroups.clientId, owner.user.clientId), sql`lower(${standaloneBoardGroups.title}) = 'product'`)), 1);

    const firstUngrouped = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${standaloneBoard!.id}/group`, headers: auth, payload: { groupTitle: null } });
    assert.equal(firstUngrouped.statusCode, 200);
    assert.equal(await db.$count(standaloneBoardGroups, eq(standaloneBoardGroups.id, createdGroupId)), 1);
    const secondUngrouped = await app.inject({ method: "PATCH", url: `/clients/me/standalone-boards/${secondBoard!.id}/group`, headers: auth, payload: { groupTitle: null } });
    assert.equal(secondUngrouped.statusCode, 200);
    assert.equal(await db.$count(standaloneBoardGroups, eq(standaloneBoardGroups.id, createdGroupId)), 0);
    const [preserved] = await db.select({ standaloneGroupId: boards.standaloneGroupId }).from(boards).where(eq(boards.id, standaloneBoard!.id));
    assert.deepEqual(preserved, { standaloneGroupId: null });
    const activities = await db.select().from(activityEvents).where(and(eq(activityEvents.clientId, owner.user.clientId), eq(activityEvents.entityId, createdGroupId)));
    assert.deepEqual(activities.map((activity) => activity.action).sort(), ["created", "deleted"]);
  } finally {
    await app.close();
  }
});

void test("enabling org push generates one shared VAPID config and reuses it across organisations", async () => {
  const app = await buildIntegrationServer();
  const first = await signupOwner(app, "owner-one@example.com", "Acme");
  const second = await signupOwner(app, "owner-two@example.com", "Beta");

  const before = await app.inject({
    method: "GET",
    url: "/notifications/push/config",
    headers: { authorization: `Bearer ${first.accessToken}` },
  });
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json(), {
    status: "org-disabled",
    enabled: false,
    publicKey: null,
  });

  const enableFirst = await app.inject({
    method: "PATCH",
    url: "/clients/me",
    headers: { authorization: `Bearer ${first.accessToken}` },
    payload: { pushEnabled: true },
  });
  assert.equal(enableFirst.statusCode, 200);
  assert.equal(enableFirst.json().pushEnabled, true);

  const [storedAfterFirst] = await db.select().from(systemConfigs).where(eq(systemConfigs.id, SYSTEM_CONFIG_ROW_ID)).limit(1);
  assert.ok(storedAfterFirst?.vapidSubject);
  assert.ok(storedAfterFirst?.vapidPublicKey);
  assert.ok(storedAfterFirst?.vapidPrivateKey);

  const ownerConfig = await app.inject({
    method: "GET",
    url: "/notifications/push/config",
    headers: { authorization: `Bearer ${first.accessToken}` },
  });
  assert.equal(ownerConfig.statusCode, 200);
  assert.deepEqual(ownerConfig.json(), {
    status: "enabled",
    enabled: true,
    publicKey: storedAfterFirst!.vapidPublicKey,
  });

  const secondBefore = await app.inject({
    method: "GET",
    url: "/notifications/push/config",
    headers: { authorization: `Bearer ${second.accessToken}` },
  });
  assert.equal(secondBefore.statusCode, 200);
  assert.deepEqual(secondBefore.json(), {
    status: "org-disabled",
    enabled: false,
    publicKey: null,
  });

  const enableSecond = await app.inject({
    method: "PATCH",
    url: "/clients/me",
    headers: { authorization: `Bearer ${second.accessToken}` },
    payload: { pushEnabled: true },
  });
  assert.equal(enableSecond.statusCode, 200);
  assert.equal(enableSecond.json().pushEnabled, true);

  const rows = await db.select().from(systemConfigs).where(eq(systemConfigs.id, SYSTEM_CONFIG_ROW_ID));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.vapidSubject, storedAfterFirst!.vapidSubject);
  assert.equal(rows[0]?.vapidPublicKey, storedAfterFirst!.vapidPublicKey);
  assert.equal(rows[0]?.vapidPrivateKey, storedAfterFirst!.vapidPrivateKey);

  const [updatedFirstClient] = await db.select().from(clients).where(eq(clients.id, first.user.clientId)).limit(1);
  const [updatedSecondClient] = await db.select().from(clients).where(eq(clients.id, second.user.clientId)).limit(1);
  assert.equal(updatedFirstClient?.pushEnabled, true);
  assert.equal(updatedSecondClient?.pushEnabled, true);
});

void test("hosted mode bootstraps push messaging for existing and new organisations", async () => {
  await withHostedMode(async () => {
    const [staleClient] = await db
      .insert(clients)
      .values({ name: "Existing Hosted Org", storageConfig: { kind: "local" }, pushEnabled: false })
      .returning();

    const app = await buildIntegrationServer();

    const [bootstrappedClient] = await db.select().from(clients).where(eq(clients.id, staleClient!.id)).limit(1);
    assert.equal(bootstrappedClient?.pushEnabled, true);

    const [storedConfig] = await db.select().from(systemConfigs).where(eq(systemConfigs.id, SYSTEM_CONFIG_ROW_ID)).limit(1);
    assert.ok(storedConfig?.vapidSubject);
    assert.ok(storedConfig?.vapidPublicKey);
    assert.ok(storedConfig?.vapidPrivateKey);

    const owner = await signupOwner(app, "hosted-push-owner@example.com", "Hosted Push Org");
    const [newClient] = await db.select().from(clients).where(eq(clients.id, owner.user.clientId)).limit(1);
    assert.equal(newClient?.pushEnabled, true);

    const clientResponse = await app.inject({
      method: "GET",
      url: "/clients/me",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(clientResponse.statusCode, 200);
    assert.equal(clientResponse.json().pushEnabled, true);
    assert.deepEqual(clientResponse.json().freePlanLimits, {
      maxBoards: env.HOSTED_FREE_MAX_BOARDS,
      maxOrgMembers: env.HOSTED_FREE_MAX_ORG_MEMBERS,
      maxEnabledAutomations: env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS,
    });

    const pushConfig = await app.inject({
      method: "GET",
      url: "/notifications/push/config",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(pushConfig.statusCode, 200);
    assert.deepEqual(pushConfig.json(), {
      status: "enabled",
      enabled: true,
      publicKey: storedConfig!.vapidPublicKey,
    });

    const disable = await app.inject({
      method: "PATCH",
      url: "/clients/me",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { pushEnabled: false },
    });
    assert.equal(disable.statusCode, 400);

    const [afterDisableAttempt] = await db.select().from(clients).where(eq(clients.id, owner.user.clientId)).limit(1);
    assert.equal(afterDisableAttempt?.pushEnabled, true);
  });
});

void test("hosted admins can start Stripe Checkout with persisted interval and active seat count", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "billing-owner@example.com", "Billing Org");

    await db.insert(users).values({
      clientId: owner.user.clientId,
      clientRole: "member",
      email: "billing-seat@example.com",
      passwordHash: "x",
      displayName: "Billing Seat",
    });
    await db.insert(users).values({
      clientId: owner.user.clientId,
      clientRole: "member",
      email: "billing-suspended@example.com",
      passwordHash: "x",
      displayName: "Suspended Seat",
      suspendedAt: new Date(),
    });

    let checkoutPrice: string | undefined;
    let checkoutQuantity: number | undefined;
    setStripeClientForTests({
      customers: {
        create: async () => ({ id: "cus_test" }),
      },
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            checkoutPrice = typeof params.line_items?.[0]?.price === "string" ? params.line_items[0].price : undefined;
            checkoutQuantity = params.line_items?.[0]?.quantity ?? undefined;
            return { url: "https://checkout.stripe.test/session" };
          },
        },
      },
    } as unknown as Stripe);

    // Admin asks to buy 1 seat, but 2 are already assigned (owner + active member; the suspended one
    // does not count). createCheckoutSession floors the purchased quantity at the used-seat count, so
    // Stripe is asked for 2.
    const checkout = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { interval: "annual", seatLimit: 1 },
    });
    assert.equal(checkout.statusCode, 200);
    assert.deepEqual(checkout.json(), { url: "https://checkout.stripe.test/session" });
    assert.equal(checkoutPrice, "price_annual");
    assert.equal(checkoutQuantity, 2);

    const [client] = await db
      .select({ billingInterval: clients.billingInterval, stripeCustomerId: clients.stripeCustomerId })
      .from(clients)
      .where(eq(clients.id, owner.user.clientId))
      .limit(1);
    assert.equal(client?.billingInterval, "annual");
    assert.equal(client?.stripeCustomerId, "cus_test");
  });
});

void test("hosted billing summary exposes pricing, status, period, Stripe flags, and active seat count", async () => {
  await withHostedMode(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "billing-me-owner@example.com", "Billing Me Org");
    await insertOrgUser(owner.user.clientId, "billing-me-active@example.com");
    await insertOrgUser(owner.user.clientId, "billing-me-suspended@example.com", "member", { suspendedAt: new Date() });
    const periodEnd = new Date("2026-07-01T00:00:00.000Z");
    await db
      .update(clients)
      .set({
        billingStatus: "active",
        billingInterval: "monthly",
        stripeCustomerId: "cus_billing_me",
        stripeSubscriptionId: "sub_billing_me",
        seatLimit: 2,
        currentPeriodEnd: periodEnd,
      })
      .where(eq(clients.id, owner.user.clientId));

    const summary = await app.inject({
      method: "GET",
      url: "/billing/me",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    assert.equal(summary.statusCode, 200);
    assert.deepEqual(summary.json(), {
      billingStatus: "active",
      billingInterval: "monthly",
      // Two active members (owner + active); the suspended member does not occupy a seat. seatCount is
      // the legacy alias of usedSeats. Paid seatLimit is the purchased subscription capacity.
      seatCount: 2,
      usedSeats: 2,
      seatLimit: 2,
      hasStripeCustomer: true,
      hasStripeSubscription: true,
      currentPeriodEnd: periodEnd.toISOString(),
      proPricing: {
        monthlyCents: env.HOSTED_PRO_PRICE_MONTHLY_CENTS,
        annualCents: env.HOSTED_PRO_PRICE_ANNUAL_CENTS,
      },
    });
  });
});

void test("billing summary and checkout reject non-admins and self-hosted billing", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "billing-member-owner@example.com", "Billing Member Org");
    const member = await signupOrgMember(app, owner.user.clientId, "billing-member@example.com");

    const summary = await app.inject({
      method: "GET",
      url: "/billing/me",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    assert.equal(summary.statusCode, 403);

    const checkout = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { interval: "monthly" },
    });
    assert.equal(checkout.statusCode, 403);
  });

  const previous = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  try {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "billing-selfhosted-owner@example.com", "Billing Self Hosted Org");
    const summary = await app.inject({
      method: "GET",
      url: "/billing/me",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(summary.statusCode, 400);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous;
  }
});

void test("checkout validates input, Stripe configuration, existing customer reuse, metadata, URLs, and missing URL", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "checkout-edges-owner@example.com", "Checkout Edges Org");
    await db.update(clients).set({ stripeCustomerId: "cus_existing" }).where(eq(clients.id, owner.user.clientId));

    const invalid = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { interval: "weekly" },
    });
    assert.equal(invalid.statusCode, 400);

    const calls: { customerCreates: number; session?: Stripe.Checkout.SessionCreateParams } = { customerCreates: 0 };
    setStripeClientForTests({
      customers: {
        create: async () => {
          calls.customerCreates += 1;
          return { id: "cus_new" };
        },
      },
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            calls.session = params;
            return { url: "https://checkout.stripe.test/reuse" };
          },
        },
      },
    } as unknown as Stripe);

    const checkout = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { interval: "monthly", seatLimit: 1 },
    });
    assert.equal(checkout.statusCode, 200);
    assert.equal(calls.customerCreates, 0);
    assert.equal(calls.session?.customer, "cus_existing");
    assert.equal(calls.session?.client_reference_id, owner.user.clientId);
    assert.deepEqual(calls.session?.metadata, { clientId: owner.user.clientId, interval: "monthly" });
    assert.deepEqual(calls.session?.subscription_data?.metadata, { clientId: owner.user.clientId, interval: "monthly" });
    assert.equal(calls.session?.success_url, `${env.WEB_ORIGIN}/settings/account-plan?billing=success`);
    assert.equal(calls.session?.cancel_url, `${env.WEB_ORIGIN}/settings/account-plan?billing=cancelled`);

    setStripeClientForTests({
      checkout: { sessions: { create: async () => ({ url: null }) } },
    } as unknown as Stripe);
    const missingUrl = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { interval: "monthly", seatLimit: 1 },
    });
    assert.equal(missingUrl.statusCode, 400);
  });

  const prevSecret = env.STRIPE_SECRET_KEY;
  await withHostedMode(async () => {
    env.STRIPE_SECRET_KEY = "";
    try {
      const app = await buildIntegrationServer();
      const owner = await signupOwner(app, "checkout-config-owner@example.com", "Checkout Config Org");
      const res = await app.inject({
        method: "POST",
        url: "/billing/checkout",
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { interval: "monthly", seatLimit: 1 },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      env.STRIPE_SECRET_KEY = prevSecret;
    }
  });
});

void test("hosted billing portal requires a Stripe customer", async () => {
  await withHostedMode(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "portal-owner@example.com", "Portal Org");

    const portal = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    assert.equal(portal.statusCode, 400);
  });
});

void test("hosted billing portal defaults an empty body to home and validates intent", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "portal-default-owner@example.com", "Portal Default Org");
    await db.update(clients).set({ stripeCustomerId: "cus_portal_default" }).where(eq(clients.id, owner.user.clientId));

    const sessions: Stripe.BillingPortal.SessionCreateParams[] = [];
    setStripeClientForTests({
      billingPortal: {
        sessions: {
          create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
            sessions.push(params);
            return { url: "https://portal.stripe.test/default" };
          },
        },
      },
    } as unknown as Stripe);

    const empty = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    assert.equal(empty.statusCode, 200);
    assert.equal(sessions[0]?.customer, "cus_portal_default");
    assert.equal(sessions[0]?.flow_data, undefined);

    const invalid = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "cancel_now" },
    });
    assert.equal(invalid.statusCode, 400);
  });
});

void test("hosted billing portal opens home and invoice history sessions for admins", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "portal-links-owner@example.com", "Portal Links Org");

    await db
      .update(clients)
      .set({ stripeCustomerId: "cus_portal_links", stripeSubscriptionId: "sub_portal_links" })
      .where(eq(clients.id, owner.user.clientId));

    const sessions: Stripe.BillingPortal.SessionCreateParams[] = [];
    setStripeClientForTests({
      billingPortal: {
        sessions: {
          create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
            sessions.push(params);
            return { url: `https://portal.stripe.test/session-${sessions.length}` };
          },
        },
      },
    } as unknown as Stripe);

    const home = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "home" },
    });
    assert.equal(home.statusCode, 200);

    const invoices = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "invoices" },
    });
    assert.equal(invoices.statusCode, 200);

    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((session) => session.customer), ["cus_portal_links", "cus_portal_links"]);
    assert.deepEqual(sessions.map((session) => session.flow_data), [undefined, undefined]);
  });
});

void test("hosted billing portal creates subscription cancellation and payment method flows", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "portal-flows-owner@example.com", "Portal Flows Org");

    await db
      .update(clients)
      .set({ stripeCustomerId: "cus_portal_flows", stripeSubscriptionId: "sub_portal_flows" })
      .where(eq(clients.id, owner.user.clientId));

    const sessions: Stripe.BillingPortal.SessionCreateParams[] = [];
    setStripeClientForTests({
      billingPortal: {
        sessions: {
          create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
            sessions.push(params);
            return { url: `https://portal.stripe.test/flow-${sessions.length}` };
          },
        },
      },
    } as unknown as Stripe);

    const cancellation = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "cancel_subscription" },
    });
    assert.equal(cancellation.statusCode, 200);

    const paymentMethod = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "payment_method" },
    });
    assert.equal(paymentMethod.statusCode, 200);

    assert.equal(sessions[0]?.flow_data?.type, "subscription_cancel");
    assert.equal(sessions[0]?.flow_data?.subscription_cancel?.subscription, "sub_portal_flows");
    assert.equal(sessions[1]?.flow_data?.type, "payment_method_update");
  });
});

void test("hosted billing portal cancellation flow requires a Stripe subscription", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "portal-no-sub-owner@example.com", "Portal No Sub Org");

    await db.update(clients).set({ stripeCustomerId: "cus_no_sub" }).where(eq(clients.id, owner.user.clientId));

    const portal = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "cancel_subscription" },
    });
    assert.equal(portal.statusCode, 400);
    assert.equal(portal.json().message, "No Stripe subscription exists for this organisation");
  });
});

void test("hosted billing portal is restricted to organisation admins", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "portal-admin-owner@example.com", "Portal Admin Org");
    const member = await signupOrgMember(app, owner.user.clientId, "portal-member@example.com");

    const portal = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { intent: "home" },
    });
    assert.equal(portal.statusCode, 403);
  });
});

void test("plan changes are rejected in self-hosted mode", async () => {
  const prev = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  try {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "self-hosted-plan@example.com", "Self Hosted Plan Org");

    const upgrade = await app.inject({
      method: "POST",
      url: "/clients/me/plan/upgrade",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { interval: "monthly" },
    });
    assert.equal(upgrade.statusCode, 400);

    const portal = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { intent: "home" },
    });
    assert.equal(portal.statusCode, 400);

    const client = await app.inject({
      method: "GET",
      url: "/clients/me",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(client.statusCode, 200);
    assert.equal(client.json().proPricing, null);
    assert.equal(client.json().freePlanLimits, null);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = prev;
  }
});

void test("account users list suspended members, scopes workspace membership, and requires admin", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, "users-list-owner@example.com", "Users List Org");
  const member = await signupOrgMember(app, owner.user.clientId, "users-list-member@example.com");
  const suspended = await insertOrgUser(owner.user.clientId, "users-list-suspended@example.com", "member", { suspendedAt: new Date("2026-06-01T00:00:00.000Z") });
  const other = await signupOwner(app, "users-list-other@example.com", "Users List Other Org");
  const [workspace] = await db.insert(workspaces).values({ clientId: owner.user.clientId, name: "Scoped Workspace" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: suspended.id, role: "member" });

  const memberList = await app.inject({
    method: "GET",
    url: "/clients/me/users",
    headers: { authorization: `Bearer ${member.accessToken}` },
  });
  assert.equal(memberList.statusCode, 403);

  const list = await app.inject({
    method: "GET",
    url: "/clients/me/users",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(list.statusCode, 200);
  const rows = list.json<Array<{ email: string; suspendedAt: string | null; workspaces: Array<{ workspaceName: string }> }>>();
  assert.equal(rows.some((row) => row.email === other.user.email), false);
  const suspendedRow = rows.find((row) => row.email === suspended.email);
  assert.ok(suspendedRow);
  assert.equal(suspendedRow.suspendedAt, "2026-06-01T00:00:00.000Z");
  assert.deepEqual(suspendedRow.workspaces.map((w) => w.workspaceName), ["Scoped Workspace"]);
});

void test("account guest-seat listing shows external guests consuming seats with board context", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, "guest-seats-owner@example.com", "Guest Seats Org");
  const member = await signupOrgMember(app, owner.user.clientId, "guest-seats-member@example.com");
  const external = await signupOwner(app, "guest-seats-external@example.com", "Guest Seats External");
  const other = await signupOwner(app, "guest-seats-other@example.com", "Guest Seats Other");
  const [workspace] = await db.insert(workspaces).values({ clientId: owner.user.clientId, name: "Client Work" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Shared Roadmap", position: "1" }).returning();
  await db.insert(boardMembers).values({ boardId: board!.id, userId: external.user.id, role: "observer" });
  await db.insert(clientGuestSeats).values({ clientId: owner.user.clientId, userId: external.user.id, createdById: owner.user.id });
  await db.insert(clientGuestSeats).values({ clientId: other.user.clientId, userId: external.user.id, createdById: other.user.id });

  const forbidden = await app.inject({
    method: "GET",
    url: "/clients/me/guest-seats",
    headers: { authorization: `Bearer ${member.accessToken}` },
  });
  assert.equal(forbidden.statusCode, 403);

  const list = await app.inject({
    method: "GET",
    url: "/clients/me/guest-seats",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(list.statusCode, 200);
  const rows = list.json<Array<{ email: string; boards: Array<{ workspaceName: string; boardName: string; role: string }> }>>();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.email, "guest-seats-external@example.com");
  assert.deepEqual(rows[0]!.boards, [{
    boardId: board!.id,
    boardName: "Shared Roadmap",
    workspaceId: workspace!.id,
    workspaceName: "Client Work",
    role: "observer",
  }]);
});

void test("archived workspace listing exposes archived workspaces to admins only", async () => {
  await withHostedMode(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "archived-list-owner@example.com", "Archived List Org");
    const member = await signupOrgMember(app, owner.user.clientId, "archived-list-member@example.com");
    await db.insert(workspaces).values([
      { clientId: owner.user.clientId, name: "Keep", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { clientId: owner.user.clientId, name: "Archive", archivedAt: new Date("2026-01-02T00:00:00.000Z"), createdAt: new Date("2026-01-02T00:00:00.000Z") },
    ]);

    const forbidden = await app.inject({
      method: "GET",
      url: "/clients/me/archived-workspaces",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    assert.equal(forbidden.statusCode, 403);

    const archived = await app.inject({
      method: "GET",
      url: "/clients/me/archived-workspaces",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(archived.statusCode, 200);
    assert.deepEqual(archived.json<Array<{ name: string }>>().map((row) => row.name), ["Archive"]);
  });
});

void test("account role updates and removal protect owners, clean memberships, revoke refresh tokens, and leave billed capacity unchanged", async () => {
  await withHostedStripe(async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, "account-owner@example.com", "Account Org");
    const admin = await insertOrgUser(owner.user.clientId, "account-admin@example.com", "admin");
    const member = await insertOrgUser(owner.user.clientId, "account-member@example.com", "member");
    const secondOwner = await insertOrgUser(owner.user.clientId, "account-second-owner@example.com", "owner");
    await insertOrgUser(owner.user.clientId, "account-third-owner@example.com", "owner");
    const [workspace] = await db.insert(workspaces).values({ clientId: owner.user.clientId, name: "Account Workspace" }).returning();
    const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Account Board", position: "1000.0000000000" }).returning();
    const [list] = await db.insert(lists).values({ workspaceId: workspace!.id, name: "Todo", position: "1000.0000000000" }).returning();
    // Removing an org user must not hard-delete their row: authored content and activity keep
    // restrictive FKs so historical attribution remains intact.
    const [card] = await db.insert(cards).values({ boardId: board!.id, listId: list!.id, title: "Member-authored card", position: "1000.0000000000", createdById: member.id }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: member.id, role: "member" });
    await db.insert(boardMembers).values({ boardId: board!.id, userId: member.id, role: "editor", assignedItemsOnly: true });
    await db.insert(boardWatchers).values({ boardId: board!.id, userId: member.id });
    await db.insert(cardAssignees).values({ cardId: card!.id, userId: member.id });
    const [checklist] = await db.insert(cardChecklists).values({ cardId: card!.id, title: "Account removal", position: "1000.0000000000" }).returning();
    const [checklistItem] = await db.insert(cardChecklistItems).values({ checklistId: checklist!.id, text: "Assigned", position: "1000.0000000000", assigneeId: member.id }).returning();
    await db.insert(cardWatchers).values({ cardId: card!.id, userId: member.id });
    await db.insert(cardMentions).values({ cardId: card!.id, userId: member.id, source: "description" });
    const [removedNotification] = await db.insert(notifications).values({
      userId: member.id,
      cardId: card!.id,
      listId: list!.id,
      boardId: board!.id,
      workspaceId: workspace!.id,
      reason: "assigned",
    }).returning();
    await db.update(clients).set({ billingStatus: "active", stripeSubscriptionItemId: "si_account" }).where(eq(clients.id, owner.user.clientId));
    await db.insert(refreshTokens).values({
      userId: member.id,
      tokenHash: hashRefresh("member-refresh-token"),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [personalApiKey] = await db.insert(workspaceApiKeys).values({
      kind: "personal",
      createdById: member.id,
      keyPrefix: "kanera_u_removed",
      keyHash: "removed-member-personal-key-hash",
    }).returning();
    const [workspaceApiKey] = await db.insert(workspaceApiKeys).values({
      kind: "workspace",
      workspaceId: workspace!.id,
      createdById: member.id,
      name: "Removed member integration",
      keyPrefix: "kanera_w_removed",
      keyHash: "removed-member-workspace-key-hash",
    }).returning();

    // Organisation removal is identity-wide, so explicit guest access in another organisation
    // must not survive merely because the retained user tombstone belongs to this organisation.
    const externalHost = await signupOwner(app, "account-external-host@example.com", "External Host Org");
    const [externalWorkspace] = await db.insert(workspaces).values({ clientId: externalHost.user.clientId, name: "External Workspace" }).returning();
    const [externalBoard] = await db.insert(boards).values({ workspaceId: externalWorkspace!.id, name: "External Guest Board", position: "1000.0000000000" }).returning();
    const [externalList] = await db.insert(lists).values({ workspaceId: externalWorkspace!.id, name: "Todo", position: "1000.0000000000" }).returning();
    const [externalCard] = await db.insert(cards).values({ boardId: externalBoard!.id, listId: externalList!.id, title: "External assignment", position: "1000.0000000000", createdById: externalHost.user.id }).returning();
    await db.insert(boardMembers).values({ boardId: externalBoard!.id, userId: member.id, role: "editor" });
    await db.insert(cardAssignees).values({ cardId: externalCard!.id, userId: member.id });
    const [externalChecklist] = await db.insert(cardChecklists).values({ cardId: externalCard!.id, title: "External checklist", position: "1000.0000000000" }).returning();
    const [externalChecklistItem] = await db.insert(cardChecklistItems).values({ checklistId: externalChecklist!.id, text: "External item", position: "1000.0000000000", assigneeId: member.id }).returning();

    const adminToken = app.jwt.sign({ sub: admin.id, cid: owner.user.clientId, role: "admin" });
    const adminTouchesOwner = await app.inject({
      method: "PATCH",
      url: `/clients/me/users/${secondOwner.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "admin" },
    });
    assert.equal(adminTouchesOwner.statusCode, 403);

    const promoteMember = await app.inject({
      method: "PATCH",
      url: `/clients/me/users/${member.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "admin" },
    });
    assert.equal(promoteMember.statusCode, 200);
    const [promotedBoardMember] = await db
      .select({ role: boardMembers.role, pinned: boardMembers.pinned, assignedItemsOnly: boardMembers.assignedItemsOnly })
      .from(boardMembers)
      .where(and(eq(boardMembers.userId, member.id), eq(boardMembers.boardId, board!.id)))
      .limit(1);
    // The pre-existing explicit editor grant is preserved in storage; organisation authority makes
    // it appear pinned while promoted, then it becomes the fallback grant after demotion.
    assert.deepEqual(promotedBoardMember, { role: "editor", pinned: false, assignedItemsOnly: false });
    const promotedBoardRoster = await app.inject({
      method: "GET",
      url: `/boards/${board!.id}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const effectiveBoardMember = promotedBoardRoster.json<Array<{ userId: string; role: string; pinned: boolean }>>()
      .find((row) => row.userId === member.id);
    assert.equal(effectiveBoardMember?.role, "editor");
    assert.equal(effectiveBoardMember?.pinned, true);
    const promotedStaleToken = app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "admin" });
    const promotedList = await app.inject({
      method: "GET",
      url: "/clients/me/users",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const promotedUser = promotedList.json<Array<{ id: string; workspaces: Array<{ workspaceId: string; role: string }> }>>()
      .find((row) => row.id === member.id);
    assert.ok(promotedUser?.workspaces.some((row) => row.workspaceId === workspace!.id && row.role === "admin"));

    const demoteMember = await app.inject({
      method: "PATCH",
      url: `/clients/me/users/${member.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "member" },
    });
    assert.equal(demoteMember.statusCode, 200);
    const [demotedBoardMember] = await db
      .select({ role: boardMembers.role, pinned: boardMembers.pinned })
      .from(boardMembers)
      .where(and(eq(boardMembers.userId, member.id), eq(boardMembers.boardId, board!.id)))
      .limit(1);
    assert.deepEqual(demotedBoardMember, { role: "editor", pinned: false });
    const staleAdminWorkspaceSettings = await app.inject({
      method: "GET",
      url: `/workspaces/${workspace!.id}/member-candidates`,
      headers: { authorization: `Bearer ${promotedStaleToken}` },
    });
    assert.equal(staleAdminWorkspaceSettings.statusCode, 403);
    const demotedToken = app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" });
    const workspaceSettingsDenied = await app.inject({
      method: "GET",
      url: `/workspaces/${workspace!.id}/member-candidates`,
      headers: { authorization: `Bearer ${demotedToken}` },
    });
    assert.equal(workspaceSettingsDenied.statusCode, 403);

    const removeSelf = await app.inject({
      method: "DELETE",
      url: `/clients/me/users/${admin.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(removeSelf.statusCode, 400);

    // Removing a member frees their pooled seat (used count drops) but must NOT change the billed
    // seat_limit — reducing capacity is a separate explicit admin action. So Stripe is never touched.
    let updatedQuantity: number | undefined;
    setStripeClientForTests({
      subscriptionItems: {
        retrieve: async () => ({ id: "si_account", quantity: 5 }),
        update: async (_id: string, params: Stripe.SubscriptionItemUpdateParams) => {
          updatedQuantity = params.quantity ?? undefined;
          return { id: "si_account" };
        },
      },
    } as unknown as Stripe);

    const remove = await app.inject({
      method: "DELETE",
      url: `/clients/me/users/${member.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(remove.statusCode, 204);
    assert.equal(await db.$count(workspaceMembers, and(eq(workspaceMembers.userId, member.id), eq(workspaceMembers.workspaceId, workspace!.id))), 0);
    assert.equal(await db.$count(boardMembers, and(eq(boardMembers.userId, member.id), eq(boardMembers.boardId, board!.id))), 0);
    assert.equal(await db.$count(boardWatchers, and(eq(boardWatchers.userId, member.id), eq(boardWatchers.boardId, board!.id))), 0);
    assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.userId, member.id), eq(cardAssignees.cardId, card!.id))), 0);
    assert.equal((await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, checklistItem!.id)))[0]?.assigneeId, null);
    assert.equal(await db.$count(cardWatchers, and(eq(cardWatchers.userId, member.id), eq(cardWatchers.cardId, card!.id))), 0);
    assert.equal(await db.$count(cardMentions, and(eq(cardMentions.userId, member.id), eq(cardMentions.cardId, card!.id))), 0);
    assert.equal(await db.$count(boardMembers, and(eq(boardMembers.userId, member.id), eq(boardMembers.boardId, externalBoard!.id))), 0);
    assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.userId, member.id), eq(cardAssignees.cardId, externalCard!.id))), 0);
    assert.equal((await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, externalChecklistItem!.id)))[0]?.assigneeId, null);
    assert.equal(await db.$count(notifications, eq(notifications.userId, member.id)), 0);
    const notificationReadEvents = await waitForUserDirectOutboxEvent(member.id, "notification:read");
    assert.ok(notificationReadEvents.some((row) => {
      const payload = row.payload as { notificationIds?: string[] };
      return payload.notificationIds?.includes(removedNotification!.id) === true;
    }));
    const assigneeEvents = await waitForBoardOutboxEvent(board!.id, "card:assignees:set");
    assert.ok(assigneeEvents.some((row) =>
      (row.payload as { cardId?: string; assigneeIds?: string[] }).cardId === card!.id &&
      (row.payload as { assigneeIds?: string[] }).assigneeIds?.length === 0
    ));
    const [removedUser] = await db.select({ email: users.email, removedAt: users.removedAt, suspendedAt: users.suspendedAt }).from(users).where(eq(users.id, member.id)).limit(1);
    assert.ok(removedUser?.removedAt);
    assert.equal(removedUser.email, `removed-${member.id}@removed.kanera.invalid`);
    assert.equal(removedUser.suspendedAt, null);
    assert.equal(await db.$count(cards, eq(cards.createdById, member.id)), 1);
    const [tokenRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefresh("member-refresh-token"))).limit(1);
    assert.ok(!tokenRow || tokenRow.revokedAt);
    assert.equal(await db.$count(workspaceApiKeys, eq(workspaceApiKeys.id, personalApiKey!.id)), 0);
    const [removedCreatorWorkspaceKey] = await db.select({ revokedAt: workspaceApiKeys.revokedAt }).from(workspaceApiKeys).where(eq(workspaceApiKeys.id, workspaceApiKey!.id)).limit(1);
    assert.ok(removedCreatorWorkspaceKey?.revokedAt);
    const removedUserRequest = await app.inject({
      method: "GET",
      url: "/clients/me",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" })}` },
    });
    assert.ok([401, 403].includes(removedUserRequest.statusCode));
    assert.equal(updatedQuantity, undefined);

    const onlyOwner = await signupOwner(app, "only-owner@example.com", "Only Owner Org");
    const lastOwner = await app.inject({
      method: "PATCH",
      url: `/clients/me/users/${onlyOwner.user.id}`,
      headers: { authorization: `Bearer ${onlyOwner.accessToken}` },
      payload: { role: "admin" },
    });
    assert.equal(lastOwner.statusCode, 400);
  });
});
