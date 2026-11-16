import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardBlock, emailLayout, heading, paragraph } from "./layout.js";

export interface ChecklistItemOverdueEmailParams {
  locale: Locale;
  /** Added when rendered: the notification settings page the footer links to. */
  notificationSettingsUrl?: string;
  displayName: string;
  itemText: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** Already in the recipient's locale. */
  dueLabel: string | null;
}

export function checklistItemOverdueEmail({ locale, notificationSettingsUrl, displayName, itemText, cardTitle, boardName, cardUrl, dueLabel }: ChecklistItemOverdueEmailParams): string {
  const m = serverMessages(locale).email.checklistItemOverdue;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    manageUrl: notificationSettingsUrl,
    subject: m.subject({ item: itemText }),
    preheader: m.preheader({ item: itemText }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, item: itemText, due: dueLabel }), "0 0 16px 0")}
      ${cardBlock({ title: cardTitle, subtitle: boardName, href: cardUrl, locale })}
    `,
  });
}
