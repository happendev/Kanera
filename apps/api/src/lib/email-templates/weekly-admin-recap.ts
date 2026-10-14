import type { Locale } from "@kanera/shared/locales";
import type { WeeklyAdminRecapEmailQueueData, WeeklyAdminRecapUpcomingGroup } from "@kanera/shared/schema";
import { formatNumber } from "../i18n/format.js";
import { serverMessages } from "../i18n/messages/index.js";
import type { ServerMessages } from "../i18n/messages/types.js";
import { button, divider, emailLayout, heading, mutedHtml, paragraph, sectionLabel, text } from "./layout.js";

/** Date labels are formatted in `locale` when the recap is queued. */
export type WeeklyAdminRecapEmailParams = WeeklyAdminRecapEmailQueueData & { locale: Locale };

const FONT = "'Inter','Segoe UI',Arial,Helvetica,sans-serif";

export function weeklyAdminRecapEmail(params: WeeklyAdminRecapEmailParams): string {
  const { locale } = params;
  const m = serverMessages(locale).email.weeklyAdminRecap;
  const upcomingCount = params.upcoming.renewals.reduce((sum, group) => sum + group.seatCount, 0);
  const preheader = m.preheader({ newAccounts: params.lastWeek.newAccounts, boardsCreated: params.lastWeek.boardsCreated, seatsRenewing: upcomingCount });

  return emailLayout({
    locale,
    subject: m.subject,
    preheader,
    body: [
      heading(m.heading),
      paragraph(m.intro({ lastWeek: params.lastWeekLabel, thisWeek: params.thisWeekLabel })),
      sectionLabel(m.lastWeek),
      metricGrid(locale, [
        [m.metrics.newAccounts, params.lastWeek.newAccounts],
        [m.metrics.newOrganisations, params.lastWeek.newOrganisations],
        [m.metrics.invitesAccepted, params.lastWeek.invitesAccepted],
        [m.metrics.boardsCreated, params.lastWeek.boardsCreated],
        [m.metrics.subscriptionsStarted, params.lastWeek.subscriptionsStarted],
        [m.metrics.seatsPurchased, params.lastWeek.seatsPurchased],
      ]),
      divider("28px 0"),
      sectionLabel(m.currentState),
      metricGrid(locale, [
        [m.metrics.activeAccounts, params.snapshot.activeAccounts],
        [m.metrics.activeOrganisations, params.snapshot.activeOrganisations],
        [m.metrics.activeBoards, params.snapshot.activeBoards],
        [m.metrics.paidOrganisations, params.snapshot.paidOrganisations],
        [m.metrics.trials, params.snapshot.trialOrganisations],
        [m.metrics.purchasedSeats, params.snapshot.purchasedSeats],
      ]),
      divider("28px 0"),
      sectionLabel(m.comingUp),
      upcomingSection(m, m.renewals, params.upcoming.renewals, m.renewalsEmpty),
      upcomingSection(m, m.trialEnds, params.upcoming.trialEnds, m.trialEndsEmpty),
      upcomingSection(m, m.cancellations, params.upcoming.cancellations, m.cancellationsEmpty),
      button({ href: params.adminUrl, label: m.button }),
      mutedHtml(text(m.footnote)),
    ].join(""),
  });
}

function metricGrid(locale: Locale, metrics: Array<[label: string, value: number]>): string {
  const cells = metrics.map(([label, value], index) => `
    <td width="50%" valign="top" style="width:50%;padding:${index % 2 === 0 ? "0 6px 12px 0" : "0 0 12px 6px"};">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td bgcolor="#f8fafc" style="padding:16px;border:1px solid #dbe4ee;border-radius:16px;background-color:#f8fafc;">
          <div style="font-family:${FONT};font-size:26px;font-weight:800;line-height:30px;color:#0f172a;">${text(formatNumber(locale, value))}</div>
          <div style="margin-top:4px;font-family:${FONT};font-size:13px;line-height:20px;color:#64748b;">${text(label)}</div>
        </td></tr>
      </table>
    </td>`);
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? ""}</tr>`);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">${rows.join("")}</table>`;
}

function upcomingSection(
  m: ServerMessages["email"]["weeklyAdminRecap"],
  title: string,
  groups: WeeklyAdminRecapUpcomingGroup[],
  emptyMessage: string,
): string {
  const content = groups.length === 0
    ? `<p style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;color:#64748b;">${text(emptyMessage)}</p>`
    : groups.map((group) => {
      const summary = m.groupSummary({ seatCount: group.seatCount, organisationCount: group.organisationCount });
      const names = group.organisations.length > 0 ? `<div style="margin-top:4px;color:#64748b;">${text(group.organisations.join(", "))}</div>` : "";
      return `<div style="padding:12px 0;border-top:1px solid #e2e8f0;font-family:${FONT};font-size:14px;line-height:21px;color:#334155;">
        <strong style="color:#0f172a;">${text(group.dateLabel)}</strong> · ${text(summary)}${names}
      </div>`;
    }).join("");
  return `<div style="margin:0 0 22px 0;">
    <h2 style="margin:0 0 8px 0;font-family:${FONT};font-size:16px;line-height:22px;color:#0f172a;">${text(title)}</h2>
    ${content}
  </div>`;
}
