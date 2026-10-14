import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardReminderEmailParams {
  locale: Locale;
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
}

export function cardReminderEmail({ locale, displayName, cardTitle, boardName, cardUrl }: CardReminderEmailParams): string {
  const m = serverMessages(locale).email.cardReminder;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ card: cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName }), "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
