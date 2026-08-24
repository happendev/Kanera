import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-api",
  standalone: true,
  imports: [DocsLinkComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./api.page.html",
  styleUrl: "./api.page.scss",
})
export class WorkspaceSettingsApiPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("api");
  }
}
