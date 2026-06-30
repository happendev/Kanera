import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { ChecklistTemplateMultiSelectDropdownComponent } from "../checklist-template-multi-select-dropdown.component";
import { UserMultiSelectDropdownComponent } from "../user-multi-select-dropdown.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-automations",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, UserMultiSelectDropdownComponent, ChecklistTemplateMultiSelectDropdownComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./automations.page.html",
  styleUrl: "./automations.page.scss",
})
export class WorkspaceSettingsAutomationsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  constructor() {
    this.settings.selectedTab.set("automations");
  }
}
