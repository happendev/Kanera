/**
 * Render every email template with sample data and write the HTML files
 * into apps/api/src/lib/email-templates/preview/.
 *
 * Run from the repo root:
 *   pnpm email:preview
 *
 * To review a translation, render one language into preview/<locale>/ (not committed; only the
 * source-language previews are):
 *   EMAIL_PREVIEW_LOCALE=de pnpm email:preview
 *   pnpm email:preview -- --locale=de
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocale, LOCALES, SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";
import { formatDate, formatLocalDate } from "../lib/i18n/format.js";
import { serverMessages } from "../lib/i18n/messages/index.js";

import { boardInviteEmail } from "../lib/email-templates/board-invite.js";
import { adminInviteEmail } from "../lib/email-templates/admin-invite.js";
import { boardAccessGrantedEmail } from "../lib/email-templates/board-access-granted.js";
import {
  billingChangedEmail,
  billingPaymentFailedEmail,
  billingPaymentRecoveredEmail,
  billingRenewedEmail,
  downgradedToFreeEmail,
  proCancelledEmail,
  proCancellationReversedEmail,
  proCancellationScheduledEmail,
  proTrialStartedEmail,
  proTrialWarningEmail,
  seatBilledEmail,
  seatCapacityReducedEmail,
  upgradedToProEmail,
  welcomeToProEmail,
} from "../lib/email-templates/billing.js";
import { cardAssignedEmail } from "../lib/email-templates/card-assigned.js";
import { cardCommentAddedEmail } from "../lib/email-templates/card-comment-added.js";
import { cardDueDateChangedEmail } from "../lib/email-templates/card-due-date-changed.js";
import { cardOverdueEmail } from "../lib/email-templates/card-overdue.js";
import { cardReminderEmail } from "../lib/email-templates/card-reminder.js";
import { storageWarningEmail } from "../lib/email-templates/storage-warning.js";
import { checklistItemOverdueEmail } from "../lib/email-templates/card-checklist-item-overdue.js";
import { commentMentionedEmail } from "../lib/email-templates/comment-mentioned.js";
import { dailyDigestEmail } from "../lib/email-templates/daily-digest.js";
import { inviteAcceptedEmail } from "../lib/email-templates/invite-accepted.js";
import { passwordResetEmail } from "../lib/email-templates/password-reset.js";
import { smtpTestEmail } from "../lib/email-templates/smtp-test.js";
import { verificationCodeEmail } from "../lib/email-templates/verification-code.js";
import { welcomeEmail } from "../lib/email-templates/welcome.js";
import { weeklyAdminRecapEmail } from "../lib/email-templates/weekly-admin-recap.js";
import { importCompletedEmail } from "../lib/email-templates/import-completed.js";
import {
  lifecycleActiveCheckinEmail,
  lifecycleEarlySuccessEmail,
  lifecycleInactiveEmail,
  lifecycleInviteTeamEmail,
  lifecycleNoBoardEmail,
} from "../lib/email-templates/lifecycle.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const requested = process.argv.find((arg) => arg.startsWith("--locale="))?.slice("--locale=".length) ?? process.env.EMAIL_PREVIEW_LOCALE ?? SOURCE_LOCALE;
if (!isLocale(requested)) {
  console.error(`Unknown locale "${requested}". Expected one of: ${LOCALES.join(", ")}`);
  process.exit(1);
}
const locale: Locale = requested;
const outDir = resolve(scriptDir, "../lib/email-templates/preview", locale === SOURCE_LOCALE ? "." : locale);
mkdirSync(outDir, { recursive: true });

// Sample dates go through the same formatters and catalog wording as real mail, so each language's
// previews show its own date order and month names.
const m = serverMessages(locale);
const shortDate = (iso: string) => formatLocalDate(locale, iso, { month: "short", day: "numeric", year: "numeric" });
const digestDue = (iso: string) => m.email.dailyDigest.itemDue({ date: formatLocalDate(locale, iso, { month: "short", day: "numeric" }) });
const today = m.email.dailyDigest.itemToday;
const billingDate = (iso: string) => formatDate(locale, new Date(`${iso}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
const recapDate = (iso: string) => formatDate(locale, new Date(`${iso}T00:00:00Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const recapRange = (start: string, end: string) => m.email.weeklyAdminRecap.dateRange({ start: recapDate(start), end: recapDate(end) });

const templates = [
  {
    name: "weekly-admin-recap",
    html: weeklyAdminRecapEmail({
      locale,
      periodStart: "2026-05-25",
      lastWeekLabel: recapRange("2026-05-18", "2026-05-24"),
      thisWeekLabel: recapRange("2026-05-25", "2026-05-31"),
      lastWeek: { newAccounts: 14, newOrganisations: 9, invitesAccepted: 7, boardsCreated: 32, subscriptionsStarted: 4, seatsPurchased: 18 },
      snapshot: { activeAccounts: 284, activeOrganisations: 91, activeBoards: 617, paidOrganisations: 38, trialOrganisations: 12, purchasedSeats: 146 },
      upcoming: {
        renewals: [{ dateLabel: recapDate("2026-05-27"), organisationCount: 2, seatCount: 8, organisations: ["Northstar Studio", "Happen Software"] }],
        trialEnds: [{ dateLabel: recapDate("2026-05-29"), organisationCount: 1, seatCount: 4, organisations: ["Bluebird Labs"] }],
        cancellations: [{ dateLabel: recapDate("2026-05-31"), organisationCount: 1, seatCount: 3, organisations: ["Acme Design"] }],
      },
      adminUrl: "http://localhost:4300",
    }),
  },
  {
    name: "admin-invite",
    html: adminInviteEmail({ locale, displayName: "Amelia Hart", inviteUrl: "http://localhost:4300/accept-invite?token=example", expiresInHours: 24 }),
  },
  {
    name: "welcome",
    html: welcomeEmail({
      locale,
      displayName: "Amelia Hart",
      loginUrl: "http://localhost:4200/login",
    }),
  },
  {
    name: "password-reset",
    html: passwordResetEmail({
      locale,
      displayName: "Amelia Hart",
      resetUrl: "http://localhost:4200/reset-password?token=example-token-abc123",
      expiresInMinutes: 60,
    }),
  },
  {
    name: "verification-code",
    html: verificationCodeEmail({
      locale,
      code: "123456",
      expiresInMinutes: 15,
    }),
  },
  {
    name: "daily-digest",
    html: dailyDigestEmail({
      locale,
      displayName: "Amelia Hart",
      localDate: "2026-05-26",
      localDateLabel: formatLocalDate(locale, "2026-05-26", { month: "long", day: "numeric", year: "numeric" }),
      dueToday: [
        {
          title: "Send client handoff notes",
          boardName: "Client Launch",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/CLIENT-12",
          dueLabel: today,
        },
        {
          title: "Export final assets",
          boardName: "Client Launch",
          context: "Send client handoff notes",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/CLIENT-12",
          dueLabel: today,
        },
      ],
      overdue: [
        {
          title: "Confirm production checklist",
          boardName: "Website Refresh",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
          dueLabel: digestDue("2026-05-24"),
        },
        {
          title: "Sign off accessibility pass",
          boardName: "Website Refresh",
          context: "Confirm production checklist",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
          dueLabel: digestDue("2026-05-23"),
        },
        {
          title: "Review launch copy",
          boardName: "Marketing",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/MKT-7",
          dueLabel: digestDue("2026-05-22"),
        },
      ],
      priorities: [
        {
          rank: 1,
          title: "Confirm production checklist",
          boardName: "Website Refresh",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
          dueLabel: digestDue("2026-05-24"),
        },
        {
          rank: 2,
          title: "Send client handoff notes",
          boardName: "Client Launch",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/CLIENT-12",
          dueLabel: today,
        },
        {
          rank: 3,
          title: "Draft Q3 roadmap",
          boardName: "Roadmap",
          cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/ROAD-3",
        },
      ],
    }),
  },
  {
    name: "card-assigned",
    html: cardAssignedEmail({
      locale,
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
    }),
  },
  {
    name: "card-comment-added",
    html: cardCommentAddedEmail({
      locale,
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
      commentExcerpt: "I updated the rollout notes and added the last deployment check.",
    }),
  },
  {
    name: "comment-mentioned",
    html: commentMentionedEmail({
      locale,
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
      commentExcerpt: "Could you confirm this before we ship?",
    }),
  },
  {
    name: "card-due-date-changed",
    html: cardDueDateChangedEmail({
      locale,
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
      previousDueLabel: shortDate("2026-05-24"),
      nextDueLabel: m.common.dueDateWithSlot({ date: shortDate("2026-05-27"), slot: m.common.dueSlots.endOfWorkDay }),
    }),
  },
  {
    name: "card-overdue",
    html: cardOverdueEmail({
      locale,
      displayName: "Amelia Hart",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
      dueLabel: shortDate("2026-05-24"),
    }),
  },
  {
    name: "card-reminder",
    html: cardReminderEmail({
      locale,
      displayName: "Amelia Hart",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
    }),
  },
  {
    name: "storage-warning",
    html: storageWarningEmail({
      locale,
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      usedLabel: "208.4 MB",
      quotaLabel: "250.0 MB",
      percentUsed: 83,
      storageUrl: "http://localhost:4200/settings/storage",
      upgradeQuotaLabel: "200.0 GB",
    }),
  },
  {
    name: "checklist-item-overdue",
    html: checklistItemOverdueEmail({
      locale,
      displayName: "Amelia Hart",
      itemText: "Confirm DNS cutover window",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/o/0123456789ABCDEF/c/WEB-42",
      dueLabel: shortDate("2026-05-24"),
    }),
  },
  {
    name: "invite-accepted",
    html: inviteAcceptedEmail({
      locale,
      context: "org",
      displayName: "Amelia Hart",
      acceptedByName: "Morgan Price",
      acceptedByEmail: "morgan@example.com",
      orgName: "Northstar Studio",
      orgRole: "member",
      membersUrl: "http://localhost:4200/settings/users",
    }),
  },
  {
    name: "board-invite-accepted",
    html: inviteAcceptedEmail({
      locale,
      context: "board",
      displayName: "Amelia Hart",
      acceptedByName: "Morgan Price",
      acceptedByEmail: "morgan@example.com",
      orgName: "Northstar Studio",
      boardName: "Client Launch",
      boardRole: "editor",
      boardUrl: "http://localhost:4200/b/board-client-launch",
    }),
  },
  {
    name: "board-invite",
    html: boardInviteEmail({
      locale,
      boards: [
        { boardName: "Client Launch", role: "editor" },
        { boardName: "Website Refresh", role: "observer" },
      ],
      orgName: "Northstar Studio",
      invitedByName: "Amelia Hart",
      acceptUrl: "http://localhost:4200/board-invite?token=example-token-abc123",
    }),
  },
  {
    name: "board-access-granted",
    html: boardAccessGrantedEmail({
      locale,
      displayName: "Morgan Price",
      boardName: "Client Launch",
      orgName: "Northstar Studio",
      invitedByName: "Amelia Hart",
      role: "editor",
      boardUrl: "http://localhost:4200/b/board-client-launch",
    }),
  },
  {
    name: "smtp-test",
    html: smtpTestEmail({
      locale,
      recipientEmail: "amelia@example.com",
      appUrl: "http://localhost:4200",
      sentAtLabel: formatDate(locale, new Date("2026-05-28T09:30:00Z"), { dateStyle: "full", timeStyle: "long", timeZone: "UTC" }),
    }),
  },
  {
    name: "pro-trial-started",
    html: proTrialStartedEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      trialEndsAtLabel: billingDate("2026-06-25"),
      impact: null,
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "pro-trial-warning",
    html: proTrialWarningEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      daysRemaining: 10,
      trialEndsAtLabel: billingDate("2026-06-25"),
      usage: { boards: 6, cards: 184, members: 5 },
      impact: { boardsArchived: 5, usersSuspended: 1, automationsDisabled: 3, webhooksDisabled: 2, apiKeysRevoked: 1, guestMembersRemoved: 4, guestInvitesRevoked: 1 },
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "downgraded-to-free",
    html: downgradedToFreeEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      impact: { boardsArchived: 2, usersSuspended: 0, automationsDisabled: 1, webhooksDisabled: 1, apiKeysRevoked: 1, guestMembersRemoved: 0, guestInvitesRevoked: 0 },
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "upgraded-to-pro",
    html: upgradedToProEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "annual",
      purchasedSeatCount: 8,
      periodEndLabel: billingDate("2027-06-25"),
      impact: { boardsArchived: 2, usersSuspended: 1, automationsDisabled: 1, webhooksDisabled: 1, apiKeysRevoked: 1, guestMembersRemoved: 1, guestInvitesRevoked: 1 },
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "welcome-to-pro",
    html: welcomeToProEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "annual",
      purchasedSeatCount: 8,
      periodEndLabel: billingDate("2027-06-25"),
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "billing-changed",
    html: billingChangedEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "monthly",
      purchasedSeatCount: 9,
      periodEndLabel: billingDate("2026-07-25"),
    }),
  },
  {
    name: "billing-renewed",
    html: billingRenewedEmail({
      locale,
      clientId: "client-example", displayName: "Amelia Hart", orgName: "Northstar Studio", settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "annual", purchasedSeatCount: 8, periodEndLabel: billingDate("2027-06-25"),
    }),
  },
  {
    name: "billing-payment-failed",
    html: billingPaymentFailedEmail({
      locale,
      clientId: "client-example", displayName: "Amelia Hart", orgName: "Northstar Studio", settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "monthly", purchasedSeatCount: 8,
    }),
  },
  {
    name: "billing-payment-recovered",
    html: billingPaymentRecoveredEmail({
      locale,
      clientId: "client-example", displayName: "Amelia Hart", orgName: "Northstar Studio", settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "monthly", purchasedSeatCount: 8, periodEndLabel: billingDate("2026-07-25"),
    }),
  },
  {
    name: "seat-billed",
    html: seatBilledEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      previousPurchasedSeatCount: 9,
      purchasedSeatCount: 10,
      billingSummary: m.email.billing.seatPurchase.capacityAvailable,
    }),
  },
  {
    name: "seat-capacity-reduced",
    html: seatCapacityReducedEmail({
      locale,
      clientId: "client-example", displayName: "Amelia Hart", orgName: "Northstar Studio", settingsUrl: "http://localhost:4200/settings/account-plan",
      previousPurchasedSeatCount: 10, purchasedSeatCount: 8,
    }),
  },
  {
    name: "pro-cancellation-scheduled",
    html: proCancellationScheduledEmail({
      locale,
      clientId: "client-example", displayName: "Amelia Hart", orgName: "Northstar Studio", settingsUrl: "http://localhost:4200/settings/account-plan",
      daysRemaining: 14, periodEndLabel: billingDate("2026-07-09"),
      impact: { boardsArchived: 3, usersSuspended: 2, automationsDisabled: 2, webhooksDisabled: 1, apiKeysRevoked: 1, guestMembersRemoved: 1, guestInvitesRevoked: 1 },
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "pro-cancellation-reversed",
    html: proCancellationReversedEmail({
      locale,
      clientId: "client-example", displayName: "Amelia Hart", orgName: "Northstar Studio", settingsUrl: "http://localhost:4200/settings/account-plan",
      billingInterval: "annual", purchasedSeatCount: 8, periodEndLabel: billingDate("2027-07-09"),
    }),
  },
  {
    name: "pro-cancelled",
    html: proCancelledEmail({
      locale,
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      impact: { boardsArchived: 3, usersSuspended: 2, automationsDisabled: 2, webhooksDisabled: 1, apiKeysRevoked: 1, guestMembersRemoved: 1, guestInvitesRevoked: 1 },
      limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 3, maxAutomationExecutionsPerMonth: 100 },
    }),
  },
  {
    name: "import-completed",
    html: importCompletedEmail({
      locale,
      displayName: "Amelia Hart", source: "trello", boardName: "Client Launch", boardUrl: "http://localhost:4200/b/board-client-launch",
      lists: 5, cards: 142, checklistItems: 318, comments: 96, attachmentsImported: 41, attachmentsSkipped: 2, warningCount: 1,
    }),
  },
  {
    name: "lifecycle-no-board",
    html: lifecycleNoBoardEmail({ locale, displayName: "Amelia Hart", orgName: "Northstar Studio", unsubscribeUrl: "http://localhost:4200/email/unsubscribe?token=example", ctaUrl: "http://localhost:4200/" }),
  },
  {
    name: "lifecycle-invite-team",
    html: lifecycleInviteTeamEmail({ locale, displayName: "Amelia Hart", orgName: "Northstar Studio", unsubscribeUrl: "http://localhost:4200/email/unsubscribe?token=example", ctaUrl: "http://localhost:4200/settings/users" }),
  },
  {
    name: "lifecycle-early-success-automations",
    html: lifecycleEarlySuccessEmail({ locale, displayName: "Amelia Hart", orgName: "Northstar Studio", unsubscribeUrl: "http://localhost:4200/email/unsubscribe?token=example", ctaUrl: "http://localhost:4200/w/workspace-example/settings/automations", nextStep: "automations" }),
  },
  {
    name: "lifecycle-early-success-my-cards",
    html: lifecycleEarlySuccessEmail({ locale, displayName: "Amelia Hart", orgName: "Northstar Studio", unsubscribeUrl: "http://localhost:4200/email/unsubscribe?token=example", ctaUrl: "http://localhost:4200/my-cards", nextStep: "my_cards" }),
  },
  {
    name: "lifecycle-inactive",
    html: lifecycleInactiveEmail({ locale, displayName: "Amelia Hart", orgName: "Northstar Studio", unsubscribeUrl: "http://localhost:4200/email/unsubscribe?token=example", ctaUrl: "http://localhost:4200/", feedbackEmail: "support@kanera.app" }),
  },
  {
    name: "lifecycle-active-checkin",
    html: lifecycleActiveCheckinEmail({ locale, displayName: "Amelia Hart", orgName: "Northstar Studio", unsubscribeUrl: "http://localhost:4200/email/unsubscribe?token=example", ctaUrl: "http://localhost:4200/team-cards", onFreePlan: true, feedbackEmail: "support@kanera.app" }),
  },
];

for (const { name, html } of templates) {
  const path = resolve(outDir, `${name}.html`);
  writeFileSync(path, cleanPreviewHtml(html));
  console.log(`  ✓ ${name}.html`);
}

console.log(`\nWrote ${templates.length} ${locale} preview(s) to ${outDir}`);

function cleanPreviewHtml(html: string): string {
  return html.replace(/[ \t]+$/gm, "");
}
