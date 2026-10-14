import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { codeDisplay, divider, emailLayout, heading, mutedHtml, paragraph, plainStrong, richHtml } from "./layout.js";

export interface VerificationCodeEmailParams {
  /** At signup no account exists yet, so this is the language the signup form was shown in. */
  locale: Locale;
  code: string;
  expiresInMinutes: number;
}

// Sent during signup and email changes. No display name: at signup-request time
// no account exists yet, so the copy stays generic.
export function verificationCodeEmail({ locale, code, expiresInMinutes }: VerificationCodeEmailParams): string {
  const messages = serverMessages(locale);
  const m = messages.email.verificationCode;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ code }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.instruction)}
      ${codeDisplay(code, locale)}
      ${mutedHtml(richHtml((s) => m.expiry(s), { duration: plainStrong(messages.common.minutes({ count: expiresInMinutes })) }))}
      ${divider("24px 0 0 0")}
    `,
  });
}
