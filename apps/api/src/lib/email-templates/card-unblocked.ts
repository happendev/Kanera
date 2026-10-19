import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardUnblockedEmailParams {
  locale: Locale;
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** The blocker whose completion left the card with no open blockers. */
  otherCardKey: string;
  /** Null when the recipient cannot open that blocker: then only its key is named. */
  otherCardTitle: string | null;
  /** The blocker was reopened or restored, so the card is blocked again rather than ready to start. */
  reblocked?: boolean;
}

export function cardUnblockedEmail({ locale, displayName, cardTitle, boardName, cardUrl, otherCardKey, otherCardTitle, reblocked }: CardUnblockedEmailParams): string {
  const m = serverMessages(locale).email.cardUnblocked;
  const firstName = displayName.split(" ")[0] ?? displayName;
  const other = otherCardTitle ? `${otherCardKey} ${otherCardTitle}` : otherCardKey;
  const values = { firstName, card: cardTitle, board: boardName, other };
  return emailLayout({
    locale,
    subject: reblocked ? m.subjectReblocked(values) : m.subject(values),
    preheader: reblocked ? m.preheaderReblocked(values) : m.preheader(values),
    body: `
      ${heading(reblocked ? m.headingReblocked : m.heading)}
      ${paragraph(reblocked ? m.introReblocked(values) : m.intro(values), "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
