import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface ChecklistItemOverdueEmailParams {
  displayName: string;
  itemText: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  dueLabel: string | null;
}

export function checklistItemOverdueEmail({ displayName, itemText, cardTitle, boardName, cardUrl, dueLabel }: ChecklistItemOverdueEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: "A Kanera checklist item is overdue",
    preheader: `"${itemText}" is overdue.`,
    body: `
      ${heading("Checklist item overdue")}
      ${paragraph(`Hi ${firstName}, a checklist item assigned to you is overdue${dueLabel ? ` (${dueLabel})` : ""}: "${itemText}".`, "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
