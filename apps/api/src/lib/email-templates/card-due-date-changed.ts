import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardDueDateChangedEmailParams {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  previousDueLabel: string | null;
  nextDueLabel: string | null;
}

export function cardDueDateChangedEmail(params: CardDueDateChangedEmailParams): string {
  const firstName = params.displayName.split(" ")[0] ?? params.displayName;
  const changeLabel = dueChangeLabel(params.previousDueLabel, params.nextDueLabel);
  return emailLayout({
    subject: "Due date changed on your Kanera card",
    preheader: `${params.actorName} changed the due date for "${params.cardTitle}".`,
    body: `
      ${heading("Due date changed")}
      ${paragraph(`Hi ${firstName}, ${params.actorName} updated the due date on a card assigned to you.`, "0 0 16px 0")}
      ${paragraph(changeLabel)}
      ${cardSummary({ title: params.cardTitle, subtitle: params.boardName, href: params.cardUrl })}
    `,
  });
}

function dueChangeLabel(previousDueLabel: string | null, nextDueLabel: string | null): string {
  if (previousDueLabel && nextDueLabel) return `Changed from ${previousDueLabel} to ${nextDueLabel}.`;
  if (nextDueLabel) return `Set to ${nextDueLabel}.`;
  if (previousDueLabel) return `Cleared from ${previousDueLabel}.`;
  return "The due date was cleared.";
}
