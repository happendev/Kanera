import { button, emailLayout, fallbackLink, heading, paragraphHtml, strong, text } from "./layout.js";

export interface BoardInviteEmailParams {
  boards?: Array<{ boardName: string; role: string }>;
  /** Legacy queued-email fields retained until pre-deployment queue rows have drained. */
  boardName?: string;
  role?: string;
  orgName: string;
  invitedByName: string;
  acceptUrl: string;
}

export function boardInviteEmail({
  boards,
  boardName,
  role,
  orgName,
  invitedByName,
  acceptUrl,
}: BoardInviteEmailParams): string {
  const grants = boards?.length ? boards : [{ boardName: boardName ?? "your board", role: role ?? "editor" }];
  const firstBoard = grants[0]!;
  const boardSummary = grants.length === 1 ? firstBoard.boardName : `${grants.length} boards`;
  const grantList = grants
    .map(({ boardName, role }) => `${strong(boardName)} (${text(role.charAt(0).toUpperCase() + role.slice(1))})`)
    .join("<br />");

  return emailLayout({
    subject: `You've been invited to ${boardSummary}`,
    preheader: `${invitedByName} invited you to join ${boardSummary} on ${orgName}.`,
    body: `
      ${heading("Board invitation")}
      ${paragraphHtml(`${text(invitedByName)} has invited you to join ${grants.length === 1 ? "a board" : `${grants.length} boards`} on ${text(orgName)}.`)}
      ${paragraphHtml(grantList)}
      ${button({ href: acceptUrl, label: "Accept invitation" })}
      ${fallbackLink(acceptUrl)}
    `,
  });
}
