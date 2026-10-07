import type { ImportCompletedEmailQueueData } from "@kanera/shared/schema";
import { escapeHtml } from "../html-escape.js";
import { button, emailLayout, fallbackLink, heading, mutedHtml, paragraph } from "./layout.js";

export type ImportCompletedEmailParams = ImportCompletedEmailQueueData;

const SOURCE_LABELS: Record<ImportCompletedEmailParams["source"], string> = {
  trello: "Trello",
  kanera: "Kanera board export",
  csv: "CSV file",
};

/**
 * Migration support: confirms exactly what transferred, so the importer can check the result
 * against the source before retiring the old tool. Counts only; no card content is quoted.
 */
export function importCompletedEmail(params: ImportCompletedEmailParams): string {
  const source = SOURCE_LABELS[params.source];
  const rows: Array<[string, number]> = [
    ["Lists", params.lists],
    ["Cards", params.cards],
    ["Checklist items", params.checklistItems],
    ["Comments", params.comments],
    ["Attachments", params.attachmentsImported],
  ];
  const notes = [
    params.attachmentsSkipped > 0
      ? `${plural(params.attachmentsSkipped, "attachment was", "attachments were")} skipped, usually because the file was too large or no longer available at the source.`
      : null,
    params.warningCount > 0
      ? `The import finished with ${plural(params.warningCount, "warning", "warnings")}, listed on the import screen when it completed. Some details may not have transferred exactly as they were in the source.`
      : null,
  ].filter((note): note is string => note !== null);

  const body = `
    ${heading("Your import is complete")}
    ${paragraph(`Hi ${firstName(params.displayName)}, your ${source} import into ${params.boardName} has finished. This is what transferred:`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px 0;border:1px solid #e2e8f0;border-radius:12px;background-color:#f8fafc;" class="email-panel">
      ${rows.map(([label, count]) => `
        <tr>
          <td style="padding:9px 12px;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;" class="email-text-muted">${escapeHtml(label)}</td>
          <td align="right" style="padding:9px 12px;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;line-height:20px;color:#0f172a;" class="email-heading">${count}</td>
        </tr>
      `).join("")}
    </table>
    ${notes.map((note) => paragraph(note, "0 0 14px 0")).join("")}
    ${paragraph("Before you retire the old tool, open the board and check that your lists and recent cards look right.", "0 0 14px 0")}
    ${button({ href: params.boardUrl, label: "Open the board" })}
    ${fallbackLink(params.boardUrl)}
    ${mutedHtml("You're receiving this because you started this import.", "18px 0 0 0")}
  `;
  return emailLayout({ subject: "Your Kanera import is complete", preheader: `${params.cards} cards transferred from ${source}.`, body });
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] || displayName;
}
