import type { BillingEmailQueueData, BillingImpactSummary } from "@kanera/shared/schema";
import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph } from "./layout.js";

export type BillingEmailParams = BillingEmailQueueData;

export function proTrialStartedEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Your Kanera Pro trial has started",
    preheader: "Your organisation now has Pro features during the trial.",
    title: "Your Pro trial is live",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} now has Kanera Pro for the trial period.`,
    params,
    lines: [
      "During the trial you can use unlimited workspaces, boards, members, and enabled automations.",
      "You also have access to guests, API keys, webhooks, and the hosted Pro storage limits.",
      params.trialEndsAtLabel ? `Your trial ends on ${params.trialEndsAtLabel}.` : null,
    ],
    cta: "Manage plan",
  });
}

export function proTrialWarningEmail(params: BillingEmailParams): string {
  const days = params.daysRemaining ?? 0;
  return billingLayout({
    subject: days === 1 ? "Your Kanera Pro trial ends tomorrow" : `Your Kanera Pro trial ends in ${days} days`,
    preheader: "No payment is needed. Your organisation will move to Free automatically.",
    title: days === 1 ? "Your trial ends tomorrow" : `Your trial ends in ${days} days`,
    intro: `Hi ${firstName(params.displayName)}, no payment is needed. ${params.orgName} will move to the Free plan automatically when the trial ends.`,
    params,
    lines: [
      "You can keep using Kanera for free.",
      "Free organisations keep the oldest workspace, boards, members, and enabled automation within the Free limits.",
      params.trialEndsAtLabel ? `Trial end date: ${params.trialEndsAtLabel}.` : null,
    ],
    includeImpact: hasImpact(params.impact),
    cta: "Review plan",
  });
}

export function downgradedToFreeEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Kanera moved your organisation to Free",
    preheader: "You can continue using Kanera for free.",
    title: "You're now on Free",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} has moved to the Free plan. You can continue using Kanera for free.`,
    params,
    lines: [
      "Some Pro-only resources may have been archived, disabled, revoked, or suspended to fit the Free limits.",
      "Upgrading to Pro later restores the resources Kanera changed during the downgrade.",
    ],
    includeImpact: true,
    cta: "View account settings",
  });
}

export function upgradedToProEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Kanera Pro is active",
    preheader: "Pro limits are unlocked for your organisation.",
    title: "You're on Pro",
    intro: `Hi ${firstName(params.displayName)}, Kanera Pro is active for ${params.orgName}.`,
    params,
    lines: [
      "Limits are unlocked for this organisation.",
      "If a previous downgrade changed resources, Kanera has restored the items it recorded at that time.",
      params.billingSummary ?? null,
    ],
    includeImpact: true,
    cta: "Manage billing",
  });
}

export function welcomeToProEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Welcome to Kanera Pro",
    preheader: "Your organisation now has active Pro features.",
    title: "Welcome to Pro",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} is now active on Kanera Pro.`,
    params,
    lines: [
      "You can keep using unlimited workspaces, boards, members, and enabled automations.",
      "You also have access to guests, API keys, webhooks, and the hosted Pro storage limits.",
      params.billingSummary ?? null,
    ],
    includeImpact: false,
    cta: "Manage billing",
  });
}

export function billingChangedEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Your Kanera billing is confirmed",
    preheader: "Stripe confirmed the latest subscription details for your organisation.",
    title: "Billing confirmed",
    intro: `Hi ${firstName(params.displayName)}, here are the latest subscription details for ${params.orgName}.`,
    params,
    lines: [params.billingSummary ?? "Stripe confirmed a subscription, seat, or billing-period change."],
    cta: "Manage billing",
  });
}

export function seatBilledEmail(params: BillingEmailParams): string {
  if (!params.seatKind) {
    return billingLayout({
      subject: "Kanera seat capacity changed",
      preheader: "Your organisation's purchased seat capacity was updated.",
      title: "Seat capacity updated",
      intro: `Hi ${firstName(params.displayName)}, Kanera updated the purchased seat capacity for ${params.orgName}.`,
      params,
      lines: [
        params.activeSeatCount
          ? `${params.orgName} now has ${params.activeSeatCount} purchased seat${params.activeSeatCount === 1 ? "" : "s"}.`
          : null,
        params.billingSummary ?? null,
      ],
      cta: "Manage billing",
    });
  }
  const seatLabel = params.seatKind === "guest" ? "external guest seat" : "member seat";
  const billedUser = params.billedUserName && params.billedUserEmail
    ? `${params.billedUserName} (${params.billedUserEmail})`
    : params.billedUserName ?? params.billedUserEmail ?? null;
  return billingLayout({
    subject: "A Kanera seat was billed",
    preheader: `A new ${seatLabel} was billed for your organisation.`,
    title: "Seat billed",
    intro: `Hi ${firstName(params.displayName)}, Kanera billed a new ${seatLabel} for ${params.orgName}.`,
    params,
    lines: [
      billedUser ? `Seat added for: ${billedUser}.` : null,
      params.activeSeatCount
        ? `${params.orgName} now has ${params.activeSeatCount} active billed seat${params.activeSeatCount === 1 ? "" : "s"}.`
        : null,
      params.billingSummary ?? null,
    ],
    cta: "Manage billing",
  });
}

export function proCancelledEmail(params: BillingEmailParams): string {
  const days = params.daysRemaining;
  return billingLayout({
    subject: "Kanera Pro was cancelled",
    preheader: days && days > 0 ? `You have ${days} day${days === 1 ? "" : "s"} of Pro remaining.` : "Your organisation will move to Free.",
    title: "Pro was cancelled",
    intro: `Hi ${firstName(params.displayName)}, Kanera Pro was cancelled for ${params.orgName}.`,
    params,
    lines: [
      days && days > 0
        ? `You have ${days} day${days === 1 ? "" : "s"} remaining before the organisation moves to Free.`
        : "Your organisation will move to Free when Stripe ends the subscription.",
      "No further action is needed if you want to continue on Free.",
    ],
    includeImpact: true,
    cta: "Review plan",
  });
}

function billingLayout(options: {
  subject: string;
  preheader: string;
  title: string;
  intro: string;
  params: BillingEmailParams;
  lines: Array<string | null>;
  includeImpact?: boolean;
  cta: string;
}) {
  const body = `
    ${heading(options.title)}
    ${paragraph(options.intro)}
    ${options.lines.filter(Boolean).map((line) => paragraph(line!, "0 0 14px 0")).join("")}
    ${options.includeImpact ? renderImpact(options.params) : ""}
    ${button({ href: options.params.settingsUrl, label: options.cta })}
    ${fallbackLink(options.params.settingsUrl)}
  `;
  return emailLayout({ subject: options.subject, preheader: options.preheader, body });
}

function renderImpact(params: BillingEmailParams): string {
  const items = impactItems(params.impact);
  const limits = params.limits;
  if (items.length === 0 && !limits) return "";
  return `
    ${divider("18px 0 18px 0")}
    ${limits ? mutedHtml(`Free includes unlimited workspaces, ${limits.maxBoards} boards, ${limits.maxOrgMembers} members, and ${limits.maxEnabledAutomations} enabled automation${limits.maxEnabledAutomations === 1 ? "" : "s"}.`, "0 0 12px 0") : ""}
    ${items.length > 0 ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${items.map((item) => `
          <tr>
            <td style="padding:4px 0;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#334155;" class="email-text">${escapeHtml(item)}</td>
          </tr>
        `).join("")}
      </table>
    ` : mutedHtml("Nothing you have set up is currently over the Free limits.", "0")}
  `;
}

function impactItems(impact: BillingImpactSummary | null | undefined): string[] {
  if (!impact) return [];
  return [
    countLine(impact.boardsArchived, "board archived", "boards archived"),
    countLine(impact.usersSuspended, "member suspended", "members suspended"),
    countLine(impact.automationsDisabled, "automation disabled", "automations disabled"),
    countLine(impact.webhooksDisabled, "webhook disabled", "webhooks disabled"),
    countLine(impact.apiKeysRevoked, "API key revoked", "API keys revoked"),
    countLine(impact.guestMembersRemoved, "guest removed from a board", "guests removed from boards"),
    countLine(impact.guestInvitesRevoked, "guest invite revoked", "guest invites revoked"),
  ].filter((line): line is string => line !== null);
}

function hasImpact(impact: BillingImpactSummary | null | undefined): boolean {
  return impactItems(impact).length > 0;
}

function countLine(count: number, singular: string, plural: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
