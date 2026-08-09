import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardMenuCoordinator } from "../../board/board-menu-coordinator.service";
import { CardLabelsComponent } from "../../board/card-labels.component";
import { UserMultiSelectDropdownComponent } from "../user-multi-select-dropdown.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";
import { AutomationActionFieldsComponent } from "./automation-action-fields.component";

@Component({
  selector: "k-workspace-settings-automations",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, UserMultiSelectDropdownComponent, AutomationActionFieldsComponent, CardLabelsComponent, TooltipDirective],
  // k-card-labels reads the shared compressed-labels preference from BoardMenuCoordinator, which is
  // deliberately not root-provided (it owns document listeners torn down in ngOnDestroy). Providing
  // it here — as home.page.ts does for the same reason — scopes it to this tab, and the parent's
  // @switch destroys this component on tab change, so the listeners go with it.
  providers: [BoardMenuCoordinator],
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
