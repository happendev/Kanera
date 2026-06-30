import { cardSummary, emailLayout, heading, paragraph, sectionLabel } from "./layout.js";

export interface DailyDigestCardItem {
  title: string;
  boardName: string;
  // Parent card title for checklist-item rows (shown so the item reads in context);
  // null/omitted for card rows where the title already is the card.
  context?: string | null;
  cardUrl: string;
  dueLabel?: string | null;
}

export interface DailyDigestEmailParams {
  displayName: string;
  localDate: string;
  localDateLabel: string;
  dueToday: DailyDigestCardItem[];
  overdue: DailyDigestCardItem[];
}

export function dailyDigestEmail({ displayName, localDateLabel, dueToday, overdue }: DailyDigestEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  const itemCount = dueToday.length + overdue.length;
  const sections = [
    renderSection("Due today", dueToday),
    renderSection("Overdue", overdue),
  ].filter(Boolean).join("");

  return emailLayout({
    subject: "Your Kanera due items",
    preheader: `${itemCount} Kanera item${itemCount === 1 ? "" : "s"} need attention today.`,
    body: `
      ${heading("Today's due items")}
      ${paragraph(`Hi ${firstName}, here's the short list for ${localDateLabel}.`)}
      ${sections}
    `,
  });
}

function renderSection(label: string, items: DailyDigestCardItem[]): string {
  if (items.length === 0) return "";
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td>${sectionLabel(label)}</td>
      </tr>
      ${items.map(renderItem).join("")}
    </table>
  `;
}

function renderItem(item: DailyDigestCardItem): string {
  // Subtitle stacks board name, optional parent-card context (checklist items), and due label.
  const parts = [item.boardName, item.context, item.dueLabel].filter((part): part is string => Boolean(part));
  return `
    <tr>
      <td style="padding:0 0 10px 0;">${cardSummary({
        title: item.title,
        subtitle: parts.join(" - "),
        href: item.cardUrl,
      })}</td>
    </tr>
  `;
}
