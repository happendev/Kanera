import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AutosaveStatusComponent } from "../../../shared/autosave-status.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-notifications",
  standalone: true,
  imports: [AutosaveStatusComponent, EmptyStateComponent, DocsLinkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./notifications.page.html",
  styleUrl: "./notifications.page.scss",
})
export class AccountSettingsNotificationsPage {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly savedTokenPlaceholder = $localize`:Placeholder for a token field that already has a saved value:Saved — leave blank to keep`;
  protected readonly optionalTokenPlaceholder = $localize`:Placeholder for the ntfy token field:Optional access token`;
  protected readonly requiredAppTokenPlaceholder = $localize`:Placeholder for the Gotify token field:Required app token`;

  protected toggleAllTypesLabel(channel: string): string {
    return $localize`:Checkbox label; channel is Email, Push, ntfy, Gotify or Webhook:Toggle all ${channel}:channel: notification types`;
  }

  protected typeViaChannelLabel(type: string, channel: string): string {
    return $localize`:Checkbox label, e.g. "Card assigned via Email":${type}:type: via ${channel}:channel:`;
  }

  constructor() {
    this.settings.selectedTab.set("notifications");
  }
}
