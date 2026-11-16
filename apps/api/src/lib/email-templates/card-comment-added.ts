import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardBlock, emailLayout, heading, paragraph, quoteBlock } from "./layout.js";

export interface CardCommentAddedEmailParams {
  locale: Locale;
  /** Added when rendered: the notification settings page the footer links to. */
  notificationSettingsUrl?: string;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentExcerpt: string;
}

export function cardCommentAddedEmail({ locale, notificationSettingsUrl, displayName, actorName, cardTitle, boardName, cardUrl, commentExcerpt }: CardCommentAddedEmailParams): string {
  const m = serverMessages(locale).email.cardCommentAdded;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    manageUrl: notificationSettingsUrl,
    subject: m.subject({ card: cardTitle }),
    preheader: m.preheader({ actor: actorName, card: cardTitle, board: boardName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, actor: actorName, card: cardTitle, board: boardName }), "0 0 16px 0")}
      ${quoteBlock(commentExcerpt)}
      ${cardBlock({ title: cardTitle, subtitle: boardName, href: cardUrl, locale })}
    `,
  });
}
