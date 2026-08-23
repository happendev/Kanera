import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AutofocusDirective } from "../../../shared/autofocus.directive";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-templates",
  standalone: true,
  imports: [AutofocusDirective, CdkDrag, CdkDragHandle, CdkDropList, DocsLinkComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./templates.page.html",
  styleUrl: "./templates.page.scss",
})
export class WorkspaceSettingsTemplatesPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("templates");
  }
}
