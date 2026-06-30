import { button, cardSummary, divider, emailLayout, heading, mutedHtml, paragraph, quoteBlock, sectionLabel } from "./layout.js";

export interface SmtpTestEmailParams {
  recipientEmail: string;
  appUrl: string;
  sentAtLabel: string;
}

export function smtpTestEmail({ recipientEmail, appUrl, sentAtLabel }: SmtpTestEmailParams): string {
  return emailLayout({
    subject: "Kanera SMTP test",
    preheader: "Your SMTP settings can deliver Kanera email.",
    body: `
      ${heading("Your SMTP settings work")}
      ${paragraph(`This is a test email from Kanera sent to ${recipientEmail} on ${sentAtLabel}. If it landed in your inbox, your organisation's outgoing mail is configured correctly.`, "0 0 20px 0")}
      ${divider()}
      ${mutedHtml("The logo above, the heading text, the card below, and the button should all remain readable in this email client.", "24px 0 18px 0")}
      ${sectionLabel("Rendering check")}
      ${cardSummary({ title: "Sample card link", subtitle: "Light surface and muted metadata", href: appUrl })}
      ${quoteBlock("Comment excerpts use this quoted panel. The teal accent should stay visible without making the text hard to read.")}
      ${button({ href: appUrl, label: "Open Kanera" })}
    `,
  });
}
