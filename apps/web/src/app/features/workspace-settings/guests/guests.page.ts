import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AvatarComponent } from "../../../shared/avatar.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-guests",
  standalone: true,
  imports: [AvatarComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./guests.page.html",
  styleUrl: "./guests.page.scss",
})
export class WorkspaceSettingsGuestsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("guests");
  }
}
