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

/** One entry from the recipient's own "Up next" queue, in queue order. */
export interface DailyDigestPriorityItem {
  /** 1-based over the recipient's whole live queue, so #3 in the email is #3 in the app. */
  rank: number;
  title: string;
  boardName: string;
  cardUrl: string;
  dueLabel?: string | null;
}

export interface DailyDigestEmailParams {
  displayName: string;
  localDate: string;
  localDateLabel: string;
  dueToday: DailyDigestCardItem[];
  overdue: DailyDigestCardItem[];
  /**
   * Optional so digests queued before this section existed still render from their stored `data`
   * blob when the worker picks them up.
   */
  priorities?: DailyDigestPriorityItem[];
}

export function dailyDigestEmail({ displayName, localDateLabel, dueToday, overdue, priorities = [] }: DailyDigestEmailParams): string {
  const firstName = displayName.split(" ")[0] ?? displayName;
  const itemCount = dueToday.length + overdue.length;
  const sections = [
    renderSection("Due today", dueToday),
    renderSection("Overdue", overdue),
    // Last, and skipped when empty: dates are the reason this email is sent at all, and the queue is
    // the answer to "and of those, what first" — which only reads once the dates are on the page.
    renderPriorities(priorities),
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

function renderPriorities(items: DailyDigestPriorityItem[]): string {
  if (items.length === 0) return "";
  return renderSection(
    "Your top priorities",
    // The rank is rendered into the title rather than as its own cell: email clients that drop the
    // table layout still keep "1." attached to the card it numbers.
    items.map((item) => ({
      title: `${item.rank}. ${item.title}`,
      boardName: item.boardName,
      context: null,
      cardUrl: item.cardUrl,
      dueLabel: item.dueLabel ?? null,
    })),
  );
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
