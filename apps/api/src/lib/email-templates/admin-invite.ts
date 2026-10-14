import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph, plainStrong, richHtml } from "./layout.js";

export interface AdminInviteEmailParams { locale: Locale; displayName: string; inviteUrl: string; expiresInHours: number }

export function adminInviteEmail({ locale, displayName, inviteUrl, expiresInHours }: AdminInviteEmailParams): string {
  const messages = serverMessages(locale);
  const m = messages.email.adminInvite;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ firstName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName }))}
      ${button({ href: inviteUrl, label: m.button })}
      ${mutedHtml(richHtml((s) => m.expiry(s), { duration: plainStrong(messages.common.hours({ count: expiresInHours })) }))}
      ${divider("24px 0 0 0")}
      ${fallbackLink(inviteUrl, locale)}
    `,
  });
}
