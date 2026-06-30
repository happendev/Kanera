import { button, emailLayout, fallbackLink, heading, paragraphHtml, strong, text } from "./layout.js";

export interface BoardInviteEmailParams {
  boardName: string;
  orgName: string;
  invitedByName: string;
  role: string;
  acceptUrl: string;
}

export function boardInviteEmail({
  boardName,
  orgName,
  invitedByName,
  role,
  acceptUrl,
}: BoardInviteEmailParams): string {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  return emailLayout({
    subject: `You've been invited to ${boardName}`,
    preheader: `${invitedByName} invited you to join ${boardName} on ${orgName}.`,
    body: `
      ${heading("Board invitation")}
      ${paragraphHtml(`${text(invitedByName)} has invited you to join the board ${strong(boardName)} on ${text(orgName)}.`)}
      ${paragraphHtml(`You'll join as a ${strong(roleLabel)}.`)}
      ${button({ href: acceptUrl, label: "Accept invitation" })}
      ${fallbackLink(acceptUrl)}
    `,
  });
}
