import { button, divider, emailLayout, fallbackLink, heading, paragraph } from "./layout.js";

export type InviteAcceptedEmailParams = {
  context?: "org";
  displayName: string;
  acceptedByName: string;
  acceptedByEmail: string;
  orgName: string;
  orgRole: string;
  membersUrl: string;
} | {
  context: "board";
  displayName: string;
  acceptedByName: string;
  acceptedByEmail: string;
  orgName: string;
  boardName: string;
  boardRole: string;
  boardUrl: string;
};

export function inviteAcceptedEmail(params: InviteAcceptedEmailParams): string {
  const { displayName, acceptedByName, acceptedByEmail, orgName } = params;
  const firstName = displayName.split(" ")[0] ?? displayName;

  if (params.context === "board") {
    const roleLabel = params.boardRole.charAt(0).toUpperCase() + params.boardRole.slice(1);
    return emailLayout({
      subject: "A Kanera invite was accepted",
      preheader: `${acceptedByName} joined ${params.boardName}.`,
      body: `
        ${heading("Board invite accepted")}
        ${paragraph(`Hi ${firstName}, ${acceptedByName} accepted an invite and joined ${params.boardName} in ${orgName}.`)}
        ${divider("0 0 24px 0")}
        ${paragraph(`New guest: ${acceptedByName} (${acceptedByEmail})`, "0 0 8px 0")}
        ${paragraph(`Board role: ${roleLabel}`, "0 0 24px 0")}
        ${button({ href: params.boardUrl, label: "View board" })}
        ${fallbackLink(params.boardUrl)}
      `,
    });
  }
  const roleLabel = params.orgRole.charAt(0).toUpperCase() + params.orgRole.slice(1);

  return emailLayout({
    subject: "A Kanera invite was accepted",
    preheader: `${acceptedByName} joined ${orgName}.`,
    body: `
      ${heading("Invite accepted")}
      ${paragraph(`Hi ${firstName}, ${acceptedByName} accepted an invite and joined ${orgName}.`)}
      ${divider("0 0 24px 0")}
      ${paragraph(`New member: ${acceptedByName} (${acceptedByEmail})`, "0 0 8px 0")}
      ${paragraph(`Organisation role: ${roleLabel}`, "0 0 24px 0")}
      ${button({ href: params.membersUrl, label: "View members" })}
      ${fallbackLink(params.membersUrl)}
    `,
  });
}
