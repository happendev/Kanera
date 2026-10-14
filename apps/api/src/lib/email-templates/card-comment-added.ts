import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph, quoteBlock } from "./layout.js";

export interface CardCommentAddedEmailParams {
  locale: Locale;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentExcerpt: string;
}

export function cardCommentAddedEmail({ locale, displayName, actorName, cardTitle, boardName, cardUrl, commentExcerpt }: CardCommentAddedEmailParams): string {
  const m = serverMessages(locale).email.cardCommentAdded;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    subject: m.subject({ card: cardTitle }),
    preheader: m.preheader({ actor: actorName, card: cardTitle, board: boardName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, actor: actorName, card: cardTitle, board: boardName }), "0 0 20px 0")}
      ${quoteBlock(commentExcerpt)}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
