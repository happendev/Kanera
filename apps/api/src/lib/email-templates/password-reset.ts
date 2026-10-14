import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph, plainStrong, richHtml } from "./layout.js";

export interface PasswordResetEmailParams {
  locale: Locale;
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export function passwordResetEmail({ locale, displayName, resetUrl, expiresInMinutes }: PasswordResetEmailParams): string {
  const messages = serverMessages(locale);
  const m = messages.email.passwordReset;
  const firstName = displayName.split(" ")[0] ?? displayName;

  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ firstName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName }))}
      ${button({ href: resetUrl, label: m.button })}
      ${mutedHtml(richHtml((s) => m.expiry(s), { duration: plainStrong(messages.common.minutes({ count: expiresInMinutes })) }))}
      ${divider("24px 0 0 0")}
      ${fallbackLink(resetUrl, locale)}
    `,
  });
}
