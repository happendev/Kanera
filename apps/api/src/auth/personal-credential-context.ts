import { clientMembers, clients, type ClientBillingStatus, type ClientPlan, type ClientRole } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import type { ApiRateTier } from "../lib/api-rate-limit.js";
import { hasPaidPlanEntitlement } from "../lib/entitlements.js";

export type PersonalCredentialOrganisation = {
  clientId: string;
  role: ClientRole;
  billingStatus: ClientBillingStatus;
  // Plan tier of this resolved organisation. Rate limits follow the organisation that owns the board
  // a request touches; this default tier only applies to requests that resolve no organisation of
  // their own (listings, search, session).
  apiRateTier: ApiRateTier;
};

/**
 * Resolve a live organisation context for an API credential. The stored organisation on a personal
 * key/grant is only a stable default and issuance record; it must not force the user to create
 * another credential after switching organisations.
 *
 * `requirePaidOrganisation` is for unattended credentials (workspace keys, OAuth service clients):
 * those are a Pro capability, so a pinned organisation that is no longer paid yields no context.
 * Personal keys and interactive agent grants act as a present user and work on every plan.
 */
export async function resolvePersonalCredentialOrganisation(
  userId: string,
  options: { requiredClientId?: string; preferredClientIds?: Array<string | null | undefined>; requirePaidOrganisation?: boolean } = {},
): Promise<PersonalCredentialOrganisation | null> {
  const rows = await db
    .select({
      clientId: clientMembers.clientId,
      role: clientMembers.clientRole,
      plan: clients.plan,
      billingStatus: clients.billingStatus,
    })
    .from(clientMembers)
    .innerJoin(clients, eq(clients.id, clientMembers.clientId))
    .where(and(
      eq(clientMembers.userId, userId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(clients.suspendedAt),
      isNull(clients.deletedAt),
    ))
    .orderBy(asc(clientMembers.addedAt));

  const hosted = env.KANERA_DEPLOYMENT_MODE === "hosted";
  const isPaid = (row: { plan: ClientPlan; billingStatus: ClientBillingStatus }) => !hosted || hasPaidPlanEntitlement(row.plan, row.billingStatus);
  const eligible = options.requirePaidOrganisation ? rows.filter(isPaid) : rows;
  const shape = (row: (typeof rows)[number]): PersonalCredentialOrganisation => ({
    clientId: row.clientId,
    role: row.role,
    billingStatus: row.billingStatus,
    apiRateTier: isPaid(row) ? "paid" : "free",
  });

  if (options.requiredClientId) {
    const required = eligible.find((row) => row.clientId === options.requiredClientId);
    return required ? shape(required) : null;
  }
  for (const clientId of options.preferredClientIds ?? []) {
    if (!clientId) continue;
    const preferred = eligible.find((row) => row.clientId === clientId);
    if (preferred) return shape(preferred);
  }
  return eligible[0] ? shape(eligible[0]) : null;
}
