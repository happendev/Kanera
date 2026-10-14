import type { Locale } from "@kanera/shared/locales";
import type { ImportCompletedEmailQueueData } from "@kanera/shared/schema";
import { escapeHtml } from "../html-escape.js";
import { formatNumber } from "../i18n/format.js";
import { serverMessages } from "../i18n/messages/index.js";
import { button, emailLayout, fallbackLink, heading, mutedHtml, paragraph, text } from "./layout.js";

export type ImportCompletedEmailParams = ImportCompletedEmailQueueData & { locale: Locale };

/**
 * Migration support: confirms exactly what transferred, so the importer can check the result
 * against the source before retiring the old tool. Counts only; no card content is quoted.
 */
export function importCompletedEmail(params: ImportCompletedEmailParams): string {
  const { locale } = params;
  const m = serverMessages(locale).email.importCompleted;
  const source = m.sources[params.source];
  const rows: Array<[string, number]> = [
    [m.rows.lists, params.lists],
    [m.rows.cards, params.cards],
    [m.rows.checklistItems, params.checklistItems],
    [m.rows.comments, params.comments],
    [m.rows.attachments, params.attachmentsImported],
  ];
  const notes = [
    params.attachmentsSkipped > 0 ? m.attachmentsSkipped({ count: params.attachmentsSkipped }) : null,
    params.warningCount > 0 ? m.warnings({ count: params.warningCount }) : null,
  ].filter((note): note is string => note !== null);

  const body = `
    ${heading(m.heading)}
    ${paragraph(m.intro({ firstName: firstName(params.displayName), source, board: params.boardName }))}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px 0;border:1px solid #e2e8f0;border-radius:12px;background-color:#f8fafc;" class="email-panel">
      ${rows.map(([label, count]) => `
        <tr>
          <td style="padding:9px 12px;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;" class="email-text-muted">${escapeHtml(label)}</td>
          <td align="right" style="padding:9px 12px;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;line-height:20px;color:#0f172a;" class="email-heading">${escapeHtml(formatNumber(locale, count))}</td>
        </tr>
      `).join("")}
    </table>
    ${notes.map((note) => paragraph(note, "0 0 14px 0")).join("")}
    ${paragraph(m.check, "0 0 14px 0")}
    ${button({ href: params.boardUrl, label: m.button })}
    ${fallbackLink(params.boardUrl, locale)}
    ${mutedHtml(text(m.footer), "18px 0 0 0")}
  `;
  return emailLayout({ locale, subject: m.subject, preheader: m.preheader({ cards: params.cards, source }), body });
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] || displayName;
}
