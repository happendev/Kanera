import type { FastifyBaseLogger } from "fastify";
import { env, type Env } from "../env.js";
import { emailSubject } from "./mailer.js";
import { resolveSmtpConfig } from "./smtp-resolve.js";
import { sendEmail, type SendEmailOptions } from "./smtp.js";

type InternalNotificationEnv = Pick<Env, "INTERNAL_NOTIFICATION_EMAILS" | "NODE_ENV">;

/** Where a self-serve signup came from, as the web app captured it (UTM tags or referrer). */
export type InternalSignupAttribution = {
  source: string;
  medium: string;
  campaign: string;
  referringDomain?: string;
  landingPage?: string;
};

export type InternalSignupNotification =
  | { type: "signup"; displayName: string; email: string; orgName: string; attribution?: InternalSignupAttribution | null }
  | { type: "invite_accepted"; displayName: string; email: string; orgName: string };

type InternalPerson = { displayName: string; email: string };

/**
 * Checkout moments worth a personal follow-up. Stripe only reports payment, so without these the team
 * never learns that an admin reached the payment page and left.
 */
export type InternalCheckoutNotification = {
  type: "checkout_started" | "checkout_abandoned";
  orgName: string;
  clientId: string;
  startedBy: InternalPerson | null;
  billingInterval: "monthly" | "annual" | null;
  seatCount: number;
  /** checkout_abandoned only: whether the follow-up email went to the person who started it. */
  customerEmailed?: boolean;
};

export type InternalTrialEndingNotification = {
  orgName: string;
  clientId: string;
  trialEndsAt: Date;
  owners: InternalPerson[];
  members: number;
  boards: number;
  cards: number;
  lastActiveAt: Date | null;
};

export type InternalSaleNotification = {
  orgName: string;
  clientId: string;
  amountPaid: number;
  currency: string;
  billingReason: "subscription_create" | "subscription_cycle" | "subscription_update" | "subscription_threshold" | "other";
  billingInterval: "monthly" | "annual" | null;
  seatCount: number;
  stripeInvoiceId: string;
};

type InternalNotificationOptions = {
  config?: InternalNotificationEnv;
  deliverEmail?: (options: SendEmailOptions) => Promise<void>;
  resolveConfig?: typeof resolveSmtpConfig;
  log?: FastifyBaseLogger;
};

export async function sendInternalSignupNotification(
  notification: InternalSignupNotification,
  options: InternalNotificationOptions = {},
): Promise<number> {
  const config = options.config ?? env;
  const subject = emailSubject("Kanera signup notification", config.NODE_ENV);
  const text = notification.type === "invite_accepted"
    ? `${notification.displayName} <${notification.email}> has accepted invite to org ${notification.orgName}.`
    : [`${notification.displayName} <${notification.email}> has signed up.`, ...attributionLines(notification.attribution)].join("\n");

  return deliverInternalNotification({ subject, text }, "signup", options);
}

function attributionLines(attribution: InternalSignupAttribution | null | undefined): string[] {
  if (!attribution) return [];
  return [
    "",
    `Source: ${attribution.source} / ${attribution.medium}`,
    `Campaign: ${attribution.campaign}`,
    ...(attribution.referringDomain ? [`Referrer: ${attribution.referringDomain}`] : []),
    ...(attribution.landingPage ? [`Landing page: ${attribution.landingPage}`] : []),
  ];
}

export async function sendInternalCheckoutNotification(
  notification: InternalCheckoutNotification,
  options: InternalNotificationOptions = {},
): Promise<number> {
  const config = options.config ?? env;
  const started = notification.type === "checkout_started";
  const subject = emailSubject(
    started ? `Kanera checkout started: ${notification.orgName}` : `Kanera checkout abandoned: ${notification.orgName}`,
    config.NODE_ENV,
  );
  const plan = notification.billingInterval ? `Pro ${notification.billingInterval}` : "Pro";
  const text = [
    started
      ? "Someone opened Stripe checkout. If no sale notification follows, it will be reported as abandoned when the session expires."
      : "A Stripe checkout expired without payment. This is a good moment for a personal follow-up.",
    "",
    `Organisation: ${notification.orgName}`,
    `Started by: ${notification.startedBy ? `${notification.startedBy.displayName} <${notification.startedBy.email}>` : "unknown"}`,
    `Plan: ${plan}`,
    `Seats: ${notification.seatCount}`,
    ...(started ? [] : [`Follow-up email sent to them: ${notification.customerEmailed ? "yes" : "no"}`]),
    `Organisation ID: ${notification.clientId}`,
  ].join("\n");

  return deliverInternalNotification({ subject, text }, "checkout", options);
}

export async function sendInternalTrialEndingNotification(
  notification: InternalTrialEndingNotification,
  options: InternalNotificationOptions = {},
): Promise<number> {
  const config = options.config ?? env;
  const ends = notification.trialEndsAt.toISOString().slice(0, 10);
  const subject = emailSubject(`Kanera trial ending ${ends}: ${notification.orgName}`, config.NODE_ENV);
  const text = [
    "This organisation's Pro trial ends soon and it has not subscribed. It will move to Free automatically.",
    "",
    `Organisation: ${notification.orgName}`,
    `Trial ends: ${ends}`,
    `Owners: ${notification.owners.length > 0 ? notification.owners.map((owner) => `${owner.displayName} <${owner.email}>`).join(", ") : "none"}`,
    `Members: ${notification.members}`,
    `Boards: ${notification.boards}`,
    `Cards: ${notification.cards}`,
    `Last active: ${notification.lastActiveAt ? notification.lastActiveAt.toISOString().slice(0, 10) : "never"}`,
    `Organisation ID: ${notification.clientId}`,
  ].join("\n");

  return deliverInternalNotification({ subject, text }, "trial", options);
}

export async function sendInternalSaleNotification(
  notification: InternalSaleNotification,
  options: InternalNotificationOptions = {},
): Promise<number> {
  const config = options.config ?? env;
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: notification.currency.toUpperCase(),
  }).format(notification.amountPaid / 100);
  const saleType = saleTypeLabel(notification.billingReason);
  const plan = notification.billingInterval ? `Pro ${notification.billingInterval}` : "Pro";
  const subject = emailSubject(`Kanera ${saleType.toLowerCase()}: ${amount} from ${notification.orgName}`, config.NODE_ENV);
  const text = [
    `Kanera received a ${saleType.toLowerCase()}.`,
    "",
    `Organisation: ${notification.orgName}`,
    `Amount: ${amount} ${notification.currency.toUpperCase()}`,
    `Plan: ${plan}`,
    `Seats: ${notification.seatCount}`,
    `Stripe invoice: ${notification.stripeInvoiceId}`,
    `Organisation ID: ${notification.clientId}`,
  ].join("\n");

  return deliverInternalNotification({ subject, text }, "sale", options);
}

async function deliverInternalNotification(
  message: { subject: string; text: string },
  kind: "signup" | "sale" | "checkout" | "trial",
  options: InternalNotificationOptions,
): Promise<number> {
  const config = options.config ?? env;
  const recipients = config.INTERNAL_NOTIFICATION_EMAILS;
  if (recipients.length === 0) return 0;

  let smtpConfig;
  try {
    smtpConfig = await (options.resolveConfig ?? resolveSmtpConfig)("__env__");
  } catch (err) {
    // Internal alerts are operational side effects. A transient SMTP/config failure must never roll
    // back signup or make Stripe retry an otherwise successfully processed payment webhook.
    options.log?.error({ err, recipients, kind }, "failed to resolve SMTP for internal notification");
    return 0;
  }
  if (!smtpConfig) {
    options.log?.warn({ recipients, kind }, "skipped internal notification because env SMTP is not configured");
    return 0;
  }

  const deliverEmail = options.deliverEmail ?? sendEmail;

  const results = await Promise.allSettled(
    recipients.map((to) => deliverEmail({ config: smtpConfig, to, ...message })),
  );
  let sent = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      sent += 1;
      continue;
    }
    options.log?.error({ err: result.reason, to: recipients[index], kind }, "failed to send internal notification");
  }
  return sent;
}

function saleTypeLabel(reason: InternalSaleNotification["billingReason"]): string {
  switch (reason) {
    case "subscription_create":
      return "New subscription";
    case "subscription_cycle":
      return "Subscription renewal";
    case "subscription_update":
      return "Subscription upgrade";
    case "subscription_threshold":
      return "Subscription usage payment";
    case "other":
      return "Subscription payment";
  }
}
