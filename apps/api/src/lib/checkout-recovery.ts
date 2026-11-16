import { clientMembers, clients, lifecycleEmailSends, notificationSettings, users } from "@kanera/shared/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type Stripe from "stripe";
import { db } from "../db.js";
import { env } from "../env.js";
import { recipientLocale } from "./i18n/request-locale.js";
import { sendInternalCheckoutNotification } from "./internal-notification-emails.js";
import { lifecycleUnsubscribeUrl } from "./lifecycle-emails.js";
import type { Mailer } from "./mailer.js";

const DAY_MS = 86_400_000;
// One follow-up per organisation in this window, however many checkouts its admins open and leave.
const FOLLOW_UP_REPEAT_DAYS = 30;
// Stripe stamps the event when the session actually expired. A session expired more than this long
// before its own expires_at was closed on purpose, not left behind.
const EARLY_EXPIRY_TOLERANCE_SECONDS = 60;

type FollowUpOptions = {
  mailer?: Mailer;
  log?: FastifyBaseLogger;
  sendInternal?: typeof sendInternalCheckoutNotification;
  now?: Date;
};

/**
 * Runs after a checkout.session.expired webhook commits. The person who opened checkout gets one email
 * asking what got in the way, and the team gets an internal notification so someone can follow up by
 * hand. Either is skipped when the expiry does not mean the sale was lost.
 */
export async function followUpAbandonedCheckout(
  session: Stripe.Checkout.Session,
  eventCreatedSeconds: number,
  options: FollowUpOptions = {},
): Promise<void> {
  const clientId = session.client_reference_id ?? session.metadata?.clientId;
  if (!clientId) return;
  // createCheckoutSession expires older open sessions when an admin starts a new one (for example to
  // change seats), and that replacement is not an abandonment.
  if (session.expires_at && eventCreatedSeconds < session.expires_at - EARLY_EXPIRY_TOLERANCE_SECONDS) return;

  const [client] = await db
    .select({
      name: clients.name,
      billingStatus: clients.billingStatus,
      deletedAt: clients.deletedAt,
      permanentDeletionRequestedAt: clients.permanentDeletionRequestedAt,
      analyticsExcluded: clients.analyticsExcluded,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client || client.deletedAt || client.permanentDeletionRequestedAt) return;
  // Paid through another session (or the portal) before this one lapsed: nothing was lost.
  if (client.billingStatus === "active" || client.billingStatus === "past_due") return;

  const starter = await checkoutStarter(clientId, session.metadata?.startedByUserId);
  const customerEmailed = await emailStarter(clientId, client, session, starter, options);

  try {
    await (options.sendInternal ?? sendInternalCheckoutNotification)({
      type: "checkout_abandoned",
      orgName: client.name,
      clientId,
      startedBy: starter ? { displayName: starter.displayName, email: starter.email } : null,
      billingInterval: session.metadata?.interval === "annual" ? "annual" : session.metadata?.interval === "monthly" ? "monthly" : null,
      seatCount: Number.parseInt(session.metadata?.seatLimit ?? "1", 10) || 1,
      customerEmailed,
    }, { log: options.log });
  } catch (err) {
    options.log?.error({ err, clientId }, "failed to send internal checkout notification");
  }
}

type Starter = { userId: string; email: string; displayName: string; locale: string | null; acceptsLifecycleEmail: boolean };

/** The admin who opened checkout, while still an active member of the organisation. */
async function checkoutStarter(clientId: string, userId: string | undefined): Promise<Starter | null> {
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      locale: users.locale,
      acceptsLifecycleEmail: sql<boolean>`coalesce(${notificationSettings.emailEnabled}, true) and coalesce(${notificationSettings.lifecycleEmail}, true)`,
    })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.userId, userId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ))
    .limit(1);
  return row ?? null;
}

async function emailStarter(
  clientId: string,
  client: { name: string; analyticsExcluded: boolean },
  session: Stripe.Checkout.Session,
  starter: Starter | null,
  options: FollowUpOptions,
): Promise<boolean> {
  // Same opt-outs as the other lifecycle emails: internal organisations, and people who turned off
  // email or onboarding tips.
  if (!options.mailer || !starter || !starter.acceptsLifecycleEmail || client.analyticsExcluded) return false;
  const now = options.now ?? new Date();
  const recent = await db.$count(lifecycleEmailSends, and(
    eq(lifecycleEmailSends.clientId, clientId),
    eq(lifecycleEmailSends.kind, "checkout_abandoned"),
    gt(lifecycleEmailSends.createdAt, new Date(now.getTime() - FOLLOW_UP_REPEAT_DAYS * DAY_MS)),
  ));
  if (recent > 0) return false;
  // Claim before queueing, keyed on the session, as the lifecycle sweep does: a crash after the claim
  // loses one optional email rather than sending it twice.
  const claimed = await db.insert(lifecycleEmailSends)
    .values({ clientId, kind: "checkout_abandoned", dedupeKey: session.id })
    .onConflictDoNothing()
    .returning({ id: lifecycleEmailSends.id });
  if (claimed.length === 0) return false;
  await options.mailer.sendLifecycle(starter.email, "lifecycle_checkout_abandoned", {
    locale: recipientLocale(starter.locale),
    displayName: starter.displayName,
    orgName: client.name,
    ctaUrl: `${env.WEB_ORIGIN}/settings/account-plan`,
    unsubscribeUrl: lifecycleUnsubscribeUrl(starter.userId),
    feedbackEmail: env.LIFECYCLE_FEEDBACK_EMAIL,
  });
  return true;
}
