import { button, divider, emailLayout, fallbackLink, heading, paragraph } from "./layout.js";

export interface WelcomeEmailParams {
  displayName: string;
  loginUrl: string;
}

export function welcomeEmail({ displayName, loginUrl }: WelcomeEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;

  return emailLayout({
    subject: "Welcome to Kanera",
    preheader: `Hey ${firstName}, your Kanera account is ready.`,
    body: `
      ${heading("Welcome to Kanera")}
      ${paragraph(`Hey ${firstName}, your account has been created and you're ready to go.`)}
      ${divider()}
      ${paragraph("A few good first steps:", "24px 0 10px 0")}

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${step("1", "Create your first workspace")}
        ${step("2", "Set up boards for your projects")}
        ${step("3", "Invite your team members")}
      </table>

      ${button({ href: loginUrl, label: "Get Started" })}
      ${fallbackLink(loginUrl)}
    `,
  });
}

function step(index: string, text: string): string {
  return `
    <tr>
      <td width="28" valign="top" style="padding:7px 0;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:24px;color:#0d9488;" class="email-link">${escapeHtml(index)}.</td>
      <td valign="top" style="padding:7px 0;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#334155;" class="email-text">${escapeHtml(text)}</td>
    </tr>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
