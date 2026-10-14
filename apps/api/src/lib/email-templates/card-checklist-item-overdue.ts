import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface ChecklistItemOverdueEmailParams {
  locale: Locale;
  displayName: string;
  itemText: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** Already in the recipient's locale. */
  dueLabel: string | null;
}

export function checklistItemOverdueEmail({ locale, displayName, itemText, cardTitle, boardName, cardUrl, dueLabel }: ChecklistItemOverdueEmailParams): string {
  const m = serverMessages(locale).email.checklistItemOverdue;
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ item: itemText }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, item: itemText, due: dueLabel }), "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
