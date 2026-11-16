import assert from "node:assert/strict";
import { test } from "node:test";
import type { SmtpConfig } from "@kanera/shared/schema";
import {
  sendInternalCheckoutNotification,
  sendInternalSaleNotification,
  sendInternalSignupNotification,
  sendInternalTrialEndingNotification,
} from "./internal-notification-emails.js";
import type { SendEmailOptions } from "./smtp.js";

const smtpConfig: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  security: "starttls",
  fromEmail: "app@example.com",
};

test("internal signup notification sends plain text to configured recipients", async () => {
  const sent: SendEmailOptions[] = [];

  const count = await sendInternalSignupNotification(
    { type: "signup", displayName: "Ada Lovelace", email: "ada@example.com", orgName: "Analytical" },
    {
      config: { INTERNAL_NOTIFICATION_EMAILS: ["ops@example.com", "founder@example.com"], NODE_ENV: "production" },
      resolveConfig: async () => smtpConfig,
      deliverEmail: async (message) => {
        sent.push(message);
      },
    },
  );

  assert.equal(count, 2);
  assert.deepEqual(sent.map((message) => message.to), ["ops@example.com", "founder@example.com"]);
  assert.equal(sent[0]!.subject, "Kanera signup notification");
  assert.equal(sent[0]!.html, undefined);
  assert.equal(sent[0]!.text, "Ada Lovelace <ada@example.com> has signed up.");
});

test("internal invite acceptance notification names the org", async () => {
  const sent: SendEmailOptions[] = [];

  await sendInternalSignupNotification(
    { type: "invite_accepted", displayName: "Grace Hopper", email: "grace@example.com", orgName: "Compiler Co" },
    {
      config: { INTERNAL_NOTIFICATION_EMAILS: ["ops@example.com"], NODE_ENV: "test" },
      resolveConfig: async () => smtpConfig,
      deliverEmail: async (message) => {
        sent.push(message);
      },
    },
  );

  assert.equal(sent[0]!.text, "Grace Hopper <grace@example.com> has accepted invite to org Compiler Co.");
});

test("internal signup notification skips when recipients or SMTP are missing", async () => {
  const withoutRecipients = await sendInternalSignupNotification(
    { type: "signup", displayName: "Ada", email: "ada@example.com", orgName: "Analytical" },
    {
      config: { INTERNAL_NOTIFICATION_EMAILS: [], NODE_ENV: "production" },
      resolveConfig: async () => smtpConfig,
      deliverEmail: async () => assert.fail("should not send without recipients"),
    },
  );
  assert.equal(withoutRecipients, 0);

  const withoutSmtp = await sendInternalSignupNotification(
    { type: "signup", displayName: "Ada", email: "ada@example.com", orgName: "Analytical" },
    {
      config: { INTERNAL_NOTIFICATION_EMAILS: ["ops@example.com"], NODE_ENV: "production" },
      resolveConfig: async () => null,
      deliverEmail: async () => assert.fail("should not send without SMTP"),
    },
  );
  assert.equal(withoutSmtp, 0);
});

test("internal sale notification includes commercial context for every configured recipient", async () => {
  const sent: SendEmailOptions[] = [];

  const count = await sendInternalSaleNotification(
    {
      orgName: "Compiler Co",
      clientId: "client-123",
      amountPaid: 14_500,
      currency: "eur",
      billingReason: "subscription_create",
      billingInterval: "annual",
      seatCount: 5,
      stripeInvoiceId: "in_123",
    },
    {
      config: { INTERNAL_NOTIFICATION_EMAILS: ["ops@example.com", "founder@example.com"], NODE_ENV: "production" },
      resolveConfig: async () => smtpConfig,
      deliverEmail: async (message) => {
        sent.push(message);
      },
    },
  );

  assert.equal(count, 2);
  assert.equal(sent[0]!.subject, "Kanera new subscription: €145.00 from Compiler Co");
  assert.equal(sent[0]!.html, undefined);
  assert.equal(sent[0]!.text, [
    "Kanera received a new subscription.",
    "",
    "Organisation: Compiler Co",
    "Amount: €145.00 EUR",
    "Plan: Pro annual",
    "Seats: 5",
    "Stripe invoice: in_123",
    "Organisation ID: client-123",
  ].join("\n"));
});

test("internal notifications do not throw when SMTP resolution fails", async () => {
  const count = await sendInternalSaleNotification(
    {
      orgName: "Compiler Co",
      clientId: "client-123",
      amountPaid: 500,
      currency: "eur",
      billingReason: "subscription_cycle",
      billingInterval: "monthly",
      seatCount: 1,
      stripeInvoiceId: "in_123",
    },
    {
      config: { INTERNAL_NOTIFICATION_EMAILS: ["ops@example.com"], NODE_ENV: "production" },
      resolveConfig: async () => {
        throw new Error("vault unavailable");
      },
      deliverEmail: async () => assert.fail("should not send without resolved SMTP"),
    },
  );

  assert.equal(count, 0);
});

const capture = (sent: SendEmailOptions[]) => ({
  config: { INTERNAL_NOTIFICATION_EMAILS: ["ops@example.com"], NODE_ENV: "production" as const },
  resolveConfig: async () => smtpConfig,
  deliverEmail: async (message: SendEmailOptions) => {
    sent.push(message);
  },
});

test("internal signup notification names the channel that brought the person in", async () => {
  const sent: SendEmailOptions[] = [];
  await sendInternalSignupNotification({
    type: "signup",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    orgName: "Private",
    attribution: { source: "reddit", medium: "paid_social", campaign: "nov-launch", referringDomain: "www.reddit.com", landingPage: "/pricing" },
  }, capture(sent));

  assert.equal(sent[0]!.text, [
    "Ada Lovelace <ada@example.com> has signed up.",
    "",
    "Source: reddit / paid_social",
    "Campaign: nov-launch",
    "Referrer: www.reddit.com",
    "Landing page: /pricing",
  ].join("\n"));
});

test("internal checkout notifications say who to follow up with", async () => {
  const sent: SendEmailOptions[] = [];
  const base = {
    orgName: "Compiler Co",
    clientId: "client-123",
    startedBy: { displayName: "Grace Hopper", email: "grace@example.com" },
    billingInterval: "annual" as const,
    seatCount: 4,
  };
  await sendInternalCheckoutNotification({ ...base, type: "checkout_started" }, capture(sent));
  await sendInternalCheckoutNotification({ ...base, type: "checkout_abandoned", customerEmailed: true }, capture(sent));

  assert.equal(sent[0]!.subject, "Kanera checkout started: Compiler Co");
  assert.match(sent[0]!.text!, /Started by: Grace Hopper <grace@example.com>/);
  assert.doesNotMatch(sent[0]!.text!, /Follow-up email/);
  assert.equal(sent[1]!.subject, "Kanera checkout abandoned: Compiler Co");
  assert.match(sent[1]!.text!, /Plan: Pro annual\nSeats: 4\nFollow-up email sent to them: yes/);
});

test("internal trial ending notification carries usage and owners", async () => {
  const sent: SendEmailOptions[] = [];
  await sendInternalTrialEndingNotification({
    orgName: "Compiler Co",
    clientId: "client-123",
    trialEndsAt: new Date("2026-12-02T10:00:00.000Z"),
    owners: [{ displayName: "Grace Hopper", email: "grace@example.com" }],
    members: 3,
    boards: 2,
    cards: 41,
    lastActiveAt: new Date("2026-11-28T09:00:00.000Z"),
  }, capture(sent));

  assert.equal(sent[0]!.subject, "Kanera trial ending 2026-12-02: Compiler Co");
  assert.match(sent[0]!.text!, /Owners: Grace Hopper <grace@example.com>\nMembers: 3\nBoards: 2\nCards: 41\nLast active: 2026-11-28/);
});
