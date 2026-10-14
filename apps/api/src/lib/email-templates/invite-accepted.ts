import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { roleLabel } from "./role-label.js";
import { button, divider, emailLayout, fallbackLink, heading, paragraph } from "./layout.js";

export type InviteAcceptedEmailParams = {
  context?: "org";
  locale: Locale;
  displayName: string;
  acceptedByName: string;
  acceptedByEmail: string;
  orgName: string;
  orgRole: string;
  membersUrl: string;
} | {
  context: "board";
  locale: Locale;
  displayName: string;
  acceptedByName: string;
  acceptedByEmail: string;
  orgName: string;
  boardName: string;
  boardRole: string;
  boardUrl: string;
};

export function inviteAcceptedEmail(params: InviteAcceptedEmailParams): string {
  const { locale, displayName, acceptedByName, acceptedByEmail, orgName } = params;
  const m = serverMessages(locale).email.inviteAccepted;
  const firstName = displayName.split(" ")[0] ?? displayName;

  if (params.context === "board") {
    const b = m.board;
    return emailLayout({
      locale,
      subject: m.subject,
      preheader: b.preheader({ name: acceptedByName, board: params.boardName }),
      body: `
        ${heading(b.heading)}
        ${paragraph(b.intro({ firstName, name: acceptedByName, board: params.boardName, org: orgName }))}
        ${divider("0 0 24px 0")}
        ${paragraph(b.newGuest({ name: acceptedByName, email: acceptedByEmail }), "0 0 8px 0")}
        ${paragraph(b.role({ role: roleLabel(params.boardRole, locale) }), "0 0 24px 0")}
        ${button({ href: params.boardUrl, label: b.button })}
        ${fallbackLink(params.boardUrl, locale)}
      `,
    });
  }
  const o = m.org;

  return emailLayout({
    locale,
    subject: m.subject,
    preheader: o.preheader({ name: acceptedByName, org: orgName }),
    body: `
      ${heading(o.heading)}
      ${paragraph(o.intro({ firstName, name: acceptedByName, org: orgName }))}
      ${divider("0 0 24px 0")}
      ${paragraph(o.newMember({ name: acceptedByName, email: acceptedByEmail }), "0 0 8px 0")}
      ${paragraph(o.role({ role: roleLabel(params.orgRole, locale) }), "0 0 24px 0")}
      ${button({ href: params.membersUrl, label: o.button })}
      ${fallbackLink(params.membersUrl, locale)}
    `,
  });
}
