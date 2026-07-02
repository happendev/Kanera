import { button, emailLayout, heading, paragraphHtml, strong, text } from "./layout.js";

export interface BoardAccessGrantedEmailParams {
  displayName: string;
  boardName: string;
  orgName: string;
  invitedByName: string;
  role: string;
  boardUrl: string;
}

export function boardAccessGrantedEmail({
  displayName,
  boardName,
  orgName,
  invitedByName,
  role,
  boardUrl,
}: BoardAccessGrantedEmailParams): string {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  return emailLayout({
    subject: `You now have access to ${boardName}`,
    preheader: `${invitedByName} gave you access to ${boardName} on ${orgName}.`,
    body: `
      ${heading("Board access granted")}
      ${paragraphHtml(`Hi ${text(displayName)}, ${text(invitedByName)} gave you access to the board ${strong(boardName)} on ${text(orgName)}.`)}
      ${paragraphHtml(`Your board role is ${strong(roleLabel)}.`)}
      ${button({ href: boardUrl, label: "Open board" })}
    `,
  });
}
