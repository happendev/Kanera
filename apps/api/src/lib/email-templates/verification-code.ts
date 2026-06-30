import { codeDisplay, divider, emailLayout, heading, mutedHtml, paragraph } from "./layout.js";

export interface VerificationCodeEmailParams {
  code: string;
  expiresInMinutes: number;
}

// Sent during signup and email changes. No display name: at signup-request time
// no account exists yet, so the copy stays generic.
export function verificationCodeEmail({ code, expiresInMinutes }: VerificationCodeEmailParams): string {
  return emailLayout({
    subject: "Verify your email for Kanera",
    preheader: `Your Kanera verification code is ${code}.`,
    body: `
      ${heading("Verify your email")}
      ${paragraph("Enter this code to confirm your email address and continue:")}
      ${codeDisplay(code)}
      ${mutedHtml(`This code expires in <strong>${expiresInMinutes} minutes</strong>. If you didn't request it, you can safely ignore this email.`)}
      ${divider("24px 0 0 0")}
    `,
  });
}
