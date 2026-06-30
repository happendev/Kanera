import { cardSummary, emailLayout, heading, paragraph, quoteBlock } from "./layout.js";

export interface CardCommentAddedEmailParams {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentExcerpt: string;
}

export function cardCommentAddedEmail({ displayName, actorName, cardTitle, boardName, cardUrl, commentExcerpt }: CardCommentAddedEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: `New comment on ${cardTitle}`,
    preheader: `${actorName} commented on "${cardTitle}" in ${boardName}.`,
    body: `
      ${heading("New comment on your card")}
      ${paragraph(`Hi ${firstName}, ${actorName} commented on "${cardTitle}" in ${boardName}.`, "0 0 20px 0")}
      ${quoteBlock(commentExcerpt)}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
