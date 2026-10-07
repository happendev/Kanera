import { EMAIL_QUEUE_STATUS, emailQueue, type BoardRole, type EmailQueue, type SmtpConfig } from "@kanera/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { env } from "../env.js";
import {
  billingChangedEmail,
  billingPaymentFailedEmail,
  billingPaymentRecoveredEmail,
  billingRenewedEmail,
  adminInviteEmail,
  boardAccessGrantedEmail,
  boardInviteEmail,
  cardAssignedEmail,
  cardCommentAddedEmail,
  cardDueDateChangedEmail,
  cardOverdueEmail,
  checklistItemOverdueEmail,
  commentMentionedEmail,
  dailyDigestEmail,
  downgradedToFreeEmail,
  inviteAcceptedEmail,
  passwordResetEmail,
  proCancelledEmail,
  proCancellationReversedEmail,
  proCancellationScheduledEmail,
  proTrialStartedEmail,
  proTrialWarningEmail,
  seatBilledEmail,
  seatCapacityReducedEmail,
  upgradedToProEmail,
  verificationCodeEmail,
  welcomeToProEmail,
  welcomeEmail,
  weeklyAdminRecapEmail,
  type BillingEmailParams,
  type BoardAccessGrantedEmailParams,
  type BoardInviteEmailParams,
  type CardAssignedEmailParams,
  type CardCommentAddedEmailParams,
  type CardDueDateChangedEmailParams,
  type CardOverdueEmailParams,
  type ChecklistItemOverdueEmailParams,
  type CommentMentionedEmailParams,
  type DailyDigestEmailParams,
  type InviteAcceptedEmailParams,
  type WeeklyAdminRecapEmailParams,
} from "./email-templates/index.js";
import { sendEmail, type SendEmailOptions } from "./smtp.js";

export interface Mailer {
  sendAdminInvite(to: string, displayName: string, link: string): Promise<EmailQueue>;
  sendWelcome(to: string, displayName: string): Promise<EmailQueue>;
  sendPasswordReset(to: string, displayName: string, link: string): Promise<EmailQueue>;
  sendEmailVerificationCode(to: string, code: string, expiresInMinutes: number): Promise<EmailQueue>;
  sendDailyDigest(to: string, memberRole: BoardRole, params: DailyDigestEmailParams): Promise<EmailQueue | null>;
  sendCardAssigned(to: string, params: CardAssignedEmailParams): Promise<EmailQueue>;
  sendCardCommentAdded(to: string, params: CardCommentAddedEmailParams): Promise<EmailQueue>;
  sendCommentMentioned(to: string, params: CommentMentionedEmailParams): Promise<EmailQueue>;
  sendCardDueDateChanged(to: string, params: CardDueDateChangedEmailParams): Promise<EmailQueue>;
  sendCardOverdue(to: string, params: CardOverdueEmailParams): Promise<EmailQueue>;
  sendChecklistItemOverdue(to: string, params: ChecklistItemOverdueEmailParams): Promise<EmailQueue>;
  sendInviteAccepted(to: string, params: InviteAcceptedEmailParams): Promise<EmailQueue>;
  sendBoardInvite(to: string, params: BoardInviteEmailParams): Promise<EmailQueue>;
  sendBoardAccessGranted(to: string, params: BoardAccessGrantedEmailParams): Promise<EmailQueue>;
  sendProTrialStarted(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendProTrialWarning(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendDowngradedToFree(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendUpgradedToPro(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendWelcomeToPro(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendBillingChanged(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendBillingRenewed(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendBillingPaymentFailed(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendBillingPaymentRecovered(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendSeatBilled(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendSeatCapacityReduced(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendProCancellationScheduled(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendProCancellationReversed(to: string, params: BillingEmailParams): Promise<EmailQueue>;
  sendProCancelled(to: string, params: BillingEmailParams): Promise<EmailQueue>;
}

export interface MailerDeps {
  db: Db;
  resolveSmtpConfig: (clientId: string) => Promise<SmtpConfig | null>;
  webOrigin: string;
  log: FastifyBaseLogger;
  sendEmail?: (options: SendEmailOptions) => Promise<void>;
}

const PASSWORD_RESET_EXPIRY_MINUTES = 60;
const DEVELOPMENT_SUBJECT_PREFIX = "[Development] ";
const IMMEDIATE_DELIVERY_LEASE_MS = 15 * 60_000;

export function createMailer({ db, resolveSmtpConfig, webOrigin, log, sendEmail: deliverEmail = sendEmail }: MailerDeps): Mailer {
  async function deliver(row: EmailQueue): Promise<void> {
    const config = await resolveSmtpConfig("__env__");
    if (!config) {
      throw new Error("no SMTP configuration available");
    }
    await deliverEmail({ config, to: row.toEmail, subject: row.subject, html: renderEmail(row) });
    log.info({ emailQueueId: row.id, to: row.toEmail, subject: row.subject }, "email sent");
  }

  async function markDelivered(row: EmailQueue) {
    const [updated] = await db
      .update(emailQueue)
      .set({ status: EMAIL_QUEUE_STATUS.success, sentAt: new Date(), processingLeaseExpiresAt: null, updatedAt: new Date(), lastError: null })
      .where(eq(emailQueue.id, row.id))
      .returning();
    return updated ?? row;
  }

  async function markFailed(row: EmailQueue, err: unknown) {
    const [updated] = await db
      .update(emailQueue)
      .set({
        status: EMAIL_QUEUE_STATUS.error,
        retries: row.retries + 1,
        lastError: errorMessage(err),
        processingLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(emailQueue.id, row.id))
      .returning();
    log.error({ err, emailQueueId: row.id, to: row.toEmail, subject: row.subject }, "failed to send email");
    return updated ?? row;
  }

  return {
    async sendAdminInvite(to, displayName, link) {
      return queueImmediateEmail(to, "You’re invited to administer Kanera", "admin_invite", { displayName, inviteUrl: link, expiresInHours: 24 });
    },
    async sendWelcome(to, displayName) {
      const loginUrl = `${webOrigin}/login`;
      return queueEmail(to, "Welcome to Kanera", "welcome", { displayName, loginUrl });
    },

    async sendPasswordReset(to, displayName, link) {
      return queueImmediateEmail(to, "Reset your Kanera password", "password_reset", { displayName, resetUrl: link, expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES });
    },

    async sendEmailVerificationCode(to, code, expiresInMinutes) {
      return queueImmediateEmail(to, "Verify your email for Kanera", "email_verification", { code, expiresInMinutes });
    },

    async sendDailyDigest(to, memberRole, params) {
      if (!shouldSendDailyDigest(memberRole, params)) return null;
      const [existing] = await db
        .select({ id: emailQueue.id })
        .from(emailQueue)
        .where(and(
          eq(emailQueue.toEmail, to),
          eq(emailQueue.type, "daily_digest"),
          sql`${emailQueue.data}->>'localDate' = ${params.localDate}`,
        ))
        .limit(1);
      if (existing) return null;

      return queueEmail(to, "Your Kanera due items", "daily_digest", params);
    },

    async sendCardAssigned(to, params) {
      return queueEmail(to, "You were assigned a Kanera card", "card_assigned", params);
    },

    async sendCardCommentAdded(to, params) {
      return queueEmail(to, `New comment on ${params.cardTitle}`, "card_comment_added", params);
    },

    async sendCommentMentioned(to, params) {
      return queueEmail(to, `Mentioned in a comment on ${params.cardTitle}`, "comment_mentioned", params);
    },

    async sendCardDueDateChanged(to, params) {
      return queueEmail(to, "Due date changed on your Kanera card", "card_due_date_changed", params);
    },

    async sendCardOverdue(to, params) {
      return queueEmail(to, "A Kanera card is overdue", "card_overdue", params);
    },

    async sendChecklistItemOverdue(to, params) {
      return queueEmail(to, "A Kanera checklist item is overdue", "checklist_item_overdue", params);
    },

    async sendInviteAccepted(to, params) {
      return queueEmail(to, "A Kanera invite was accepted", "invite_accepted", params);
    },

    async sendBoardInvite(to, params) {
      const boardSummary = params.boards.length === 1 ? params.boards[0]!.boardName : `${params.boards.length} boards`;
      return queueEmail(to, `You've been invited to ${boardSummary}`, "board_invite", params);
    },

    async sendBoardAccessGranted(to, params) {
      return queueEmail(to, `You now have access to ${params.boardName}`, "board_access_granted", params);
    },

    async sendProTrialStarted(to, params) {
      return queueEmail(to, "Your Kanera Pro trial has started", "pro_trial_started", params);
    },

    async sendProTrialWarning(to, params) {
      const days = params.daysRemaining ?? 0;
      return queueEmail(to, days === 1 ? "Your Kanera Pro trial ends tomorrow" : `Your Kanera Pro trial ends in ${days} days`, "pro_trial_warning", params);
    },

    async sendDowngradedToFree(to, params) {
      return queueEmail(to, `${params.orgName} is now on Kanera Free`, "downgraded_to_free", params);
    },

    async sendUpgradedToPro(to, params) {
      return queueEmail(to, "Kanera Pro is active", "upgraded_to_pro", params);
    },

    async sendWelcomeToPro(to, params) {
      return queueEmail(to, "Welcome to Kanera Pro", "welcome_to_pro", params);
    },

    async sendBillingChanged(to, params) {
      return queueEmail(to, "Your Kanera Pro subscription was updated", "billing_changed", params);
    },

    async sendBillingRenewed(to, params) {
      return queueEmail(to, "Your Kanera Pro subscription renewed", "billing_renewed", params);
    },

    async sendBillingPaymentFailed(to, params) {
      return queueEmail(to, "Action needed: update your Kanera payment method", "billing_payment_failed", params);
    },

    async sendBillingPaymentRecovered(to, params) {
      return queueEmail(to, "Your Kanera Pro payment is confirmed", "billing_payment_recovered", params);
    },

    async sendSeatBilled(to, params) {
      const subject = params.seatKind ? "A Kanera seat was billed" : "Your Kanera seat purchase is confirmed";
      return queueEmail(to, subject, "seat_billed", params);
    },

    async sendSeatCapacityReduced(to, params) {
      return queueEmail(to, "Your Kanera seat capacity was reduced", "seat_capacity_reduced", params);
    },

    async sendProCancellationScheduled(to, params) {
      return queueEmail(to, `Kanera Pro will end for ${params.orgName}`, "pro_cancellation_scheduled", params);
    },

    async sendProCancellationReversed(to, params) {
      return queueEmail(to, `Kanera Pro will continue for ${params.orgName}`, "pro_cancellation_reversed", params);
    },

    async sendProCancelled(to, params) {
      return queueEmail(to, `${params.orgName} is now on Kanera Free`, "pro_cancelled", params);
    },
  };

  /**
   * Records an email for the background sweep to deliver. Rows are stored exactly as they will be
   * sent (including the development subject prefix) so the queue doubles as an audit trail.
   */
  async function queueEmail(to: string, subject: string, type: EmailQueue["type"], data: EmailQueue["data"]): Promise<EmailQueue> {
    const [row] = await db
      .insert(emailQueue)
      .values({
        toEmail: to,
        subject: emailSubject(subject),
        type,
        data,
        status: EMAIL_QUEUE_STATUS.queued,
      })
      .returning();
    return row!;
  }

  /**
   * Password reset, verification codes and admin invites bypass the sweep: the recipient is waiting
   * on them, so the row is recorded first (with a lease so a concurrent sweep leaves it alone), then
   * delivered immediately and marked on this row.
   */
  async function queueImmediateEmail(to: string, subject: string, type: EmailQueue["type"], data: EmailQueue["data"]): Promise<EmailQueue> {
    const [row] = await db
      .insert(emailQueue)
      .values({
        toEmail: to,
        subject: emailSubject(subject),
        type,
        data,
        status: EMAIL_QUEUE_STATUS.immediate,
        processingLeaseExpiresAt: new Date(Date.now() + IMMEDIATE_DELIVERY_LEASE_MS),
      })
      .returning();
    try {
      await deliver(row!);
      return await markDelivered(row!);
    } catch (err) {
      return await markFailed(row!, err);
    }
  }
}

export function renderEmail(row: EmailQueue): string {
  switch (row.type) {
    case "admin_invite":
      return adminInviteEmail(row.data as { displayName: string; inviteUrl: string; expiresInHours: number });
    case "welcome":
      return welcomeEmail(row.data as { displayName: string; loginUrl: string });
    case "password_reset":
      return passwordResetEmail(row.data as { displayName: string; resetUrl: string; expiresInMinutes: number });
    case "email_verification":
      return verificationCodeEmail(row.data as { code: string; expiresInMinutes: number });
    case "daily_digest":
      return dailyDigestEmail(row.data as DailyDigestEmailParams);
    case "weekly_admin_recap":
      return weeklyAdminRecapEmail(row.data as WeeklyAdminRecapEmailParams);
    case "card_assigned":
      return cardAssignedEmail(row.data as CardAssignedEmailParams);
    case "card_comment_added":
      return cardCommentAddedEmail(row.data as CardCommentAddedEmailParams);
    case "comment_mentioned":
      return commentMentionedEmail(row.data as CommentMentionedEmailParams);
    case "card_due_date_changed":
      return cardDueDateChangedEmail(row.data as CardDueDateChangedEmailParams);
    case "card_overdue":
      return cardOverdueEmail(row.data as CardOverdueEmailParams);
    case "checklist_item_overdue":
      return checklistItemOverdueEmail(row.data as ChecklistItemOverdueEmailParams);
    case "invite_accepted":
      return inviteAcceptedEmail(row.data as InviteAcceptedEmailParams);
    case "board_invite":
      return boardInviteEmail(row.data as BoardInviteEmailParams);
    case "board_access_granted":
      return boardAccessGrantedEmail(row.data as BoardAccessGrantedEmailParams);
    case "pro_trial_started":
      return proTrialStartedEmail(row.data as BillingEmailParams);
    case "pro_trial_warning":
      return proTrialWarningEmail(row.data as BillingEmailParams);
    case "downgraded_to_free":
      return downgradedToFreeEmail(row.data as BillingEmailParams);
    case "upgraded_to_pro":
      return upgradedToProEmail(row.data as BillingEmailParams);
    case "welcome_to_pro":
      return welcomeToProEmail(row.data as BillingEmailParams);
    case "billing_changed":
      return billingChangedEmail(row.data as BillingEmailParams);
    case "billing_renewed":
      return billingRenewedEmail(row.data as BillingEmailParams);
    case "billing_payment_failed":
      return billingPaymentFailedEmail(row.data as BillingEmailParams);
    case "billing_payment_recovered":
      return billingPaymentRecoveredEmail(row.data as BillingEmailParams);
    case "seat_billed":
      return seatBilledEmail(row.data as BillingEmailParams);
    case "seat_capacity_reduced":
      return seatCapacityReducedEmail(row.data as BillingEmailParams);
    case "pro_cancellation_scheduled":
      return proCancellationScheduledEmail(row.data as BillingEmailParams);
    case "pro_cancellation_reversed":
      return proCancellationReversedEmail(row.data as BillingEmailParams);
    case "pro_cancelled":
      return proCancelledEmail(row.data as BillingEmailParams);
  }
}

export function errorMessage(err: unknown): string {
  return Error.isError(err) ? err.message : String(err);
}

export function shouldSendDailyDigest(memberRole: BoardRole, params: DailyDigestEmailParams): boolean {
  if (memberRole === "observer") return false;
  return params.dueToday.length > 0 || params.overdue.length > 0;
}

export function emailSubject(subject: string, nodeEnv = env.NODE_ENV): string {
  // Prefix at enqueue time so development emails remain obvious in SMTP logs
  // and in email_queue inspection, without double-prefixing retries.
  if (nodeEnv !== "development") return subject;
  if (subject.startsWith(DEVELOPMENT_SUBJECT_PREFIX)) return subject;
  return `${DEVELOPMENT_SUBJECT_PREFIX}${subject}`;
}

/**
 * Resolve SMTP config for a given client, falling back to env-level config.
 * The special client ID "__env__" skips the DB lookup and goes straight to env.
 */
