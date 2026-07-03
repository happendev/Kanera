import { EMAIL_QUEUE_STATUS, emailQueue, type BoardRole, type EmailQueue, type SmtpConfig } from "@kanera/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { env } from "../env.js";
import {
  billingChangedEmail,
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
  proTrialStartedEmail,
  proTrialWarningEmail,
  seatBilledEmail,
  upgradedToProEmail,
  verificationCodeEmail,
  welcomeToProEmail,
  welcomeEmail,
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
} from "./email-templates/index.js";
import { sendEmail, type SendEmailOptions } from "./smtp.js";

export interface Mailer {
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
  sendSeatBilled(to: string, params: BillingEmailParams): Promise<EmailQueue>;
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
      .set({ status: EMAIL_QUEUE_STATUS.success, sentAt: new Date(), updatedAt: new Date(), lastError: null })
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
        updatedAt: new Date(),
      })
      .where(eq(emailQueue.id, row.id))
      .returning();
    log.error({ err, emailQueueId: row.id, to: row.toEmail, subject: row.subject }, "failed to send email");
    return updated ?? row;
  }

  return {
    async sendWelcome(to, displayName) {
      const loginUrl = `${webOrigin}/login`;
      // Store queued emails exactly as they will be sent so the queue is an audit trail,
      // including the development subject prefix when applicable.
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("Welcome to Kanera"),
          type: "welcome",
          data: { displayName, loginUrl },
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendPasswordReset(to, displayName, link) {
      // Password reset is the only email that bypasses the background sweep:
      // record it first, then immediately attempt delivery and update this row.
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("Reset your Kanera password"),
          type: "password_reset",
          data: { displayName, resetUrl: link, expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES },
          status: EMAIL_QUEUE_STATUS.immediate,
        })
        .returning();
      try {
        await deliver(row!);
        return await markDelivered(row!);
      } catch (err) {
        return await markFailed(row!, err);
      }
    },

    async sendEmailVerificationCode(to, code, expiresInMinutes) {
      // Like password reset, this bypasses the background sweep: the user is
      // actively waiting on the code, so record the row then deliver immediately.
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("Verify your email for Kanera"),
          type: "email_verification",
          data: { code, expiresInMinutes },
          status: EMAIL_QUEUE_STATUS.immediate,
        })
        .returning();
      try {
        await deliver(row!);
        return await markDelivered(row!);
      } catch (err) {
        return await markFailed(row!, err);
      }
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

      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("Your Kanera due items"),
          type: "daily_digest",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row ?? null;
    },

    async sendCardAssigned(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("You were assigned a Kanera card"),
          type: "card_assigned",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendCardCommentAdded(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject(`New comment on ${params.cardTitle}`),
          type: "card_comment_added",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendCommentMentioned(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject(`Mentioned in a comment on ${params.cardTitle}`),
          type: "comment_mentioned",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendCardDueDateChanged(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("Due date changed on your Kanera card"),
          type: "card_due_date_changed",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendCardOverdue(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("A Kanera card is overdue"),
          type: "card_overdue",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendChecklistItemOverdue(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("A Kanera checklist item is overdue"),
          type: "checklist_item_overdue",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendInviteAccepted(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject("A Kanera invite was accepted"),
          type: "invite_accepted",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendBoardInvite(to, params) {
      const boardSummary = params.boards?.length === 1
        ? params.boards[0]!.boardName
        : params.boards?.length
          ? `${params.boards.length} boards`
          : params.boardName ?? "a board";
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject(`You've been invited to ${boardSummary}`),
          type: "board_invite",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendBoardAccessGranted(to, params) {
      const [row] = await db
        .insert(emailQueue)
        .values({
          toEmail: to,
          subject: emailSubject(`You now have access to ${params.boardName}`),
          type: "board_access_granted",
          data: params,
          status: EMAIL_QUEUE_STATUS.queued,
        })
        .returning();
      return row!;
    },

    async sendProTrialStarted(to, params) {
      return queueBillingEmail(to, "Your Kanera Pro trial has started", "pro_trial_started", params);
    },

    async sendProTrialWarning(to, params) {
      const days = params.daysRemaining ?? 0;
      return queueBillingEmail(to, days === 1 ? "Your Kanera Pro trial ends tomorrow" : `Your Kanera Pro trial ends in ${days} days`, "pro_trial_warning", params);
    },

    async sendDowngradedToFree(to, params) {
      return queueBillingEmail(to, "Kanera moved your organisation to Free", "downgraded_to_free", params);
    },

    async sendUpgradedToPro(to, params) {
      return queueBillingEmail(to, "Kanera Pro is active", "upgraded_to_pro", params);
    },

    async sendWelcomeToPro(to, params) {
      return queueBillingEmail(to, "Welcome to Kanera Pro", "welcome_to_pro", params);
    },

    async sendBillingChanged(to, params) {
      return queueBillingEmail(to, "Your Kanera billing changed", "billing_changed", params);
    },

    async sendSeatBilled(to, params) {
      return queueBillingEmail(to, "A Kanera seat was billed", "seat_billed", params);
    },

    async sendProCancelled(to, params) {
      return queueBillingEmail(to, "Kanera Pro was cancelled", "pro_cancelled", params);
    },
  };

  async function queueBillingEmail(to: string, subject: string, type: EmailQueue["type"], params: BillingEmailParams): Promise<EmailQueue> {
    const [row] = await db
      .insert(emailQueue)
      .values({
        toEmail: to,
        subject: emailSubject(subject),
        type,
        data: params,
        status: EMAIL_QUEUE_STATUS.queued,
      })
      .returning();
    return row!;
  }
}

export function renderEmail(row: EmailQueue): string {
  switch (row.type) {
    case "welcome":
      return welcomeEmail(row.data as { displayName: string; loginUrl: string });
    case "password_reset":
      return passwordResetEmail(row.data as { displayName: string; resetUrl: string; expiresInMinutes: number });
    case "email_verification":
      return verificationCodeEmail(row.data as { code: string; expiresInMinutes: number });
    case "daily_digest":
      return dailyDigestEmail(row.data as DailyDigestEmailParams);
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
    case "seat_billed":
      return seatBilledEmail(row.data as BillingEmailParams);
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
export { resolveSmtpConfig } from "./smtp-resolve.js";
