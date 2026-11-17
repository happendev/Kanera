import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import type { ServerMessages } from "../i18n/messages/types.js";
import { cardBlock, emailLayout, heading, paragraph } from "./layout.js";

export interface CardDueDateChangedEmailParams {
  locale: Locale;
  /** Added when rendered: the notification settings page the footer links to. */
  notificationSettingsUrl?: string;
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  /** Both labels are already in the recipient's locale. */
  previousDueLabel: string | null;
  nextDueLabel: string | null;
  /**
   * False when only the planned start moved, which turns this into the start-date email. Absent
   * (rows queued before start dates existed) means true. A due-date email still names a start that
   * moved with it, as a Timeline drag or a due date pulled before the start does.
   */
  dueChanged?: boolean;
  previousStartLabel?: string | null;
  nextStartLabel?: string | null;
}

export function cardDueDateChangedEmail(params: CardDueDateChangedEmailParams): string {
  const m = serverMessages(params.locale).email.cardDueDateChanged;
  const firstName = params.displayName.split(" ")[0] ?? params.displayName;
  const dueChanged = params.dueChanged !== false;
  const startLabel = startChangeLabel(m, params.previousStartLabel ?? null, params.nextStartLabel ?? null);
  const lines = [dueChanged ? dueChangeLabel(m, params.previousDueLabel, params.nextDueLabel) : null, startLabel].filter((line): line is string => Boolean(line));
  return emailLayout({
    locale: params.locale,
    manageUrl: params.notificationSettingsUrl,
    subject: cardDueDateChangedSubject(params),
    preheader: dueChanged ? m.preheader({ actor: params.actorName, card: params.cardTitle }) : m.startPreheader({ actor: params.actorName, card: params.cardTitle }),
    body: `
      ${heading(dueChanged ? m.heading : m.startHeading)}
      ${paragraph(dueChanged ? m.intro({ firstName, actor: params.actorName }) : m.startIntro({ firstName, actor: params.actorName }), "0 0 12px 0")}
      ${lines.map((line, index) => paragraph(line, index === lines.length - 1 ? "0 0 20px 0" : "0 0 4px 0")).join("")}
      ${cardBlock({ title: params.cardTitle, subtitle: params.boardName, href: params.cardUrl, locale: params.locale })}
    `,
  });
}

export function cardDueDateChangedSubject(params: Pick<CardDueDateChangedEmailParams, "locale" | "dueChanged" | "cardTitle">): string {
  const m = serverMessages(params.locale).email.cardDueDateChanged;
  return params.dueChanged === false ? m.startSubject({ card: params.cardTitle }) : m.subject({ card: params.cardTitle });
}

/** Null when the start did not move (both labels equal, including both empty). */
function startChangeLabel(m: ServerMessages["email"]["cardDueDateChanged"], previous: string | null, next: string | null): string | null {
  if (previous === next) return null;
  if (previous && next) return m.startChanged({ from: previous, to: next });
  if (next) return m.startSet({ to: next });
  return m.startClearedFrom({ from: previous! });
}

function dueChangeLabel(m: ServerMessages["email"]["cardDueDateChanged"], previousDueLabel: string | null, nextDueLabel: string | null): string {
  if (previousDueLabel && nextDueLabel) return m.changed({ from: previousDueLabel, to: nextDueLabel });
  if (nextDueLabel) return m.set({ to: nextDueLabel });
  if (previousDueLabel) return m.clearedFrom({ from: previousDueLabel });
  return m.cleared;
}
