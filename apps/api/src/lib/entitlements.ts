import {
  cardAttachments,
  clients,
  noteAttachments,
  type ClientPlan,
  type ClientBillingStatus,
} from "@kanera/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { env, type Env } from "../env.js";
import { AppError } from "./errors.js";

export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number | null;
  remainingBytes: number | null;
  limited: boolean;
  billingStatus: ClientBillingStatus | null;
  // Org plan, carried alongside billingStatus so upload entitlements can derive the per-file limit
  // without a second clients read (getUploadEntitlements reuses this). Stripped before the wire DTO.
  plan: ClientPlan | null;
  // Trial end timestamp from the org's clients row, threaded through so auth responses can derive
  // entitlements (tier + trialEndsAt) from a single clients read.
  currentPeriodEnd: Date | null;
};

export type UploadEntitlements = StorageUsage & {
  maxFileBytes: number;
};

type EntitlementEnv = Pick<
  Env,
  | "KANERA_DEPLOYMENT_MODE"
  | "ATTACHMENT_MAX_BYTES"
  | "HOSTED_FREE_ATTACHMENT_MAX_BYTES"
  | "HOSTED_FREE_STORAGE_QUOTA_BYTES"
  | "HOSTED_PAID_STORAGE_QUOTA_BYTES"
>;

// Single source of truth for "is this org entitled to paid features". Dunning (`past_due`) keeps
// paid access so a transient Stripe retry state does not destructively downgrade resources.
// Self-hosted orgs are unlimited and never reach the free-tier branches that consult this.
export function isPaidTier(billingStatus: ClientBillingStatus | null | undefined): boolean {
  return billingStatus === "trialing" || billingStatus === "active" || billingStatus === "past_due";
}

// Stricter than isPaidTier: whether the org may incur a NEW billing addition (e.g. a paid guest
// seat) right now. Excludes `past_due` on purpose — a dunning org keeps access to its existing
// resources, but creating a new seat would fire an immediate proration invoice (syncStripeSeatQuantity
// uses always_invoice on increase) against a card that is already failing. Block it until the
// overdue invoice is resolved.
export function canAddPaidSeat(billingStatus: ClientBillingStatus | null | undefined): boolean {
  return billingStatus === "active" || billingStatus === "trialing";
}

function hasPaidStorageEntitlement(
  plan: ClientPlan | null | undefined,
  billingStatus: ClientBillingStatus | null | undefined,
): boolean {
  return plan === "paid" && isPaidTier(billingStatus);
}

export function maxFileBytesForBillingStatus(
  billingStatus: ClientBillingStatus | null | undefined,
  config: Pick<EntitlementEnv, "KANERA_DEPLOYMENT_MODE" | "ATTACHMENT_MAX_BYTES" | "HOSTED_FREE_ATTACHMENT_MAX_BYTES"> = env,
  plan: ClientPlan | null | undefined = "paid",
): number {
  const paid = hasPaidStorageEntitlement(plan, billingStatus);
  return config.KANERA_DEPLOYMENT_MODE === "hosted" && !paid
    ? Math.min(config.HOSTED_FREE_ATTACHMENT_MAX_BYTES, config.ATTACHMENT_MAX_BYTES)
    : config.ATTACHMENT_MAX_BYTES;
}

export function quotaForBillingStatus(
  billingStatus: ClientBillingStatus | null | undefined,
  config: EntitlementEnv = env,
  storageQuotaBytes: number | null | undefined = null,
  plan: ClientPlan | null | undefined = "paid",
): Pick<StorageUsage, "quotaBytes" | "remainingBytes" | "limited" | "billingStatus"> {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") {
    return { quotaBytes: null, remainingBytes: null, limited: false, billingStatus: billingStatus ?? null };
  }

  const quotaBytes = storageQuotaBytes ?? (hasPaidStorageEntitlement(plan, billingStatus)
    ? config.HOSTED_PAID_STORAGE_QUOTA_BYTES
    : config.HOSTED_FREE_STORAGE_QUOTA_BYTES);

  return { quotaBytes, remainingBytes: quotaBytes, limited: true, billingStatus: billingStatus ?? null };
}

// Storage is an org-level pool charged to whoever owns the board's workspace ("host-pays"), not the
// uploader's personal org. Attachment rows denormalize that owning client_id so /me and upload gates
// can sum usage directly; `uploadedById` remains purely for audit/attribution, not quota.
export async function getOrgStorageUsage(
  database: Db,
  orgClientId: string,
  config: EntitlementEnv = env,
): Promise<StorageUsage> {
  const [[client], [cardUsage], [noteUsage]] = await Promise.all([
    database
      .select({
        plan: clients.plan,
        billingStatus: clients.billingStatus,
        currentPeriodEnd: clients.currentPeriodEnd,
        storageQuotaBytes: clients.storageQuotaBytes,
      })
      .from(clients)
      .where(eq(clients.id, orgClientId))
      .limit(1),
    database
      .select({ usedBytes: sql<string>`coalesce(sum(${cardAttachments.byteSize}), 0)::bigint` })
      .from(cardAttachments)
      .where(eq(cardAttachments.clientId, orgClientId)),
    database
      .select({ usedBytes: sql<string>`coalesce(sum(${noteAttachments.byteSize}), 0)::bigint` })
      .from(noteAttachments)
      .where(eq(noteAttachments.clientId, orgClientId)),
  ]);

  const plan = client?.plan ?? null;
  const base = quotaForBillingStatus(client?.billingStatus ?? null, config, client?.storageQuotaBytes ?? null, plan);
  const currentPeriodEnd = client?.currentPeriodEnd ?? null;
  const usedBytes = Number(cardUsage?.usedBytes ?? 0) + Number(noteUsage?.usedBytes ?? 0);
  if (!base.limited || base.quotaBytes === null) return { ...base, plan, currentPeriodEnd, usedBytes, remainingBytes: null };
  return {
    ...base,
    plan,
    currentPeriodEnd,
    usedBytes,
    remainingBytes: Math.max(0, base.quotaBytes - usedBytes),
  };
}

export async function getUploadEntitlements(
  database: Db,
  orgClientId: string,
  config: EntitlementEnv = env,
): Promise<UploadEntitlements> {
  const usage = await getOrgStorageUsage(database, orgClientId, config);
  // plan is already read inside getOrgStorageUsage — reuse it rather than re-querying clients.
  const maxFileBytes = maxFileBytesForBillingStatus(usage.billingStatus, config, usage.plan);
  return { ...usage, maxFileBytes };
}

// True when a hosted org has exhausted its storage pool. Upload routes call this on the entitlements
// they already fetched so a full org is rejected BEFORE the request body is read — a full org never
// wastes upload bandwidth.
export function isStorageFull(usage: StorageUsage): boolean {
  return usage.limited && usage.quotaBytes !== null && usage.usedBytes >= usage.quotaBytes;
}

// Single source for the STORAGE_QUOTA_EXCEEDED error so the early "already full" reject and the
// post-read over-quota reject return identical codes/details. The role-specific guidance ("upgrade"
// vs "ask an admin") is added by the web client, which knows the viewer's role; this stays neutral so
// the public API also gets a clear, accurate message. attemptedBytes is omitted on the early path
// because the body has not been read yet.
export function storageQuotaExceededError(usage: StorageUsage, attemptedBytes?: number): AppError {
  const quota = formatStorageBytes(usage.quotaBytes ?? 0);
  return new AppError(
    403,
    "STORAGE_QUOTA_EXCEEDED",
    `Your organisation has used its ${quota} storage allowance. Upgrade the plan or remove files to upload more.`,
    {
      limit: "storage",
      usedBytes: usage.usedBytes,
      quotaBytes: usage.quotaBytes,
      attemptedBytes,
      upgradePlan: "paid",
    },
  );
}

export async function assertCanUploadAttachment(
  database: Db,
  orgClientId: string,
  attemptedBytes: number,
  config: EntitlementEnv = env,
): Promise<UploadEntitlements> {
  const usage = await getUploadEntitlements(database, orgClientId, config);
  if (attemptedBytes > usage.maxFileBytes) {
    throw new AppError(
      400,
      "FILE_TOO_LARGE",
      `File is too large. The maximum file size is ${formatStorageBytes(usage.maxFileBytes)}.`,
      { limit: "fileSize", maxFileBytes: usage.maxFileBytes, attemptedBytes },
    );
  }
  if (!usage.limited || usage.quotaBytes === null) return usage;
  if (usage.usedBytes + attemptedBytes <= usage.quotaBytes) return usage;

  throw storageQuotaExceededError(usage, attemptedBytes);
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
