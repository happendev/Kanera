import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import type { ServerMessages } from "../i18n/messages/types.js";
import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardDueDateChangedEmailParams {
  locale: Locale;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** Both labels are already in the recipient's locale. */
  previousDueLabel: string | null;
  nextDueLabel: string | null;
}

export function cardDueDateChangedEmail(params: CardDueDateChangedEmailParams): string {
  const m = serverMessages(params.locale).email.cardDueDateChanged;
  const firstName = params.displayName.split(" ")[0] ?? params.displayName;
  const changeLabel = dueChangeLabel(m, params.previousDueLabel, params.nextDueLabel);
  return emailLayout({
    locale: params.locale,
    subject: m.subject,
    preheader: m.preheader({ actor: params.actorName, card: params.cardTitle }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName, actor: params.actorName }), "0 0 16px 0")}
      ${paragraph(changeLabel)}
      ${cardSummary({ title: params.cardTitle, subtitle: params.boardName, href: params.cardUrl })}
    `,
  });
}

function dueChangeLabel(m: ServerMessages["email"]["cardDueDateChanged"], previousDueLabel: string | null, nextDueLabel: string | null): string {
  if (previousDueLabel && nextDueLabel) return m.changed({ from: previousDueLabel, to: nextDueLabel });
  if (nextDueLabel) return m.set({ to: nextDueLabel });
  if (previousDueLabel) return m.clearedFrom({ from: previousDueLabel });
  return m.cleared;
}
