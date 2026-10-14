import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { button, cardSummary, divider, emailLayout, heading, mutedHtml, paragraph, quoteBlock, sectionLabel, text } from "./layout.js";

export interface SmtpTestEmailParams {
  locale: Locale;
  recipientEmail: string;
  appUrl: string;
  /** Already in `locale`. */
  sentAtLabel: string;
}

export function smtpTestEmail({ locale, recipientEmail, appUrl, sentAtLabel }: SmtpTestEmailParams): string {
  const m = serverMessages(locale).email.smtpTest;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader,
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ email: recipientEmail, sentAt: sentAtLabel }), "0 0 20px 0")}
      ${divider()}
      ${mutedHtml(text(m.renderingNote), "24px 0 18px 0")}
      ${sectionLabel(m.renderingCheck)}
      ${cardSummary({ title: m.sampleCardTitle, subtitle: m.sampleCardSubtitle, href: appUrl })}
      ${quoteBlock(m.sampleQuote)}
      ${button({ href: appUrl, label: m.button })}
    `,
  });
}
