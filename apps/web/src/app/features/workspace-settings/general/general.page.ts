import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-general",
  standalone: true,
  imports: [IconPickerComponent, ColorPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./general.page.html",
  styleUrl: "./general.page.scss",
})
export class WorkspaceSettingsGeneralPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("general");
  }
}
