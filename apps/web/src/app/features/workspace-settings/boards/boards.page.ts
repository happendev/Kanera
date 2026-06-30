import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-boards",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, IconPickerComponent, ColorPickerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./boards.page.html",
  styleUrl: "./boards.page.scss",
})
export class WorkspaceSettingsBoardsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("boards");
  }
}
