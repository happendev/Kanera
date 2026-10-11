import { DatePipe } from "@angular/common";
import { RouterLink } from "@angular/router";
import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-plan",
  standalone: true,
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./account-plan.page.html",
})
export class AccountSettingsPlanPage implements OnInit {
  protected readonly settings = inject(AccountSettingsPage);

  constructor() {
    this.settings.selectedTab.set("account-plan");
  }

  ngOnInit(): void {
    this.settings.trackPricingViewed();
  }
}
