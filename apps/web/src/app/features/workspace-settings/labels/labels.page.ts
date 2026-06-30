import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AutofocusDirective } from "../../../shared/autofocus.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-labels",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, ColorPickerComponent, AutofocusDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./labels.page.html",
  styleUrl: "./labels.page.scss",
})
export class WorkspaceSettingsLabelsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("labels");
  }
}
