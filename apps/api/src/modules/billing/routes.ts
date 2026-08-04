import { dto } from "@kanera/shared";
import type { BillingDowngradePreviewResponse, BillingInfoResponse } from "@kanera/shared/dto";
import { boards, clientMembers, clients, users, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import {
  constructStripeWebhookEvent,
  countActiveSeats,
  createBillingPortalSession,
  createCheckoutSession,
  handleStripeEvent,
  setSeatCapacity,
  settleSeatCapacity,
} from "../../lib/billing.js";
import { assertOrgRole } from "../../lib/access.js";
import { badRequest } from "../../lib/errors.js";
import { isPaidTier } from "../../lib/entitlements.js";
import { previewDowngradeImpact } from "../../lib/billing-emails.js";

function assertHostedBillingMode() {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") {
    throw badRequest("billing is only available in hosted mode");
  }
}

async function assertBillingOrganisationActive(clientId: string): Promise<void> {
  const [client] = await db.select({ id: clients.id }).from(clients).where(and(
    eq(clients.id, clientId),
    isNull(clients.deletedAt),
    isNull(clients.permanentDeletionRequestedAt),
  )).limit(1);
  // Access JWTs are intentionally short-lived without a per-request membership lookup. Billing
  // has a stricter boundary: an old tab must never create Checkout or mutate a subscription after
  // permanent deletion has begun.
  if (!client) throw badRequest("organisation is unavailable for billing");
}

async function buildBillingInfo(clientId: string): Promise<BillingInfoResponse> {
  const [client] = await db
    .select({
      billingStatus: clients.billingStatus,
      billingInterval: clients.billingInterval,
      stripeCustomerId: clients.stripeCustomerId,
      stripeSubscriptionId: clients.stripeSubscriptionId,
      currentPeriodEnd: clients.currentPeriodEnd,
      seatLimit: clients.seatLimit,
      plan: clients.plan,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw badRequest("client not found");
  const usedSeats = await countActiveSeats(clientId);
  const seatLimit = client.plan === "free" || !isPaidTier(client.billingStatus)
    ? env.HOSTED_FREE_MAX_ORG_MEMBERS
    : client.billingStatus === "trialing"
      ? usedSeats
      : client.seatLimit;
  return {
    billingStatus: client.billingStatus,
    billingInterval: client.billingInterval,
    // seatCount is the legacy alias of usedSeats kept for older clients.
    seatCount: usedSeats,
    usedSeats,
    seatLimit,
    hasStripeCustomer: client.stripeCustomerId !== null,
    hasStripeSubscription: client.stripeSubscriptionId !== null,
    currentPeriodEnd: client.currentPeriodEnd?.toISOString() ?? null,
    proPricing: {
      monthlyCents: env.HOSTED_PRO_PRICE_MONTHLY_CENTS,
      annualCents: env.HOSTED_PRO_PRICE_ANNUAL_CENTS,
    },
  };
}

export async function billingRoutes(app: FastifyInstance) {
  app.get("/billing/me", { preHandler: app.authenticate }, async (req) => {
    assertOrgRole(req.auth, "admin");
    assertHostedBillingMode();
    await assertBillingOrganisationActive(req.auth.cid);
    return buildBillingInfo(req.auth.cid);
  });

  app.get("/billing/downgrade-preview", { preHandler: app.authenticate }, async (req) => {
    assertOrgRole(req.auth, "admin");
    assertHostedBillingMode();
    await assertBillingOrganisationActive(req.auth.cid);

    // Match reconcileToFreeTier's oldest-first retention exactly. Naming the selected rows here is
    // what lets a trial warning say what changes, rather than presenting an abstract limit table.
    const liveBoards = await db
      .select({ id: boards.id, name: boards.name, workspaceName: workspaces.name })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, req.auth.cid), isNull(workspaces.archivedAt), isNull(boards.archivedAt)))
      .orderBy(asc(boards.createdAt));

    const activeMembers = await db
      .select({ id: clientMembers.userId, role: clientMembers.clientRole, displayName: users.displayName, email: users.email })
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(eq(clientMembers.clientId, req.auth.cid), isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt)))
      .orderBy(asc(clientMembers.addedAt));
    const protectedOwnerId = activeMembers.find((member) => member.role === "owner")?.id ?? null;
    const memberCandidates = activeMembers.filter((member) => member.id !== protectedOwnerId);
    const keepSlots = Math.max(0, env.HOSTED_FREE_MAX_ORG_MEMBERS - (protectedOwnerId ? 1 : 0));

    const impact = await previewDowngradeImpact(req.auth.cid);
    const quantity = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
    const features = [
      ...(impact.automationsDisabled ? [`${quantity(impact.automationsDisabled, "automation rule")} made read-only`] : []),
      ...(impact.webhooksDisabled ? [`${quantity(impact.webhooksDisabled, "webhook")} disabled`] : []),
      ...(impact.apiKeysRevoked ? [`${quantity(impact.apiKeysRevoked, "API key")} revoked; API and MCP access becomes read-only`] : []),
      ...(impact.guestMembersRemoved ? [`Guest collaboration for ${quantity(impact.guestMembersRemoved, "person", "people")} becomes read-only`] : []),
      ...(impact.guestInvitesRevoked ? [`${quantity(impact.guestInvitesRevoked, "pending guest invite")} revoked`] : []),
    ];
    return {
      boards: liveBoards.slice(env.HOSTED_FREE_MAX_BOARDS),
      members: memberCandidates.slice(keepSlots).map(({ id, displayName, email }) => ({ id, displayName, email })),
      features,
    } satisfies BillingDowngradePreviewResponse;
  });

  app.post("/billing/checkout", { preHandler: app.authenticate }, async (req) => {
    assertOrgRole(req.auth, "admin");
    assertHostedBillingMode();
    await assertBillingOrganisationActive(req.auth.cid);
    const body = dto.billingCheckoutBody.parse(req.body);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    return createCheckoutSession(req.auth.cid, user?.email ?? "", body.interval, body.seatLimit);
  });

  // Buy more / reduce seats: set the org's purchased capacity. On an active subscription an increase is
  // invoiced immediately; if the proration charge needs the customer to authenticate (3DS/SCA or a redirect
  // wallet), we return a paymentConfirmation so the browser can confirm it in-app via Stripe.js, then call
  // /billing/seats/confirm. During a trial it is free until checkout.
  app.post("/billing/seats", { preHandler: app.authenticate }, async (req) => {
    assertOrgRole(req.auth, "admin");
    assertHostedBillingMode();
    await assertBillingOrganisationActive(req.auth.cid);
    const body = dto.setSeatCapacityBody.parse(req.body);
    const result = await setSeatCapacity(req.auth.cid, body.seatLimit, env, { mailer: app.mailer, log: req.log });
    const info = await buildBillingInfo(req.auth.cid);
    return result.status === "requires_confirmation"
      ? { ...info, paymentConfirmation: { clientSecret: result.clientSecret, publishableKey: result.publishableKey } }
      : info;
  });

  // Finalize a seat increase after the browser has confirmed the proration payment in-app. Idempotent with
  // the invoice.paid webhook; lets the UI reflect the new capacity immediately instead of waiting on the webhook.
  app.post("/billing/seats/confirm", { preHandler: app.authenticate }, async (req) => {
    assertOrgRole(req.auth, "admin");
    assertHostedBillingMode();
    await assertBillingOrganisationActive(req.auth.cid);
    await settleSeatCapacity(req.auth.cid, env, { mailer: app.mailer, log: req.log });
    return buildBillingInfo(req.auth.cid);
  });

  app.post("/billing/portal", { preHandler: app.authenticate }, async (req) => {
    assertOrgRole(req.auth, "admin");
    assertHostedBillingMode();
    await assertBillingOrganisationActive(req.auth.cid);
    const body = dto.billingPortalBody.parse(req.body);
    return createBillingPortalSession(req.auth.cid, body.intent);
  });

  app.post("/billing/webhook", { config: { rawBody: true } }, async (req) => {
    assertHostedBillingMode();
    const signature = req.headers["stripe-signature"];
    const event = constructStripeWebhookEvent(req.rawBody, Array.isArray(signature) ? signature[0] : signature);
    await handleStripeEvent(event, env, app.mailer);
    return { received: true };
  });
}
