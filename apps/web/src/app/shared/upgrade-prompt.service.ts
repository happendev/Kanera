import { ApplicationRef, createComponent, EnvironmentInjector, inject, Injectable, type ComponentRef } from "@angular/core";
import { Router } from "@angular/router";
import type { BillingAnalyticsContextResponse, BillingInfoResponse } from "@kanera/shared/dto";
import { AnalyticsService } from "../core/analytics/analytics.service";
import type { PlanLimitAnalyticsProperties, PremiumFeature, UpgradeSource } from "../core/analytics/analytics-events";
import { ApiClient } from "../core/api/api.client";
import { AuthService } from "../core/auth/auth.service";
import { icu } from "../core/i18n/icu";
import { appLocale } from "../core/i18n/locale";
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

// Prices are always USD (that is what Stripe bills); only the number formatting follows the viewer.
function money(cents: number): string {
  return new Intl.NumberFormat(appLocale(), { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
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
      ? $localize`:Upgrade dialog price row for a non-admin; Pro is the plan name:Ask your organisation owner to review Pro and your team's exact price.`
      : monthlyEquivalent === null
      ? $localize`:Upgrade dialog price row when pricing is unavailable:See the Account Plan page for your exact team price.`
      : icu(
        $localize`:Upgrade dialog price row; monthly and yearly are formatted prices:{seats, plural, one {{monthly}/month for # person on annual billing ({yearly} billed yearly).} other {{monthly}/month for # people on annual billing ({yearly} billed yearly).}}`,
        { seats, monthly: money(monthlyEquivalent), yearly: money(annualCents! * seats) },
      );
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
      ? icu($localize`:Upgrade dialog headline; Pro is the plan name:{seats, plural, other {Bring your full #-person team into Kanera with Pro.}}`, { seats })
      : icu(
        $localize`:Upgrade dialog headline; price is a formatted monthly price:{seats, plural, other {Your full #-person team costs {price}/month on annual billing.}}`,
        { seats, price: money(monthlyEquivalent) },
      );
    const others = Math.max(0, seats - 1);
    switch (options.reason) {
      case "member":
        return {
          headline: teamHeadline,
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Invite another editor`,
          valueReceived: icu($localize`:Upgrade dialog:{others, plural, one {# person already shares your organisation's boards, fields, and workflow.} other {# people already share your organisation's boards, fields, and workflow.}}`, { others }),
          cost,
          freeConsequence: icu($localize`:Upgrade dialog:{others, plural, one {Your team stays at # active person and this invitation cannot add another editor.} other {Your team stays at # active people and this invitation cannot add another editor.}}`, { others }),
        };
      case "board": {
        const boardCount = options.boardCount ?? 0;
        return {
          headline: $localize`:Upgrade dialog headline:Move from a pilot to running all your projects in Kanera.`,
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Create another board`,
          valueReceived: icu($localize`:Upgrade dialog:{boardCount, plural, one {Your team already runs # active project in one shared workflow.} other {Your team already runs # active projects in one shared workflow.}}`, { boardCount }),
          cost,
          freeConsequence: $localize`:Upgrade dialog:Your current boards stay available, but this new board will not be created.`,
        };
      }
      case "automation": {
        const allowance = options.automationAllowance ?? 100;
        return {
          headline: icu($localize`:Upgrade dialog headline:{allowance, plural, one {Kanera automated # action for your team this month.} other {Kanera automated # actions for your team this month.}}`, { allowance }),
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Run another automation`,
          valueReceived: icu($localize`:Upgrade dialog:{allowance, plural, one {# repetitive action was handled automatically this month.} other {# repetitive actions were handled automatically this month.}}`, { allowance }),
          cost,
          freeConsequence: $localize`:Upgrade dialog:Enabled automations stay configured, but further automation actions wait until next month's allowance resets.`,
        };
      }
      case "automationRule":
        return {
          headline: $localize`:Upgrade dialog headline; Pro is the plan name:Run every workflow your team needs with Pro.`,
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Enable another automation`,
          valueReceived: $localize`:Upgrade dialog:Your active automations already take repeatable work off your team's plate.`,
          cost,
          freeConsequence: $localize`:Upgrade dialog:Existing enabled automations keep running within the monthly allowance, but this additional one stays paused.`,
        };
      case "guest":
        return {
          headline: $localize`:Upgrade dialog headline; Pro is the plan name:Collaborate with this client across projects with Pro.`,
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Add a multi-board guest`,
          valueReceived: $localize`:Upgrade dialog:The client relationship and project work already live in Kanera.`,
          cost,
          freeConsequence: $localize`:Upgrade dialog:The guest keeps their existing access, but cannot be added across more projects.`,
        };
      case "api":
        return {
          headline: $localize`:Upgrade dialog headline; Pro is the plan name:Run integrations and unattended AI agents with Pro.`,
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Create a workspace API key or unattended agent`,
          valueReceived: $localize`:Upgrade dialog:Your boards and workflows are ready to become the source for connected systems and agents.`,
          cost,
          freeConsequence: $localize`:Upgrade dialog:Your own AI agents and personal API keys keep working within fair-use limits, but workspace API keys, webhooks, and unattended agents remain unavailable.`,
        };
      case "integration":
        return {
          headline: $localize`:Upgrade dialog headline:Bring Kanera updates into the chat where your team already works.`,
          attemptedAction: $localize`:Upgrade dialog label for the blocked action:Connect a chat destination`,
          valueReceived: $localize`:Upgrade dialog:Your workspace already has the card activity your team needs to follow.`,
          cost,
          freeConsequence: $localize`:Upgrade dialog:Work stays available in Kanera, but updates will not post to Slack, Discord, Telegram, or Zulip.`,
        };
    }
  }
}
