import type { FastifyBaseLogger } from "fastify";
import { env, type Env } from "../env.js";
import { emailSubject } from "./mailer.js";
import { resolveSmtpConfig } from "./smtp-resolve.js";
import { sendEmail, type SendEmailOptions } from "./smtp.js";

type InternalNotificationEnv = Pick<Env, "INTERNAL_NOTIFICATION_EMAILS" | "NODE_ENV">;

export type InternalSignupNotification =
  | { type: "signup"; displayName: string; email: string; orgName: string }
  | { type: "invite_accepted"; displayName: string; email: string; orgName: string };

export async function sendInternalSignupNotification(
  notification: InternalSignupNotification,
  options: {
    config?: InternalNotificationEnv;
    deliverEmail?: (options: SendEmailOptions) => Promise<void>;
    resolveConfig?: typeof resolveSmtpConfig;
    log?: FastifyBaseLogger;
  } = {},
): Promise<number> {
  const config = options.config ?? env;
  const recipients = config.INTERNAL_NOTIFICATION_EMAILS;
  if (recipients.length === 0) return 0;

  const smtpConfig = await (options.resolveConfig ?? resolveSmtpConfig)("__env__");
  if (!smtpConfig) {
    options.log?.warn({ recipients }, "skipped internal signup notification because env SMTP is not configured");
    return 0;
  }

  const subject = emailSubject("Kanera signup notification", config.NODE_ENV);
  const text = notification.type === "invite_accepted"
    ? `${notification.displayName} <${notification.email}> has accepted invite to org ${notification.orgName}.`
    : `${notification.displayName} <${notification.email}> has signed up.`;
  const deliverEmail = options.deliverEmail ?? sendEmail;

  const results = await Promise.allSettled(
    recipients.map((to) => deliverEmail({ config: smtpConfig, to, subject, text })),
  );
  let sent = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      sent += 1;
      continue;
    }
    options.log?.error({ err: result.reason, to: recipients[index] }, "failed to send internal signup notification");
  }
  return sent;
}
