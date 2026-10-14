import type { ActivitySummaryMessages } from "@kanera/shared/activity-summary";

/**
 * Every word the API writes to a person outside a request/response: email and push. One object per
 * language (`messages/<locale>.ts`), checked against this interface, so a missing or misspelt string
 * fails type-checking instead of falling back silently.
 *
 * Conventions for translators:
 * - Plain strings are copied as-is. Functions take named params and return the sentence; put the
 *   params wherever the language wants them, and write plural logic inline (`count === 1 ? … : …`,
 *   or `new Intl.PluralRules(locale).select(count)` for languages with more categories).
 * - Params are user content (names, titles) or pre-formatted values (dates, durations). Insert them
 *   verbatim, never translate or reformat them.
 * - Write plain text, never HTML. Some sentences have a param that the email renders bold or as a
 *   link (noted on the entry); the template escapes the text and splices the markup in afterwards.
 * - Keep **Kanera** and plan names (**Free**, **Pro**) untranslated. See
 *   apps/web/src/locale/GLOSSARY.md for product terms and per-language voice.
 */
export interface ServerMessages {
  common: CommonMessages;
  layout: LayoutMessages;
  email: EmailMessages;
  push: PushMessages;
  /** The notification-drawer action lines, reused as watched-activity push bodies. */
  activity: ActivitySummaryMessages;
}

export type Role = "owner" | "admin" | "member" | "editor" | "observer";

export interface CommonMessages {
  /** Durations used in expiry notices ("60 minutes"). */
  minutes: (p: { count: number }) => string;
  hours: (p: { count: number }) => string;
  /** Organisation and board role names as shown to people. */
  roles: Record<Role, string>;
  /** Stand-in when the person who sent an invite can no longer be looked up. */
  fallbackInviterName: string;
  /** Stand-in actor for activity with no known author. */
  someone: string;
  /** An agent acting for its owner: "Priya via Claude". */
  viaAgent: (p: { owner: string; agent: string }) => string;
  /** Agent name when the agent did not give one. */
  aiAgent: string;
  /** Stand-in for a card whose title is unknown. */
  aCard: string;
  /** Comment excerpt when the comment had no readable text (only an image, say). */
  emptyCommentExcerpt: string;
  /** Time-of-day slot that follows a due date. */
  dueSlots: { morning: string; afternoon: string; endOfWorkDay: string };
  /** A due date with its slot: "27 May 2026, end of workday". */
  dueDateWithSlot: (p: { date: string; slot: string }) => string;
}

export interface LayoutMessages {
  /** Footer line on transactional mail. */
  footerAccount: string;
  /** Footer line on optional onboarding/lifecycle mail, followed by the unsubscribe link. */
  footerLifecycle: string;
  unsubscribe: string;
  /** Precedes the raw URL under a button. */
  fallbackLink: string;
  /** Label above a one-time code. */
  oneTimeCode: string;
}

export interface EmailMessages {
  adminInvite: {
    subject: string;
    preheader: (p: { firstName: string }) => string;
    heading: string;
    intro: (p: { firstName: string }) => string;
    button: string;
    /** `duration` is rendered bold. */
    expiry: (p: { duration: string }) => string;
  };
  welcome: {
    subject: string;
    preheader: (p: { firstName: string }) => string;
    heading: string;
    intro: (p: { firstName: string }) => string;
    firstSteps: string;
    steps: readonly [string, string, string];
    button: string;
  };
  passwordReset: {
    subject: string;
    preheader: (p: { firstName: string }) => string;
    heading: string;
    intro: (p: { firstName: string }) => string;
    button: string;
    /** `duration` is rendered bold. */
    expiry: (p: { duration: string }) => string;
  };
  verificationCode: {
    subject: string;
    preheader: (p: { code: string }) => string;
    heading: string;
    instruction: string;
    /** `duration` is rendered bold. */
    expiry: (p: { duration: string }) => string;
  };
  dailyDigest: {
    subject: string;
    preheader: (p: { count: number }) => string;
    heading: string;
    intro: (p: { firstName: string; date: string }) => string;
    dueToday: string;
    overdue: string;
    priorities: string;
    /** Item label when it is due today. */
    itemToday: string;
    /** Item label for another due date: "Due 24 May". */
    itemDue: (p: { date: string }) => string;
  };
  weeklyAdminRecap: {
    /** Queue/inbox subject; `period` is last week's date range. */
    queueSubject: (p: { period: string }) => string;
    /** Document title inside the email. */
    subject: string;
    preheader: (p: { newAccounts: number; boardsCreated: number; seatsRenewing: number }) => string;
    heading: string;
    intro: (p: { lastWeek: string; thisWeek: string }) => string;
    lastWeek: string;
    currentState: string;
    comingUp: string;
    metrics: {
      newAccounts: string;
      newOrganisations: string;
      invitesAccepted: string;
      boardsCreated: string;
      subscriptionsStarted: string;
      seatsPurchased: string;
      activeAccounts: string;
      activeOrganisations: string;
      activeBoards: string;
      paidOrganisations: string;
      trials: string;
      purchasedSeats: string;
    };
    renewals: string;
    renewalsEmpty: string;
    trialEnds: string;
    trialEndsEmpty: string;
    cancellations: string;
    cancellationsEmpty: string;
    /** "8 seats across 2 organisations"; follows the bold date. */
    groupSummary: (p: { seatCount: number; organisationCount: number }) => string;
    /** Last entry of a truncated organisation list. */
    moreOrganisations: (p: { count: number }) => string;
    dateRange: (p: { start: string; end: string }) => string;
    button: string;
    footnote: string;
  };
  cardAssigned: {
    subject: string;
    preheader: (p: { actor: string; card: string }) => string;
    heading: string;
    intro: (p: { firstName: string; actor: string; board: string }) => string;
  };
  cardCommentAdded: {
    subject: (p: { card: string }) => string;
    preheader: (p: { actor: string; card: string; board: string }) => string;
    heading: string;
    intro: (p: { firstName: string; actor: string; card: string; board: string }) => string;
  };
  commentMentioned: {
    subject: (p: { card: string }) => string;
    preheader: (p: { actor: string; card: string; board: string }) => string;
    heading: string;
    intro: (p: { firstName: string; actor: string; card: string; board: string }) => string;
  };
  cardDueDateChanged: {
    subject: string;
    preheader: (p: { actor: string; card: string }) => string;
    heading: string;
    intro: (p: { firstName: string; actor: string }) => string;
    changed: (p: { from: string; to: string }) => string;
    set: (p: { to: string }) => string;
    clearedFrom: (p: { from: string }) => string;
    cleared: string;
  };
  cardOverdue: {
    subject: string;
    preheader: (p: { card: string }) => string;
    heading: string;
    intro: (p: { firstName: string; due: string | null }) => string;
  };
  cardReminder: {
    subject: string;
    preheader: (p: { card: string }) => string;
    heading: string;
    intro: (p: { firstName: string }) => string;
  };
  checklistItemOverdue: {
    subject: string;
    preheader: (p: { item: string }) => string;
    heading: string;
    intro: (p: { firstName: string; item: string; due: string | null }) => string;
  };
  inviteAccepted: {
    subject: string;
    org: {
      preheader: (p: { name: string; org: string }) => string;
      heading: string;
      intro: (p: { firstName: string; name: string; org: string }) => string;
      newMember: (p: { name: string; email: string }) => string;
      role: (p: { role: string }) => string;
      button: string;
    };
    board: {
      preheader: (p: { name: string; board: string }) => string;
      heading: string;
      intro: (p: { firstName: string; name: string; board: string; org: string }) => string;
      newGuest: (p: { name: string; email: string }) => string;
      role: (p: { role: string }) => string;
      button: string;
    };
  };
  boardInvite: {
    /** `boardName` is the only board when `boardCount` is 1. */
    subject: (p: { boardCount: number; boardName: string }) => string;
    preheader: (p: { inviter: string; boardCount: number; boardName: string; org: string }) => string;
    heading: string;
    intro: (p: { inviter: string; boardCount: number; org: string }) => string;
    /** One line per board; `board` is rendered bold. */
    grant: (p: { board: string; role: string }) => string;
    button: string;
  };
  boardAccessGranted: {
    subject: (p: { board: string }) => string;
    preheader: (p: { inviter: string; board: string; org: string }) => string;
    heading: string;
    /** `board` is rendered bold. */
    intro: (p: { name: string; inviter: string; board: string; org: string }) => string;
    /** `role` is rendered bold. */
    role: (p: { role: string }) => string;
    button: string;
  };
  billing: BillingMessages;
  importCompleted: {
    subject: string;
    preheader: (p: { cards: number; source: string }) => string;
    heading: string;
    intro: (p: { firstName: string; source: string; board: string }) => string;
    sources: { trello: string; kanera: string; csv: string };
    rows: { lists: string; cards: string; checklistItems: string; comments: string; attachments: string };
    attachmentsSkipped: (p: { count: number }) => string;
    warnings: (p: { count: number }) => string;
    check: string;
    button: string;
    footer: string;
  };
  storageWarning: {
    subject: (p: { org: string }) => string;
    preheader: (p: { percent: number; quota: string }) => string;
    heading: string;
    intro: (p: { firstName: string; org: string; used: string; quota: string; percent: number }) => string;
    whenFull: string;
    howToFree: string;
    upgrade: (p: { quota: string }) => string;
    noUpgrade: string;
    button: string;
    footer: string;
  };
  lifecycle: LifecycleMessages;
  smtpTest: {
    subject: string;
    preheader: string;
    heading: string;
    intro: (p: { email: string; sentAt: string }) => string;
    renderingNote: string;
    renderingCheck: string;
    sampleCardTitle: string;
    sampleCardSubtitle: string;
    sampleQuote: string;
    button: string;
  };
}

export type BillingImpactKey = "board" | "user" | "automation" | "webhook" | "apiKey" | "guest" | "invite";

export interface BillingMessages {
  trialStarted: {
    subject: string;
    preheader: (p: { end: string | null }) => string;
    title: string;
    intro: (p: { firstName: string; org: string; end: string | null }) => string;
    lines: (p: { org: string }) => string[];
    cta: string;
  };
  trialWarning: {
    subject: (p: { days: number }) => string;
    preheader: (p: { org: string }) => string;
    title: (p: { days: number }) => string;
    intro: (p: { firstName: string; org: string; end: string | null; days: number }) => string;
    lines: string[];
    cta: string;
  };
  downgradedToFree: {
    subject: (p: { org: string }) => string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    lines: string[];
    cta: string;
  };
  upgradedToPro: {
    subject: string;
    preheader: (p: { org: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    line: string;
    restoredLine: string;
    cta: string;
  };
  welcomeToPro: {
    subject: string;
    preheader: (p: { org: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    lines: string[];
    cta: string;
  };
  changed: {
    subject: string;
    preheader: (p: { org: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    line: string;
    cta: string;
  };
  renewed: {
    subject: string;
    preheader: (p: { org: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    line: string;
    cta: string;
  };
  paymentFailed: {
    subject: string;
    preheader: (p: { org: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    lines: string[];
    cta: string;
  };
  paymentRecovered: {
    subject: string;
    preheader: (p: { org: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    line: string;
    cta: string;
  };
  /** Purchased capacity was raised (no specific person). */
  seatPurchase: {
    subject: string;
    preheader: (p: { org: string; count: number | null }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    added: (p: { added: number; from: number; to: number }) => string;
    total: (p: { count: number }) => string;
    /** Summary line queued with a capacity increase. */
    capacityAvailable: string;
    cta: string;
  };
  /** A seat was billed for a specific person. */
  seatBilled: {
    subject: string;
    seatKind: { member: string; guest: string };
    preheader: (p: { seatKind: string }) => string;
    title: string;
    intro: (p: { firstName: string; org: string; seatKind: string }) => string;
    billedUser: (p: { user: string }) => string;
    /** "Name (email)" */
    userWithEmail: (p: { name: string; email: string }) => string;
    activeSeats: (p: { org: string; count: number }) => string;
    cta: string;
  };
  seatCapacityReduced: {
    subject: string;
    preheader: (p: { org: string; count: number | null }) => string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    reduced: (p: { count: number; from: number }) => string;
    total: (p: { count: number }) => string;
    creditLine: string;
    cta: string;
  };
  cancellationScheduled: {
    subject: (p: { org: string }) => string;
    preheader: (p: { end: string | null }) => string;
    title: string;
    intro: (p: { firstName: string; org: string; end: string | null }) => string;
    lines: (p: { org: string }) => string[];
    cta: string;
  };
  cancellationReversed: {
    subject: (p: { org: string }) => string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    line: string;
    cta: string;
  };
  cancelled: {
    subject: (p: { org: string }) => string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    lines: string[];
    cta: string;
  };
  details: {
    billing: string;
    annual: string;
    monthly: string;
    purchasedSeats: string;
    nextRenewal: string;
  };
  impact: {
    forecastTitle: string;
    restoredTitle: string;
    appliedTitle: string;
    forecastEmpty: string;
    appliedEmpty: string;
    freeLimits: (p: { boards: number; members: number; automations: number; executions: number }) => string;
    forecast: Record<BillingImpactKey, (count: number) => string>;
    restored: Record<BillingImpactKey, (count: number) => string>;
    applied: Record<BillingImpactKey, (count: number) => string>;
  };
  /** Trial-warning "what you built" line. */
  usage: (p: { boards: number; cards: number; members: number }) => string;
}

/** A bold lead-in followed by the rest of the paragraph. */
export interface LeadLine {
  lead: string;
  body: string;
}

export interface LifecycleMessages {
  footerNote: string;
  noBoard: {
    subject: string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    lines: string[];
    cta: string;
  };
  inviteTeam: {
    subject: string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    lines: string[];
    cta: string;
  };
  earlySuccess: {
    subjectAutomations: string;
    subjectMyCards: string;
    preheaderAutomations: string;
    preheaderMyCards: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    linesAutomations: string[];
    linesMyCards: string[];
    ctaAutomations: string;
    ctaMyCards: string;
  };
  inactive: {
    subject: string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    setup: LeadLine;
    timing: LeadLine;
    /** `email` is rendered as a mailto link. */
    somethingWrong: { lead: string; withFeedback: (p: { email: string }) => string; withoutFeedback: string };
    wrongTool: LeadLine;
    cta: string;
  };
  activeCheckin: {
    subject: string;
    preheader: string;
    title: string;
    intro: (p: { firstName: string; org: string }) => string;
    tip: LeadLine;
    freePlan: LeadLine;
    growing: LeadLine;
    /** `email` is rendered as a mailto link. */
    feedback: { lead: string; body: (p: { email: string }) => string };
    cta: string;
  };
}

/** Browser push and personal channels (ntfy, Gotify, webhook): a short title and one-line body. */
export interface PushMessages {
  cardAssigned: { title: string; body: (p: { actor: string; card: string }) => string };
  commentAdded: { title: string; body: (p: { actor: string; board: string; card: string; excerpt: string }) => string };
  mentioned: { title: string; body: (p: { actor: string; board: string; card: string; excerpt: string }) => string };
  dueDateChanged: { title: string; body: (p: { actor: string; card: string }) => string };
  cardOverdue: { title: string; body: (p: { card: string }) => string };
  checklistItemOverdue: { title: string; body: (p: { item: string; card: string }) => string };
  /** The body is the card title. */
  reminder: { title: string };
  /** `action` is the drawer's action line ("moved this card to Doing"). */
  watchedActivity: { body: (p: { actor: string; action: string }) => string };
  test: { title: string; body: string };
  channelTest: { title: string; body: (p: { channel: string }) => string };
}
