import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_QUEUE_STATUS, type EmailQueue } from "@kanera/shared/schema";
import { billingChangedEmail, proCancelledEmail, proTrialWarningEmail, seatBilledEmail, upgradedToProEmail } from "./email-templates/billing.js";
import { emailSubject, renderEmail, shouldSendDailyDigest } from "./mailer.js";

test("development email subjects are prefixed once", () => {
  assert.equal(emailSubject("Welcome to Kanera", "development"), "[Development] Welcome to Kanera");
  assert.equal(emailSubject("[Development] Welcome to Kanera", "development"), "[Development] Welcome to Kanera");
  assert.equal(emailSubject("Welcome to Kanera", "production"), "Welcome to Kanera");
});

test("daily digests are skipped for observers and empty payloads", () => {
  const params = {
    displayName: "Ada",
    localDate: "2026-05-26",
    localDateLabel: "May 26, 2026",
    dueToday: [{ title: "Ship release", boardName: "Launch", cardUrl: "https://kanera.test/c/PROJ-1" }],
    overdue: [],
  };

  assert.equal(shouldSendDailyDigest("observer", params), false);
  assert.equal(shouldSendDailyDigest("editor", { ...params, dueToday: [], overdue: [] }), false);
  assert.equal(shouldSendDailyDigest("editor", params), true);
});

test("assignee notification email types render", () => {
  const base = {
    id: "email-1",
    toEmail: "member@example.com",
    status: EMAIL_QUEUE_STATUS.queued,
    retries: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const rows: EmailQueue[] = [
    {
      ...base,
      subject: "You were assigned a Kanera card",
      type: "card_assigned" as const,
      data: {
        displayName: "Member",
        actorName: "Owner",
        cardTitle: "Prepare launch",
        boardName: "Inbox",
        cardUrl: "https://kanera.test/c/PROJ-1",
      },
    },
    {
      ...base,
      subject: "New comment on Prepare launch",
      type: "card_comment_added" as const,
      data: {
        displayName: "Member",
        actorName: "Owner",
        cardTitle: "Prepare launch",
        boardName: "Inbox",
        cardUrl: "https://kanera.test/c/PROJ-1",
        commentExcerpt: "Please review today.",
      },
    },
    {
      ...base,
      subject: "Mentioned in a comment on Prepare launch",
      type: "comment_mentioned" as const,
      data: {
        displayName: "Member",
        actorName: "Owner",
        cardTitle: "Prepare launch",
        boardName: "Inbox",
        cardUrl: "https://kanera.test/c/PROJ-1",
        commentExcerpt: "Please review today.",
      },
    },
    {
      ...base,
      subject: "Due date changed on your Kanera card",
      type: "card_due_date_changed" as const,
      data: {
        displayName: "Member",
        actorName: "Owner",
        cardTitle: "Prepare launch",
        boardName: "Inbox",
        cardUrl: "https://kanera.test/c/PROJ-1",
        previousDueLabel: null,
        nextDueLabel: "May 27, 2026",
      },
    },
    {
      ...base,
      subject: "A Kanera card is overdue",
      type: "card_overdue" as const,
      data: {
        displayName: "Member",
        cardTitle: "Prepare launch",
        boardName: "Inbox",
        cardUrl: "https://kanera.test/c/PROJ-1",
        dueLabel: "May 27, 2026",
      },
    },
    {
      ...base,
      subject: "A Kanera invite was accepted",
      type: "invite_accepted" as const,
      data: {
        displayName: "Owner",
        acceptedByName: "Member",
        acceptedByEmail: "member@example.com",
        orgName: "Acme",
        orgRole: "member",
        membersUrl: "https://kanera.test/settings/users",
      },
    },
  ];

  for (const row of rows) {
    const html = renderEmail(row);
    assertRenderedEmail(html, row.subject);
    assert.match(html, /Prepare launch|Member|Acme/);
  }
});

test("hosted billing email types render", () => {
  const base = {
    id: "email-1",
    toEmail: "owner@example.com",
    status: EMAIL_QUEUE_STATUS.queued,
    retries: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    data: {
      clientId: "client-1",
      displayName: "Owner",
      orgName: "Acme",
      settingsUrl: "https://kanera.test/settings/account-plan",
      daysRemaining: 10,
      trialEndsAtLabel: "Jun 25, 2026",
      impact: {
        boardsArchived: 2,
        usersSuspended: 1,
        automationsDisabled: 1,
        webhooksDisabled: 1,
        apiKeysRevoked: 1,
        guestMembersRemoved: 1,
        guestInvitesRevoked: 1,
      },
      limits: { maxBoards: 3, maxOrgMembers: 10, maxEnabledAutomations: 1 },
      billingSummary: "Stripe confirmed 3 active seats.",
      seatKind: "guest" as const,
      billedUserName: "Guest User",
      billedUserEmail: "guest@example.com",
      activeSeatCount: 3,
    },
  };
  const rows: EmailQueue[] = [
    { ...base, subject: "Your Kanera Pro trial has started", type: "pro_trial_started" as const },
    { ...base, subject: "Your Kanera Pro trial ends in 10 days", type: "pro_trial_warning" as const },
    { ...base, subject: "Acme is now on Kanera Basic", type: "downgraded_to_free" as const },
    { ...base, subject: "Kanera Pro is active", type: "upgraded_to_pro" as const },
    { ...base, subject: "Your Kanera Pro subscription was updated", type: "billing_changed" as const },
    { ...base, subject: "Your Kanera Pro subscription renewed", type: "billing_renewed" as const },
    { ...base, subject: "Action needed: update your Kanera payment method", type: "billing_payment_failed" as const },
    { ...base, subject: "Your Kanera Pro payment is confirmed", type: "billing_payment_recovered" as const },
    { ...base, subject: "A Kanera seat was billed", type: "seat_billed" as const },
    { ...base, subject: "Your Kanera seat capacity was reduced", type: "seat_capacity_reduced" as const },
    { ...base, subject: "Kanera Pro will end for Acme", type: "pro_cancellation_scheduled" as const },
    { ...base, subject: "Kanera Pro will continue for Acme", type: "pro_cancellation_reversed" as const },
    { ...base, subject: "Acme is now on Kanera Basic", type: "pro_cancelled" as const },
  ];

  for (const row of rows) {
    const html = renderEmail(row);
    assertRenderedEmail(html, row.subject);
    assert.match(html, /Acme/);
    assert.match(html, /https:\/\/kanera\.test\/settings\/account-plan/);
  }
});

test("seat purchase email confirms the new total without repeating Stripe status", () => {
  const html = seatBilledEmail({
    clientId: "client-1",
    displayName: "Dylan",
    orgName: "Happen Software",
    settingsUrl: "https://kanera.test/settings/account-plan",
    previousPurchasedSeatCount: 7,
    purchasedSeatCount: 8,
    billingSummary: "The new capacity is available now and can be assigned to a member or guest.",
  });

  assert.match(html, /<title>Your Kanera seat purchase is confirmed<\/title>/);
  assert.match(html, /Seat purchase confirmed/);
  assert.match(html, /your seat purchase for Happen Software is confirmed/);
  assert.match(html, /1 purchased seat was added, taking your seat capacity from 7 to 8/);
  assert.match(html, /The new capacity is available now and can be assigned to a member or guest/);
  assert.match(html, /Manage seats/);
  assert.doesNotMatch(html, /Stripe confirmed|updated the purchased seat capacity/);
});

test("billing lifecycle emails use forecast, applied, and restored impact language", () => {
  const base = {
    clientId: "client-1",
    displayName: "Dylan",
    orgName: "Happen Software",
    settingsUrl: "https://kanera.test/settings/account-plan",
    impact: { boardsArchived: 2, usersSuspended: 1, automationsDisabled: 0, webhooksDisabled: 0, apiKeysRevoked: 0, guestMembersRemoved: 0, guestInvitesRevoked: 0 },
    limits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 1 },
  };

  const warning = proTrialWarningEmail({ ...base, daysRemaining: 10, trialEndsAtLabel: "Aug 13, 2026" });
  assert.match(warning, /2 boards will be archived/);
  assert.match(warning, /1 member will be suspended/);
  assert.match(warning, /Kanera Basic includes unlimited workspaces/);

  const ended = proCancelledEmail(base);
  assert.match(ended, /2 boards archived/);
  assert.match(ended, /1 member suspended/);
  assert.doesNotMatch(ended, /will be archived|will be suspended/);

  const restored = upgradedToProEmail({ ...base, billingInterval: "annual", purchasedSeatCount: 8, periodEndLabel: "Aug 13, 2027" });
  assert.match(restored, /2 boards restored/);
  assert.match(restored, /1 member reactivated/);
  assert.doesNotMatch(restored, /Kanera Basic includes/);
});

test("subscription emails present customer-facing billing details instead of Stripe status text", () => {
  const html = billingChangedEmail({
    clientId: "client-1",
    displayName: "Dylan",
    orgName: "Happen Software",
    settingsUrl: "https://kanera.test/settings/account-plan",
    billingInterval: "annual",
    purchasedSeatCount: 8,
    periodEndLabel: "Aug 13, 2027",
  });

  assert.match(html, /Billing/);
  assert.match(html, /Annual/);
  assert.match(html, /Purchased seats/);
  assert.match(html, /Next renewal/);
  assert.match(html, /Aug 13, 2027/);
  assert.doesNotMatch(html, /Stripe confirmed|active seats|current period ends/);
});

function assertRenderedEmail(html: string, subject: string): void {
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, new RegExp(`<title>${escapeRegExp(subject)}</title>`));
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, /<meta name="supported-color-schemes" content="light">/);
  assert.match(html, /<img src="https:\/\/www\.kanera\.app\/assets\/logo\/jpg\/logo%20light%20long\.jpg" alt="Kanera"/);
  assert.match(html, /class="email-card"/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
