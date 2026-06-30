import { cardSummary, emailLayout, heading, paragraph } from "./layout.js";

export interface CardAssignedEmailParams {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
}

export function cardAssignedEmail({ displayName, actorName, cardTitle, boardName, cardUrl }: CardAssignedEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: "You were assigned a Kanera card",
    preheader: `${actorName} assigned you to "${cardTitle}".`,
    body: `
      ${heading("You were assigned a card")}
      ${paragraph(`Hi ${firstName}, ${actorName} assigned you to a card on ${boardName}.`)}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
