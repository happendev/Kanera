import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { roleLabel } from "./role-label.js";
import { button, emailLayout, fallbackLink, heading, paragraphHtml, richHtml, strong, text } from "./layout.js";

export interface BoardInviteEmailParams {
  /** The inviter's language: the invitee has no account to read one from. */
  locale: Locale;
  boards: Array<{ boardName: string; role: string }>;
  orgName: string;
  invitedByName: string;
  acceptUrl: string;
}

export function boardInviteEmailSubject({ locale, boards }: Pick<BoardInviteEmailParams, "locale" | "boards">): string {
  return serverMessages(locale).email.boardInvite.subject({ boardCount: boards.length, boardName: boards[0]!.boardName });
}

export function boardInviteEmail({
  locale,
  boards,
  orgName,
  invitedByName,
  acceptUrl,
}: BoardInviteEmailParams): string {
  const m = serverMessages(locale).email.boardInvite;
  const grants = boards;
  const firstBoard = grants[0]!;
  const grantList = grants
    .map(({ boardName, role }) => richHtml((s) => m.grant(s), { board: strong(boardName), role: text(roleLabel(role, locale)) }))
    .join("<br />");

  return emailLayout({
    locale,
    subject: boardInviteEmailSubject({ locale, boards }),
    preheader: m.preheader({ inviter: invitedByName, boardCount: grants.length, boardName: firstBoard.boardName, org: orgName }),
    body: `
      ${heading(m.heading)}
      ${paragraphHtml(richHtml((s) => m.intro({ ...s, boardCount: grants.length }), { inviter: text(invitedByName), org: text(orgName) }))}
      ${paragraphHtml(grantList)}
      ${button({ href: acceptUrl, label: m.button })}
      ${fallbackLink(acceptUrl, locale)}
    `,
  });
}
