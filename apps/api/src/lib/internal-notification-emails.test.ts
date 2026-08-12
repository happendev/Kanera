import assert from "node:assert/strict";
import { test } from "node:test";
import type { SmtpConfig } from "@kanera/shared/schema";
import { sendInternalSaleNotification, sendInternalSignupNotification } from "./internal-notification-emails.js";
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
