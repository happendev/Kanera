import type { Locale } from "@kanera/shared/locales";
import type { OrgInviteEmailQueueData } from "@kanera/shared/schema";
import { serverMessages } from "../i18n/messages/index.js";
import { roleLabel } from "./role-label.js";
import { button, emailLayout, fallbackLink, heading, joinSentences, mutedHtml, paragraphHtml, plainStrong, richHtml, strong, text } from "./layout.js";

/** `locale` is the inviter's language: the invitee may have no account to read one from. */
export type OrgInviteEmailParams = OrgInviteEmailQueueData & { locale: Locale };

export function orgInviteEmailSubject(params: Pick<OrgInviteEmailParams, "locale" | "invitedByName" | "orgName">): string {
  return serverMessages(params.locale).email.orgInvite.subject({ inviter: params.invitedByName, org: params.orgName });
}

export function orgInviteEmail(params: OrgInviteEmailParams): string {
  const messages = serverMessages(params.locale);
  const m = messages.email.orgInvite;
  return emailLayout({
    locale: params.locale,
    subject: orgInviteEmailSubject(params),
    preheader: m.preheader({ org: params.orgName }),
    body: `
      ${heading(m.heading({ org: params.orgName }))}
      ${paragraphHtml(richHtml((s) => m.intro(s), { inviter: text(params.invitedByName), org: strong(params.orgName) }), "0 0 16px 0")}
      ${paragraphHtml(richHtml((s) => m.role(s), { role: strong(roleLabel(params.orgRole, params.locale)) }), "0")}
      ${button({ href: params.acceptUrl, label: m.button })}
      ${mutedHtml(joinSentences(params.locale, [params.expiresAtLabel ? richHtml((s) => m.expiry(s), { date: plainStrong(params.expiresAtLabel) }) : null, text(m.ignore)]))}
      ${fallbackLink(params.acceptUrl, params.locale)}
    `,
    footerReason: messages.layout.footerInvite({ inviter: params.invitedByName }),
  });
}
