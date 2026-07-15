import type { Entitlements } from "@kanera/shared/dto";
import { automations, boards, clientGuestSeats, clients, users, workspaces, type ClientBillingStatus } from "@kanera/shared/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { env, type Env } from "../env.js";
import { AppError } from "./errors.js";
import { isPaidTier } from "./entitlements.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

type TierLimitEnv = Pick<
  Env,
  | "KANERA_DEPLOYMENT_MODE"
  | "HOSTED_FREE_MAX_BOARDS"
  | "HOSTED_FREE_MAX_ORG_MEMBERS"
  | "HOSTED_FREE_MAX_ENABLED_AUTOMATIONS"
>;

export type FreePlanLimits = {
  maxBoards: number;
  maxOrgMembers: number;
  maxEnabledAutomations: number;
};

export function getFreePlanLimits(config: TierLimitEnv = env): FreePlanLimits {
  return {
    maxBoards: config.HOSTED_FREE_MAX_BOARDS,
    maxOrgMembers: config.HOSTED_FREE_MAX_ORG_MEMBERS,
    maxEnabledAutomations: config.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS,
  };
}

// Thrown when a hosted free-tier org exceeds a product cap. The `details` carry a machine-readable
// shape (limit name, current usage, max, upgradePlan) so the web app and a future upgrade flow can
// react without parsing the message string.
function planLimitError(limit: string, current: number, max: number): AppError {
  return new AppError(403, "PLAN_LIMIT", `Your plan's ${limit} limit has been reached. Upgrade to add more.`, {
    limit,
    current,
    max,
    upgradePlan: "paid",
  });
}

async function billingStatusFor(clientId: string, tx: Tx = db): Promise<ClientBillingStatus | null> {
  const [row] = await tx.select({ billingStatus: clients.billingStatus }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return row?.billingStatus ?? null;
}

// Returns true when free-tier caps do not apply: self-hosted always, and hosted trial/paid orgs.
// Callers that pass an explicit billing status avoid a second query.
async function isUnlimited(clientId: string, tx: Tx, config: TierLimitEnv): Promise<boolean> {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return true;
  return isPaidTier(await billingStatusFor(clientId, tx));
}

// Serialize concurrent create operations for a tenant so a count(*) cap check cannot race a
// concurrent insert past the free cap. Taking a FOR UPDATE row lock on the tenant's clients row
// makes same-tenant creates queue; the lock is released when the surrounding transaction commits.
// Only meaningful when the caller runs the assert + insert inside one transaction.
async function lockTenant(clientId: string, tx: Tx): Promise<void> {
  await tx.execute(sql`select 1 from ${clients} where ${clients.id} = ${clientId} for update`);
}

export async function assertBoardLimit(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<void> {
  if (await isUnlimited(clientId, tx, config)) return;
  await lockTenant(clientId, tx);
  // Workspaces are unlimited on Free, so the board cap must be org-wide rather than workspace-local.
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(boards.archivedAt)));
  const current = row?.count ?? 0;
  if (current >= config.HOSTED_FREE_MAX_BOARDS) throw planLimitError("boards", current, config.HOSTED_FREE_MAX_BOARDS);
}

export async function assertOrgMemberLimit(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<void> {
  if (await isUnlimited(clientId, tx, config)) return;
  await lockTenant(clientId, tx);
  // Accepted, active members only; pending invites, suspended members (disabled by a prior downgrade),
  // and removed member tombstones do not occupy a slot (mirrors board-guest-limits).
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt)));
  const current = row?.count ?? 0;
  if (current >= config.HOSTED_FREE_MAX_ORG_MEMBERS) throw planLimitError("members", current, config.HOSTED_FREE_MAX_ORG_MEMBERS);
}

// Thrown when assigning a member/guest would exceed the org's purchased seat pool. The admin must buy
// more seats first (block-until-buy). Carries the seat pool shape so the web app can route to the buy flow.
function seatLimitError(current: number, max: number): AppError {
  return new AppError(402, "SEAT_LIMIT_REACHED", "All purchased seats are in use. Buy more seats to add this person.", {
    limit: "seats",
    current,
    max,
    upgradePlan: "paid",
  });
}

// Enforces the purchased seat pool on paid subscription orgs: a new member or paid guest seat may only be
// assigned when used seats < seat_limit. Trials are intentionally unlimited until checkout; free tier is
// governed by assertOrgMemberLimit/assertGuestsAllowed, and self-hosted has no pool. Must run inside the
// same locked transaction as the insert so the count check cannot race a concurrent assignment.
export async function assertSeatPoolAvailable(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<void> {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return;
  const billingStatus = await billingStatusFor(clientId, tx);
  if (billingStatus !== "active" && billingStatus !== "past_due") return;
  await lockTenant(clientId, tx);
  const [seatRow] = await tx.select({ seatLimit: clients.seatLimit }).from(clients).where(eq(clients.id, clientId)).limit(1);
  const seatLimit = seatRow?.seatLimit ?? 1;
  const [memberRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt)));
  const [guestSeatRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(clientGuestSeats)
    .innerJoin(users, eq(users.id, clientGuestSeats.userId))
    .where(and(eq(clientGuestSeats.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt)));
  const used = (memberRow?.count ?? 0) + (guestSeatRow?.count ?? 0);
  if (used >= seatLimit) throw seatLimitError(used, seatLimit);
}

export async function assertEnabledAutomationLimit(
  clientId: string,
  options: { excludeId?: string } = {},
  tx: Tx = db,
  config: TierLimitEnv = env,
): Promise<void> {
  if (await isUnlimited(clientId, tx, config)) return;
  await lockTenant(clientId, tx);
  const conditions = [eq(workspaces.clientId, clientId), eq(automations.enabled, true)];
  // When toggling an existing automation on, exclude it from the count so re-enabling the only
  // allowed automation does not trip the limit against itself.
  if (options.excludeId) conditions.push(ne(automations.id, options.excludeId));
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(automations)
    .innerJoin(workspaces, eq(workspaces.id, automations.workspaceId))
    .where(and(...conditions));
  const current = row?.count ?? 0;
  if (current >= config.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS) {
    throw planLimitError("enabled automations", current, config.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS);
  }
}

export async function shouldEnableSeededAutomations(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<boolean> {
  // Template recipes should all be visible on Free, but enabling an arbitrary subset during setup
  // would make the chosen workflow unpredictable. Seed the complete set disabled instead; an admin
  // can then choose which recipe occupies the available enabled-automation slot.
  return isUnlimited(clientId, tx, config);
}

export async function assertGuestsAllowed(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<void> {
  if (await isUnlimited(clientId, tx, config)) return;
  throw new AppError(403, "PLAN_LIMIT", "Guests are not available on your plan. Upgrade to invite guests.", {
    limit: "guests",
    upgradePlan: "paid",
  });
}

export async function assertApiKeysAllowed(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<void> {
  if (await isUnlimited(clientId, tx, config)) return;
  throw new AppError(403, "PLAN_LIMIT", "API keys are not available on your plan. Upgrade to create API keys.", {
    limit: "apiKeys",
    upgradePlan: "paid",
  });
}

export async function assertWebhooksAllowed(clientId: string, tx: Tx = db, config: TierLimitEnv = env): Promise<void> {
  if (await isUnlimited(clientId, tx, config)) return;
  throw new AppError(403, "PLAN_LIMIT", "Webhooks are not available on your plan. Upgrade to create webhooks.", {
    limit: "webhooks",
    upgradePlan: "paid",
  });
}

// Pure projection of an org's billing status into the entitlement payload the web app consumes.
// Kept here so route enforcement and the surfaced limits share one definition of "free".
export function getEntitlements(
  billingStatus: ClientBillingStatus | null | undefined,
  currentPeriodEnd: Date | null | undefined,
  config: TierLimitEnv = env,
): Entitlements {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted" || isPaidTier(billingStatus)) {
    const tier = config.KANERA_DEPLOYMENT_MODE === "hosted" ? (billingStatus === "trialing" ? "trial" : "paid") : "paid";
    return {
      tier,
      // Only a trialing org has a meaningful end date; paid/self-hosted have none.
      trialEndsAt: tier === "trial" ? (currentPeriodEnd?.toISOString() ?? null) : null,
      limited: false,
      maxBoards: null,
      maxOrgMembers: null,
      maxEnabledAutomations: null,
      guestsAllowed: true,
      apiAllowed: true,
      webhooksAllowed: true,
    };
  }
  return {
    tier: "free",
    trialEndsAt: null,
    limited: true,
    ...getFreePlanLimits(config),
    guestsAllowed: false,
    apiAllowed: false,
    webhooksAllowed: false,
  };
}
