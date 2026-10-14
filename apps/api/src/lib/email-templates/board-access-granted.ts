import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { roleLabel } from "./role-label.js";
import { button, emailLayout, heading, paragraphHtml, richHtml, strong, text } from "./layout.js";

export interface BoardAccessGrantedEmailParams {
  locale: Locale;
  displayName: string;
  boardName: string;
  orgName: string;
  invitedByName: string;
  role: string;
  boardUrl: string;
}

export function boardAccessGrantedEmail({
  locale,
  displayName,
  boardName,
  orgName,
  invitedByName,
  role,
  boardUrl,
}: BoardAccessGrantedEmailParams): string {
  const m = serverMessages(locale).email.boardAccessGranted;

  return emailLayout({
    locale,
    subject: m.subject({ board: boardName }),
    preheader: m.preheader({ inviter: invitedByName, board: boardName, org: orgName }),
    body: `
      ${heading(m.heading)}
      ${paragraphHtml(richHtml((s) => m.intro(s), { name: text(displayName), inviter: text(invitedByName), board: strong(boardName), org: text(orgName) }))}
      ${paragraphHtml(richHtml((s) => m.role(s), { role: strong(roleLabel(role, locale)) }))}
      ${button({ href: boardUrl, label: m.button })}
    `,
  });
}
