import type { BillingEmailQueueData, BillingImpactSummary } from "@kanera/shared/schema";
import { button, divider, emailLayout, fallbackLink, heading, mutedHtml, paragraph } from "./layout.js";

export type BillingEmailParams = BillingEmailQueueData;

export function proTrialStartedEmail(params: BillingEmailParams): string {
  const end = params.trialEndsAtLabel;
  return billingLayout({
    subject: "Your Kanera Pro trial has started",
    preheader: end ? `Explore Kanera Pro until ${end}. You won't be charged automatically.` : "Explore Kanera Pro with no automatic charge at the end of your trial.",
    title: "Your Pro trial is live",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} now has full Kanera Pro access${end ? ` until ${end}` : " during your trial"}.`,
    params,
    lines: [
      "No payment method is required, and you won't be charged automatically when the trial ends.",
      "Try unlimited boards, members, automations, and executions, plus guest collaboration, API access, webhooks, and higher storage limits.",
      `Unless you upgrade, ${params.orgName} will move to Kanera Free automatically when the trial ends.`,
    ],
    cta: "Review your trial",
  });
}

export function proTrialWarningEmail(params: BillingEmailParams): string {
  const days = params.daysRemaining ?? 0;
  return billingLayout({
    subject: days === 1 ? "Your Kanera Pro trial ends tomorrow" : `Your Kanera Pro trial ends in ${days} days`,
    preheader: `Review what will change when ${params.orgName} moves to Kanera Free.`,
    title: days === 1 ? "Your trial ends tomorrow" : `Your trial ends in ${days} days`,
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName}'s Pro trial ends${params.trialEndsAtLabel ? ` on ${params.trialEndsAtLabel}` : days === 1 ? " tomorrow" : ` in ${days} days`}.`,
    params,
    lines: [
      "You won't be charged automatically. Unless you upgrade, the organisation will move to Kanera Free when the trial ends.",
      "All workspaces remain available. The summary below shows what will change based on your current setup.",
    ],
    impactMode: "forecast",
    cta: "Review changes and upgrade",
  });
}

export function downgradedToFreeEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: `${params.orgName} is now on Kanera Free`,
    preheader: "Your Pro trial ended. All workspaces remain available on Kanera Free.",
    title: "Your trial has ended",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} is now on Kanera Free.`,
    params,
    lines: [
      "All workspaces remain available. Kanera adjusted only the resources shown below to fit the Free limits.",
      "If you return to Pro, Kanera will restore eligible resources it changed during this downgrade.",
    ],
    impactMode: "applied",
    cta: "Review changes",
  });
}

export function upgradedToProEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Kanera Pro is active",
    preheader: `${params.orgName} now has active Kanera Pro access.`,
    title: "You're on Pro",
    intro: `Hi ${firstName(params.displayName)}, your Kanera Pro purchase for ${params.orgName} is confirmed.`,
    params,
    lines: [
      "Pro features and limits are available now.",
      hasImpact(params.impact) ? "Kanera also restored eligible resources recorded during the previous downgrade." : null,
    ],
    detailsPeriodLabel: "Next renewal",
    impactMode: hasImpact(params.impact) ? "restored" : undefined,
    cta: "Manage Pro",
  });
}

export function welcomeToProEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Welcome to Kanera Pro",
    preheader: `Your Pro subscription for ${params.orgName} is active.`,
    title: "Your Pro subscription is active",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} has moved from the Pro trial to a paid Pro subscription.`,
    params,
    lines: [
      "Your access continued without interruption, and no trial resources were changed.",
      "You can keep using unlimited boards, members, automations, and executions, plus guest collaboration, API access, webhooks, and higher storage limits.",
    ],
    detailsPeriodLabel: "Next renewal",
    cta: "Manage subscription",
  });
}

export function billingChangedEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Your Kanera Pro subscription was updated",
    preheader: `Review the updated subscription details for ${params.orgName}.`,
    title: "Subscription updated",
    intro: `Hi ${firstName(params.displayName)}, the Kanera Pro subscription for ${params.orgName} has been updated.`,
    params,
    lines: ["Here are the current details:"],
    detailsPeriodLabel: "Next renewal",
    cta: "Manage subscription",
  });
}

export function billingRenewedEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Your Kanera Pro subscription renewed",
    preheader: `Kanera Pro will continue for ${params.orgName}.`,
    title: "Pro renewed",
    intro: `Hi ${firstName(params.displayName)}, the Kanera Pro subscription for ${params.orgName} renewed successfully.`,
    params,
    lines: ["No action is needed. Your Pro access continues without interruption."],
    detailsPeriodLabel: "Next renewal",
    cta: "View billing",
  });
}

export function billingPaymentFailedEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Action needed: update your Kanera payment method",
    preheader: `We couldn't process the latest Pro payment for ${params.orgName}.`,
    title: "Payment needs attention",
    intro: `Hi ${firstName(params.displayName)}, we couldn't process the latest Kanera Pro payment for ${params.orgName}.`,
    params,
    lines: [
      "Pro remains available while the payment is retried, but an unresolved payment could interrupt access later.",
      "Update your payment method to keep the subscription active.",
    ],
    cta: "Update payment method",
  });
}

export function billingPaymentRecoveredEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: "Your Kanera Pro payment is confirmed",
    preheader: `Billing is back in good standing for ${params.orgName}.`,
    title: "Payment confirmed",
    intro: `Hi ${firstName(params.displayName)}, the outstanding Kanera Pro payment for ${params.orgName} has been confirmed.`,
    params,
    lines: ["No further action is needed. Pro access will continue without interruption."],
    detailsPeriodLabel: "Next renewal",
    cta: "View billing",
  });
}

export function seatBilledEmail(params: BillingEmailParams): string {
  if (!params.seatKind) {
    const current = params.purchasedSeatCount ?? params.activeSeatCount;
    const previous = params.previousPurchasedSeatCount;
    const added = current && previous !== null && previous !== undefined ? current - previous : null;
    return billingLayout({
      subject: "Your Kanera seat purchase is confirmed",
      preheader: current
        ? `${params.orgName} now has ${current} purchased seat${current === 1 ? "" : "s"}.`
        : `Your seat purchase for ${params.orgName} is confirmed.`,
      title: "Seat purchase confirmed",
      intro: `Hi ${firstName(params.displayName)}, your seat purchase for ${params.orgName} is confirmed.`,
      params,
      lines: [
        current && previous !== null && previous !== undefined && added && added > 0
          ? `${added} purchased seat${added === 1 ? " was" : "s were"} added, taking your seat capacity from ${previous} to ${current}.`
          : current
            ? `Your Pro plan now includes ${current} purchased seat${current === 1 ? "" : "s"}.`
          : null,
        params.billingSummary ?? null,
      ],
      cta: "Manage seats",
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

export function seatCapacityReducedEmail(params: BillingEmailParams): string {
  const current = params.purchasedSeatCount ?? params.activeSeatCount;
  const previous = params.previousPurchasedSeatCount;
  return billingLayout({
    subject: "Your Kanera seat capacity was reduced",
    preheader: current ? `${params.orgName} now has ${current} purchased seat${current === 1 ? "" : "s"}.` : `The purchased seat capacity for ${params.orgName} was reduced.`,
    title: "Seat capacity reduced",
    intro: `Hi ${firstName(params.displayName)}, the purchased seat capacity for ${params.orgName} has been updated.`,
    params,
    lines: [
      current && previous !== null && previous !== undefined
        ? `Your Pro plan now includes ${current} purchased seat${current === 1 ? "" : "s"}, reduced from ${previous}.`
        : current
          ? `Your Pro plan now includes ${current} purchased seat${current === 1 ? "" : "s"}.`
          : null,
      "Any resulting prorated credit will be reflected in future billing.",
    ],
    cta: "Manage seats",
  });
}

export function proCancellationScheduledEmail(params: BillingEmailParams): string {
  const end = params.periodEndLabel ?? params.trialEndsAtLabel;
  return billingLayout({
    subject: `Kanera Pro will end for ${params.orgName}`,
    preheader: end ? `Pro remains active until ${end}. Review what will change after that.` : "Pro remains active until the current billing period ends.",
    title: "Pro cancellation scheduled",
    intro: `Hi ${firstName(params.displayName)}, Kanera Pro will remain active for ${params.orgName}${end ? ` until ${end}` : " until the current billing period ends"}.`,
    params,
    lines: [
      `${params.orgName} will then move to Kanera Free automatically, and no further Pro renewals will be charged.`,
      "All workspaces will remain available. The summary below shows what will change based on the current setup.",
    ],
    impactMode: "forecast",
    cta: "Review or keep Pro",
  });
}

export function proCancellationReversedEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: `Kanera Pro will continue for ${params.orgName}`,
    preheader: "The scheduled cancellation was reversed and Pro will renew normally.",
    title: "Pro will continue",
    intro: `Hi ${firstName(params.displayName)}, the scheduled Kanera Pro cancellation for ${params.orgName} has been reversed.`,
    params,
    lines: ["Pro access will continue without interruption and the subscription will renew normally."],
    detailsPeriodLabel: "Next renewal",
    cta: "Manage subscription",
  });
}

export function proCancelledEmail(params: BillingEmailParams): string {
  return billingLayout({
    subject: `${params.orgName} is now on Kanera Free`,
    preheader: "The Pro subscription has ended. Review what changed on Kanera Free.",
    title: "Your Pro subscription has ended",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} is now on Kanera Free.`,
    params,
    lines: [
      "All workspaces remain available. Kanera adjusted only the resources shown below to fit the Free limits.",
      "If you return to Pro, Kanera will restore eligible resources it changed when the subscription ended.",
    ],
    impactMode: "applied",
    cta: "Review changes",
  });
}

function billingLayout(options: {
  subject: string;
  preheader: string;
  title: string;
  intro: string;
  params: BillingEmailParams;
  lines: Array<string | null>;
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
    ${fallbackLink(options.params.settingsUrl)}
  `;
  return emailLayout({ subject: options.subject, preheader: options.preheader, body });
}

function renderBillingDetails(params: BillingEmailParams, periodLabel: string): string {
  const seatCount = params.purchasedSeatCount ?? params.activeSeatCount;
  const rows = [
    params.billingInterval ? ["Billing", params.billingInterval === "annual" ? "Annual" : "Monthly"] : null,
    seatCount ? ["Purchased seats", String(seatCount)] : null,
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
  const items = impactItems(params.impact, mode);
  const limits = params.limits;
  const visibleLimits = mode !== "restored" ? limits : null;
  if (items.length === 0 && !visibleLimits) return "";
  const title = mode === "forecast" ? "What will change on Kanera Free" : mode === "restored" ? "What Kanera restored" : "What changed";
  const empty = mode === "forecast"
    ? "Nothing in your current setup exceeds the Kanera Free limits."
    : "No resources needed to be changed to fit the Kanera Free limits.";
  return `
    ${divider("18px 0 18px 0")}
    ${paragraph(title, "0 0 8px 0")}
    ${visibleLimits ? mutedHtml(`Kanera Free includes unlimited workspaces, ${visibleLimits.maxBoards} boards, ${visibleLimits.maxOrgMembers} members, ${visibleLimits.maxEnabledAutomations} active automations, and ${visibleLimits.maxAutomationExecutionsPerMonth} automation executions per month.`, "0 0 12px 0") : ""}
    ${items.length > 0 ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${items.map((item) => `
          <tr>
            <td style="padding:4px 0;font-family:'Inter','Segoe UI',Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#334155;" class="email-text">${escapeHtml(item)}</td>
          </tr>
        `).join("")}
      </table>
    ` : mutedHtml(empty, "0")}
  `;
}

function impactItems(impact: BillingImpactSummary | null | undefined, mode: "forecast" | "applied" | "restored" = "applied"): string[] {
  if (!impact) return [];
  type ImpactLabels = Record<"board" | "user" | "automation" | "webhook" | "apiKey" | "guest" | "invite", readonly [string, string]>;
  const labels: ImpactLabels = mode === "forecast"
    ? {
        board: ["board will be archived", "boards will be archived"],
        user: ["member will be suspended", "members will be suspended"],
        automation: ["automation will be disabled", "automations will be disabled"],
        webhook: ["webhook will be disabled", "webhooks will be disabled"],
        apiKey: ["API key will be revoked", "API keys will be revoked"],
        guest: ["guest will be removed from your boards", "guests will be removed from your boards"],
        invite: ["guest invite will be revoked", "guest invites will be revoked"],
      }
    : mode === "restored"
      ? {
          board: ["board restored", "boards restored"],
          user: ["member reactivated", "members reactivated"],
          automation: ["automation re-enabled", "automations re-enabled"],
          webhook: ["webhook re-enabled", "webhooks re-enabled"],
          apiKey: ["API key restored", "API keys restored"],
          guest: ["guest restored to your boards", "guests restored to your boards"],
          invite: ["guest invite restored", "guest invites restored"],
        }
      : {
          board: ["board archived", "boards archived"],
          user: ["member suspended", "members suspended"],
          automation: ["automation disabled", "automations disabled"],
          webhook: ["webhook disabled", "webhooks disabled"],
          apiKey: ["API key revoked", "API keys revoked"],
          guest: ["guest removed from your boards", "guests removed from your boards"],
          invite: ["guest invite revoked", "guest invites revoked"],
        };
  return [
    countLine(impact.boardsArchived, ...labels.board),
    countLine(impact.usersSuspended, ...labels.user),
    countLine(impact.automationsDisabled, ...labels.automation),
    countLine(impact.webhooksDisabled, ...labels.webhook),
    countLine(impact.apiKeysRevoked, ...labels.apiKey),
    countLine(impact.guestMembersRemoved, ...labels.guest),
    countLine(impact.guestInvitesRevoked, ...labels.invite),
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
