import type { WeeklyAdminRecapEmailQueueData, WeeklyAdminRecapUpcomingGroup } from "@kanera/shared/schema";
import { button, divider, emailLayout, heading, mutedHtml, paragraph, sectionLabel, text } from "./layout.js";

export type WeeklyAdminRecapEmailParams = WeeklyAdminRecapEmailQueueData;

const FONT = "'Inter','Segoe UI',Arial,Helvetica,sans-serif";

export function weeklyAdminRecapEmail(params: WeeklyAdminRecapEmailParams): string {
  const upcomingCount = params.upcoming.renewals.reduce((sum, group) => sum + group.seatCount, 0);
  const preheader = `${params.lastWeek.newAccounts} new accounts, ${params.lastWeek.boardsCreated} boards, and ${upcomingCount} seats renewing this week.`;

  return emailLayout({
    subject: "Your weekly Kanera system recap",
    preheader,
    body: [
      heading("Weekly system recap"),
      paragraph(`${params.lastWeekLabel} at a glance, followed by what is scheduled for ${params.thisWeekLabel}.`),
      sectionLabel("Last week"),
      metricGrid([
        ["New accounts", params.lastWeek.newAccounts],
        ["New organisations", params.lastWeek.newOrganisations],
        ["Invites accepted", params.lastWeek.invitesAccepted],
        ["Boards created", params.lastWeek.boardsCreated],
        ["Subscriptions started", params.lastWeek.subscriptionsStarted],
        ["Seats purchased", params.lastWeek.seatsPurchased],
      ]),
      divider("28px 0"),
      sectionLabel("Current system state"),
      metricGrid([
        ["Active accounts", params.snapshot.activeAccounts],
        ["Active organisations", params.snapshot.activeOrganisations],
        ["Active boards", params.snapshot.activeBoards],
        ["Paid organisations", params.snapshot.paidOrganisations],
        ["Trials", params.snapshot.trialOrganisations],
        ["Purchased seats", params.snapshot.purchasedSeats],
      ]),
      divider("28px 0"),
      sectionLabel("Coming up this week"),
      upcomingSection("Seat renewals", params.upcoming.renewals, "No seat renewals are scheduled."),
      upcomingSection("Trials ending", params.upcoming.trialEnds, "No trials are scheduled to end."),
      upcomingSection("Scheduled cancellations", params.upcoming.cancellations, "No subscriptions are scheduled to end."),
      button({ href: params.adminUrl, label: "Open admin console" }),
      mutedHtml("Reporting windows and send time use UTC. Counts exclude soft-deleted accounts, organisations, and boards where applicable."),
    ].join(""),
  });
}

function metricGrid(metrics: Array<[label: string, value: number]>): string {
  const cells = metrics.map(([label, value], index) => `
    <td width="50%" valign="top" style="width:50%;padding:${index % 2 === 0 ? "0 6px 12px 0" : "0 0 12px 6px"};">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td bgcolor="#f8fafc" style="padding:16px;border:1px solid #dbe4ee;border-radius:16px;background-color:#f8fafc;">
          <div style="font-family:${FONT};font-size:26px;font-weight:800;line-height:30px;color:#0f172a;">${value}</div>
          <div style="margin-top:4px;font-family:${FONT};font-size:13px;line-height:20px;color:#64748b;">${text(label)}</div>
        </td></tr>
      </table>
    </td>`);
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? ""}</tr>`);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">${rows.join("")}</table>`;
}

function upcomingSection(title: string, groups: WeeklyAdminRecapUpcomingGroup[], emptyMessage: string): string {
  const content = groups.length === 0
    ? `<p style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;color:#64748b;">${text(emptyMessage)}</p>`
    : groups.map((group) => {
      const orgLabel = `${group.organisationCount} organisation${group.organisationCount === 1 ? "" : "s"}`;
      const seatLabel = `${group.seatCount} seat${group.seatCount === 1 ? "" : "s"}`;
      const names = group.organisations.length > 0 ? `<div style="margin-top:4px;color:#64748b;">${text(group.organisations.join(", "))}</div>` : "";
      return `<div style="padding:12px 0;border-top:1px solid #e2e8f0;font-family:${FONT};font-size:14px;line-height:21px;color:#334155;">
        <strong style="color:#0f172a;">${text(group.dateLabel)}</strong> · ${text(seatLabel)} across ${text(orgLabel)}${names}
      </div>`;
    }).join("");
  return `<div style="margin:0 0 22px 0;">
    <h2 style="margin:0 0 8px 0;font-family:${FONT};font-size:16px;line-height:22px;color:#0f172a;">${text(title)}</h2>
    ${content}
  </div>`;
}
