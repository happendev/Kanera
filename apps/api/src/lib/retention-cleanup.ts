import {
  activityEvents,
  adminAuditLogs,
  adminInvites,
  adminRefreshTokens,
  boardInvitations,
  emailVerificationCodes,
  inviteTokens,
  notifications,
  passwordResetTokens,
  refreshTokens,
} from "@kanera/shared/schema";
import { and, isNotNull, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1,440 minutes

export interface RetentionCleanupDeps {
  db: Db;
  log: FastifyBaseLogger;
}

const daysMs = (days: number) => days * 24 * 60 * 60 * 1000;
const cutoffFrom = (now: Date, days: number) => new Date(now.getTime() - daysMs(days));

/**
 * activity_event is the single largest long-term growth source — a row per board/card/list/comment
 * mutation, never otherwise pruned. Notifications reference activity via ON DELETE CASCADE, but this
 * sweep runs notification cleanup first with a shorter window, so any notification pointing at a
 * to-be-pruned activity row is already gone by the time we get here.
 */
export async function runActivityRetentionCleanup({ db, log }: RetentionCleanupDeps, now = new Date()): Promise<number> {
  const cutoff = cutoffFrom(now, env.ACTIVITY_EVENT_RETENTION_DAYS);
  const deleted = await db.delete(activityEvents).where(lt(activityEvents.createdAt, cutoff)).returning({ id: activityEvents.id });
  if (deleted.length > 0) {
    log.info({ deletedCount: deleted.length, retentionDays: env.ACTIVITY_EVENT_RETENTION_DAYS }, "purged activity events past retention");
  }
  return deleted.length;
}

/** Admin-console audit trail. Compliance-sensitive, so the default window is long (3 years). */
export async function runAdminAuditRetentionCleanup({ db, log }: RetentionCleanupDeps, now = new Date()): Promise<number> {
  const cutoff = cutoffFrom(now, env.ADMIN_AUDIT_LOG_RETENTION_DAYS);
  const deleted = await db.delete(adminAuditLogs).where(lt(adminAuditLogs.createdAt, cutoff)).returning({ id: adminAuditLogs.id });
  if (deleted.length > 0) {
    log.info({ deletedCount: deleted.length, retentionDays: env.ADMIN_AUDIT_LOG_RETENTION_DAYS }, "purged admin audit logs past retention");
  }
  return deleted.length;
}

/**
 * Two-part notification retention: read notifications are pruned on the short window, and a longer
 * max window clears never-read stragglers so the table can't grow forever for a user who never opens
 * their inbox. Both deletes cascade cleanly since notifications hold no dependents.
 */
export async function runNotificationRetentionCleanup({ db, log }: RetentionCleanupDeps, now = new Date()): Promise<number> {
  const readCutoff = cutoffFrom(now, env.NOTIFICATION_READ_RETENTION_DAYS);
  const maxCutoff = cutoffFrom(now, env.NOTIFICATION_MAX_RETENTION_DAYS);
  const deleted = await db
    .delete(notifications)
    .where(
      or(
        and(isNotNull(notifications.readAt), lt(notifications.readAt, readCutoff)),
        lt(notifications.createdAt, maxCutoff),
      ),
    )
    .returning({ id: notifications.id });
  if (deleted.length > 0) {
    log.info(
      { deletedCount: deleted.length, readRetentionDays: env.NOTIFICATION_READ_RETENTION_DAYS, maxRetentionDays: env.NOTIFICATION_MAX_RETENTION_DAYS },
      "purged notifications past retention",
    );
  }
  return deleted.length;
}

/**
 * A token/invite is safe to delete once it can no longer be used (expired, or terminal via
 * used/consumed/revoked/accepted) AND that terminal moment is older than the grace window. The grace
 * (a single cutoff) keeps just-expired rows briefly for debugging and avoids racing rows near expiry.
 * `expiresAt` is nullable on invite tables (open-ended invites), so an expiry predicate is only added
 * when the column exists and is non-null.
 */
export async function runAuthTokenRetentionCleanup({ db, log }: RetentionCleanupDeps, now = new Date()): Promise<number> {
  const cutoff = cutoffFrom(now, env.AUTH_TOKEN_RETENTION_DAYS);

  // Each terminal-timestamp column contributes a `column < cutoff` predicate; a row is purged if any
  // holds (i.e. it went terminal before the grace cutoff). `expiresAt` on the invite tables is
  // nullable, so `lt` naturally skips rows with no expiry — those only clear via revoke/accept.
  const terminalBefore = (columns: PgColumn[]): SQL => {
    const predicates = columns.map((column) => lt(column, cutoff));
    return predicates.length === 1 ? predicates[0]! : or(...predicates)!;
  };

  const [refresh, adminRefresh, emailCode, passwordReset, invite, adminInvite, boardInvite] = await Promise.all([
    db.delete(refreshTokens).where(terminalBefore([refreshTokens.expiresAt, refreshTokens.revokedAt])).returning({ id: refreshTokens.id }),
    db.delete(adminRefreshTokens).where(terminalBefore([adminRefreshTokens.expiresAt, adminRefreshTokens.revokedAt])).returning({ id: adminRefreshTokens.id }),
    db.delete(emailVerificationCodes).where(terminalBefore([emailVerificationCodes.expiresAt, emailVerificationCodes.consumedAt])).returning({ id: emailVerificationCodes.id }),
    db.delete(passwordResetTokens).where(terminalBefore([passwordResetTokens.expiresAt, passwordResetTokens.usedAt])).returning({ id: passwordResetTokens.id }),
    db.delete(inviteTokens).where(terminalBefore([inviteTokens.expiresAt, inviteTokens.revokedAt])).returning({ id: inviteTokens.id }),
    db.delete(adminInvites).where(terminalBefore([adminInvites.expiresAt, adminInvites.acceptedAt, adminInvites.revokedAt])).returning({ id: adminInvites.id }),
    db.delete(boardInvitations).where(terminalBefore([boardInvitations.expiresAt, boardInvitations.acceptedAt, boardInvitations.revokedAt])).returning({ id: boardInvitations.id }),
  ]);

  const byTable = {
    refresh_token: refresh.length,
    admin_refresh_token: adminRefresh.length,
    email_verification_code: emailCode.length,
    password_reset_token: passwordReset.length,
    invite_token: invite.length,
    admin_invite: adminInvite.length,
    board_invitation: boardInvite.length,
  };
  const total = Object.values(byTable).reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    log.info({ deletedCount: total, byTable, retentionDays: env.AUTH_TOKEN_RETENTION_DAYS }, "purged terminal auth tokens past retention");
  }
  return total;
}

/**
 * One daily sweep that runs every retention cleanup. Notification cleanup runs before activity cleanup
 * because notifications cascade from activity — pruning notifications first keeps their (shorter)
 * retention window authoritative rather than having them silently vanish with their activity row.
 */
export function startRetentionCleanupScheduler(deps: RetentionCleanupDeps): () => void {
  return startSweepScheduler({
    name: "retention-cleanup",
    task: async () => {
      await runNotificationRetentionCleanup(deps);
      await runActivityRetentionCleanup(deps);
      await runAdminAuditRetentionCleanup(deps);
      await runAuthTokenRetentionCleanup(deps);
    },
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: deps.log,
  }).stop;
}
