import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph } from "./layout.js";

export interface PasswordResetEmailParams {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export function passwordResetEmail({ displayName, resetUrl, expiresInMinutes }: PasswordResetEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;

  return emailLayout({
    subject: "Reset your Kanera password",
    preheader: `Hi ${firstName}, we received a request to reset your password.`,
    body: `
      ${heading("Reset your password")}
      ${paragraph(`Hi ${firstName}, we received a request to reset the password for your Kanera account. Click the button below to choose a new password.`)}
      ${button({ href: resetUrl, label: "Reset Password" })}
      ${mutedHtml(`This link will expire in <strong>${expiresInMinutes} minutes</strong>. If you did not request a password reset, you can safely ignore this email and your password will remain unchanged.`)}
      ${divider("24px 0 0 0")}
      ${fallbackLink(resetUrl)}
    `,
  });
}
