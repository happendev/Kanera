export interface LayoutOptions {
  subject: string;
  preheader: string;
  body: string;
}

const BRAND = "#0d9488";
const FONT_STACK = "'Inter','Segoe UI',Arial,Helvetica,sans-serif";
const EMAIL_BG = "#f8fafc";
const EMAIL_BG_END = "#e2e8f0";
const EMAIL_CARD = "#ffffff";
const EMAIL_PANEL = "#f8fafc";
const EMAIL_BORDER = "#dbe4ee";
const EMAIL_PANEL_BORDER = "#dbe4ee";
const EMAIL_BODY_TEXT = "#0f172a";
const EMAIL_TEXT = "#334155";
const EMAIL_HEADING = "#0f172a";
const EMAIL_MUTED_TEXT = "#64748b";
const EMAIL_FOOTER_TEXT = "#64748b";
const EMAIL_DIVIDER = "#e2e8f0";
const EMAIL_LINK = BRAND;
const EMAIL_BUTTON_TEXT = "#ffffff";
const LOGO_URL = "https://www.kanera.app/assets/logo/jpg/logo%20light%20long.jpg";

export function emailLayout({ subject, preheader, body }: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(subject)}</title>
  <style>
    :root {
      color-scheme: light;
      supported-color-schemes: light;
    }
    @media screen and (max-width: 520px) {
      .email-shell { padding: 20px 10px !important; }
      .email-card-inner { padding-left: 22px !important; padding-right: 22px !important; }
      .email-heading-main { font-size: 24px !important; line-height: 30px !important; }
      .email-logo { width: 190px !important; max-width: 190px !important; }
    }
  </style>
</head>
<body class="email-page" style="margin:0;padding:0;background-color:${EMAIL_BG};color:${EMAIL_BODY_TEXT};font-family:${FONT_STACK};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_BG};opacity:0;">
    ${escapeHtml(preheader)}
  </div>
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_BG};opacity:0;">
    &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>
  <div class="email-gradient email-shell" style="margin:0;padding:32px 16px;background:${EMAIL_BG};background:linear-gradient(180deg,${EMAIL_BG} 0%,${EMAIL_BG_END} 100%);">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="email-card" style="width:100%;max-width:640px;margin:0 auto;background-color:${EMAIL_CARD};border:1px solid ${EMAIL_BORDER};border-radius:24px;overflow:hidden;box-shadow:0 18px 40px rgba(15,23,42,0.08);border-collapse:separate;">
            <tr>
              <td style="padding:0;height:8px;background-color:${BRAND};font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td align="center" bgcolor="${EMAIL_CARD}" class="email-card-inner" style="padding:30px 32px 10px 32px;background-color:${EMAIL_CARD};text-align:center;">
                <img src="${LOGO_URL}" alt="Kanera" width="220" class="email-logo" style="display:block;margin:0 auto;max-width:220px;max-height:52px;width:220px;height:auto;border:0;outline:none;text-decoration:none;">
              </td>
            </tr>
            <tr>
              <td class="email-card-inner" style="padding:14px 32px 0 32px;">
                ${body}
              </td>
            </tr>
            <tr>
              <td class="email-card-inner" style="padding:28px 32px 32px 32px;">
                <div class="email-footer" style="padding-top:20px;border-top:1px solid ${EMAIL_DIVIDER};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_FOOTER_TEXT};text-align:center;mso-line-height-rule:exactly;">
                  You're receiving this because you have a Kanera account.<br>
                  &copy; 2026 Kanera
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

/**
 * Outlook's Word engine ignores padding on inline anchors, so the coloured
 * button padding lives on the table cell and the link fills that area.
 */
export function button({ href, label }: { href: string; label: string }): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td align="center" valign="middle" height="48" bgcolor="${BRAND}" class="email-button" style="border-radius:999px;background-color:${BRAND};height:48px;padding:0 28px;mso-padding-alt:0 28px;">
          <a href="${escapeAttr(href)}" target="_blank" class="email-button-link" style="display:block;height:48px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${EMAIL_BUTTON_TEXT};text-decoration:none;line-height:48px;white-space:nowrap;mso-line-height-rule:exactly;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

export function codeDisplay(code: string): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td align="center" bgcolor="${EMAIL_PANEL}" style="padding:24px 16px;background-color:${EMAIL_PANEL};border:1px solid ${EMAIL_PANEL_BORDER};border-radius:20px;" class="email-panel">
          <div style="font-family:${FONT_STACK};font-size:12px;font-weight:700;line-height:18px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_MUTED_TEXT};mso-line-height-rule:exactly;">One-time code</div>
          <div style="margin-top:12px;font-family:${FONT_STACK};font-size:34px;font-weight:800;letter-spacing:8px;line-height:40px;color:${BRAND};mso-line-height-rule:exactly;" class="email-heading">${escapeHtml(code)}</div>
        </td>
      </tr>
    </table>`;
}

export function heading(text: string): string {
  return `<h1 style="margin:0 0 10px 0;font-family:${FONT_STACK};font-size:28px;font-weight:700;line-height:34px;color:${EMAIL_HEADING};text-align:left;mso-line-height-rule:exactly;" class="email-heading email-heading-main">${escapeHtml(text)}</h1>`;
}

export function paragraph(text: string, margin = "0 0 24px 0"): string {
  return `<p style="margin:${margin};font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_TEXT};mso-line-height-rule:exactly;" class="email-text">${escapeHtml(text)}</p>`;
}

export function paragraphHtml(html: string, margin = "0 0 24px 0"): string {
  return `<p style="margin:${margin};font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_TEXT};mso-line-height-rule:exactly;" class="email-text">${html}</p>`;
}

export function mutedHtml(html: string, margin = "24px 0 0 0"): string {
  return `<p style="margin:${margin};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_MUTED_TEXT};mso-line-height-rule:exactly;" class="email-text-muted">${html}</p>`;
}

export function divider(margin = "0"): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:${margin};">
      <tr><td style="border-top:1px solid ${EMAIL_DIVIDER};padding:0;" class="email-divider"></td></tr>
    </table>`;
}

export function link({ href, label }: { href: string; label: string }): string {
  return `<a href="${escapeAttr(href)}" target="_blank" class="email-link" style="color:${EMAIL_LINK};font-weight:600;text-decoration:underline;word-break:break-word;">${escapeHtml(label)}</a>`;
}

export function fallbackLink(url: string): string {
  return mutedHtml(`If the button above does not work, copy and paste this link into your browser:<br>${link({ href: url, label: url })}`, "26px 0 0 0");
}

export function strong(text: string): string {
  return `<strong style="color:${EMAIL_HEADING};">${escapeHtml(text)}</strong>`;
}

export function text(text: string): string {
  return escapeHtml(text);
}

export function sectionLabel(text: string): string {
  return `<p style="margin:0 0 10px 0;font-family:${FONT_STACK};font-size:12px;font-weight:700;line-height:18px;color:${EMAIL_HEADING};text-transform:uppercase;letter-spacing:0.12em;mso-line-height-rule:exactly;" class="email-heading">${escapeHtml(text)}</p>`;
}

export function cardSummary({ title, subtitle, href }: { title: string; subtitle: string; href: string }): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0;">
      <tr>
        <td bgcolor="${EMAIL_PANEL}" style="padding:16px 18px;background-color:${EMAIL_PANEL};border:1px solid ${EMAIL_PANEL_BORDER};border-radius:16px;" class="email-panel">
          <a href="${escapeAttr(href)}" target="_blank" class="email-link" style="display:block;font-family:${FONT_STACK};font-size:17px;font-weight:700;line-height:24px;color:${EMAIL_LINK};text-decoration:none;mso-line-height-rule:exactly;">${escapeHtml(title)}</a>
          <p style="margin:4px 0 0 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${EMAIL_MUTED_TEXT};mso-line-height-rule:exactly;" class="email-text-muted">${escapeHtml(subtitle)}</p>
        </td>
      </tr>
    </table>`;
}

export function quoteBlock(text: string): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td width="4" bgcolor="${BRAND}" style="width:4px;background-color:${BRAND};font-size:0;line-height:0;">&nbsp;</td>
        <td bgcolor="${EMAIL_PANEL}" style="padding:14px 16px;background-color:${EMAIL_PANEL};border-top:1px solid ${EMAIL_PANEL_BORDER};border-right:1px solid ${EMAIL_PANEL_BORDER};border-bottom:1px solid ${EMAIL_PANEL_BORDER};font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${EMAIL_TEXT};mso-line-height-rule:exactly;" class="email-panel email-text">
          ${escapeHtml(text)}
        </td>
      </tr>
    </table>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
