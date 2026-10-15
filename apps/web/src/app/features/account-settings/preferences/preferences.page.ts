import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-preferences",
  standalone: true,
  imports: [DocsLinkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./preferences.page.html",
})
export class AccountSettingsPreferencesPage {
  protected readonly settings = inject(AccountSettingsPage);
}
