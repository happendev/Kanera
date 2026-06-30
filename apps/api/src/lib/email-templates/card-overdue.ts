import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardOverdueEmailParams {
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  dueLabel: string | null;
}

export function cardOverdueEmail({ displayName, cardTitle, boardName, cardUrl, dueLabel }: CardOverdueEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: "A Kanera card is overdue",
    preheader: `"${cardTitle}" is overdue.`,
    body: `
      ${heading("Card overdue")}
      ${paragraph(`Hi ${firstName}, a card assigned to you is overdue${dueLabel ? ` (${dueLabel})` : ""}.`, "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
