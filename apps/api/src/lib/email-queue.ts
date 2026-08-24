import { EMAIL_QUEUE_STATUS, emailQueue, type EmailQueue, type SmtpConfig } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { errorMessage, renderEmail } from "./mailer.js";
import { notificationDeliveryDuration, notificationDeliveryTotal, notificationQueueWaitDuration } from "./metrics.js";
import { sendEmail, type SendEmailOptions } from "./smtp.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const MAX_RETRIES = 3;
const SWEEP_BATCH_SIZE = 25;
const SWEEP_INTERVAL_MS = 30_000; // 30 seconds
const PROCESSING_LEASE_MS = 15 * 60_000; // 15 minutes
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1,440 minutes
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 43,200 minutes
const RETRY_BACKOFF_BASE_MS = 5 * 60_000; // 5 minutes
const RETRY_BACKOFF_MAX_MS = 60 * 60_000; // 1 hour

// Exponential backoff between retries so a failing SMTP target isn't hammered every sweep.
// `retries` is the attempt count after the failure just recorded (1-based).
function retryDelayMs(retries: number): number {
  return Math.min(RETRY_BACKOFF_MAX_MS, 2 ** Math.max(0, retries - 1) * RETRY_BACKOFF_BASE_MS);
}

export interface EmailQueueDeps {
  db: Db;
  resolveSmtpConfig: (clientId: string) => Promise<SmtpConfig | null>;
  log: FastifyBaseLogger;
  sendEmail?: (options: SendEmailOptions) => Promise<void>;
}

export async function runEmailQueueSweep({
  db,
  resolveSmtpConfig,
  log,
  sendEmail: deliverEmail = sendEmail,
}: EmailQueueDeps): Promise<number> {
  const config = await resolveSmtpConfig("__env__");
  if (!config) {
    return 0;
  }

  let processed = 0;
  while (true) {
    const rows = await claimQueuedEmails(db);
    if (rows.length === 0) return processed;

    // Drain every email that is currently due before the scheduler starts its next idle window.
    // Claims stay bounded so a large backlog never becomes one oversized database transaction.
    for (const row of rows) {
      const startedAt = Date.now();
      let outcome = "error";
      notificationQueueWaitDuration.observe(
        { queue: "email", channel: "smtp" },
        Math.max(0, (startedAt - row.createdAt.getTime()) / 1000),
      );
      try {
        await deliverEmail({ config, to: row.toEmail, subject: row.subject, html: renderEmail(row) });
        await db
          .update(emailQueue)
          .set({ status: EMAIL_QUEUE_STATUS.success, sentAt: new Date(), processingLeaseExpiresAt: null, updatedAt: new Date(), lastError: null })
          .where(eq(emailQueue.id, row.id));
        log.info({ emailQueueId: row.id, to: row.toEmail, subject: row.subject }, "email sent");
        outcome = "success";
      } catch (err) {
        const retries = row.retries + 1;
        const now = new Date();
        await db
          .update(emailQueue)
          .set({
            status: retries >= MAX_RETRIES ? EMAIL_QUEUE_STATUS.error : EMAIL_QUEUE_STATUS.queued,
            retries,
            // Defer the next attempt with exponential backoff so this drain skips the row
            // until it becomes due again. Terminal failures keep a future value too; it is ignored.
            nextAttemptAt: new Date(now.getTime() + retryDelayMs(retries)),
            processingLeaseExpiresAt: null,
            lastError: errorMessage(err),
            updatedAt: now,
          })
          .where(eq(emailQueue.id, row.id));
        log.error({ err, emailQueueId: row.id, retries }, "queued email send failed");
        outcome = retries >= MAX_RETRIES ? "error" : "retry";
      } finally {
        notificationDeliveryDuration.observe({ queue: "email", channel: "smtp" }, (Date.now() - startedAt) / 1000);
        notificationDeliveryTotal.inc({ queue: "email", channel: "smtp", outcome });
      }
    }
    processed += rows.length;
  }
}

export async function runEmailQueueCleanup({ db, log }: Pick<EmailQueueDeps, "db" | "log">, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  // Pending and leased emails remain recoverable work; retention applies only after a terminal result.
  const deleted = await db.delete(emailQueue).where(and(
    lt(emailQueue.createdAt, cutoff),
    inArray(emailQueue.status, [EMAIL_QUEUE_STATUS.success, EMAIL_QUEUE_STATUS.error]),
  )).returning({ id: emailQueue.id });
  if (deleted.length > 0) log.info({ deletedCount: deleted.length }, "purged old email queue rows");
  return deleted.length;
}

export function startEmailQueueScheduler(deps: EmailQueueDeps): () => Promise<void> {
  const sweep = startSweepScheduler({
    name: "email-queue",
    task: () => runEmailQueueSweep(deps),
    nextDelayMs: SWEEP_INTERVAL_MS,
    log: deps.log,
  });
  const cleanup = startSweepScheduler({
    name: "email-queue-cleanup",
    task: () => runEmailQueueCleanup(deps),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: deps.log,
  });
  return async () => {
    await Promise.all([sweep.stop(), cleanup.stop()]);
  };
}

async function claimQueuedEmails(db: Db): Promise<EmailQueue[]> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS);
    // Claim rows inside one transaction so multiple API processes can run the
    // sweep without sending the same queued email twice.
    const rows = await tx
      .select()
      .from(emailQueue)
      .where(and(
        lt(emailQueue.retries, MAX_RETRIES),
        or(
          and(
            eq(emailQueue.status, EMAIL_QUEUE_STATUS.queued),
            // Skip rows whose backoff window has not elapsed.
            lte(emailQueue.nextAttemptAt, now),
          ),
          and(
            eq(emailQueue.status, EMAIL_QUEUE_STATUS.immediate),
            or(isNull(emailQueue.processingLeaseExpiresAt), lte(emailQueue.processingLeaseExpiresAt, now)),
          ),
        ),
      ))
      .orderBy(emailQueue.createdAt)
      .limit(SWEEP_BATCH_SIZE)
      .for("update", { skipLocked: true });

    if (rows.length === 0) return [];

    await tx
      .update(emailQueue)
      // Reuse status 99 as the in-flight marker; successful sends become 1,
      // failed sends either return to 0 for retry or move to 2 permanently.
      .set({ status: EMAIL_QUEUE_STATUS.immediate, processingLeaseExpiresAt: leaseExpiresAt, updatedAt: now })
      .where(inArray(emailQueue.id, rows.map((row) => row.id)));

    return rows;
  });
}
