import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-notifications",
  standalone: true,
  imports: [EmptyStateComponent, DocsLinkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./notifications.page.html",
  styleUrl: "./notifications.page.scss",
})
export class AccountSettingsNotificationsPage {
  protected readonly settings = inject(AccountSettingsPage);

  constructor() {
    this.settings.selectedTab.set("notifications");
  }
}
