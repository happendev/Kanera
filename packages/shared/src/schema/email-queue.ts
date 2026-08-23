import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";

export const EMAIL_QUEUE_TYPES = [
  "admin_invite",
  "welcome",
  "password_reset",
  "email_verification",
  "daily_digest",
  "card_assigned",
  "card_comment_added",
  "comment_mentioned",
  "card_due_date_changed",
  "card_overdue",
  "checklist_item_overdue",
  "invite_accepted",
  "board_invite",
  "board_access_granted",
  "pro_trial_started",
  "pro_trial_warning",
  "downgraded_to_free",
  "upgraded_to_pro",
  "welcome_to_pro",
  "billing_changed",
  "billing_renewed",
  "billing_payment_failed",
  "billing_payment_recovered",
  "seat_billed",
  "seat_capacity_reduced",
  "pro_cancellation_scheduled",
  "pro_cancellation_reversed",
  "pro_cancelled",
] as const;
export type EmailQueueType = (typeof EMAIL_QUEUE_TYPES)[number];

export const EMAIL_QUEUE_STATUS = {
  queued: "queued",
  success: "success",
  error: "error",
  immediate: "immediate",
} as const;

export type EmailQueueStatus = (typeof EMAIL_QUEUE_STATUS)[keyof typeof EMAIL_QUEUE_STATUS];
export const EMAIL_QUEUE_STATUSES = Object.values(EMAIL_QUEUE_STATUS) as [
  EmailQueueStatus,
  ...EmailQueueStatus[],
];

export type WelcomeEmailQueueData = {
  displayName: string;
  loginUrl: string;
};

export type AdminInviteEmailQueueData = {
  displayName: string;
  inviteUrl: string;
  expiresInHours: number;
};

export type PasswordResetEmailQueueData = {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
};

export type EmailVerificationEmailQueueData = {
  code: string;
  expiresInMinutes: number;
};

export type DailyDigestEmailQueueData = {
  displayName: string;
  localDate: string;
  localDateLabel: string;
  dueToday: {
    title: string;
    boardName: string;
    cardUrl: string;
    dueLabel?: string | null;
  }[];
  overdue: {
    title: string;
    boardName: string;
    cardUrl: string;
    dueLabel?: string | null;
  }[];
  /**
   * The head of the recipient's own "Up next" queue, in queue order.
   *
   * Optional because this column is durable: rows queued before the section existed are still
   * waiting for the worker, and they must render without it rather than throw.
   */
  priorities?: {
    /** 1-based over the recipient's whole live queue, so #3 in the email is #3 in the app. */
    rank: number;
    title: string;
    boardName: string;
    cardUrl: string;
    dueLabel?: string | null;
  }[];
};

export type CardAssignedEmailQueueData = {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
};

export type CardCommentAddedEmailQueueData = {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentExcerpt: string;
};

export type CommentMentionedEmailQueueData = {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentExcerpt: string;
};

export type CardDueDateChangedEmailQueueData = {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  previousDueLabel: string | null;
  nextDueLabel: string | null;
};

export type CardOverdueEmailQueueData = {
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  dueLabel: string | null;
};

export type ChecklistItemOverdueEmailQueueData = {
  displayName: string;
  itemText: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  dueLabel: string | null;
};

export type InviteAcceptedEmailQueueData = {
  context?: "org";
  displayName: string;
  acceptedByName: string;
  acceptedByEmail: string;
  orgName: string;
  orgRole: string;
  membersUrl: string;
} | {
  context: "board";
  displayName: string;
  acceptedByName: string;
  acceptedByEmail: string;
  orgName: string;
  boardName: string;
  boardRole: string;
  boardUrl: string;
};

export type BoardInviteEmailQueueData = {
  boards?: Array<{ boardName: string; role: string }>;
  boardName?: string;
  role?: string;
  orgName: string;
  invitedByName: string;
  acceptUrl: string;
};

export type BoardAccessGrantedEmailQueueData = {
  displayName: string;
  boardName: string;
  orgName: string;
  invitedByName: string;
  role: string;
  boardUrl: string;
};

export type BillingImpactSummary = {
  boardsArchived: number;
  usersSuspended: number;
  automationsDisabled: number;
  webhooksDisabled: number;
  apiKeysRevoked: number;
  guestMembersRemoved: number;
  guestInvitesRevoked: number;
};

export type BillingLimitsSummary = {
  maxBoards: number;
  maxOrgMembers: number;
  maxEnabledAutomations: number;
  maxAutomationExecutionsPerMonth: number;
};

export type BillingEmailQueueData = {
  clientId: string;
  dedupeKey?: string | null;
  displayName: string;
  orgName: string;
  settingsUrl: string;
  trialEndsAtLabel?: string | null;
  daysRemaining?: number | null;
  impact?: BillingImpactSummary | null;
  limits?: BillingLimitsSummary | null;
  billingSummary?: string | null;
  billingInterval?: "monthly" | "annual" | null;
  purchasedSeatCount?: number | null;
  previousPurchasedSeatCount?: number | null;
  periodEndLabel?: string | null;
  seatKind?: "member" | "guest" | null;
  billedUserEmail?: string | null;
  billedUserName?: string | null;
  activeSeatCount?: number | null;
};

export type EmailQueueData =
  | { type: "admin_invite"; data: AdminInviteEmailQueueData }
  | { type: "welcome"; data: WelcomeEmailQueueData }
  | { type: "password_reset"; data: PasswordResetEmailQueueData }
  | { type: "email_verification"; data: EmailVerificationEmailQueueData }
  | { type: "daily_digest"; data: DailyDigestEmailQueueData }
  | { type: "card_assigned"; data: CardAssignedEmailQueueData }
  | { type: "card_comment_added"; data: CardCommentAddedEmailQueueData }
  | { type: "comment_mentioned"; data: CommentMentionedEmailQueueData }
  | { type: "card_due_date_changed"; data: CardDueDateChangedEmailQueueData }
  | { type: "card_overdue"; data: CardOverdueEmailQueueData }
  | { type: "checklist_item_overdue"; data: ChecklistItemOverdueEmailQueueData }
  | { type: "invite_accepted"; data: InviteAcceptedEmailQueueData }
  | { type: "board_invite"; data: BoardInviteEmailQueueData }
  | { type: "board_access_granted"; data: BoardAccessGrantedEmailQueueData }
  | { type: "pro_trial_started"; data: BillingEmailQueueData }
  | { type: "pro_trial_warning"; data: BillingEmailQueueData }
  | { type: "downgraded_to_free"; data: BillingEmailQueueData }
  | { type: "upgraded_to_pro"; data: BillingEmailQueueData }
  | { type: "welcome_to_pro"; data: BillingEmailQueueData }
  | { type: "billing_changed"; data: BillingEmailQueueData }
  | { type: "billing_renewed"; data: BillingEmailQueueData }
  | { type: "billing_payment_failed"; data: BillingEmailQueueData }
  | { type: "billing_payment_recovered"; data: BillingEmailQueueData }
  | { type: "seat_billed"; data: BillingEmailQueueData }
  | { type: "seat_capacity_reduced"; data: BillingEmailQueueData }
  | { type: "pro_cancellation_scheduled"; data: BillingEmailQueueData }
  | { type: "pro_cancellation_reversed"; data: BillingEmailQueueData }
  | { type: "pro_cancelled"; data: BillingEmailQueueData };

export const emailQueue = pgTable(
  "email_queue",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    type: text("type", { enum: EMAIL_QUEUE_TYPES }).notNull(),
    data: jsonb("data").notNull().$type<EmailQueueData["data"]>(),
    status: text("status", { enum: EMAIL_QUEUE_STATUSES }).notNull().default(EMAIL_QUEUE_STATUS.queued),
    retries: integer("retries").notNull().default(0),
    // Gate retries with exponential backoff: a failing SMTP target waits progressively
    // longer between attempts instead of being re-sent on every sweep. New rows default to
    // now() so they remain eligible immediately.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_queue_type_ck", valueIn(t.type, EMAIL_QUEUE_TYPES)),
    check("email_queue_status_ck", valueIn(t.status, EMAIL_QUEUE_STATUSES)),
    index("email_queue_status_created_at_idx").on(t.status, t.createdAt),
    index("email_queue_type_created_at_idx").on(t.type, t.createdAt),
    index("email_queue_created_at_idx").on(t.createdAt),
    // Supports the sweep claim query, which filters by status and due time.
    index("email_queue_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
  ],
);

export type EmailQueue = typeof emailQueue.$inferSelect;
