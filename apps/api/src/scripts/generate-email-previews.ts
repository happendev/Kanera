/**
 * Render every email template with sample data and write the HTML files
 * into apps/api/src/lib/email-templates/preview/.
 *
 * Run from the repo root:
 *   pnpm email:preview
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { boardInviteEmail } from "../lib/email-templates/board-invite.js";
import { adminInviteEmail } from "../lib/email-templates/admin-invite.js";
import { boardAccessGrantedEmail } from "../lib/email-templates/board-access-granted.js";
import {
  billingChangedEmail,
  downgradedToFreeEmail,
  proCancelledEmail,
  proTrialStartedEmail,
  proTrialWarningEmail,
  seatBilledEmail,
  upgradedToProEmail,
  welcomeToProEmail,
} from "../lib/email-templates/billing.js";
import { cardAssignedEmail } from "../lib/email-templates/card-assigned.js";
import { cardCommentAddedEmail } from "../lib/email-templates/card-comment-added.js";
import { cardDueDateChangedEmail } from "../lib/email-templates/card-due-date-changed.js";
import { cardOverdueEmail } from "../lib/email-templates/card-overdue.js";
import { checklistItemOverdueEmail } from "../lib/email-templates/card-checklist-item-overdue.js";
import { commentMentionedEmail } from "../lib/email-templates/comment-mentioned.js";
import { dailyDigestEmail } from "../lib/email-templates/daily-digest.js";
import { inviteAcceptedEmail } from "../lib/email-templates/invite-accepted.js";
import { passwordResetEmail } from "../lib/email-templates/password-reset.js";
import { smtpTestEmail } from "../lib/email-templates/smtp-test.js";
import { verificationCodeEmail } from "../lib/email-templates/verification-code.js";
import { welcomeEmail } from "../lib/email-templates/welcome.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(scriptDir, "../lib/email-templates/preview");
mkdirSync(outDir, { recursive: true });

const templates = [
  {
    name: "admin-invite",
    html: adminInviteEmail({ displayName: "Amelia Hart", inviteUrl: "http://localhost:4300/accept-invite?token=example", expiresInHours: 24 }),
  },
  {
    name: "welcome",
    html: welcomeEmail({
      displayName: "Amelia Hart",
      loginUrl: "http://localhost:4200/login",
    }),
  },
  {
    name: "password-reset",
    html: passwordResetEmail({
      displayName: "Amelia Hart",
      resetUrl: "http://localhost:4200/reset-password?token=example-token-abc123",
      expiresInMinutes: 60,
    }),
  },
  {
    name: "verification-code",
    html: verificationCodeEmail({
      code: "123456",
      expiresInMinutes: 15,
    }),
  },
  {
    name: "daily-digest",
    html: dailyDigestEmail({
      displayName: "Amelia Hart",
      localDate: "2026-05-26",
      localDateLabel: "May 26, 2026",
      dueToday: [
        {
          title: "Send client handoff notes",
          boardName: "Client Launch",
          cardUrl: "http://localhost:4200/b/board-client-launch?cardId=card-handoff",
          dueLabel: "Today",
        },
        {
          title: "Export final assets",
          boardName: "Client Launch",
          context: "Send client handoff notes",
          cardUrl: "http://localhost:4200/b/board-client-launch?cardId=card-handoff",
          dueLabel: "Today",
        },
      ],
      overdue: [
        {
          title: "Confirm production checklist",
          boardName: "Website Refresh",
          cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
          dueLabel: "Due May 24",
        },
        {
          title: "Sign off accessibility pass",
          boardName: "Website Refresh",
          context: "Confirm production checklist",
          cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
          dueLabel: "Due May 23",
        },
        {
          title: "Review launch copy",
          boardName: "Marketing",
          cardUrl: "http://localhost:4200/b/board-marketing?cardId=card-copy",
          dueLabel: "Due May 22",
        },
      ],
    }),
  },
  {
    name: "card-assigned",
    html: cardAssignedEmail({
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
    }),
  },
  {
    name: "card-comment-added",
    html: cardCommentAddedEmail({
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
      commentExcerpt: "I updated the rollout notes and added the last deployment check.",
    }),
  },
  {
    name: "comment-mentioned",
    html: commentMentionedEmail({
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
      commentExcerpt: "Could you confirm this before we ship?",
    }),
  },
  {
    name: "card-due-date-changed",
    html: cardDueDateChangedEmail({
      displayName: "Amelia Hart",
      actorName: "Jordan Lee",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
      previousDueLabel: "May 24, 2026",
      nextDueLabel: "May 27, 2026, end of workday",
    }),
  },
  {
    name: "card-overdue",
    html: cardOverdueEmail({
      displayName: "Amelia Hart",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
      dueLabel: "May 24, 2026",
    }),
  },
  {
    name: "checklist-item-overdue",
    html: checklistItemOverdueEmail({
      displayName: "Amelia Hart",
      itemText: "Confirm DNS cutover window",
      cardTitle: "Confirm production checklist",
      boardName: "Website Refresh",
      cardUrl: "http://localhost:4200/b/board-website-refresh?cardId=card-checklist",
      dueLabel: "May 24, 2026",
    }),
  },
  {
    name: "invite-accepted",
    html: inviteAcceptedEmail({
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
      recipientEmail: "amelia@example.com",
      appUrl: "http://localhost:4200",
      sentAtLabel: "Wed, 28 May 2026 09:30:00 GMT",
    }),
  },
  {
    name: "pro-trial-started",
    html: proTrialStartedEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      trialEndsAtLabel: "Jun 25, 2026",
      impact: null,
      limits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
    }),
  },
  {
    name: "pro-trial-warning",
    html: proTrialWarningEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      daysRemaining: 10,
      trialEndsAtLabel: "Jun 25, 2026",
      impact: { boardsArchived: 5, usersSuspended: 1, automationsDisabled: 3, webhooksDisabled: 2, apiKeysRevoked: 1, guestMembersRemoved: 4, guestInvitesRevoked: 1 },
      limits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
    }),
  },
  {
    name: "downgraded-to-free",
    html: downgradedToFreeEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      impact: { boardsArchived: 2, usersSuspended: 0, automationsDisabled: 1, webhooksDisabled: 1, apiKeysRevoked: 1, guestMembersRemoved: 0, guestInvitesRevoked: 0 },
      limits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
    }),
  },
  {
    name: "upgraded-to-pro",
    html: upgradedToProEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      billingSummary: "Stripe confirmed billing interval: annual, 8 active seats, current period ends Jun 25, 2027.",
      limits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
    }),
  },
  {
    name: "welcome-to-pro",
    html: welcomeToProEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      billingSummary: "Stripe confirmed billing interval: annual, 8 active seats, current period ends Jun 25, 2027.",
      limits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
    }),
  },
  {
    name: "billing-changed",
    html: billingChangedEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      billingSummary: "Stripe confirmed billing interval: monthly, 9 active seats, current period ends Jul 25, 2026.",
    }),
  },
  {
    name: "seat-billed",
    html: seatBilledEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      activeSeatCount: 10,
      billingSummary: "Stripe confirmed your subscription now covers 10 seats.",
    }),
  },
  {
    name: "pro-cancelled",
    html: proCancelledEmail({
      clientId: "client-example",
      displayName: "Amelia Hart",
      orgName: "Northstar Studio",
      settingsUrl: "http://localhost:4200/settings/account-plan",
      daysRemaining: 14,
      trialEndsAtLabel: "Jul 9, 2026",
      impact: { boardsArchived: 3, usersSuspended: 2, automationsDisabled: 2, webhooksDisabled: 1, apiKeysRevoked: 1, guestMembersRemoved: 1, guestInvitesRevoked: 1 },
      limits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
    }),
  },
];

for (const { name, html } of templates) {
  const path = resolve(outDir, `${name}.html`);
  writeFileSync(path, cleanPreviewHtml(html));
  console.log(`  ✓ ${name}.html`);
}

console.log(`\nWrote ${templates.length} preview(s) to ${outDir}`);

function cleanPreviewHtml(html: string): string {
  return html.replace(/[ \t]+$/gm, "");
}
