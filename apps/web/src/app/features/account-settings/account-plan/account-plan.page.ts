import { RouterLink } from "@angular/router";
import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import type { PlanUsageMeterKey, PlanUsageResponse } from "@kanera/shared/dto";
import { planUsageLevel, planUsagePercent, type PlanUsageLevel } from "@kanera/shared/dto/plan-usage-limits";
import { ApiClient } from "../../../core/api/api.client";
import { appLocale } from "../../../core/i18n/locale";
import { formatDate } from "../../../shared/date-format";
import { AccountSettingsPage } from "../account-settings.page";

const METER_LABELS: Record<PlanUsageMeterKey, { label: string; icon: string }> = {
  boards: { label: $localize`:Plan usage meter label:Boards`, icon: "layout-board" },
  members: { label: $localize`:Plan usage meter label:Members`, icon: "users" },
  seats: { label: $localize`:Plan usage meter label — purchased seats in use:Seats`, icon: "users" },
  activeAutomations: { label: $localize`:Plan usage meter label:Active automations`, icon: "settings-automation" },
  automationExecutions: { label: $localize`:Plan usage meter label:Automation executions this month`, icon: "bolt" },
};

type MeterView = {
  key: PlanUsageMeterKey;
  label: string;
  icon: string;
  level: PlanUsageLevel;
  percent: number | null;
  used: number | null;
  limit: number | null;
  valueLabel: string;
  resetsLabel: string | null;
};

@Component({
  selector: "k-account-settings-plan",
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./account-plan.page.html",
})
export class AccountSettingsPlanPage implements OnInit {
  protected readonly settings = inject(AccountSettingsPage);
  private readonly api = inject(ApiClient);
  protected readonly trialEndLabel = computed(() => formatDate(this.settings.trialEndsAt(), "medium"));
  // The Free plan is always $0 in USD; only the number formatting follows the interface language.
  protected readonly freePrice = new Intl.NumberFormat(appLocale(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(0);

  // Live counts against the plan's caps. The server derives both from the same counters the limit
  // enforcement uses, so a meter at its limit means the next create is refused.
  private readonly planUsage = signal<PlanUsageResponse | null>(null);
  protected readonly meters = computed<MeterView[]>(() => {
    const usage = this.planUsage();
    if (!usage) return [];
    const number = new Intl.NumberFormat(appLocale());
    return usage.meters.map((meter) => {
      const used = meter.used === null ? null : number.format(meter.used);
      const valueLabel = meter.limit !== null
        ? $localize`:Plan usage value, e.g. 2 of 3:${used ?? "0"}:used: of ${number.format(meter.limit)}:limit:`
        : used !== null
          ? $localize`:Plan usage value with no limit, e.g. 12 · Unlimited:${used}:used: · Unlimited`
          : $localize`:Plan usage value when the plan has no limit:Unlimited`;
      return {
        key: meter.key,
        ...METER_LABELS[meter.key],
        level: planUsageLevel(meter.used, meter.limit),
        percent: planUsagePercent(meter.used, meter.limit),
        used: meter.used,
        limit: meter.limit,
        valueLabel,
        // The execution allowance is a UTC calendar month, so show the reset day in UTC too.
        resetsLabel: meter.resetsAt
          ? $localize`:When the monthly allowance starts again:Resets ${formatDate(meter.resetsAt, "medium", { timeZone: "UTC" })}:date:`
          : null,
      };
    });
  });
  // The tier the meters were counted under, so the note always matches the limits shown.
  protected readonly usageTier = computed(() => this.planUsage()?.tier ?? null);
  protected readonly anyAtLimit = computed(() => this.meters().some((meter) => meter.level === "limit"));
  protected readonly anyNearLimit = computed(() => this.meters().some((meter) => meter.level === "warning"));
  protected readonly seatsFull = computed(() => this.meters().some((meter) => meter.key === "seats" && meter.level === "limit"));

  constructor() {
    this.settings.selectedTab.set("account-plan");
  }

  ngOnInit(): void {
    this.settings.trackPricingViewed();
    void this.loadPlanUsage();
  }

  private async loadPlanUsage() {
    // Self-hosted has no plans; the tab is hosted-only, but never ask for meters it cannot have.
    if (!this.settings.isHosted()) return;
    try {
      this.planUsage.set(await this.api.get<PlanUsageResponse>("/clients/me/plan-usage"));
    } catch {
      // Meters are informational. The plan cards and enforcement still work without them.
      this.planUsage.set(null);
    }
  }
}
