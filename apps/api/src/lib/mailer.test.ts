import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_QUEUE_STATUS, type EmailQueue } from "@kanera/shared/schema";
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
    dueToday: [{ title: "Ship release", boardName: "Launch", cardUrl: "https://kanera.test/b/board-1?cardId=card-1" }],
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
        cardUrl: "https://kanera.test/b/board-1?cardId=card-1",
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
        cardUrl: "https://kanera.test/b/board-1?cardId=card-1",
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
        cardUrl: "https://kanera.test/b/board-1?cardId=card-1",
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
        cardUrl: "https://kanera.test/b/board-1?cardId=card-1",
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
        cardUrl: "https://kanera.test/b/board-1?cardId=card-1",
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
    { ...base, subject: "Kanera moved your organisation to Free", type: "downgraded_to_free" as const },
    { ...base, subject: "Kanera Pro is active", type: "upgraded_to_pro" as const },
    { ...base, subject: "Your Kanera billing is confirmed", type: "billing_changed" as const },
    { ...base, subject: "A Kanera seat was billed", type: "seat_billed" as const },
    { ...base, subject: "Kanera Pro was cancelled", type: "pro_cancelled" as const },
  ];

  for (const row of rows) {
    const html = renderEmail(row);
    assertRenderedEmail(html, row.subject);
    assert.match(html, /Acme/);
    assert.match(html, /https:\/\/kanera\.test\/settings\/account-plan/);
  }
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
