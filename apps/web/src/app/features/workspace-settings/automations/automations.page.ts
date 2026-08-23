import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardMenuCoordinator } from "../../board/board-menu-coordinator.service";
import { CardLabelsComponent } from "../../board/card-labels.component";
import { UserMultiSelectDropdownComponent } from "../user-multi-select-dropdown.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";
import { AutomationActionFieldsComponent } from "./automation-action-fields.component";
import { AutomationExamplesPopover } from "./automation-examples.popover";

@Component({
  selector: "k-workspace-settings-automations",
  standalone: true,
  imports: [AutomationActionFieldsComponent, AutomationExamplesPopover, CardLabelsComponent, CdkDrag, CdkDragHandle, CdkDropList, DocsLinkComponent, TooltipDirective, UserMultiSelectDropdownComponent],
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

  /**
   * Which trigger the examples menu is anchored to, if any.
   *
   * Two anchors rather than one shared panel: the empty state's button sits well below the toolbar's,
   * and a menu that opened somewhere other than where it was clicked reads as a different control.
   */
  protected readonly examplesAnchor = signal<"toolbar" | "empty" | null>(null);

  constructor() {
    this.settings.selectedTab.set("automations");
  }

  protected toggleExamples(anchor: "toolbar" | "empty"): void {
    this.examplesAnchor.update((current) => (current === anchor ? null : anchor));
  }

  /**
   * Only clears when the panel that closed is still the open one. Clicking the other trigger
   * dismisses this panel *after* the new one has been recorded, and an unguarded set(null) there
   * would close the panel that click just opened.
   */
  protected closeExamples(anchor: "toolbar" | "empty"): void {
    this.examplesAnchor.update((current) => (current === anchor ? null : current));
  }
}
