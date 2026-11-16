import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardBlock, emailLayout, heading, paragraph } from "./layout.js";

export interface CardReminderEmailParams {
  locale: Locale;
  /** Added when rendered: the notification settings page the footer links to. */
  notificationSettingsUrl?: string;
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
}

export function cardReminderEmail({ locale, notificationSettingsUrl, displayName, cardTitle, boardName, cardUrl }: CardReminderEmailParams): string {
  const m = serverMessages(locale).email.cardReminder;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    manageUrl: notificationSettingsUrl,
    subject: m.subject({ card: cardTitle }),
    preheader: m.preheader({ card: cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName }), "0 0 16px 0")}
      ${cardBlock({ title: cardTitle, subtitle: boardName, href: cardUrl, locale })}
    `,
  });
}
