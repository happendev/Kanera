import { ApplicationRef, createComponent, EnvironmentInjector, inject, Injectable, type ComponentRef } from "@angular/core";
import { Router } from "@angular/router";
import type { BillingAnalyticsContextResponse, BillingInfoResponse } from "@kanera/shared/dto";
import { AnalyticsService } from "../core/analytics/analytics.service";
import type { PlanLimitAnalyticsProperties, PremiumFeature, UpgradeSource } from "../core/analytics/analytics-events";
import { ApiClient } from "../core/api/api.client";
import { AuthService } from "../core/auth/auth.service";
import { UpgradePromptDialogComponent, type UpgradePromptContent } from "./upgrade-prompt-dialog.component";

export type UpgradePromptReason = "member" | "board" | "automation" | "automationRule" | "guest" | "api" | "integration";

export interface UpgradePromptOptions {
  reason: UpgradePromptReason;
  source: UpgradeSource;
  /** Include the attempted addition when quoting a seat-gated action. */
  projectedSeats?: number;
  boardCount?: number;
  automationAllowance?: number;
  currentUsage?: number;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

@Injectable({ providedIn: "root" })
export class UpgradePromptService {
  private readonly api = inject(ApiClient);
  private readonly analytics = inject(AnalyticsService);
  private readonly appRef = inject(ApplicationRef);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(EnvironmentInjector);
  private readonly router = inject(Router);
  private openDialog: ComponentRef<UpgradePromptDialogComponent> | null = null;

  async open(options: UpgradePromptOptions): Promise<void> {
    if (this.openDialog || this.auth.entitlements()?.tier === "paid") return;

    const canReviewPlan = this.auth.isOrgAdmin();
    const billing = canReviewPlan ? await this.api.get<BillingInfoResponse>("/billing/me").catch(() => null) : null;
    const analyticsContext = billing?.analyticsContext
      ?? await this.api.get<BillingAnalyticsContextResponse>("/billing/analytics-context").catch(() => null);
    const currentSeats = billing?.usedSeats ?? 1;
    const seats = Math.max(1, options.projectedSeats ?? (options.reason === "guest" ? currentSeats + 1 : currentSeats));
    const annualCents = billing?.proPricing?.annualCents;
    const monthlyEquivalent = annualCents === undefined ? null : Math.round((annualCents * seats) / 12);
    const cost = !canReviewPlan
      ? "Ask your organisation owner to review Pro and your team's exact price."
      : monthlyEquivalent === null
      ? "See the Account Plan page for your exact team price."
      : `${money(monthlyEquivalent)}/month for ${seats} ${seats === 1 ? "person" : "people"} on annual billing (${money(annualCents! * seats)} billed yearly).`;
    const content = { ...this.content(options, seats, monthlyEquivalent, cost), canReviewPlan };
    const limitContext = this.limitContext(options, billing, analyticsContext);
    const premiumFeature = this.premiumFeature(options.reason);

    const ref = createComponent(UpgradePromptDialogComponent, { environmentInjector: this.injector });
    this.openDialog = ref;
    ref.setInput("content", content);
    const close = () => {
      if (this.openDialog !== ref) return;
      this.openDialog = null;
      this.appRef.detachView(ref.hostView);
      ref.destroy();
    };
    // These four events share one immutable snapshot so funnels never compare subtly different
    // usage totals for the same blocked action and modal impression.
    this.analytics.track("premium_feature_attempted", { ...limitContext, premium_feature: premiumFeature });
    this.analytics.track("plan_limit_reached", limitContext);
    this.analytics.track("plan_limit_warning_seen", limitContext);
    this.analytics.track("upgrade_modal_viewed", { ...limitContext, premium_feature: premiumFeature });
    ref.instance.dismissed.subscribe(() => {
      this.analytics.track("upgrade_modal_dismissed", { ...limitContext, premium_feature: premiumFeature });
      close();
    });
    ref.instance.reviewPlan.subscribe(() => {
      close();
      if (canReviewPlan) void this.router.navigate(["/settings", "account-plan"], { queryParams: { billing: "annual" } });
    });
    this.appRef.attachView(ref.hostView);
    document.body.appendChild(ref.location.nativeElement);
  }

  private premiumFeature(reason: UpgradePromptReason): PremiumFeature {
    switch (reason) {
      case "member": return "members";
      case "board": return "boards";
      case "automationRule": return "automation_rules";
      case "automation": return "automation_executions";
      case "guest": return "guests";
      case "api": return "api";
      case "integration": return "integrations";
    }
  }

  private limitContext(
    options: UpgradePromptOptions,
    billing: BillingInfoResponse | null,
    analyticsContext: BillingAnalyticsContextResponse | null,
  ): PlanLimitAnalyticsProperties {
    const feature = this.premiumFeature(options.reason);
    const entitlements = this.auth.entitlements();
    const totals = analyticsContext;
    const planLimit = feature === "members"
      ? entitlements?.maxOrgMembers ?? billing?.seatLimit ?? 0
      : feature === "boards"
      ? entitlements?.maxBoards ?? 0
      : feature === "automation_rules"
      ? entitlements?.maxEnabledAutomations ?? 0
      : feature === "automation_executions"
      ? entitlements?.maxAutomationExecutionsPerMonth ?? options.automationAllowance ?? 0
      : 0;
    const currentUsage = options.currentUsage
      ?? (feature === "members" ? totals?.activeMemberCount ?? (options.projectedSeats !== undefined ? Math.max(0, options.projectedSeats - 1) : billing?.usedSeats ?? 0)
        : feature === "boards" ? totals?.boardCount ?? options.boardCount ?? 0
        : planLimit);
    const trialEndsAt = entitlements?.trialEndsAt ? new Date(entitlements.trialEndsAt).getTime() : Number.NaN;
    const trialDaysRemaining = Number.isFinite(trialEndsAt)
      ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86_400_000))
      : 0;

    return {
      limit_type: feature,
      current_usage: currentUsage,
      plan_limit: planLimit,
      member_count: totals?.memberCount ?? billing?.usedSeats ?? 0,
      active_member_count: totals?.activeMemberCount ?? billing?.usedSeats ?? 0,
      board_count: totals?.boardCount ?? options.boardCount ?? 0,
      trial_days_remaining: trialDaysRemaining,
      upgrade_source: options.source,
    };
  }

  private content(options: UpgradePromptOptions, seats: number, monthlyEquivalent: number | null, cost: string): Omit<UpgradePromptContent, "canReviewPlan"> {
    const teamHeadline = monthlyEquivalent === null
      ? `Bring your full ${seats}-person team into Kanera with Pro.`
      : `Your full ${seats}-person team costs ${money(monthlyEquivalent)}/month on annual billing.`;
    switch (options.reason) {
      case "member":
        return {
          headline: teamHeadline,
          attemptedAction: "Invite another editor",
          valueReceived: `${Math.max(0, seats - 1)} people already share your organisation's boards, fields, and workflow.`,
          cost,
          freeConsequence: `Your team stays at ${Math.max(0, seats - 1)} active people and this invitation cannot add another editor.`,
        };
      case "board": {
        const boardCount = options.boardCount ?? 0;
        return {
          headline: "Move from a pilot to running all your projects in Kanera.",
          attemptedAction: "Create another board",
          valueReceived: `Your team already runs ${boardCount} active project${boardCount === 1 ? "" : "s"} in one shared workflow.`,
          cost,
          freeConsequence: "Your current boards stay available, but this new board will not be created.",
        };
      }
      case "automation": {
        const allowance = options.automationAllowance ?? 100;
        return {
          headline: `Kanera automated ${allowance} actions for your team this month.`,
          attemptedAction: "Run another automation",
          valueReceived: `${allowance} repetitive actions were handled automatically this month.`,
          cost,
          freeConsequence: "Enabled rules stay configured, but further automation actions wait until next month's allowance resets.",
        };
      }
      case "automationRule":
        return {
          headline: "Run every workflow your team needs with Pro.",
          attemptedAction: "Enable another automation",
          valueReceived: "Your active rules already take repeatable work off your team's plate.",
          cost,
          freeConsequence: "Existing enabled rules keep running within the monthly allowance, but this additional rule stays paused.",
        };
      case "guest":
        return {
          headline: "Collaborate with this client across projects with Pro.",
          attemptedAction: "Add a multi-board guest",
          valueReceived: "The client relationship and project work already live in Kanera.",
          cost,
          freeConsequence: "The guest keeps their existing access, but cannot be added across more projects.",
        };
      case "api":
        return {
          headline: "Connect Kanera to your systems and AI agents with Pro.",
          attemptedAction: "Open API or MCP setup",
          valueReceived: "Your boards and workflows are ready to become the source for connected systems and agents.",
          cost,
          freeConsequence: "Your work stays in Kanera, but API keys, webhooks, and MCP connections remain unavailable.",
        };
      case "integration":
        return {
          headline: "Bring Kanera updates into the chat where your team already works.",
          attemptedAction: "Connect a chat destination",
          valueReceived: "Your workspace already has the card activity your team needs to follow.",
          cost,
          freeConsequence: "Work stays available in Kanera, but updates will not post to Slack, Discord, Telegram, or Zulip.",
        };
    }
  }
}
