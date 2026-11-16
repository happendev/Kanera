import type { AccountSecurityEvent, SignInProvider } from "@kanera/shared/schema";
import { users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { formatMomentInZone } from "./i18n/format.js";
import { recipientLocale } from "./i18n/request-locale.js";
import type { Mailer } from "./mailer.js";

/**
 * Emails the account owner after a security-relevant change so that someone who did not make it
 * finds out. Sent regardless of notification settings: turning email notifications off must not hide
 * a takeover. A failure is logged, never thrown, so the change itself still succeeds.
 *
 * `toEmail` overrides the recipient for an email change, whose notice goes to the previous address.
 */
export async function notifyAccountSecurityChange(
  mailer: Mailer,
  { userId, event, toEmail, newEmail, provider, log, now = new Date() }: {
    userId: string;
    event: AccountSecurityEvent;
    toEmail?: string;
    newEmail?: string;
    provider?: SignInProvider;
    log: FastifyBaseLogger;
    now?: Date;
  },
): Promise<void> {
  try {
    const [user] = await db
      .select({ email: users.email, displayName: users.displayName, locale: users.locale, timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return;
    const locale = recipientLocale(user.locale);
    await mailer.sendAccountSecurity(toEmail ?? user.email, {
      locale,
      displayName: user.displayName,
      event,
      occurredAtLabel: formatMomentInZone(locale, now, user.timezone),
      newEmail: newEmail ?? null,
      provider: provider ?? null,
      securityUrl: `${env.WEB_ORIGIN}/settings/account-security`,
      supportEmail: securitySupportEmail(),
    });
  } catch (err) {
    log.error({ err, userId, event }, "failed to queue account security notice");
  }
}

/** Hosted installs have a support desk; on self-hosted the copy points at the local administrator. */
export function securitySupportEmail(): string | null {
  return env.KANERA_DEPLOYMENT_MODE === "hosted" ? env.LIFECYCLE_FEEDBACK_EMAIL : null;
}
