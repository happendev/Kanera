import type { Locale } from "@kanera/shared/locales";
import { EMAIL_QUEUE_STATUS, emailQueue, type BoardRole, type EmailQueue, type LifecycleEmailQueueType, type SmtpConfig } from "@kanera/shared/schema";
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
  boardInviteEmailSubject,
  cardAssignedEmail,
  cardCommentAddedEmail,
  cardDueDateChangedEmail,
  cardDueDateChangedSubject,
  cardOverdueEmail,
  cardReminderEmail,
  checklistItemOverdueEmail,
  commentMentionedEmail,
  reactionAddedEmail,
  cardDependencyAddedEmail,
  cardUnblockedEmail,
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
  seatBilledEmailSubject,
  seatCapacityReducedEmail,
  storageWarningEmail,
  upgradedToProEmail,
  verificationCodeEmail,
  welcomeToProEmail,
  welcomeEmail,
  weeklyAdminRecapEmail,
  importCompletedEmail,
  lifecycleActiveCheckinEmail,
  lifecycleEarlySuccessEmail,
  lifecycleEmailSubject,
  lifecycleInactiveEmail,
  lifecycleInviteTeamEmail,
  lifecycleNoBoardEmail,
  type AdminInviteEmailParams,
  type ImportCompletedEmailParams,
  type PasswordResetEmailParams,
  type VerificationCodeEmailParams,
  type WelcomeEmailParams,
  type LifecycleEmailParams,
  type BillingEmailParams,
  type BoardAccessGrantedEmailParams,
  type BoardInviteEmailParams,
  type CardAssignedEmailParams,
  type CardCommentAddedEmailParams,
  type CardDueDateChangedEmailParams,
  type CardOverdueEmailParams,
  type CardReminderEmailParams,
  type ChecklistItemOverdueEmailParams,
  type CommentMentionedEmailParams,
  type ReactionAddedEmailParams,
  type CardDependencyAddedEmailParams,
  type CardUnblockedEmailParams,
  type DailyDigestEmailParams,
  type InviteAcceptedEmailParams,
  type StorageWarningEmailParams,
  type WeeklyAdminRecapEmailParams,
} from "./email-templates/index.js";
import { serverMessages } from "./i18n/messages/index.js";
import { recipientLocale } from "./i18n/request-locale.js";
import { sendEmail, SmtpReplyError, type SendEmailOptions } from "./smtp.js";

/**
 * Every send takes the recipient's language (`locale`, directly or in `params`), resolved by the
 * caller: the recipient's stored `users.locale` via `recipientLocale`, or for someone with no account
 * yet, the requester's language (see lib/i18n/README.md). It is stored on the queue row, so the
 * subject and the body the worker renders later are in the same language.
 */
export interface Mailer {
  sendAdminInvite(to: string, displayName: string, link: string, locale: Locale): Promise<EmailQueue>;
  sendWelcome(to: string, displayName: string, locale: Locale): Promise<EmailQueue>;
  sendPasswordReset(to: string, displayName: string, link: string, locale: Locale): Promise<EmailQueue>;
  sendEmailVerificationCode(to: string, code: string, expiresInMinutes: number, locale: Locale): Promise<EmailQueue>;
  sendDailyDigest(to: string, memberRole: BoardRole, params: DailyDigestEmailParams): Promise<EmailQueue | null>;
  sendCardAssigned(to: string, params: CardAssignedEmailParams): Promise<EmailQueue>;
  sendCardCommentAdded(to: string, params: CardCommentAddedEmailParams): Promise<EmailQueue>;
  sendCommentMentioned(to: string, params: CommentMentionedEmailParams): Promise<EmailQueue>;
  sendReactionAdded(to: string, params: ReactionAddedEmailParams): Promise<EmailQueue>;
  sendCardDependencyAdded(to: string, params: CardDependencyAddedEmailParams): Promise<EmailQueue>;
  sendCardUnblocked(to: string, params: CardUnblockedEmailParams): Promise<EmailQueue>;
  sendCardDueDateChanged(to: string, params: CardDueDateChangedEmailParams): Promise<EmailQueue>;
  sendCardOverdue(to: string, params: CardOverdueEmailParams): Promise<EmailQueue>;
  sendCardReminder(to: string, params: CardReminderEmailParams): Promise<EmailQueue>;
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
  sendImportCompleted(to: string, params: ImportCompletedEmailParams): Promise<EmailQueue>;
  sendStorageWarning(to: string, params: StorageWarningEmailParams): Promise<EmailQueue>;
  sendLifecycle(to: string, type: LifecycleEmailQueueType, params: LifecycleEmailParams): Promise<EmailQueue>;
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
    assertDeliverableRecipient(row.toEmail);
    await deliverEmail({ config, to: row.toEmail, subject: row.subject, html: renderEmail(row), headers: emailHeaders(row) });
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
    if (permanentEmailFailure(err)) log.warn({ err, emailQueueId: row.id, to: row.toEmail, subject: row.subject }, "email recipient rejected permanently");
    else log.error({ err, emailQueueId: row.id, to: row.toEmail, subject: row.subject }, "failed to send email");
    return updated ?? row;
  }

  return {
    async sendAdminInvite(to, displayName, link, locale) {
      return queueImmediateEmail(to, mail(locale).adminInvite.subject, "admin_invite", { locale, displayName, inviteUrl: link, expiresInHours: 24 });
    },
    async sendWelcome(to, displayName, locale) {
      const loginUrl = `${webOrigin}/login`;
      return queueEmail(to, mail(locale).welcome.subject, "welcome", { locale, displayName, loginUrl });
    },

    async sendPasswordReset(to, displayName, link, locale) {
      return queueImmediateEmail(to, mail(locale).passwordReset.subject, "password_reset", { locale, displayName, resetUrl: link, expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES });
    },

    async sendEmailVerificationCode(to, code, expiresInMinutes, locale) {
      return queueImmediateEmail(to, mail(locale).verificationCode.subject, "email_verification", { locale, code, expiresInMinutes });
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

      return queueEmail(to, mail(params.locale).dailyDigest.subject, "daily_digest", params);
    },

    async sendCardAssigned(to, params) {
      return queueEmail(to, mail(params.locale).cardAssigned.subject, "card_assigned", params);
    },

    async sendCardCommentAdded(to, params) {
      return queueEmail(to, mail(params.locale).cardCommentAdded.subject({ card: params.cardTitle }), "card_comment_added", params);
    },

    async sendCommentMentioned(to, params) {
      return queueEmail(to, mail(params.locale).commentMentioned.subject({ card: params.cardTitle }), "comment_mentioned", params);
    },

    async sendReactionAdded(to, params) {
      return queueEmail(to, mail(params.locale).reactionAdded.subject({ actor: params.actorName, card: params.cardTitle }), "reaction_added", params);
    },

    async sendCardDependencyAdded(to, params) {
      const m = mail(params.locale).cardDependencyAdded;
      const values = { card: params.cardTitle, other: params.otherCardTitle ? `${params.otherCardKey} ${params.otherCardTitle}` : params.otherCardKey };
      return queueEmail(to, params.direction === "blocked_by" ? m.subjectBlockedBy(values) : m.subjectBlocking(values), "card_dependency_added", params);
    },

    async sendCardUnblocked(to, params) {
      const m = mail(params.locale).cardUnblocked;
      return queueEmail(to, params.reblocked ? m.subjectReblocked({ card: params.cardTitle }) : m.subject({ card: params.cardTitle }), "card_unblocked", params);
    },

    async sendCardDueDateChanged(to, params) {
      return queueEmail(to, cardDueDateChangedSubject(params), "card_due_date_changed", params);
    },

    async sendCardOverdue(to, params) {
      return queueEmail(to, mail(params.locale).cardOverdue.subject, "card_overdue", params);
    },

    async sendCardReminder(to, params) {
      return queueEmail(to, mail(params.locale).cardReminder.subject, "card_reminder", params);
    },

    async sendChecklistItemOverdue(to, params) {
      return queueEmail(to, mail(params.locale).checklistItemOverdue.subject, "checklist_item_overdue", params);
    },

    async sendInviteAccepted(to, params) {
      return queueEmail(to, mail(params.locale).inviteAccepted.subject, "invite_accepted", params);
    },

    async sendBoardInvite(to, params) {
      return queueEmail(to, boardInviteEmailSubject(params), "board_invite", params);
    },

    async sendBoardAccessGranted(to, params) {
      return queueEmail(to, mail(params.locale).boardAccessGranted.subject({ board: params.boardName }), "board_access_granted", params);
    },

    async sendProTrialStarted(to, params) {
      return queueEmail(to, billing(params).trialStarted.subject, "pro_trial_started", params);
    },

    async sendProTrialWarning(to, params) {
      return queueEmail(to, billing(params).trialWarning.subject({ days: params.daysRemaining ?? 0 }), "pro_trial_warning", params);
    },

    async sendDowngradedToFree(to, params) {
      return queueEmail(to, billing(params).downgradedToFree.subject({ org: params.orgName }), "downgraded_to_free", params);
    },

    async sendUpgradedToPro(to, params) {
      return queueEmail(to, billing(params).upgradedToPro.subject, "upgraded_to_pro", params);
    },

    async sendWelcomeToPro(to, params) {
      return queueEmail(to, billing(params).welcomeToPro.subject, "welcome_to_pro", params);
    },

    async sendBillingChanged(to, params) {
      return queueEmail(to, billing(params).changed.subject, "billing_changed", params);
    },

    async sendBillingRenewed(to, params) {
      return queueEmail(to, billing(params).renewed.subject, "billing_renewed", params);
    },

    async sendBillingPaymentFailed(to, params) {
      return queueEmail(to, billing(params).paymentFailed.subject, "billing_payment_failed", params);
    },

    async sendBillingPaymentRecovered(to, params) {
      return queueEmail(to, billing(params).paymentRecovered.subject, "billing_payment_recovered", params);
    },

    async sendSeatBilled(to, params) {
      return queueEmail(to, seatBilledEmailSubject(params), "seat_billed", params);
    },

    async sendSeatCapacityReduced(to, params) {
      return queueEmail(to, billing(params).seatCapacityReduced.subject, "seat_capacity_reduced", params);
    },

    async sendProCancellationScheduled(to, params) {
      return queueEmail(to, billing(params).cancellationScheduled.subject({ org: params.orgName }), "pro_cancellation_scheduled", params);
    },

    async sendProCancellationReversed(to, params) {
      return queueEmail(to, billing(params).cancellationReversed.subject({ org: params.orgName }), "pro_cancellation_reversed", params);
    },

    async sendProCancelled(to, params) {
      return queueEmail(to, billing(params).cancelled.subject({ org: params.orgName }), "pro_cancelled", params);
    },

    async sendImportCompleted(to, params) {
      return queueEmail(to, mail(params.locale).importCompleted.subject, "import_completed", params);
    },

    async sendStorageWarning(to, params) {
      return queueEmail(to, mail(params.locale).storageWarning.subject({ org: params.orgName }), "storage_warning", params);
    },

    async sendLifecycle(to, type, params) {
      return queueEmail(to, lifecycleEmailSubject(type, params), type, params);
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

/**
 * Lifecycle emails are optional product mail, so they carry RFC 2369/8058 one-click unsubscribe
 * headers. Mail providers show their own "Unsubscribe" control for these and POST to the API URL
 * directly (no page, no session); the mailto-free HTTPS form is what Gmail and Yahoo require. The
 * web page link stays second for clients that only open URLs. Transactional mail gets no headers.
 */
export function emailHeaders(row: EmailQueue): Record<string, string> | undefined {
  if (!row.type.startsWith("lifecycle_")) return undefined;
  const pageUrl = (row.data as LifecycleEmailParams).unsubscribeUrl;
  const token = pageUrl ? new URL(pageUrl).searchParams.get("token") : null;
  if (!token) return undefined;
  const oneClickUrl = `${env.API_PUBLIC_URL}/api/email/unsubscribe/one-click?token=${encodeURIComponent(token)}`;
  return {
    "List-Unsubscribe": `<${oneClickUrl}>, <${pageUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function mail(locale: Locale) {
  return serverMessages(locale).email;
}

function billing(params: { locale: Locale }) {
  return serverMessages(params.locale).email.billing;
}

export function renderEmail(row: EmailQueue): string {
  // Rows queued before localisation carry no locale; they render in the source language they were
  // queued in (and their stored subject already is).
  const data = { ...row.data, locale: recipientLocale(row.data.locale) };
  switch (row.type) {
    case "admin_invite":
      return adminInviteEmail(data as AdminInviteEmailParams);
    case "welcome":
      return welcomeEmail(data as WelcomeEmailParams);
    case "password_reset":
      return passwordResetEmail(data as PasswordResetEmailParams);
    case "email_verification":
      return verificationCodeEmail(data as VerificationCodeEmailParams);
    case "daily_digest":
      return dailyDigestEmail(data as DailyDigestEmailParams);
    case "weekly_admin_recap":
      return weeklyAdminRecapEmail(data as WeeklyAdminRecapEmailParams);
    case "card_assigned":
      return cardAssignedEmail(data as CardAssignedEmailParams);
    case "card_comment_added":
      return cardCommentAddedEmail(data as CardCommentAddedEmailParams);
    case "comment_mentioned":
      return commentMentionedEmail(data as CommentMentionedEmailParams);
    case "reaction_added":
      return reactionAddedEmail(data as ReactionAddedEmailParams);
    case "card_dependency_added":
      return cardDependencyAddedEmail(data as CardDependencyAddedEmailParams);
    case "card_unblocked":
      return cardUnblockedEmail(data as CardUnblockedEmailParams);
    case "card_due_date_changed":
      return cardDueDateChangedEmail(data as CardDueDateChangedEmailParams);
    case "card_overdue":
      return cardOverdueEmail(data as CardOverdueEmailParams);
    case "card_reminder":
      return cardReminderEmail(data as CardReminderEmailParams);
    case "checklist_item_overdue":
      return checklistItemOverdueEmail(data as ChecklistItemOverdueEmailParams);
    case "invite_accepted":
      return inviteAcceptedEmail(data as InviteAcceptedEmailParams);
    case "board_invite":
      return boardInviteEmail(data as BoardInviteEmailParams);
    case "board_access_granted":
      return boardAccessGrantedEmail(data as BoardAccessGrantedEmailParams);
    case "pro_trial_started":
      return proTrialStartedEmail(data as BillingEmailParams);
    case "pro_trial_warning":
      return proTrialWarningEmail(data as BillingEmailParams);
    case "downgraded_to_free":
      return downgradedToFreeEmail(data as BillingEmailParams);
    case "upgraded_to_pro":
      return upgradedToProEmail(data as BillingEmailParams);
    case "welcome_to_pro":
      return welcomeToProEmail(data as BillingEmailParams);
    case "billing_changed":
      return billingChangedEmail(data as BillingEmailParams);
    case "billing_renewed":
      return billingRenewedEmail(data as BillingEmailParams);
    case "billing_payment_failed":
      return billingPaymentFailedEmail(data as BillingEmailParams);
    case "billing_payment_recovered":
      return billingPaymentRecoveredEmail(data as BillingEmailParams);
    case "seat_billed":
      return seatBilledEmail(data as BillingEmailParams);
    case "seat_capacity_reduced":
      return seatCapacityReducedEmail(data as BillingEmailParams);
    case "pro_cancellation_scheduled":
      return proCancellationScheduledEmail(data as BillingEmailParams);
    case "pro_cancellation_reversed":
      return proCancellationReversedEmail(data as BillingEmailParams);
    case "pro_cancelled":
      return proCancelledEmail(data as BillingEmailParams);
    case "import_completed":
      return importCompletedEmail(data as ImportCompletedEmailParams);
    case "storage_warning":
      return storageWarningEmail(data as StorageWarningEmailParams);
    case "lifecycle_no_board":
      return lifecycleNoBoardEmail(data as LifecycleEmailParams);
    case "lifecycle_invite_team":
      return lifecycleInviteTeamEmail(data as LifecycleEmailParams);
    case "lifecycle_early_success":
      return lifecycleEarlySuccessEmail(data as LifecycleEmailParams);
    case "lifecycle_inactive":
      return lifecycleInactiveEmail(data as LifecycleEmailParams);
    case "lifecycle_active_checkin":
      return lifecycleActiveCheckinEmail(data as LifecycleEmailParams);
  }
}

// RFC 2606 / RFC 6761 names that can never receive mail. Demo and seed accounts use them, and a
// production SMTP relay rejects them with a permanent 5xx, so they are refused before any send.
const RESERVED_EMAIL_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_EMAIL_DOMAINS = ["example.com", "example.net", "example.org"];

export function isReservedEmailDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return RESERVED_EMAIL_TLDS.has(tld) || RESERVED_EMAIL_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`));
}

class UndeliverableRecipientError extends Error {
  override name = "UndeliverableRecipientError";
}

/**
 * Production only: development and E2E deliver reserved-domain seed users to a local mail catcher,
 * which is how their verification and reset emails are read.
 */
export function assertDeliverableRecipient(email: string, environment = env.KANERA_ENVIRONMENT): void {
  if (environment === "production" && isReservedEmailDomain(email)) {
    throw new UndeliverableRecipientError(`recipient ${email} uses a reserved domain (RFC 2606); not sent`);
  }
}

/**
 * Failures that retrying the same row cannot fix. "suppressed" is a reserved recipient refused
 * before any send (expected for demo/seed users, not an incident); "rejected" is the server refusing
 * the recipient itself (5xx to RCPT TO). A 5xx at connect, AUTH or MAIL FROM is a relay or
 * configuration fault that affects every email, so it returns null and stays retryable.
 */
export function permanentEmailFailure(err: unknown): "suppressed" | "rejected" | null {
  if (err instanceof UndeliverableRecipientError) return "suppressed";
  if (err instanceof SmtpReplyError && err.stage === "RCPT" && err.code >= 500 && err.code < 600) return "rejected";
  return null;
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
