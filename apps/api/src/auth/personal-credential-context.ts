import { clientMembers, clients, type ClientBillingStatus, type ClientRole } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { isPaidTier } from "../lib/entitlements.js";

export type PersonalCredentialOrganisation = {
  clientId: string;
  role: ClientRole;
  billingStatus: ClientBillingStatus;
};

/**
 * Resolve a live organisation context for an identity-level credential. The stored organisation on
 * a personal key/grant is only a stable default and issuance record; it must not force the user to
 * create another credential after switching organisations.
 */
export async function resolvePersonalCredentialOrganisation(
  userId: string,
  options: { requiredClientId?: string; preferredClientIds?: Array<string | null | undefined> } = {},
): Promise<PersonalCredentialOrganisation | null> {
  const rows = await db
    .select({
      clientId: clientMembers.clientId,
      role: clientMembers.clientRole,
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

  const eligible = rows.filter((row) =>
    env.KANERA_DEPLOYMENT_MODE !== "hosted" || isPaidTier(row.billingStatus)
  );
  if (options.requiredClientId) {
    return eligible.find((row) => row.clientId === options.requiredClientId) ?? null;
  }
  for (const clientId of options.preferredClientIds ?? []) {
    if (!clientId) continue;
    const preferred = eligible.find((row) => row.clientId === clientId);
    if (preferred) return preferred;
  }
  return eligible[0] ?? null;
}
