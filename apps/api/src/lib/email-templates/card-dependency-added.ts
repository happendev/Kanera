import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardDependencyAddedEmailParams {
  locale: Locale;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** From the watched card's side: it is now `blocked_by` the other card, or `blocks` it. */
  direction: "blocks" | "blocked_by";
  otherCardKey: string;
  /** Null when the recipient cannot open the other card: then only its key is named. */
  otherCardTitle: string | null;
}

export function cardDependencyAddedEmail({ locale, displayName, actorName, cardTitle, boardName, cardUrl, direction, otherCardKey, otherCardTitle }: CardDependencyAddedEmailParams): string {
  const m = serverMessages(locale).email.cardDependencyAdded;
  const firstName = displayName.split(" ")[0] ?? displayName;
  const other = otherCardTitle ? `${otherCardKey} ${otherCardTitle}` : otherCardKey;
  const values = { firstName, actor: actorName, card: cardTitle, board: boardName, other };
  return emailLayout({
    locale,
    subject: direction === "blocked_by" ? m.subjectBlockedBy(values) : m.subjectBlocking(values),
    preheader: m.preheader(values),
    body: `
      ${heading(m.heading)}
      ${paragraph(direction === "blocked_by" ? m.introBlockedBy(values) : m.introBlocking(values), "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
