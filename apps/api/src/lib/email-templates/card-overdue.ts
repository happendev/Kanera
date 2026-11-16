import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardBlock, emailLayout, heading, paragraph } from "./layout.js";

export interface CardOverdueEmailParams {
  locale: Locale;
  /** Added when rendered: the notification settings page the footer links to. */
  notificationSettingsUrl?: string;
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** Already in the recipient's locale. */
  dueLabel: string | null;
}

export function cardOverdueEmail({ locale, notificationSettingsUrl, displayName, cardTitle, boardName, cardUrl, dueLabel }: CardOverdueEmailParams): string {
  const m = serverMessages(locale).email.cardOverdue;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    manageUrl: notificationSettingsUrl,
    subject: m.subject({ card: cardTitle }),
    preheader: m.preheader({ card: cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, due: dueLabel }), "0 0 16px 0")}
      ${cardBlock({ title: cardTitle, subtitle: boardName, href: cardUrl, locale })}
    `,
  });
}
