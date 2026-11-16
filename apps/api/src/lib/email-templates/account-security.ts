import type { Locale } from "@kanera/shared/locales";
import type { AccountSecurityEmailQueueData, AccountSecurityEvent } from "@kanera/shared/schema";
import { serverMessages } from "../i18n/messages/index.js";
import type { SecurityNotice, ServerMessages } from "../i18n/messages/types.js";
import { button, emailLayout, fallbackLink, heading, mailtoLink, mutedHtml, paragraph, richHtml, text } from "./layout.js";

export type AccountSecurityEmailParams = AccountSecurityEmailQueueData & { locale: Locale };

type SecurityMessages = ServerMessages["email"]["accountSecurity"];

function notice(m: SecurityMessages, event: AccountSecurityEvent): SecurityNotice | SecurityMessages["emailChanged"] {
  switch (event) {
    case "password_changed": return m.passwordChanged;
    case "password_reset": return m.passwordReset;
    case "email_changed": return m.emailChanged;
    case "mfa_enabled": return m.mfaEnabled;
    case "mfa_disabled": return m.mfaDisabled;
    case "recovery_codes_regenerated": return m.recoveryCodesRegenerated;
  }
}

/** Shared with the mailer so the queued subject and the rendered <title> cannot drift. */
export function accountSecurityEmailSubject(params: Pick<AccountSecurityEmailParams, "locale" | "event">): string {
  return notice(serverMessages(params.locale).email.accountSecurity, params.event).subject;
}

/**
 * Confirms a security-relevant change to the recipient's own account, so someone who did not make it
 * finds out. Every notice says what to do then: reset the password, or for an email change (where a
 * reset would go to the new address) contact support.
 */
export function accountSecurityEmail(params: AccountSecurityEmailParams): string {
  const messages = serverMessages(params.locale);
  const m = messages.email.accountSecurity;
  const firstName = params.displayName.split(" ")[0] || params.displayName;
  const n = notice(m, params.event);
  const intro = params.event === "email_changed"
    ? m.emailChanged.intro({ firstName, newEmail: params.newEmail ?? "", when: params.occurredAtLabel })
    : (n as SecurityNotice).intro({ firstName, when: params.occurredAtLabel });
  const support = params.supportEmail ?? null;
  const notYou = params.event === "email_changed"
    ? support ? richHtml((s) => m.notYouEmailWithSupport(s), { email: mailtoLink(support) }) : text(m.notYouEmailWithoutSupport)
    : support ? richHtml((s) => m.notYouWithSupport(s), { email: mailtoLink(support) }) : text(m.notYouWithoutSupport);
  return emailLayout({
    locale: params.locale,
    subject: n.subject,
    preheader: n.preheader,
    body: `
      ${heading(n.heading)}
      ${paragraph(intro, "0 0 16px 0")}
      ${mutedHtml(notYou, "0")}
      ${button({ href: params.securityUrl, label: m.button })}
      ${fallbackLink(params.securityUrl, params.locale)}
    `,
    footerReason: messages.layout.footerSecurity,
  });
}
