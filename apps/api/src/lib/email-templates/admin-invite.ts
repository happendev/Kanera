import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph } from "./layout.js";

export interface AdminInviteEmailParams { displayName: string; inviteUrl: string; expiresInHours: number }

export function adminInviteEmail({ displayName, inviteUrl, expiresInHours }: AdminInviteEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return emailLayout({
    subject: "You’re invited to administer Kanera",
    preheader: `${firstName}, set up your Kanera superadmin account.`,
    body: `
      ${heading("Set up your administrator account")}
      ${paragraph(`Hi ${firstName}, you’ve been invited to become a Kanera superadmin. Use the button below to choose your password.`)}
      ${button({ href: inviteUrl, label: "Set Up Account" })}
      ${mutedHtml(`This single-use link expires in <strong>${expiresInHours} hours</strong>. If you weren’t expecting it, you can ignore this email.`)}
      ${divider("24px 0 0 0")}
      ${fallbackLink(inviteUrl)}
    `,
  });
}
