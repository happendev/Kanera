import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph, quoteBlock } from "./layout.js";

export interface ReactionAddedEmailParams {
  locale: Locale;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** A comment's excerpt, or null when the thumbs-up was on an attachment. */
  commentExcerpt: string | null;
  /** The attachment's file name, or null when the thumbs-up was on a comment. */
  fileName: string | null;
}

export function reactionAddedEmail({ locale, displayName, actorName, cardTitle, boardName, cardUrl, commentExcerpt, fileName }: ReactionAddedEmailParams): string {
  const m = serverMessages(locale).email.reactionAdded;
  const firstName = displayName.split(" ")[0] ?? displayName;
  const intro = fileName
    ? m.introAttachment({ firstName, actor: actorName, file: fileName, card: cardTitle, board: boardName })
    : m.introComment({ firstName, actor: actorName, card: cardTitle, board: boardName });
  return emailLayout({
    locale,
    subject: m.subject({ actor: actorName, card: cardTitle }),
    preheader: m.preheader({ actor: actorName, card: cardTitle, board: boardName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(intro, "0 0 20px 0")}
      ${commentExcerpt ? quoteBlock(commentExcerpt) : ""}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
