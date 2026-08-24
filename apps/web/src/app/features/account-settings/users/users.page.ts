import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { AvatarComponent } from "../../../shared/avatar.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { SearchFieldComponent } from "../../../shared/search-field.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-users",
  standalone: true,
  imports: [AvatarComponent, DocsLinkComponent, RouterLink, SearchFieldComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./users.page.html",
  styleUrl: "./users.page.scss",
})
export class AccountSettingsUsersPage {
  protected readonly settings = inject(AccountSettingsPage);

  constructor() {
    this.settings.selectedTab.set("users");
  }
}
