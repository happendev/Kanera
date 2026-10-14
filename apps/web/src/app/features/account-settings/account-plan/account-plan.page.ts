import { RouterLink } from "@angular/router";
import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { appLocale } from "../../../core/i18n/locale";
import { formatDate } from "../../../shared/date-format";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-plan",
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./account-plan.page.html",
})
export class AccountSettingsPlanPage implements OnInit {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly trialEndLabel = computed(() => formatDate(this.settings.trialEndsAt(), "medium"));
  // The Free plan is always $0 in USD; only the number formatting follows the interface language.
  protected readonly freePrice = new Intl.NumberFormat(appLocale(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(0);

  constructor() {
    this.settings.selectedTab.set("account-plan");
  }

  ngOnInit(): void {
    this.settings.trackPricingViewed();
  }
}
