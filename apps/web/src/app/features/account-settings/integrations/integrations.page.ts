import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { AccountSettingsPage } from "../account-settings.page";

/** Organisation → Integrations: GitHub, and on self-hosted deployments the push and SMTP plumbing. */
@Component({
  selector: "k-account-settings-integrations",
  standalone: true,
  imports: [AnchoredPanelDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./integrations.page.html",
})
export class AccountSettingsIntegrationsPage {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly savedUsernamePlaceholder = $localize`:Placeholder for a saved SMTP username:Saved, leave blank to keep`;
  protected readonly savedPasswordPlaceholder = $localize`:Placeholder for a saved SMTP password:•••••••• (saved, leave blank to keep)`;
  protected readonly showPasswordLabel = $localize`:Button — reveal the typed password:Show password`;
  protected readonly hidePasswordLabel = $localize`:Button — mask the typed password:Hide password`;
  protected readonly smtpPanelPlacement = { width: 320, maxHeight: 360, minHeight: 190 } as const;

  constructor() {
    this.settings.selectedTab.set("integrations");
  }
}
