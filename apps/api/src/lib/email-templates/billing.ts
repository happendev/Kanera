import type { Locale } from "@kanera/shared/locales";
import type { BillingEmailQueueData, BillingImpactSummary } from "@kanera/shared/schema";
import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph, text } from "./layout.js";
import { escapeHtml } from "../html-escape.js";
import { serverMessages } from "../i18n/messages/index.js";
import type { BillingImpactKey, BillingMessages } from "../i18n/messages/types.js";

/** Date labels (`trialEndsAtLabel`, `periodEndLabel`) are formatted in `locale` when queued. */
export type BillingEmailParams = BillingEmailQueueData & { locale: Locale };

function billingMessages(params: Pick<BillingEmailParams, "locale">): BillingMessages {
  return serverMessages(params.locale).email.billing;
}

export function proTrialStartedEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).trialStarted;
  const end = params.trialEndsAtLabel ?? null;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ end }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName, end }),
    params,
    lines: m.lines({ org: params.orgName }),
    cta: m.cta,
  });
}

export function proTrialWarningEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).trialWarning;
  const days = params.daysRemaining ?? 0;
  return billingLayout({
    subject: m.subject({ days }),
    preheader: m.preheader({ org: params.orgName }),
    title: m.title({ days }),
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName, end: params.trialEndsAtLabel ?? null, days }),
    params,
    lines: [usageLine(params), ...m.lines],
    impactMode: "forecast",
    cta: m.cta,
  });
}

export function downgradedToFreeEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).downgradedToFree;
  return billingLayout({
    subject: m.subject({ org: params.orgName }),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: m.lines,
    impactMode: "applied",
    cta: m.cta,
  });
}

export function upgradedToProEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  const m = messages.upgradedToPro;
  const restored = hasImpact(params.impact);
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: [m.line, restored ? m.restoredLine : null],
    detailsPeriodLabel: messages.details.nextRenewal,
    impactMode: restored ? "restored" : undefined,
    cta: m.cta,
  });
}

export function welcomeToProEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  const m = messages.welcomeToPro;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: m.lines,
    detailsPeriodLabel: messages.details.nextRenewal,
    cta: m.cta,
  });
}

export function billingChangedEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  const m = messages.changed;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: [m.line],
    detailsPeriodLabel: messages.details.nextRenewal,
    cta: m.cta,
  });
}

export function billingRenewedEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  const m = messages.renewed;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: [m.line],
    detailsPeriodLabel: messages.details.nextRenewal,
    cta: m.cta,
  });
}

export function billingPaymentFailedEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).paymentFailed;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: m.lines,
    cta: m.cta,
  });
}

export function billingPaymentRecoveredEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  const m = messages.paymentRecovered;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: [m.line],
    detailsPeriodLabel: messages.details.nextRenewal,
    cta: m.cta,
  });
}

/** Shared with the mailer so the queued subject and the rendered <title> cannot drift. */
export function seatBilledEmailSubject(params: BillingEmailParams): string {
  const m = billingMessages(params);
  return params.seatKind ? m.seatBilled.subject : m.seatPurchase.subject;
}

export function seatBilledEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  if (!params.seatKind) {
    const m = messages.seatPurchase;
    const current = params.purchasedSeatCount ?? params.activeSeatCount;
    const previous = params.previousPurchasedSeatCount;
    const added = current && previous !== null && previous !== undefined ? current - previous : null;
    return billingLayout({
      subject: seatBilledEmailSubject(params),
      preheader: m.preheader({ org: params.orgName, count: current ?? null }),
      title: m.title,
      intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
      params,
      lines: [
        current && previous !== null && previous !== undefined && added && added > 0
          ? m.added({ added, from: previous, to: current })
          : current
            ? m.total({ count: current })
          : null,
        params.billingSummary ?? null,
      ],
      cta: m.cta,
    });
  }
  const m = messages.seatBilled;
  const seatKind = m.seatKind[params.seatKind];
  const billedUser = params.billedUserName && params.billedUserEmail
    ? m.userWithEmail({ name: params.billedUserName, email: params.billedUserEmail })
    : params.billedUserName ?? params.billedUserEmail ?? null;
  return billingLayout({
    subject: seatBilledEmailSubject(params),
    preheader: m.preheader({ seatKind }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName, seatKind }),
    params,
    lines: [
      billedUser ? m.billedUser({ user: billedUser }) : null,
      params.activeSeatCount ? m.activeSeats({ org: params.orgName, count: params.activeSeatCount }) : null,
      params.billingSummary ?? null,
    ],
    cta: m.cta,
  });
}

export function seatCapacityReducedEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).seatCapacityReduced;
  const current = params.purchasedSeatCount ?? params.activeSeatCount;
  const previous = params.previousPurchasedSeatCount;
  return billingLayout({
    subject: m.subject,
    preheader: m.preheader({ org: params.orgName, count: current ?? null }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: [
      current && previous !== null && previous !== undefined
        ? m.reduced({ count: current, from: previous })
        : current
          ? m.total({ count: current })
          : null,
      m.creditLine,
    ],
    cta: m.cta,
  });
}

export function proCancellationScheduledEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).cancellationScheduled;
  const end = params.periodEndLabel ?? params.trialEndsAtLabel ?? null;
  return billingLayout({
    subject: m.subject({ org: params.orgName }),
    preheader: m.preheader({ end }),
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName, end }),
    params,
    lines: m.lines({ org: params.orgName }),
    impactMode: "forecast",
    cta: m.cta,
  });
}

export function proCancellationReversedEmail(params: BillingEmailParams): string {
  const messages = billingMessages(params);
  const m = messages.cancellationReversed;
  return billingLayout({
    subject: m.subject({ org: params.orgName }),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: [m.line],
    detailsPeriodLabel: messages.details.nextRenewal,
    cta: m.cta,
  });
}

export function proCancelledEmail(params: BillingEmailParams): string {
  const m = billingMessages(params).cancelled;
  return billingLayout({
    subject: m.subject({ org: params.orgName }),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    params,
    lines: m.lines,
    impactMode: "applied",
    cta: m.cta,
  });
}

function billingLayout(options: {
  subject: string;
  preheader: string;
  title: string;
  intro: string;
  params: BillingEmailParams;
  lines: ReadonlyArray<string | null>;
  detailsPeriodLabel?: string;
  impactMode?: "forecast" | "applied" | "restored";
  cta: string;
}) {
  const body = `
    ${heading(options.title)}
    ${paragraph(options.intro)}
    ${options.lines.filter(Boolean).map((line) => paragraph(line!, "0 0 14px 0")).join("")}
    ${options.detailsPeriodLabel ? renderBillingDetails(options.params, options.detailsPeriodLabel) : ""}
    ${options.impactMode ? renderImpact(options.params, options.impactMode) : ""}
    ${button({ href: options.params.settingsUrl, label: options.cta })}
    ${fallbackLink(options.params.settingsUrl, options.params.locale)}
  `;
  return emailLayout({ locale: options.params.locale, subject: options.subject, preheader: options.preheader, body });
}

function renderBillingDetails(params: BillingEmailParams, periodLabel: string): string {
  const m = billingMessages(params).details;
  const seatCount = params.purchasedSeatCount ?? params.activeSeatCount;
  const rows = [
    params.billingInterval ? [m.billing, params.billingInterval === "annual" ? m.annual : m.monthly] : null,
    seatCount ? [m.purchasedSeats, String(seatCount)] : null,
    params.periodEndLabel ? [periodLabel, params.periodEndLabel] : null,
  ].filter((row): row is string[] => row !== null);
  if (rows.length === 0) return params.billingSummary ? paragraph(params.billingSummary, "0 0 14px 0") : "";
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 18px 0;border:1px solid #e2e8f0;border-radius:12px;background-color:#f8fafc;">
      ${rows.map(([label, value]) => `
        <tr>
          <td style="padding:9px 12px;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">${escapeHtml(label!)}</td>
          <td align="right" style="padding:9px 12px;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;line-height:20px;color:#0f172a;">${escapeHtml(value!)}</td>
        </tr>
      `).join("")}
    </table>
  `;
}

function renderImpact(params: BillingEmailParams, mode: "forecast" | "applied" | "restored"): string {
  const m = billingMessages(params).impact;
  const items = impactItems(params.impact, m[mode]);
  const limits = params.limits;
  const visibleLimits = mode !== "restored" ? limits : null;
  if (items.length === 0 && !visibleLimits) return "";
  const title = mode === "forecast" ? m.forecastTitle : mode === "restored" ? m.restoredTitle : m.appliedTitle;
  const empty = mode === "forecast" ? m.forecastEmpty : m.appliedEmpty;
  return `
    ${divider("18px 0 18px 0")}
    ${paragraph(title, "0 0 8px 0")}
    ${visibleLimits ? mutedHtml(text(m.freeLimits({
      boards: visibleLimits.maxBoards,
      members: visibleLimits.maxOrgMembers,
      automations: visibleLimits.maxEnabledAutomations,
      executions: visibleLimits.maxAutomationExecutionsPerMonth,
    })), "0 0 12px 0") : ""}
    ${items.length > 0 ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${items.map((item) => `
          <tr>
            <td style="padding:4px 0;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#334155;" class="email-text">${escapeHtml(item)}</td>
          </tr>
        `).join("")}
      </table>
    ` : mutedHtml(text(empty), "0")}
  `;
}

function impactItems(impact: BillingImpactSummary | null | undefined, labels: Record<BillingImpactKey, (count: number) => string>): string[] {
  if (!impact) return [];
  const counts: Array<[BillingImpactKey, number]> = [
    ["board", impact.boardsArchived],
    ["user", impact.usersSuspended],
    ["automation", impact.automationsDisabled],
    ["webhook", impact.webhooksDisabled],
    ["apiKey", impact.apiKeysRevoked],
    ["guest", impact.guestMembersRemoved],
    ["invite", impact.guestInvitesRevoked],
  ];
  return counts.filter(([, count]) => count > 0).map(([key, count]) => labels[key](count));
}

function hasImpact(impact: BillingImpactSummary | null | undefined): boolean {
  if (!impact) return false;
  return Object.values(impact).some((count) => count > 0);
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}


function usageLine(params: BillingEmailParams): string | null {
  const usage = params.usage;
  if (!usage || (usage.boards === 0 && usage.cards === 0)) return null;
  return billingMessages(params).usage(usage);
}
