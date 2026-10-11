import { STORAGE_WARNING_PERCENT } from "@kanera/shared/dto";
import { cardAttachments, clientMembers, clients, noteAttachments, scratchpadNoteAttachments, users } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env, type Env } from "../env.js";
import { formatStorageBytes, hasPaidPlanEntitlement, quotaForBillingStatus } from "./entitlements.js";
import type { Mailer } from "./mailer.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

// Hysteresis: the warning re-arms only once usage falls this far back down. Without the gap, an org
// hovering around the threshold (upload, delete, upload) would be emailed on every crossing.
const STORAGE_WARNING_REARM_PERCENT = 70;

const STORAGE_WARNING_SWEEP_MS = 60 * 60_000;

type StorageWarningEnv = Pick<
  Env,
  | "KANERA_DEPLOYMENT_MODE"
  | "WEB_ORIGIN"
  | "ATTACHMENT_MAX_BYTES"
  | "HOSTED_FREE_ATTACHMENT_MAX_BYTES"
  | "HOSTED_FREE_STORAGE_QUOTA_BYTES"
  | "HOSTED_PAID_STORAGE_QUOTA_BYTES"
>;

type UsageRow = {
  id: string;
  name: string;
  plan: typeof clients.$inferSelect.plan;
  billingStatus: typeof clients.$inferSelect.billingStatus;
  storageQuotaBytes: number | null;
  storageWarningSentAt: Date | null;
  usedBytes: number;
};

/**
 * Emails owners and admins once when a hosted organisation reaches STORAGE_WARNING_PERCENT of its
 * quota, and re-arms after usage drops below STORAGE_WARNING_REARM_PERCENT (a cleanup or an
 * upgrade). Self-hosted deployments have no quota and never warn.
 *
 * A periodic sweep rather than an upload hook: files arrive through cards, comments, notes,
 * scratchpads, upload links and imports, and deletes and plan changes move the percentage too. One
 * grouped scan over the attachment tables catches every path; an hour's latency is fine for a
 * warning whose whole point is lead time.
 */
export async function runStorageWarningSweep(mailer: Mailer, log?: FastifyBaseLogger, config: StorageWarningEnv = env): Promise<number> {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return 0;

  // Every attachment table is summed, matching getOrgStorageUsage; a table missing here would
  // under-report usage and the warning would arrive late.
  const usage = db.$with("usage").as(
    db.select({
      clientId: sql<string>`u.client_id`.as("client_id"),
      usedBytes: sql<string>`sum(u.byte_size)`.as("used_bytes"),
    }).from(sql`(
      select ${cardAttachments.clientId} as client_id, ${cardAttachments.byteSize} as byte_size from ${cardAttachments}
      union all
      select ${noteAttachments.clientId}, ${noteAttachments.byteSize} from ${noteAttachments}
      union all
      select ${scratchpadNoteAttachments.clientId}, ${scratchpadNoteAttachments.byteSize} from ${scratchpadNoteAttachments}
    ) u`).groupBy(sql`u.client_id`),
  );
  const rows = await db.with(usage)
    .select({
      id: clients.id,
      name: clients.name,
      plan: clients.plan,
      billingStatus: clients.billingStatus,
      storageQuotaBytes: clients.storageQuotaBytes,
      storageWarningSentAt: clients.storageWarningSentAt,
      usedBytes: sql<string>`coalesce(${usage.usedBytes}, 0)`,
    })
    .from(clients)
    .leftJoin(usage, eq(usage.clientId, clients.id))
    .where(and(
      isNull(clients.deletedAt),
      isNull(clients.permanentDeletionRequestedAt),
      // Only orgs that could change state: anything stored, or a warning waiting to re-arm.
      sql`(${usage.usedBytes} > 0 or ${clients.storageWarningSentAt} is not null)`,
    ));

  let sent = 0;
  for (const raw of rows) {
    const row: UsageRow = { ...raw, usedBytes: Number(raw.usedBytes) };
    const { quotaBytes } = quotaForBillingStatus(row.billingStatus, config, row.storageQuotaBytes, row.plan);
    if (!quotaBytes) continue;
    const percentUsed = (row.usedBytes / quotaBytes) * 100;

    if (percentUsed < STORAGE_WARNING_REARM_PERCENT && row.storageWarningSentAt) {
      await db.update(clients).set({ storageWarningSentAt: null }).where(eq(clients.id, row.id));
      continue;
    }
    if (percentUsed < STORAGE_WARNING_PERCENT || row.storageWarningSentAt) continue;

    // Claim before sending so overlapping workers (or a retry after a crash mid-loop) cannot email
    // the same organisation twice for one approach.
    const claimed = await db.update(clients)
      .set({ storageWarningSentAt: new Date() })
      .where(and(eq(clients.id, row.id), isNull(clients.storageWarningSentAt)))
      .returning({ id: clients.id });
    if (claimed.length === 0) continue;
    sent += await sendStorageWarningEmails(mailer, row, quotaBytes, Math.min(100, Math.floor(percentUsed)), config);
  }
  if (sent > 0) log?.info({ sent }, "queued storage warning emails");
  return sent;
}

async function sendStorageWarningEmails(mailer: Mailer, row: UsageRow, quotaBytes: number, percentUsed: number, config: StorageWarningEnv): Promise<number> {
  const recipients = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.clientId, row.id),
      inArray(clientMembers.clientRole, ["owner", "admin"]),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ));
  // Only a Free org gains storage by upgrading; a custom quota override is a negotiated allowance,
  // so the email does not promise the standard paid amount on top of it.
  const upgradeQuotaLabel = !hasPaidPlanEntitlement(row.plan, row.billingStatus) && row.storageQuotaBytes === null
    ? formatStorageBytes(config.HOSTED_PAID_STORAGE_QUOTA_BYTES)
    : null;
  for (const recipient of recipients) {
    await mailer.sendStorageWarning(recipient.email, {
      displayName: recipient.displayName,
      orgName: row.name,
      usedLabel: formatStorageBytes(row.usedBytes),
      quotaLabel: formatStorageBytes(quotaBytes),
      percentUsed,
      storageUrl: `${config.WEB_ORIGIN}/settings/storage`,
      upgradeQuotaLabel,
    });
  }
  return recipients.length;
}

export function startStorageWarningScheduler(log: FastifyBaseLogger, mailer: Mailer): () => Promise<void> {
  const scheduler = startSweepScheduler({
    name: "storage-warning",
    task: () => runStorageWarningSweep(mailer, log),
    nextDelayMs: STORAGE_WARNING_SWEEP_MS,
    log,
  });
  return scheduler.stop;
}

