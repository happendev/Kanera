import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardReminderEmailParams {
  displayName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
}

export function cardReminderEmail({ displayName, cardTitle, boardName, cardUrl }: CardReminderEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: "Your Kanera reminder",
    preheader: `You asked to be reminded about "${cardTitle}".`,
    body: `
      ${heading("Reminder")}
      ${paragraph(`Hi ${firstName}, you asked Kanera to remind you about this card.`, "0 0 20px 0")}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
