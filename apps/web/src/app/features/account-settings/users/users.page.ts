import { EmptyStateComponent } from "../../../shared/empty-state.component";
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
  imports: [EmptyStateComponent, AvatarComponent, DocsLinkComponent, RouterLink, SearchFieldComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./users.page.html",
  styleUrl: "./users.page.scss",
})
export class AccountSettingsUsersPage {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly copiedLabel = $localize`:Tooltip after copying:Copied`;
  protected readonly copyInviteLinkLabel = $localize`Copy invite link`;

  protected noMatchesText(query: string): string {
    return $localize`:Empty search result:Nothing matches “${query}:query:”.`;
  }

  constructor() {
    this.settings.selectedTab.set("users");
  }
}
