import type { Locale } from "@kanera/shared/locales";
import { button, divider, emailLayout, fallbackLink, heading, paragraph } from "./layout.js";
import { escapeHtml } from "../html-escape.js";
import { serverMessages } from "../i18n/messages/index.js";

export interface WelcomeEmailParams {
  locale: Locale;
  displayName: string;
  loginUrl: string;
}

export function welcomeEmail({ locale, displayName, loginUrl }: WelcomeEmailParams): string {
  const m = serverMessages(locale).email.welcome;
  const firstName = displayName.split(" ")[0] ?? displayName;

  return emailLayout({
    locale,
    subject: m.subject,
    preheader: m.preheader({ firstName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(m.intro({ firstName }))}
      ${divider()}
      ${paragraph(m.firstSteps, "24px 0 10px 0")}

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${m.steps.map((label, index) => step(String(index + 1), label)).join("\n        ")}
      </table>

      ${button({ href: loginUrl, label: m.button })}
      ${fallbackLink(loginUrl, locale)}
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

