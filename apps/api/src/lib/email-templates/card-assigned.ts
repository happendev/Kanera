import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardAssignedEmailParams {
  locale: Locale;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
}

export function cardAssignedEmail({ locale, displayName, actorName, cardTitle, boardName, cardUrl }: CardAssignedEmailParams): string {
  const m = serverMessages(locale).email.cardAssigned;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ actor: actorName, card: cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, actor: actorName, board: boardName }))}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
