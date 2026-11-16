import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { roleLabel } from "./role-label.js";
import { button, emailLayout, fallbackLink, heading, joinSentences, mutedHtml, paragraphHtml, plainStrong, richHtml, strong, text } from "./layout.js";

export interface BoardInviteEmailParams {
  /** The inviter's language: the invitee has no account to read one from. */
  locale: Locale;
  boards: Array<{ boardName: string; role: string }>;
  orgName: string;
  invitedByName: string;
  acceptUrl: string;
  /** Already formatted in `locale`; absent when the invitation never expires. */
  expiresAtLabel?: string | null;
}

export function boardInviteEmailSubject({ locale, boards, invitedByName }: Pick<BoardInviteEmailParams, "locale" | "boards" | "invitedByName">): string {
  return serverMessages(locale).email.boardInvite.subject({ inviter: invitedByName, boardCount: boards.length, boardName: boards[0]!.boardName });
}

export function boardInviteEmail({
  locale,
  boards,
  orgName,
  invitedByName,
  acceptUrl,
  expiresAtLabel,
}: BoardInviteEmailParams): string {
  const messages = serverMessages(locale);
  const m = messages.email.boardInvite;
  const grants = boards;
  const firstBoard = grants[0]!;
  const grantList = grants
    .map(({ boardName, role }) => richHtml((s) => m.grant(s), { board: strong(boardName), role: text(roleLabel(role, locale)) }))
    .join("<br />");

  return emailLayout({
    locale,
    subject: boardInviteEmailSubject({ locale, boards, invitedByName }),
    preheader: m.preheader({ inviter: invitedByName, boardCount: grants.length, boardName: firstBoard.boardName, org: orgName }),
    body: `
      ${heading(m.heading)}
      ${paragraphHtml(richHtml((s) => m.intro({ ...s, boardCount: grants.length }), { inviter: text(invitedByName), org: text(orgName) }))}
      ${paragraphHtml(grantList)}
      ${button({ href: acceptUrl, label: m.button })}
      ${mutedHtml(joinSentences(locale, [expiresAtLabel ? richHtml((s) => m.expiry(s), { date: plainStrong(expiresAtLabel) }) : null, text(m.ignore)]))}
      ${fallbackLink(acceptUrl, locale)}
    `,
    // The invitee may have no account yet, so the usual "you have a Kanera account" would be wrong.
    footerReason: messages.layout.footerInvite({ inviter: invitedByName }),
  });
}
