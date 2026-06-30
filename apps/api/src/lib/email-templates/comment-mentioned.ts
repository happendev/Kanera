import { cardSummary, emailLayout, heading, paragraph, quoteBlock } from "./layout.js";

export interface CommentMentionedEmailParams {
  displayName: string;
  actorName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentExcerpt: string;
}

export function commentMentionedEmail({ displayName, actorName, cardTitle, boardName, cardUrl, commentExcerpt }: CommentMentionedEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: `Mentioned in a comment on ${cardTitle}`,
    preheader: `${actorName} mentioned you in a comment on "${cardTitle}" in ${boardName}.`,
    body: `
      ${heading("You were mentioned in a comment")}
      ${paragraph(`Hi ${firstName}, ${actorName} mentioned you in a comment on "${cardTitle}" in ${boardName}.`, "0 0 20px 0")}
      ${quoteBlock(commentExcerpt)}
      ${cardSummary({ title: cardTitle, subtitle: boardName, href: cardUrl })}
    `,
  });
}
