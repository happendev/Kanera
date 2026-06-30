import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-plan",
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./account-plan.page.html",
  styleUrl: "./account-plan.page.scss",
})
export class AccountSettingsPlanPage {
  protected readonly settings = inject(AccountSettingsPage);

  constructor() {
    this.settings.selectedTab.set("account-plan");
  }
}
