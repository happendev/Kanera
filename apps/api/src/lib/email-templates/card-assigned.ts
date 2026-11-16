import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardBlock, emailLayout, heading, paragraph } from "./layout.js";

export interface CardAssignedEmailParams {
  locale: Locale;
  /** Added when rendered: the notification settings page the footer links to. */
  notificationSettingsUrl?: string;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
}

export function cardAssignedEmail({ locale, notificationSettingsUrl, displayName, actorName, cardTitle, boardName, cardUrl }: CardAssignedEmailParams): string {
  const m = serverMessages(locale).email.cardAssigned;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    manageUrl: notificationSettingsUrl,
    subject: m.subject({ card: cardTitle }),
    preheader: m.preheader({ actor: actorName, card: cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, actor: actorName, board: boardName }))}
      ${cardBlock({ title: cardTitle, subtitle: boardName, href: cardUrl, locale })}
    `,
  });
}
