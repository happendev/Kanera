import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardOverdueEmailParams {
  locale: Locale;
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** Already in the recipient's locale. */
  dueLabel: string | null;
}

export function cardOverdueEmail({ locale, displayName, cardTitle, boardName, cardUrl, dueLabel }: CardOverdueEmailParams): string {
  const m = serverMessages(locale).email.cardOverdue;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ card: cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, due: dueLabel }), "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
