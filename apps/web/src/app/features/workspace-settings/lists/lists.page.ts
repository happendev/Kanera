import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AutofocusDirective } from "../../../shared/autofocus.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-lists",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, IconPickerComponent, ColorPickerComponent, AutofocusDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./lists.page.html",
  styleUrl: "./lists.page.scss",
})
export class WorkspaceSettingsListsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("lists");
  }
}
